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
}

/** The fixed assistant turn after `context`; it must never change, or the cached prefix breaks. */
export const CONTEXT_ACK = '好的，资料已读。'

function chatMessages(request: ModelRequest): { role: 'user' | 'assistant'; content: string }[] {
  return [
    ...(request.context ? [{ role: 'user' as const, content: request.context }, { role: 'assistant' as const, content: CONTEXT_ACK }] : []),
    { role: 'user' as const, content: request.user },
  ]
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
  const system = request.context ? `${request.system}\n\n${request.context}` : request.system
  return {
    system: [{ type: 'text', text: system, cache_control: mark }],
    messages: [{ role: 'user', content: request.user }],
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

export async function callModel(target: ModelTarget, request: ModelRequest, opts: ModelCallOptions): Promise<ModelCallResult> {
  const started = Date.now()
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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const response = await (opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
      return {
        ok: false,
        status: response.status,
        text: '',
        latencyMs,
        error: `HTTP ${response.status}: ${redact(raw).slice(0, ERROR_TAIL_CHARS)}`,
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
    const latencyMs = Date.now() - started
    const message = controller.signal.aborted
      ? `timed out after ${opts.timeoutMs}ms`
      : error instanceof Error ? error.message : String(error)
    return { ok: false, text: '', latencyMs, error: redact(message) }
  } finally {
    clearTimeout(timer)
  }
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
