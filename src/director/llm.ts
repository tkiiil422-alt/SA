/**
 * 支持原生 Tool Calling（Function Calling）的双协议模型调用封装。
 *
 * 同时兼容 OpenAI Chat Completions (`openai-completions`) 与 Anthropic Messages (`anthropic-messages`)，
 * 复用平台统一的用量解析（`gateway/usage.ts`）、前缀缓存策略（`sessionId` / `cache_control`）与密钥脱敏。
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createSseUsageParser, usageFrom, type Usage } from '../gateway/usage.ts'
import {
  appendSafetyFilterHint,
  describeFetchError,
  isRetryableNetworkError,
  RETRYABLE_HTTP_STATUSES,
  retryBackoffMs,
  sleepMs,
  type ModelTarget,
} from '../assessor/model-call.ts'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean }

export interface ToolModelRequest {
  model: string
  system: string
  messages: readonly AgentMessage[]
  tools: readonly ToolDefinition[]
  maxTokens: number
}

export interface ToolModelOptions {
  timeoutMs: number
  fetch?: typeof fetch
  sessionId?: string
  stream?: boolean
  cacheTtl?: '5m' | '1h'
  /** 遇到临时断连（ECONNRESET / ETIMEDOUT / 502 / 503 / 504 等）时的最大自动重试次数，默认 3。 */
  maxRetries?: number
  /** 首次重试基准退避毫秒数，默认 600。 */
  retryDelayMs?: number
  /** 流式请求在该毫秒数内未收到上游任何响应头即视为连接挂起，中止本次尝试并换新连接重试（默认 45000，传 0 关闭；仅 stream 生效）。 */
  firstByteTimeoutMs?: number
}

export interface ToolModelResult {
  ok: boolean
  status?: number
  text: string
  toolCalls: ToolCall[]
  usage?: Usage
  latencyMs: number
  error?: string
  truncated?: boolean
  /** 当上游明确报错不支持 tools/function calling 时置为 true，便于上层给出明确引导。 */
  toolsUnsupported?: boolean
}

const ERROR_TAIL_CHARS = 300

function parseJsonArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { _raw: trimmed }
  }
}

function looksLikeToolsUnsupported(status: number | undefined, raw: string): boolean {
  if (status !== 400 && status !== 422) return false
  return /(tool|function).*(not\s+support|unsupported|invalid|not\s+allowed)|does\s+not\s+support\s+tools/i.test(raw)
}

function toOpenAiMessages(system: string, messages: readonly AgentMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content })
    } else if (msg.role === 'assistant') {
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: msg.content || (msg.toolCalls && msg.toolCalls.length > 0 ? null : ''),
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        }))
      }
      out.push(entry)
    } else {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      })
    }
  }
  return out
}

type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }

function toAnthropicMessages(
  messages: readonly AgentMessage[],
  mark: { type: 'ephemeral'; ttl?: '1h' },
): { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] {
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = []

  const pushBlocks = (role: 'user' | 'assistant', blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return
    const prev = out[out.length - 1]
    if (prev && prev.role === role) {
      prev.content.push(...blocks)
    } else {
      out.push({ role, content: [...blocks] })
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      pushBlocks('user', [{ type: 'text', text: msg.content || ' ' }])
    } else if (msg.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (msg.content) blocks.push({ type: 'text', text: msg.content })
      for (const tc of msg.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} })
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: ' ' })
      pushBlocks('assistant', blocks)
    } else {
      pushBlocks('user', [{
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      }])
    }
  }

  // 在倒数第二条消息的最后一个文本/tool_result 块打缓存标记，最大化前缀缓存命中
  if (out.length >= 2) {
    const target = out[out.length - 2]!
    for (let i = target.content.length - 1; i >= 0; i -= 1) {
      const block = target.content[i]!
      if (block.type === 'text' || block.type === 'tool_result') {
        block.cache_control = mark
        break
      }
    }
  }
  return out
}

function extractOpenAiResponse(json: unknown): { text: string; toolCalls: ToolCall[]; truncated: boolean } {
  if (typeof json !== 'object' || json === null) return { text: '', toolCalls: [], truncated: false }
  const obj = json as Record<string, unknown>
  const choices = Array.isArray(obj.choices) ? obj.choices : []
  const first = choices[0] as {
    message?: {
      content?: unknown
      tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]
    }
    finish_reason?: unknown
  } | undefined
  let text = ''
  if (typeof first?.message?.content === 'string') {
    text = first.message.content
  } else if (Array.isArray(first?.message?.content)) {
    text = first.message.content
      .map(part => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('')
  }
  const toolCalls: ToolCall[] = []
  if (Array.isArray(first?.message?.tool_calls)) {
    first.message.tool_calls.forEach((tc, idx) => {
      const name = typeof tc?.function?.name === 'string' ? tc.function.name.trim() : ''
      if (!name) return
      const id = typeof tc?.id === 'string' && tc.id.trim() ? tc.id.trim() : `call_${idx + 1}`
      const rawArgs = typeof tc?.function?.arguments === 'string'
        ? tc.function.arguments
        : tc?.function?.arguments && typeof tc.function.arguments === 'object'
          ? JSON.stringify(tc.function.arguments)
          : '{}'
      toolCalls.push({ id, name, arguments: parseJsonArgs(rawArgs) })
    })
  }
  return { text, toolCalls, truncated: first?.finish_reason === 'length' }
}

function extractAnthropicResponse(json: unknown): { text: string; toolCalls: ToolCall[]; truncated: boolean } {
  if (typeof json !== 'object' || json === null) return { text: '', toolCalls: [], truncated: false }
  const obj = json as Record<string, unknown>
  const blocks = Array.isArray(obj.content) ? obj.content : []
  let text = ''
  const toolCalls: ToolCall[] = []
  blocks.forEach((raw, idx) => {
    const block = raw as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown } | null
    if (!block || typeof block !== 'object') return
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    } else if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.trim()) {
      const id = typeof block.id === 'string' && block.id.trim() ? block.id.trim() : `toolu_${idx + 1}`
      const input = typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input)
        ? block.input as Record<string, unknown>
        : {}
      toolCalls.push({ id, name: block.name.trim(), arguments: input })
    }
  })
  return { text, toolCalls, truncated: obj.stop_reason === 'max_tokens' }
}

async function readToolStream(
  api: ModelTarget['api'],
  response: Response,
): Promise<{ text: string; toolCalls: ToolCall[]; truncated: boolean; usage?: Usage }> {
  const usage = createSseUsageParser()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let truncated = false

  // OpenAI 流式 tool_calls 按 index 累积
  const openAiCalls = new Map<number, { id: string; name: string; argsRaw: string }>()
  // Anthropic 流式 content_block 按 index 累积
  const anthropicBlocks = new Map<number, { id: string; name: string; argsRaw: string }>()

  const onLine = (rawLine: string): void => {
    const trimmed = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
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
      const choices = Array.isArray(event.choices) ? event.choices : []
      const first = choices[0] as {
        delta?: {
          content?: unknown
          tool_calls?: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]
        }
        finish_reason?: unknown
      } | undefined
      if (typeof first?.delta?.content === 'string') text += first.delta.content
      if (Array.isArray(first?.delta?.tool_calls)) {
        for (const delta of first.delta.tool_calls) {
          const index = typeof delta.index === 'number' ? delta.index : 0
          let slot = openAiCalls.get(index)
          if (!slot) {
            slot = { id: '', name: '', argsRaw: '' }
            openAiCalls.set(index, slot)
          }
          if (typeof delta.id === 'string' && delta.id) slot.id = delta.id
          if (typeof delta.function?.name === 'string' && delta.function.name) slot.name += delta.function.name
          if (typeof delta.function?.arguments === 'string') slot.argsRaw += delta.function.arguments
        }
      }
      if (first?.finish_reason === 'length') truncated = true
    } else {
      const type = event.type
      if (type === 'content_block_start') {
        const index = typeof event.index === 'number' ? event.index : 0
        const block = event.content_block as { type?: unknown; id?: unknown; name?: unknown } | undefined
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          anthropicBlocks.set(index, {
            id: typeof block.id === 'string' ? block.id : `toolu_${index + 1}`,
            name: block.name,
            argsRaw: '',
          })
        }
      } else if (type === 'content_block_delta') {
        const index = typeof event.index === 'number' ? event.index : 0
        const delta = event.delta as { type?: unknown; text?: unknown; partial_json?: unknown } | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const slot = anthropicBlocks.get(index)
          if (slot) slot.argsRaw += delta.partial_json
        }
      } else if (type === 'message_delta') {
        const delta = event.delta as { stop_reason?: unknown } | undefined
        if (delta?.stop_reason === 'max_tokens') truncated = true
      }
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
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        onLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    }
  } else {
    const all = await response.text()
    usage.push(all)
    buffer = all
  }
  const rest = buffer + decoder.decode()
  for (const rawLine of rest.split('\n')) onLine(rawLine)
  usage.flush()

  const toolCalls: ToolCall[] = []
  if (api === 'openai-completions') {
    for (const [idx, slot] of [...openAiCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!slot.name.trim()) continue
      toolCalls.push({
        id: slot.id || `call_${idx + 1}`,
        name: slot.name.trim(),
        arguments: parseJsonArgs(slot.argsRaw),
      })
    }
  } else {
    for (const [, slot] of [...anthropicBlocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (!slot.name.trim()) continue
      toolCalls.push({
        id: slot.id,
        name: slot.name.trim(),
        arguments: parseJsonArgs(slot.argsRaw),
      })
    }
  }

  const seen = usage.usage()
  return { text, toolCalls, truncated, ...(seen ? { usage: seen } : {}) }
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

function makeAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return Object.assign(new Error(typeof reason === 'string' && reason ? reason : 'The operation was aborted'), { name: 'AbortError' })
}

function toNodeHeaders(raw: RequestInit['headers'] | undefined): { headers: Record<string, string>; forceClose: boolean } {
  const headers: Record<string, string> = {}
  let forceClose = false
  if (!raw) return { headers, forceClose }
  new Headers(raw).forEach((value, key) => {
    headers[key] = value
    if (key.toLowerCase() === 'connection' && value.toLowerCase() === 'close') forceClose = true
  })
  return { headers, forceClose }
}

function toWebHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') headers.append(k, v)
    else if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item)
    }
  }
  return headers
}

/**
 * 基于 `node:http` / `node:https` 的零依赖长超时 Fetch 适配器。
 * 绕开 Node.js 内置 undici `fetch` 默认 5 分钟的 `headersTimeout` / `bodyTimeout` 硬限制，
 * 将 socket 超时设为 0，使高推理模型请求可稳定等待 20–60 分钟并严格响应外部 `AbortSignal`。
 */
export function nodeHttpFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const parsed = new URL(urlStr)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new TypeError(`Unsupported protocol: ${parsed.protocol}`))
  }

  const signal = init?.signal ?? undefined
  if (signal?.aborted) {
    return Promise.reject(makeAbortError(signal.reason))
  }

  const { headers, forceClose } = toNodeHeaders(init?.headers)
  let bodyBuf: Buffer | undefined
  if (typeof init?.body === 'string') {
    bodyBuf = Buffer.from(init.body, 'utf8')
  } else if (init?.body instanceof Uint8Array) {
    bodyBuf = Buffer.from(init.body)
  } else if (init?.body instanceof ArrayBuffer) {
    bodyBuf = Buffer.from(init.body)
  }
  if (bodyBuf && !('content-length' in headers)) {
    headers['content-length'] = String(bodyBuf.byteLength)
  }

  const requester = parsed.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<Response>((resolve, reject) => {
    let settled = false
    const req = requester(parsed, {
      method: init?.method ?? 'GET',
      headers,
      timeout: 0,
      ...(forceClose ? { agent: false } : {}),
    })
    req.setTimeout(0)

    let activeRes: import('node:http').IncomingMessage | undefined
    let onStreamAbort: ((err: Error) => void) | undefined

    const cleanupSignal = (): void => {
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      const err = makeAbortError(signal?.reason)
      cleanupSignal()
      req.destroy(err)
      if (activeRes) activeRes.destroy(err)
      if (!settled) {
        settled = true
        reject(err)
      } else {
        onStreamAbort?.(err)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.on('error', err => {
      cleanupSignal()
      if (!settled) {
        settled = true
        reject(err)
      } else {
        onStreamAbort?.(err)
      }
    })

    req.on('response', res => {
      activeRes = res
      const status = res.statusCode ?? 502
      const resHeaders = toWebHeaders(res.headers)
      if (NULL_BODY_STATUSES.has(status)) {
        res.resume()
        cleanupSignal()
        if (!settled) {
          settled = true
          resolve(new Response(null, { status, statusText: res.statusMessage ?? '', headers: resHeaders }))
        }
        return
      }

      let streamDone = false
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const finishError = (err: Error): void => {
            if (streamDone) return
            streamDone = true
            cleanupSignal()
            try { controller.error(err) } catch { /* stream already errored */ }
          }
          onStreamAbort = finishError

          res.on('data', (chunk: Buffer) => {
            if (streamDone) return
            controller.enqueue(new Uint8Array(chunk))
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              res.pause()
            }
          })
          res.on('end', () => {
            if (streamDone) return
            streamDone = true
            cleanupSignal()
            try { controller.close() } catch { /* stream already closed */ }
          })
          res.on('error', err => finishError(err))
          res.on('aborted', () => finishError(new Error('Upstream response aborted')))
        },
        pull() {
          if (!streamDone) res.resume()
        },
        cancel() {
          streamDone = true
          cleanupSignal()
          res.destroy()
          req.destroy()
        },
      })

      if (!settled) {
        settled = true
        resolve(new Response(bodyStream, { status, statusText: res.statusMessage ?? '', headers: resHeaders }))
      }
    })

    if (bodyBuf && bodyBuf.byteLength > 0) req.write(bodyBuf)
    req.end()
  })
}

/** 发起一次带工具定义的模型调用，绝不抛异常，密钥永不出现在错误文案中。 */
export async function callToolModel(
  target: ModelTarget,
  request: ToolModelRequest,
  opts: ToolModelOptions,
): Promise<ToolModelResult> {
  const started = Date.now()
  const base = target.baseUrl.replace(/\/+$/, '')
  const redact = (text: string): string => (target.apiKey ? text.split(target.apiKey).join('***') : text)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const mark: { type: 'ephemeral'; ttl?: '1h' } = opts.cacheTtl === '1h'
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' }

  let url: string
  let body: Record<string, unknown>

  if (target.api === 'openai-completions') {
    url = `${base}/chat/completions`
    headers.authorization = `Bearer ${target.apiKey}`
    body = {
      model: request.model,
      messages: toOpenAiMessages(request.system, request.messages),
      max_tokens: request.maxTokens,
      stream: opts.stream === true,
      ...(opts.stream === true ? { stream_options: { include_usage: true } } : {}),
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
      body.tool_choice = 'auto'
    }
  } else {
    url = `${base}/v1/messages`
    headers['x-api-key'] = target.apiKey
    headers['anthropic-version'] = '2023-06-01'
    const anthropicTools = request.tools.map((t, idx) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(idx === request.tools.length - 1 ? { cache_control: mark } : {}),
    }))
    body = {
      model: request.model,
      system: [{ type: 'text', text: request.system, cache_control: mark }],
      messages: toAnthropicMessages(request.messages, mark),
      max_tokens: request.maxTokens,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(opts.stream === true ? { stream: true } : {}),
    }
  }
  if (target.sessionHeader && opts.sessionId) headers[target.sessionHeader] = opts.sessionId

  const deadline = started + opts.timeoutMs
  const payload = JSON.stringify(body)
  // 超过 4 分钟的长超时请求默认切换至 nodeHttpFetch，规避 Node 内置 undici 5 分钟隐性 headers/body 超时限制
  const doFetch = opts.fetch ?? (opts.timeoutMs > 240_000 ? nodeHttpFetch : fetch)
  const maxRetries = Math.max(0, opts.maxRetries ?? 3)
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 600)
  const minRetryBudgetMs = 2_000

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { ok: false, text: '', toolCalls: [], latencyMs: Date.now() - started, error: `模型调用超时（${Math.round(opts.timeoutMs / 1000)} 秒）` }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    // 上游「接了连接却长时间不吐字」是网关最常见的挂起形态：先用首字节看门狗截断并重试（传 0 可关闭以等待超长静默思考）。
    let stalled = false
    const rawFirstByte = opts.firstByteTimeoutMs
    const firstByteMs = rawFirstByte === 0 ? 0 : Math.max(5_000, rawFirstByte ?? 45_000)
    const stallTimer = opts.stream === true && firstByteMs > 0 && firstByteMs < remaining
      ? setTimeout(() => { stalled = true; controller.abort() }, firstByteMs)
      : undefined
    // 重试时禁用 keep-alive 连接复用，强制建立全新 TCP+TLS 连接，避免撞到代理/TUN 半开旧套接字。
    const attemptHeaders = attempt > 0 ? { ...headers, connection: 'close' } : headers
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: attemptHeaders,
        body: payload,
        signal: controller.signal,
      })
      if (stallTimer) clearTimeout(stallTimer)
      if (opts.stream === true && response.ok && (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
        const streamed = await readToolStream(target.api, response)
        return {
          ok: true,
          status: response.status,
          text: streamed.text,
          toolCalls: streamed.toolCalls,
          latencyMs: Date.now() - started,
          ...(streamed.usage ? { usage: streamed.usage } : {}),
          ...(streamed.truncated ? { truncated: true } : {}),
        }
      }
      const raw = await response.text()
      const latencyMs = Date.now() - started
      if (!response.ok) {
        const safeRaw = redact(raw)
        const canRetry = attempt < maxRetries
          && RETRYABLE_HTTP_STATUSES.has(response.status)
          && (deadline - Date.now()) > minRetryBudgetMs
        if (canRetry) {
          const wait = Math.min(
            retryBackoffMs(attempt, retryDelayMs, response.headers.get('retry-after')),
            Math.max(0, deadline - Date.now() - minRetryBudgetMs),
          )
          await sleepMs(wait)
          continue
        }
        const suffix = attempt > 0 ? `（已自动重试 ${attempt} 次）` : ''
        return {
          ok: false,
          status: response.status,
          text: '',
          toolCalls: [],
          latencyMs,
          error: appendSafetyFilterHint(`HTTP ${response.status}: ${safeRaw.slice(0, ERROR_TAIL_CHARS)}${suffix}`, safeRaw),
          ...(looksLikeToolsUnsupported(response.status, safeRaw) ? { toolsUnsupported: true } : {}),
        }
      }
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        return { ok: false, status: response.status, text: '', toolCalls: [], latencyMs, error: '上游响应不是合法 JSON' }
      }
      const usage = usageFrom(json)
      const extracted = target.api === 'openai-completions' ? extractOpenAiResponse(json) : extractAnthropicResponse(json)
      return {
        ok: true,
        status: response.status,
        text: extracted.text,
        toolCalls: extracted.toolCalls,
        latencyMs,
        ...(usage ? { usage } : {}),
        ...(extracted.truncated ? { truncated: true } : {}),
      }
    } catch (error) {
      const timedOut = controller.signal.aborted && !stalled
      const canRetry = (stalled || (!timedOut && isRetryableNetworkError(error)))
        && attempt < maxRetries
        && (deadline - Date.now()) > minRetryBudgetMs
      if (canRetry) {
        const wait = Math.min(
          retryBackoffMs(attempt, retryDelayMs),
          Math.max(0, deadline - Date.now() - minRetryBudgetMs),
        )
        await sleepMs(wait)
        continue
      }
      const latencyMs = Date.now() - started
      const suffix = attempt > 0 ? `（已自动重试 ${attempt} 次）` : ''
      const message = timedOut
        ? `模型调用超时（${Math.round(opts.timeoutMs / 1000)} 秒）`
        : stalled
          ? `上游连接挂起：${Math.round(firstByteMs / 1000)} 秒内无任何响应${suffix}`
          : `${describeFetchError(error)}${suffix}`
      return { ok: false, text: '', toolCalls: [], latencyMs, error: redact(message) }
    } finally {
      clearTimeout(timer)
      if (stallTimer) clearTimeout(stallTimer)
    }
  }
  return { ok: false, text: '', toolCalls: [], latencyMs: Date.now() - started, error: `模型调用超时（${Math.round(opts.timeoutMs / 1000)} 秒）` }
}
