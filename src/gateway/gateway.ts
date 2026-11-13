/**
 * Local model gateway: workers call `/p/<providerId>/<path>` with a ticket token; the gateway validates the token, looks up
 * the provider, swaps in that provider's real key for its protocol, forwards the request body byte-for-byte (so upstream
 * prefix caching keeps working), streams the response back, and reports usage and cost to the injected ledger.
 *
 * Real API keys live only in this process. The gateway has no storage dependency: provider lookup, authorization, pricing
 * and recording are injected functions.
 */
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage,
  type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { costOf, type Price } from './pricing.ts'
import { createSseUsageParser, extractUsage, type Usage } from './usage.ts'

/** An accepted ticket token: who is calling and in what role. */
export interface Authorized {
  ticketId: string
  role: string
  /** Sub-agent role when the token carried a `.<role>` suffix; absent for the ticket's main worker. */
  agent?: string
}

/** An authorization result: accepted, or denied because the token is unknown or the ticket's budget is spent. */
export type Authorization = Authorized | { denied: 'unknown' | 'budget' }

/** A configured upstream provider. The gateway reads it on every request, so a change takes effect without a restart. */
export interface UpstreamTarget {
  /** Wire protocol; decides which header carries the real key. */
  api: 'openai-completions' | 'anthropic-messages'
  /** Base URL; the request path after `/p/<id>` and its query are appended to it. */
  baseUrl: string
  /** The real API key; it never leaves this process. */
  apiKey: string
  /** Model ids this provider may serve; any other requested model gets a 400 and never reaches upstream. */
  models: readonly string[]
}

/** One finished upstream call, as the ledger receives it. `at` is when the call started, ISO-8601. */
export interface CallRecord {
  ticketId: string
  role: string
  /** Sub-agent role that made the call; absent for the ticket's main worker. */
  agent?: string
  provider: string
  model: string
  usage: Usage | undefined
  costUsd: number
  latencyMs: number
  status: number
  at: string
}

export interface GatewayOptions {
  /** Resolve a provider id taken from the request path. Called on every request. */
  resolveProvider(id: string): UpstreamTarget | undefined
  /** Resolve a ticket token. May be synchronous or asynchronous. */
  authorize(token: string): Authorization | Promise<Authorization>
  /** Called once for every authorized call that reaches upstream, also when upstream fails. */
  record(entry: CallRecord): void
  /**
   * Extra headers to add to the upstream request, resolved per call. Used for provider-specific routing headers such as
   * OpenCode Go's `x-opencode-session`, which must stay stable for one conversation so requests reach the same backend.
   */
  upstreamHeaders?(auth: Authorized, providerId: string): Record<string, string>
  /** Price of a model at a provider, in USD per million tokens. Without a price the call is recorded at zero cost. */
  price?(providerId: string, model: string): Price | undefined
  /** Interface to listen on; defaults to `127.0.0.1`. */
  host?: string
  /** Port to listen on; defaults to `0` (an ephemeral port, reported by `listen`). */
  port?: number
  /** Maximum accepted request body size, in bytes. Defaults to 16 MiB. */
  maxBodyBytes?: number
  /**
   * Deadline for the upstream exchange, in milliseconds: waiting for the response headers and then for data while the
   * stream idles. Defaults to 600 000. Zero disables the timer.
   */
  upstreamTimeoutMs?: number
  /** Deadline for the upstream response headers alone; a hung upstream is cut so the client can retry. Default 150 000. */
  headersTimeoutMs?: number
  /**
   * An event stream that carries only keep-alive pings (or nothing) for this long is treated as stalled and cut, even
   * though bytes keep arriving. Default 240 000. Zero disables the check.
   */
  stallTimeoutMs?: number
}

export interface Gateway {
  /** Start listening and report the bound port. */
  listen(): Promise<{ port: number }>
  /** Stop listening and drop open connections. */
  close(): Promise<void>
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'host',
])

/** Client credentials: replaced by the gateway, never forwarded. */
const CLIENT_CREDENTIALS = new Set(['authorization', 'x-api-key'])

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024
/** How much of an over-limit body is read so its older images can be dropped; beyond this it is refused unread. */
const HARD_BODY_CAP_BYTES = 96 * 1024 * 1024
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000
const DEFAULT_HEADERS_TIMEOUT_MS = 150_000
const DEFAULT_STALL_TIMEOUT_MS = 240_000

/** Whether an SSE chunk carries real content, not just blank lines, comments or ping events. */
export function sseHasContent(chunk: Buffer): boolean {
  for (const raw of chunk.toString('utf8').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '' || line.startsWith(':')) continue
    if (/^event:\s*ping\s*$/.test(line)) continue
    if (/^data:\s*\{\s*"type"\s*:\s*"ping"\s*\}\s*$/.test(line)) continue
    return true
  }
  return false
}
/** Client headers in this namespace are session routing, chosen by the gateway, never supplied by the caller. */
const RESERVED_HEADER_PREFIX = 'x-opencode-'

/** A request routed to a provider: the provider id, and the path to forward (with query). */
interface ProviderRoute {
  providerId: string
  path: string
}

const connectionTokens = (headers: IncomingHttpHeaders): Set<string> =>
  new Set(String(headers.connection ?? '').toLowerCase().split(',').map(token => token.trim()).filter(Boolean))

/**
 * Copy request headers for upstream, dropping hop-by-hop headers and the client's credentials, then adding the
 * provider's real key in the header its protocol expects. Anthropic version and beta headers pass through untouched.
 */
function forwardedHeaders(headers: IncomingHttpHeaders, target: UpstreamTarget): Record<string, string | string[]> {
  const skip = connectionTokens(headers)
  const forwarded: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || CLIENT_CREDENTIALS.has(lower) || HOP_BY_HOP.has(lower) || skip.has(lower)) continue
    // Session routing headers belong to the gateway; a client-supplied one must never reach upstream.
    if (lower.startsWith(RESERVED_HEADER_PREFIX)) continue
    forwarded[lower] = value
  }
  if (target.api === 'anthropic-messages') forwarded['x-api-key'] = target.apiKey
  else forwarded.authorization = `Bearer ${target.apiKey}`
  return forwarded
}

/** Copy response headers for the client, dropping hop-by-hop headers only. */
function responseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const skip = connectionTokens(headers)
  const forwarded: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP.has(lower) || skip.has(lower)) continue
    forwarded[lower] = value
  }
  return forwarded
}

/** The token from a `Bearer <token>` header; empty when absent or malformed. */
function bearer(header: string | undefined): string {
  if (!header) return ''
  const match = /^\s*Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() ?? ''
}

/** The token from an `x-api-key` header (Anthropic-style clients); empty when absent. */
function apiKeyHeader(headers: IncomingHttpHeaders): string {
  const value = headers['x-api-key']
  return typeof value === 'string' ? value.trim() : ''
}

/** Split `/p/<providerId>/<rest>?query` into the provider id and `/<rest>?query`; undefined when the path has no provider. */
function providerRoute(requestUrl: string | undefined): ProviderRoute | undefined {
  const incoming = new URL(requestUrl ?? '/', 'http://gateway.invalid')
  const match = /^\/p\/([^/]+)(\/.*)?$/.exec(incoming.pathname)
  if (!match) return undefined
  return { providerId: match[1]!, path: `${match[2] ?? '/'}${incoming.search}` }
}

/**
 * Resolve the forwarded path and query against the provider's base URL, never trusting a host in the request.
 *
 * The base may carry a path prefix (`https://host/inference/go/openai/v1`); the incoming path is appended to it
 * rather than replacing it, so a provider served under a prefix still receives the full route.
 */
function targetUrl(base: URL, requestUrl: string | undefined): URL {
  const url = new URL(base.toString())
  const incoming = new URL(requestUrl ?? '/', 'http://gateway.invalid')
  const prefix = base.pathname.replace(/\/+$/, '')
  const suffix = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`
  url.pathname = `${prefix}${suffix}`
  // Keep the base's query parameters, which may be part of the upstream contract, and let the incoming ones win by name.
  const incomingParams = [...incoming.searchParams]
  const incomingNames = new Set(incomingParams.map(([name]) => name))
  const merged = new URLSearchParams()
  for (const [name, value] of base.searchParams) if (!incomingNames.has(name)) merged.append(name, value)
  for (const [name, value] of incomingParams) merged.append(name, value)
  url.search = merged.toString()
  return url
}

/** The model a request body names, for pricing and the allow-list; the body itself is forwarded untouched. */
function modelOf(body: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const model = (parsed as Record<string, unknown>).model
      if (typeof model === 'string') return model
    }
  } catch {
    // A non-JSON body has no model; usage and cost stay empty for it.
  }
  return ''
}

const IMAGE_PART_TYPES = new Set(['image_url', 'image', 'input_image'])
/** What replaces an image the gateway dropped; the model sees that a picture was there. */
export const DROPPED_IMAGE_TEXT = '[较早的截图已省略，以免请求超过大小上限；需要时请重新读取文件]'

/**
 * A worker that reads many screenshots carries every one of them in each later request until the body passes the limit
 * and every call fails with 413. Replace image parts with a short text, oldest first, until the body fits; the newest
 * images stay. Returns the smaller body, or undefined when it is not a chat body or still does not fit without images.
 */
export function shrinkImages(body: Buffer, limit: number): { body: Buffer; dropped: number } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const root = parsed as Record<string, unknown>
  const messages = Array.isArray(root.messages) ? root.messages : Array.isArray(root.input) ? root.input : undefined
  if (!messages) return undefined
  const spots: { parts: unknown[]; index: number; size: number }[] = []
  const visit = (content: unknown): void => {
    if (!Array.isArray(content)) return
    content.forEach((part, index) => {
      if (typeof part !== 'object' || part === null) return
      const record = part as Record<string, unknown>
      if (typeof record.type === 'string' && IMAGE_PART_TYPES.has(record.type)) {
        spots.push({ parts: content, index, size: Buffer.byteLength(JSON.stringify(part)) })
      } else if (Array.isArray(record.content)) {
        // Anthropic tool_result blocks nest their own content.
        visit(record.content)
      }
    })
  }
  for (const message of messages) {
    if (typeof message === 'object' && message !== null) visit((message as Record<string, unknown>).content)
  }
  if (spots.length === 0) return undefined
  const replacement = { type: 'text', text: DROPPED_IMAGE_TEXT }
  const replacementSize = Buffer.byteLength(JSON.stringify(replacement))
  let estimate = body.length
  let dropped = 0
  for (const spot of spots) {
    spot.parts[spot.index] = replacement
    dropped += 1
    estimate -= spot.size - replacementSize
    if (estimate <= limit) break
  }
  const out = Buffer.from(JSON.stringify(parsed), 'utf8')
  return out.length <= limit ? { body: out, dropped } : undefined
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

type BodyRead =
  | { kind: 'body'; body: Buffer }
  | { kind: 'too_large' }
  | { kind: 'aborted' }

/** Buffer the request body up to `limit` bytes; stop reading and report it as too large beyond that. */
function readBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result: BodyRead): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // Stop accepting data; the caller answers 413 and closes the exchange.
        req.pause()
        finish({ kind: 'too_large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ kind: 'body', body: Buffer.concat(chunks) }))
    req.on('error', () => finish({ kind: 'aborted' }))
    req.on('aborted', () => finish({ kind: 'aborted' }))
  })
}

export function createGateway(options: GatewayOptions): Gateway {
  const { authorize, record } = options
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  const headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS

  /** A price lookup that cannot take the gateway down; a failing lookup means no price. */
  const priceOf = (providerId: string, model: string): Price | undefined => {
    try {
      return options.price?.(providerId, model)
    } catch {
      return undefined
    }
  }

  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    auth: Authorized,
    body: Buffer,
    started: number,
    at: string,
    route: ProviderRoute,
    target: UpstreamTarget,
  ): void {
    // The client may have gone away while authorization was pending; do not open an upstream call for it.
    if (res.destroyed) return
    const { providerId } = route
    let url: URL
    try {
      url = targetUrl(new URL(target.baseUrl), route.path)
    } catch {
      sendJson(res, 502, { error: { type: 'upstream_misconfigured', message: 'Upstream address is invalid' } })
      return
    }
    const model = modelOf(body)
    const headers = forwardedHeaders(req.headers, target)
    Object.assign(headers, options.upstreamHeaders?.(auth, providerId) ?? {})
    // The buffered body is the exact bytes the client sent, so its length is authoritative.
    headers['content-length'] = String(body.length)

    let status: number | undefined
    let finished = false
    let upstreamRequest: ClientRequest | undefined
    /** The SSE usage reader, once the upstream answered with an event stream; it keeps usage seen before a cut. */
    let sseParser: ReturnType<typeof createSseUsageParser> | undefined
    let headersTimer: NodeJS.Timeout | undefined
    let stallTimer: NodeJS.Timeout | undefined
    const clearTimers = (): void => {
      if (headersTimer) clearTimeout(headersTimer)
      if (stallTimer) clearTimeout(stallTimer)
      headersTimer = undefined
      stallTimer = undefined
    }

    const finalize = (resultStatus: number, usage: Usage | undefined): void => {
      if (finished) return
      finished = true
      clearTimers()
      upstreamRequest?.setTimeout(0)
      let costUsd = 0
      const price = usage ? priceOf(providerId, model) : undefined
      if (usage && price) costUsd = costOf(price, usage)
      try {
        record({
          ticketId: auth.ticketId,
          role: auth.role,
          ...(auth.agent ? { agent: auth.agent } : {}),
          provider: providerId,
          model,
          usage,
          costUsd,
          latencyMs: Date.now() - started,
          status: resultStatus,
          at,
        })
      } catch {
        // A ledger failure must not take the gateway down.
      }
    }

    // A client that goes away aborts the upstream call, so its in-flight tokens are not billed for nothing. Usage the
    // stream already reported is still real spend, so it is recorded even though the response never completes.
    const abortUpstream = (): void => {
      if (finished) return
      upstreamRequest?.destroy()
      finalize(status ?? 499, sseParser?.usage())
    }
    res.on('close', abortUpstream)
    res.on('error', abortUpstream)
    req.on('error', abortUpstream)

    // A stream that only pings is cut as 504 so the agent retries at once instead of waiting on a dead generation.
    const armStall = (): void => {
      if (stallTimeoutMs <= 0 || finished) return
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        if (finished) return
        upstreamRequest?.destroy()
        res.destroy()
        finalize(504, sseParser?.usage())
      }, stallTimeoutMs)
      stallTimer.unref?.()
    }

    const onResponse = (upstreamRes: IncomingMessage): void => {
      if (headersTimer) { clearTimeout(headersTimer); headersTimer = undefined }
      status = upstreamRes.statusCode ?? 502
      res.writeHead(status, responseHeaders(upstreamRes.headers))
      res.flushHeaders()
      const contentType = String(upstreamRes.headers['content-type'] ?? '').toLowerCase()
      if (contentType.includes('text/event-stream')) { sseParser = createSseUsageParser(); armStall() }
      const buffered: Buffer[] = []

      upstreamRes.on('data', (chunk: Buffer) => {
        if (sseParser) { sseParser.push(chunk); if (sseHasContent(chunk)) armStall() }
        else buffered.push(chunk)
        res.write(chunk)
      })
      upstreamRes.on('end', () => {
        sseParser?.flush()
        const usage = sseParser ? sseParser.usage() : extractUsage(Buffer.concat(buffered))
        res.end()
        finalize(status ?? 502, usage)
      })
      upstreamRes.on('error', () => {
        res.destroy()
        finalize(status ?? 502, sseParser?.usage())
      })
    }

    upstreamRequest = url.protocol === 'https:'
      ? httpsRequest(url, { method: req.method, headers }, onResponse)
      : httpRequest(url, { method: req.method, headers }, onResponse)

    // Headers that never come mean a hung upstream; answer 504 early so the agent's own retry can start.
    if (headersTimeoutMs > 0) {
      headersTimer = setTimeout(() => {
        if (finished || res.headersSent) return
        upstreamRequest?.destroy()
        if (!res.destroyed) sendJson(res, 504, { error: { type: 'upstream_timeout', message: 'Upstream sent no response headers in time' } })
        finalize(504, undefined)
      }, headersTimeoutMs)
      headersTimer.unref?.()
    }

    // Covers both waiting for the response headers and an idle stream. A timed-out exchange is recorded as 504.
    if (upstreamTimeoutMs > 0) {
      upstreamRequest.setTimeout(upstreamTimeoutMs, () => {
        if (finished) return
        upstreamRequest?.destroy()
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, 504, { error: { type: 'upstream_timeout', message: 'Upstream timed out' } })
        } else {
          res.destroy()
        }
        finalize(504, sseParser?.usage())
      })
    }

    upstreamRequest.on('error', () => {
      if (finished) return
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 502, { error: { type: 'upstream_error', message: 'Upstream request failed' } })
      } else {
        res.destroy()
      }
      finalize(502, sseParser?.usage())
    })
    upstreamRequest.end(body)
  }

  /** Answer a request that will not be forwarded, and discard its body without buffering it. */
  function reject(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
    sendJson(res, status, body)
    req.on('error', () => {})
    req.resume()
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    const at = new Date(started).toISOString()

    // Authorization comes first: a rejected caller never gets the gateway to buffer its body.
    const token = bearer(req.headers.authorization) || apiKeyHeader(req.headers)
    let auth: Authorization
    try {
      auth = await authorize(token)
    } catch {
      reject(req, res, 401, { error: { type: 'unknown_token', message: 'Token authorization failed' } })
      return
    }
    if ('denied' in auth) {
      if (auth.denied === 'budget') {
        reject(req, res, 402, { error: { type: 'budget_exhausted', message: 'This ticket has used its budget' } })
      } else {
        reject(req, res, 401, { error: { type: 'unknown_token', message: 'Unknown or missing ticket token' } })
      }
      return
    }

    // The provider comes from the path; a malformed path or unknown provider is answered before the body is read.
    const route = providerRoute(req.url)
    const target = route ? options.resolveProvider(route.providerId) : undefined
    if (!route || !target) {
      reject(req, res, 404, { error: { type: 'unknown_provider', message: 'Unknown provider; use /p/<provider>/<path>' } })
      return
    }

    // Read past the limit up to a hard cap, so an image-heavy body can be shrunk instead of refused.
    const read = await readBody(req, Math.max(maxBodyBytes, HARD_BODY_CAP_BYTES))
    if (read.kind === 'aborted') {
      if (!res.headersSent) res.destroy()
      return
    }
    if (read.kind === 'body' && read.body.length > maxBodyBytes) {
      const shrunk = shrinkImages(read.body, maxBodyBytes)
      if (shrunk) {
        console.error(`superagentd: gateway dropped ${shrunk.dropped} older image(s) to fit the body limit (ticket=${auth.ticketId})`)
        read.body = shrunk.body
      }
    }
    if (read.kind === 'too_large' || read.body.length > maxBodyBytes) {
      sendJson(res, 413, { error: { type: 'body_too_large', message: 'Request body is too large' } })
      // Stop reading and close the exchange once the response has been flushed.
      req.pause()
      req.socket.destroySoon()
      return
    }

    if (!target.models.includes(modelOf(read.body))) {
      // A rejected model never reaches upstream, so it is not recorded as a call.
      sendJson(res, 400, { error: { type: 'model_not_allowed', message: 'The requested model is not allowed' } })
      return
    }

    forward(req, res, auth, read.body, started, at, route, target)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: { type: 'gateway_error', message: 'Gateway failure' } })
      else res.destroy()
    })
  })

  return {
    listen() {
      return new Promise<{ port: number }>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(port, host, () => {
          server.off('error', onError)
          const address = server.address()
          resolve({ port: typeof address === 'object' && address !== null ? address.port : port })
        })
      })
    },
    close() {
      return new Promise<void>(resolve => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
