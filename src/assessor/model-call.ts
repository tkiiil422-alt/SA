/**
 * One non-streaming call to an upstream model, made by the daemon itself with the real key (not through the gateway).
 *
 * Never throws: timeouts, network errors and bad responses come back as `ok: false`. The API key never appears in `error`.
 */
import { usageFrom, type Usage } from '../gateway/usage.ts'

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
}

export interface ModelCallOptions {
  timeoutMs: number
  fetch?: typeof fetch
  sessionId?: string
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
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      max_tokens: request.maxTokens,
      stream: false,
    }
  } else {
    url = `${base}/v1/messages`
    headers['x-api-key'] = target.apiKey
    headers['anthropic-version'] = '2023-06-01'
    body = {
      model: request.model,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      max_tokens: request.maxTokens,
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
