/**
 * One non-streaming call to an upstream model, made by the daemon itself with the real key (not through the gateway).
 *
 * Never throws: timeouts, network errors and bad responses come back as `ok: false`. The API key never appears in `error`.
 */
import { createSseUsageParser, usageFrom, type Usage } from '../gateway/usage.ts'

export interface ModelTarget {
  api: 'openai-completions' | 'anthropic-messages'
  baseUrl: string
  apiKey: string
  sessionHeader?: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ModelRequest {
  model: string
  system: string
  user: string
  maxTokens: number
  /**
   * Stable material sent as its own earlier user turn (followed by a fixed assistant acknowledgement), before `user`.
   * Upstream prefix caches reuse whole earlier messages: measured on OpenCode Go, a stable block inside the same message
   * as varying text never hit, while the same block as its own message hit on every call after the first.
   */
  context?: string
  /**
   * Append-only multi-turn conversation history (alternating user/assistant turns) kept byte-identical across turns so
   * upstreams like Gemini 4 / Anthropic / OpenAI hit full prefix & session cache. The final message sent is always `user`
   * (never an `assistant` prefill).
   */
  history?: readonly ChatTurn[]
}

/** The fixed assistant turn after `context`; it must never change, or the cached prefix breaks. */
export const CONTEXT_ACK = '好的，资料已读。'

function chatMessages(request: ModelRequest): ChatTurn[] {
  const prefix: ChatTurn[] = request.history && request.history.length > 0
    ? [...request.history]
    : request.context
      ? [{ role: 'user', content: request.context }, { role: 'assistant', content: CONTEXT_ACK }]
      : []
  return [...prefix, { role: 'user', content: request.user }]
}

export interface ModelCallOptions {
  timeoutMs: number
  fetch?: typeof fetch
  sessionId?: string
  /**
   * Ask the upstream to stream (SSE) and assemble the reply here. Some gateways cut a non-streaming request off after a
   * fixed time (about 120 s observed) while a long generation is still running; a stream keeps the connection busy.
   * The result has the same shape as a non-streaming call. Default false.
   */
  stream?: boolean
  /**
   * Prompt-cache lifetime for upstreams that only cache what the request marks (Anthropic messages). The system prompt
   * and `context` get a `cache_control` marker with this TTL; without markers such an upstream writes the prefix to
   * cache on every call (billed at the write premium) and never reads it back. OpenAI-style upstreams cache whole
   * earlier messages on their own and ignore this. Default '5m'; use '1h' when calls sharing the prefix are more than
   * five minutes apart (a novel role is called once or twice per chapter, and a chapter takes 10–20 minutes).
   */
  cacheTtl?: '5m' | '1h'
  /** 遇到临时断连（如 ECONNRESET / ETIMEDOUT / 502 / 503 / 504）时的最大自动重试次数，默认 2。 */
  maxRetries?: number
  /** 首次重试的基准退避毫秒数（指数退避并带轻微抖动），默认 500。 */
  retryDelayMs?: number
}

type CacheMark = { type: 'ephemeral'; ttl?: '1h' }

/**
 * The Anthropic request's `system` and `messages`, shaped so the stable part is read back from cache: `context` is
 * appended to the system prompt and the whole system block carries a cache marker; only `user` varies.
 *
 * Measured on the `gw` relay (2026-11-08, fresh tail on every call): `context` sent as its own earlier user turn was
 * written to cache on every call and never read back, with or without markers; the same text inside the system prompt
 * was read back from the second call on. A direct Anthropic upstream honours the marker in both places. Upstreams skip
 * caching below their minimum size (512 tokens on current models), so marking a short prompt costs nothing.
 */
function anthropicCached(request: ModelRequest, ttl: ModelCallOptions['cacheTtl']): { system: unknown; messages: unknown[] } {
  const mark: CacheMark = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
  const system = request.context && (!request.history || request.history.length === 0)
    ? `${request.system}\n\n${request.context}`
    : request.system
  const history = request.history ?? []
  const prior = history.map((turn, idx) => idx === history.length - 1
    ? { role: turn.role, content: [{ type: 'text', text: turn.content, cache_control: mark }] }
    : { role: turn.role, content: turn.content })
  return {
    system: [{ type: 'text', text: system, cache_control: mark }],
    messages: [...prior, { role: 'user', content: request.user }],
  }
}

export interface ModelCallResult {
  ok: boolean
  status?: number
  text: string
  usage?: Usage
  latencyMs: number
  error?: string
  /** True when the upstream stopped because it ran out of output tokens; the text is then incomplete. */
  truncated?: boolean
}

const ERROR_TAIL_CHARS = 200
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 500
const MIN_RETRY_BUDGET_MS = 2_000

/** 适合自动重试的临时上游状态码（含 Cloudflare 52x 与 Anthropic 529 过载，不包含 500）。 */
export const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504, 520, 521, 522, 523, 524, 529])

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

const RETRYABLE_ERROR_TEXT = /fetch failed|socket hang up|other side closed|terminated|network socket disconnected|unexpected eof|econnreset|etimedout|epipe|upstream response aborted|closed prematurely|premature close|connection reset|tls|ssl|handshake/i

const CONTENT_FILTER_TEXT = /blocked by gemini'?s filters|PROHIBITED_CONTENT|HARM_CATEGORY|content_filter|finish_reason["':\s]+["']?content_filter|blockReason["':\s]+["']?(SAFETY|PROHIBITED_CONTENT)/i

/** 判断上游错误或阻断文本是否命中了模型内容安全过滤。 */
export function isContentFilterError(raw: string): boolean {
  return CONTENT_FILTER_TEXT.test(raw)
}

/** 命中上游模型内容安全过滤时附加清晰的中文排查引导。 */
export function appendSafetyFilterHint(message: string, raw = message): string {
  if (!isContentFilterError(raw)) return message
  return `${message}（提示：上游模型触发了安全过滤误拦截，建议改用「防御工作台」的代码审查与加固剧本，或在项目中切换审计模型）`
}

/** 拼接 fetch 异常及其底层 cause 错误码（如 ECONNRESET / ETIMEDOUT），便于排查网络抖动。 */
export function describeFetchError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.cause instanceof Error) {
    const code = (error.cause as NodeJS.ErrnoException).code
    const detail = code || error.cause.message
    if (detail && !base.includes(detail)) return `${base} (${detail})`
  }
  return base
}

/** 判断异常是否属于临时网络/代理断连，适合换新连接自动重试。 */
export function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return RETRYABLE_ERROR_TEXT.test(String(error))
  const code = (error as NodeJS.ErrnoException).code
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true
  const cause = error.cause
  if (cause instanceof Error) {
    const causeCode = (cause as NodeJS.ErrnoException).code
    if (causeCode && RETRYABLE_ERROR_CODES.has(causeCode)) return true
    if (RETRYABLE_ERROR_TEXT.test(cause.message)) return true
  }
  return RETRYABLE_ERROR_TEXT.test(error.message)
}

/** 计算下一次重试等待毫秒数（优先尊重 Retry-After，其次指数退避 + 轻微抖动）。 */
export function retryBackoffMs(attempt: number, baseDelayMs: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader.trim())
    if (Number.isFinite(sec) && sec > 0) return Math.min(10_000, Math.round(sec * 1000))
  }
  const exp = Math.min(15_000, baseDelayMs * (2 ** attempt))
  return Math.max(0, Math.round(exp * (0.85 + Math.random() * 0.3)))
}

export function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export async function callModel(target: ModelTarget, request: ModelRequest, opts: ModelCallOptions): Promise<ModelCallResult> {
  const started = Date.now()
  const deadline = started + opts.timeoutMs
  const base = target.baseUrl.replace(/\/+$/, '')
  const redact = (text: string): string => target.apiKey ? text.split(target.apiKey).join('***') : text
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let url: string
  let body: unknown
  if (target.api === 'openai-completions') {
    url = `${base}/chat/completions`
    headers.authorization = `Bearer ${target.apiKey}`
    body = {
      model: request.model,
      messages: [{ role: 'system', content: request.system }, ...chatMessages(request)],
      max_tokens: request.maxTokens,
      stream: opts.stream === true,
      ...(opts.stream === true ? { stream_options: { include_usage: true } } : {}),
    }
  } else {
    url = `${base}/v1/messages`
    headers['x-api-key'] = target.apiKey
    headers['anthropic-version'] = '2023-06-01'
    body = {
      model: request.model,
      ...anthropicCached(request, opts.cacheTtl),
      max_tokens: request.maxTokens,
      ...(opts.stream === true ? { stream: true } : {}),
    }
  }
  if (target.sessionHeader && opts.sessionId) headers[target.sessionHeader] = opts.sessionId

  const payload = JSON.stringify(body)
  const doFetch = opts.fetch ?? fetch
  const maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES)
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { ok: false, text: '', latencyMs: Date.now() - started, error: `timed out after ${opts.timeoutMs}ms` }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    // 重试时强制关闭连接复用，绕开代理/TUN 中可能已半开的陈旧 keep-alive 套接字。
    const attemptHeaders = attempt > 0 ? { ...headers, connection: 'close' } : headers
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: attemptHeaders,
        body: payload,
        signal: controller.signal,
      })
      // An upstream that ignores the stream flag answers with plain JSON; that falls through to the JSON path below.
      if (opts.stream === true && response.ok && (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
        const streamed = await readStream(target.api, response)
        const usage = streamed.usage
        return {
          ok: true,
          status: response.status,
          text: streamed.text,
          latencyMs: Date.now() - started,
          ...(usage ? { usage } : {}),
          ...(streamed.truncated ? { truncated: true } : {}),
        }
      }
      const raw = await response.text()
      const latencyMs = Date.now() - started
      if (!response.ok) {
        const canRetry = attempt < maxRetries
          && RETRYABLE_HTTP_STATUSES.has(response.status)
          && (deadline - Date.now()) > MIN_RETRY_BUDGET_MS
        if (canRetry) {
          const wait = Math.min(
            retryBackoffMs(attempt, retryDelayMs, response.headers.get('retry-after')),
            Math.max(0, deadline - Date.now() - MIN_RETRY_BUDGET_MS),
          )
          await sleepMs(wait)
          continue
        }
        const suffix = attempt > 0 ? ` (after ${attempt} retries)` : ''
        const safeRaw = redact(raw)
        return {
          ok: false,
          status: response.status,
          text: '',
          latencyMs,
          error: appendSafetyFilterHint(`HTTP ${response.status}: ${safeRaw.slice(0, ERROR_TAIL_CHARS)}${suffix}`, safeRaw),
        }
      }
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        return { ok: false, status: response.status, text: '', latencyMs, error: 'response is not JSON' }
      }
      const usage = usageFrom(json)
      return {
        ok: true,
        status: response.status,
        text: extractText(target.api, json),
        latencyMs,
        ...(usage ? { usage } : {}),
        ...(isTruncated(target.api, json) ? { truncated: true } : {}),
      }
    } catch (error) {
      const timedOut = controller.signal.aborted
      const canRetry = !timedOut
        && attempt < maxRetries
        && isRetryableNetworkError(error)
        && (deadline - Date.now()) > MIN_RETRY_BUDGET_MS
      if (canRetry) {
        const wait = Math.min(
          retryBackoffMs(attempt, retryDelayMs),
          Math.max(0, deadline - Date.now() - MIN_RETRY_BUDGET_MS),
        )
        await sleepMs(wait)
        continue
      }
      const latencyMs = Date.now() - started
      const suffix = attempt > 0 ? ` (after ${attempt} retries)` : ''
      const message = timedOut
        ? `timed out after ${opts.timeoutMs}ms`
        : `${describeFetchError(error)}${suffix}`
      return { ok: false, text: '', latencyMs, error: redact(message) }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, text: '', latencyMs: Date.now() - started, error: `timed out after ${opts.timeoutMs}ms` }
}

/**
 * Assemble an SSE reply: OpenAI-style `choices[0].delta.content` (reasoning deltas are ignored) or Anthropic
 * `content_block_delta` text, the stop reason, and usage through the gateway's SSE usage parser.
 */
async function readStream(api: ModelTarget['api'], response: Response): Promise<{ text: string; truncated: boolean; usage?: Usage }> {
  const usage = createSseUsageParser()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let truncated = false
  const line = (raw: string): void => {
    const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed !== 'object' || parsed === null) return
      event = parsed as Record<string, unknown>
    } catch {
      return
    }
    if (api === 'openai-completions') {
      const choices = Array.isArray(event.choices) ? event.choices as { delta?: { content?: unknown }; finish_reason?: unknown }[] : []
      const first = choices[0]
      if (typeof first?.delta?.content === 'string') text += first.delta.content
      if (first?.finish_reason === 'length') truncated = true
    } else {
      const delta = event.delta as { type?: unknown; text?: unknown; stop_reason?: unknown } | undefined
      if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') text += delta.text
      if (event.type === 'message_delta' && delta?.stop_reason === 'max_tokens') truncated = true
    }
  }
  const reader = response.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      usage.push(chunk)
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        line(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
  } else {
    const all = await response.text()
    usage.push(all)
    buffer = all
  }
  const rest = buffer + decoder.decode()
  for (const raw of rest.split('\n')) line(raw)
  usage.flush()
  const seen = usage.usage()
  return { text, truncated, ...(seen ? { usage: seen } : {}) }
}

/** True when the upstream stopped because it ran out of output tokens (`finish_reason` length, `stop_reason` max_tokens). */
function isTruncated(api: ModelTarget['api'], json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false
  const value = json as Record<string, unknown>
  if (api === 'openai-completions') {
    const choices = Array.isArray(value.choices) ? value.choices as unknown[] : []
    const first = choices[0] as { finish_reason?: unknown } | undefined
    return first?.finish_reason === 'length'
  }
  return value.stop_reason === 'max_tokens'
}

function extractText(api: ModelTarget['api'], json: unknown): string {
  if (typeof json !== 'object' || json === null) return ''
  const value = json as Record<string, unknown>
  if (api === 'openai-completions') {
    const choices = Array.isArray(value.choices) ? value.choices as unknown[] : []
    const first = choices[0] as { message?: { content?: unknown } } | undefined
    return typeof first?.message?.content === 'string' ? first.message.content : ''
  }
  if (!Array.isArray(value.content)) return ''
  return (value.content as unknown[]).map(block => {
    const part = block as { type?: unknown; text?: unknown } | null
    return part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''
  }).join('')
}
