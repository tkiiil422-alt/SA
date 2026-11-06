/**
 * The Feishu (Lark) Source: messages arrive as HTTP event callbacks, and replies go out through the Open API.
 *
 * The pure helpers (`decryptEvent`, `verifySignature`, `parseEvent`) hold the protocol rules. `FeishuSource` adds the
 * callback handler, the tenant token cache, the bot identity lookup, reply delivery and the connection test. Secrets
 * and tokens never appear in errors, events or logs.
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FeishuOptions } from '../admin/options.ts'
import { key } from '../core/ids.ts'
import type { Trigger } from '../core/model.ts'
import type { OutboundMessage, ScopeResult, SourceScope } from '../core/ports.ts'

export const FEISHU_SOURCE = 'feishu'
const MAX_BODY = 1_048_576
const TOKEN_REFRESH_MS = 5 * 60_000
const DEFAULT_TOKEN_SECONDS = 7200
const DEDUPE_LIMIT = 1000
const PLACEHOLDER = /@_user_\d+/g

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Decrypt an event callback body: AES-256-CBC, key = SHA256(encryptKey), IV = the first 16 bytes of the ciphertext. */
export function decryptEvent(encrypt: string, encryptKey: string): string {
  const raw = Buffer.from(encrypt, 'base64')
  if (raw.length <= 16) throw new Error('飞书加密内容无效')
  const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), raw.subarray(0, 16))
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8')
}

/** `X-Lark-Signature` is the hex SHA256 of timestamp + nonce + encryptKey + the raw body. */
export function verifySignature(timestamp: string, nonce: string, encryptKey: string, rawBody: string, signature: string): boolean {
  const expected = Buffer.from(sha256Hex(timestamp + nonce + encryptKey + rawBody))
  const actual = Buffer.from(signature)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function sameToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || expected === '') return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface ParseOptions {
  verificationToken: string
  /** Set when the Feishu app encrypts its events: the body must then be `{ encrypt }`. */
  encryptKey?: string
  groupMode: 'mention' | 'all'
  /** The bot's own open_id, used to tell whether a group message mentions the bot. */
  botOpenId?: string
}

export type ParseResult =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'message'; trigger: Trigger; eventId: string }
  | { kind: 'ignore' }
  | { kind: 'reject'; reason: 'token' | 'malformed' | 'decrypt' }

function postText(content: unknown): string | undefined {
  if (!isObject(content)) return undefined
  const locale = Array.isArray(content.content)
    ? content
    : Object.values(content).find((value): value is Record<string, unknown> => isObject(value) && Array.isArray(value.content))
  if (!locale || !Array.isArray(locale.content)) return undefined
  const lines: string[] = []
  if (typeof locale.title === 'string' && locale.title !== '') lines.push(locale.title)
  for (const paragraph of locale.content) {
    if (!Array.isArray(paragraph)) continue
    lines.push(paragraph.map(segment => {
      if (!isObject(segment) || (segment.tag !== 'text' && segment.tag !== 'a')) return ''
      return typeof segment.text === 'string' ? segment.text : ''
    }).join(''))
  }
  return lines.join('\n')
}

/** The plain text of a message: `@_user_N` placeholders removed; unsupported types get a marker. */
function contentText(type: string, raw: unknown): string {
  const unsupported = `[不支持的消息类型: ${type}]`
  let content: unknown = raw
  if (typeof raw === 'string') {
    try {
      content = JSON.parse(raw)
    } catch {
      return unsupported
    }
  }
  let text: string | undefined
  if (type === 'text' && isObject(content) && typeof content.text === 'string') text = content.text
  else if (type === 'post') text = postText(content)
  if (text === undefined) return unsupported
  return text.replace(PLACEHOLDER, '').trim()
}

/** The token a callback carries: top level for a challenge, in the 2.0 header for an event. */
function payloadToken(payload: Record<string, unknown>): unknown {
  if (typeof payload.token === 'string') return payload.token
  const header = isObject(payload.header) ? payload.header : undefined
  return header?.token
}

/**
 * Decrypt (when `encryptKey` is set) and JSON-parse a callback body into its payload object. The caller can answer a
 * challenge and reject a bad token from this alone, before making any outbound call.
 */
export function decodePayload(body: string, encryptKey: string | undefined):
{ payload?: Record<string, unknown>; reason?: 'malformed' | 'decrypt' } {
  let outer: unknown
  try {
    outer = JSON.parse(body)
  } catch {
    return { reason: 'malformed' }
  }
  if (!isObject(outer)) return { reason: 'malformed' }
  let payload: unknown = outer
  if (typeof outer.encrypt === 'string') {
    // An encrypted body carries its own authenticity: only the holder of the key can produce one we can decrypt.
    if (!encryptKey) return { reason: 'malformed' }
    try {
      payload = JSON.parse(decryptEvent(outer.encrypt, encryptKey))
    } catch {
      return { reason: 'decrypt' }
    }
  }
  // A plain body stays usable even when a key is configured: Feishu sends the challenge and unsigned events in the
  // clear when the app has no encryption enabled, and the verification token still gates the request.
  if (!isObject(payload)) return { reason: 'malformed' }
  return { payload }
}

export interface MessageEventLike {
  sender?: unknown
  message?: unknown
}

/** Why a message event produced no Trigger; kept stable so callers can log the reason without the payload. */
export type MessageEventIgnore =
  | 'missing_message'
  | 'missing_sender'
  | 'missing_open_id'
  | 'missing_ids'
  | 'group_mention_required'

/**
 * The message→Trigger rules shared by the HTTP callback and the long connection: a p2p message is direct; a group
 * message needs a mention of the bot under `mention` mode; text and post content are parsed; the thread is the root
 * message (or the message itself). The event object is the 2.0 `event` payload (with `sender` and `message`).
 */
export function triggerFromMessageEvent(
  event: MessageEventLike,
  opts: { botOpenId?: string; groupMode: 'mention' | 'all' },
): Trigger | { ignored: MessageEventIgnore } {
  const message = isObject(event.message) ? event.message : undefined
  if (!message) return { ignored: 'missing_message' }
  const sender = isObject(event.sender) ? event.sender : undefined
  if (!sender) return { ignored: 'missing_sender' }
  const senderId = isObject(sender.sender_id) ? sender.sender_id : undefined
  const openId = typeof senderId?.open_id === 'string' ? senderId.open_id : ''
  if (openId === '') return { ignored: 'missing_open_id' }
  if (typeof message.message_id !== 'string' || typeof message.chat_id !== 'string') return { ignored: 'missing_ids' }

  const direct = message.chat_type === 'p2p'
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const mentioned = !!opts.botOpenId && mentions.some(item => isObject(item) && isObject(item.id) && item.id.open_id === opts.botOpenId)
  if (!direct && opts.groupMode === 'mention' && !mentioned) return { ignored: 'group_mention_required' }

  const messageId = message.message_id
  const chatId = message.chat_id
  const rootId = typeof message.root_id === 'string' && message.root_id !== '' ? message.root_id : messageId
  const threadId = `${chatId}:${rootId}`
  const createdMs = Number(message.create_time)
  const at = Number.isFinite(createdMs) && createdMs > 0 ? new Date(createdMs).toISOString() : new Date().toISOString()
  const addressed = direct ? 'direct' : mentioned ? 'mention' : undefined
  return {
    id: key('trigger', FEISHU_SOURCE, messageId),
    source: FEISHU_SOURCE,
    threads: [{ source: FEISHU_SOURCE, id: threadId }],
    actor: { source: FEISHU_SOURCE, id: openId },
    human: sender.sender_type === 'user',
    ...(addressed ? { addressed } : {}),
    at,
    text: contentText(String(message.message_type ?? ''), message.content),
    channel: { source: FEISHU_SOURCE, thread: threadId, address: { chatId, messageId } },
    meta: { chatType: direct ? 'p2p' : 'group', chatId, direct },
  }
}

/** Turn a decrypted or plain callback body into the Source's decision: challenge, Trigger, ignore or reject. */
export function parseEvent(body: string, opts: ParseOptions): ParseResult {
  const decoded = decodePayload(body, opts.encryptKey)
  if (!decoded.payload) return { kind: 'reject', reason: decoded.reason ?? 'malformed' }
  const payload = decoded.payload

  if (payload.type === 'url_verification') {
    // Feishu puts the token at the top level for a challenge; keep accepting the 2.0 header form as well.
    if (!sameToken(payloadToken(payload), opts.verificationToken)) return { kind: 'reject', reason: 'token' }
    return { kind: 'challenge', challenge: String(payload.challenge ?? '') }
  }

  const header = isObject(payload.header) ? payload.header : undefined
  if (!header) return { kind: 'reject', reason: 'malformed' }
  if (!sameToken(header.token, opts.verificationToken)) return { kind: 'reject', reason: 'token' }
  if (header.event_type !== 'im.message.receive_v1') return { kind: 'ignore' }

  const event = isObject(payload.event) ? payload.event : undefined
  const result = triggerFromMessageEvent(event ?? {}, {
    ...(opts.botOpenId ? { botOpenId: opts.botOpenId } : {}),
    groupMode: opts.groupMode,
  })
  if ('ignored' in result) return { kind: 'ignore' }
  return { kind: 'message', trigger: result, eventId: typeof header.event_id === 'string' ? header.event_id : '' }
}

export interface FeishuEvent {
  kind: 'feishu.received' | 'feishu.rejected' | 'feishu.send_failed'
  level: 'info' | 'warn'
  text: string
  data?: Record<string, unknown>
}

export interface FeishuSourceOptions {
  /** The current feishu options, read on every use so a console change applies at once. */
  config: () => FeishuOptions
  /** Receives each accepted message; called after the HTTP answer has been sent. */
  onTrigger: (trigger: Trigger) => void
  /** Receives rejections and delivery failures; text and data never carry secrets. */
  onEvent?: (event: FeishuEvent) => void
  fetch?: typeof fetch
  now?: () => number
}

interface Bot { openId: string; name: string }

function readBodyText(req: IncomingMessage): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > MAX_BODY) {
        done = true
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolve(undefined)
    })
  })
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return typeof value === 'string' ? value : ''
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export class FeishuSource implements SourceScope {
  readonly source = FEISHU_SOURCE
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private token?: { key: string; value: string; expiresAt: number }
  private tokenFlight?: Promise<string>
  private bot?: { key: string; value: Bot }
  private readonly seen = new Set<string>()

  constructor(private readonly options: FeishuSourceOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
  }

  /** Listens only while the source is enabled; a group message reaches here only when the parser let it through. */
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    if (input.source !== FEISHU_SOURCE || !this.options.config().enabled) return { listened: false, reason: 'source_disabled' }
    return { listened: true, observed: true, row: input.meta.chatType === 'p2p' ? 'p2p' : 'group' }
  }

  /** The event callback (`POST /feishu/events`). Answers first, then hands the Trigger on. */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cfg = this.options.config()
    if (!cfg.enabled) {
      sendJson(res, 404, { error: 'not_found', message: '没有这个地址。' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed', message: '只接受 POST 请求。' })
      return
    }
    const body = await readBodyText(req)
    if (body === undefined) {
      sendJson(res, 413, { error: 'too_large', message: '请求内容太大（上限 1MB）。' })
      return
    }
    // Feishu signs a callback only when the app has encryption enabled, and the signature covers the raw body. Check it
    // only when the request actually carries one: an unsigned plain body is still gated by the verification token below,
    // and an encrypted body can only be produced with the key itself.
    const timestamp = header(req, 'x-lark-request-timestamp')
    const nonce = header(req, 'x-lark-request-nonce')
    const signature = header(req, 'x-lark-signature')
    const signed = timestamp !== '' && nonce !== '' && signature !== ''
    const encrypted = /"encrypt"\s*:\s*"/.test(body)
    if (signed && cfg.encryptKey && !verifySignature(timestamp, nonce, cfg.encryptKey, body, signature)) {
      // The diagnostics say which side disagrees: an encrypted body means the stored key differs from the app's.
      this.emit({
        kind: 'feishu.rejected', level: 'warn', text: '飞书回调签名不正确',
        data: { reason: 'signature', encrypted, bodyLength: body.length },
      })
      sendJson(res, 401, { error: 'rejected', message: '签名不正确。' })
      return
    }

    // Answer a challenge and reject a bad token before any outbound call: the callback is unauthenticated until this
    // point, so an unknown caller must not make the daemon talk to Feishu, and Feishu's URL check never waits on it.
    const decoded = decodePayload(body, cfg.encryptKey || undefined)
    if (!decoded.payload) {
      this.emit({
        kind: 'feishu.rejected', level: 'warn',
        text: decoded.reason === 'decrypt' ? '飞书回调无法解密，请核对 Encrypt Key' : '飞书回调内容无效',
        data: { reason: decoded.reason, encrypted, signed },
      })
      sendJson(res, 400, { error: 'rejected', message: '回调内容未通过校验。' })
      return
    }
    if (!sameToken(payloadToken(decoded.payload), cfg.verificationToken)) {
      this.emit({ kind: 'feishu.rejected', level: 'warn', text: '飞书回调令牌不正确', data: { reason: 'token' } })
      sendJson(res, 401, { error: 'rejected', message: '回调内容未通过校验。' })
      return
    }
    if (decoded.payload.type === 'url_verification') {
      sendJson(res, 200, { challenge: String(decoded.payload.challenge ?? '') })
      return
    }

    const botOpenId = await this.botOpenId()
    const result = parseEvent(body, {
      verificationToken: cfg.verificationToken,
      ...(cfg.encryptKey ? { encryptKey: cfg.encryptKey } : {}),
      groupMode: cfg.groupMode,
      ...(botOpenId ? { botOpenId } : {}),
    })
    switch (result.kind) {
      case 'challenge':
        sendJson(res, 200, { challenge: result.challenge })
        return
      case 'ignore':
        sendJson(res, 200, {})
        return
      case 'reject':
        this.emit({
          kind: 'feishu.rejected',
          level: 'warn',
          text: result.reason === 'token' ? '飞书回调令牌不正确' : '飞书回调内容无效',
          data: { reason: result.reason },
        })
        sendJson(res, result.reason === 'token' ? 401 : 400, { error: 'rejected', message: '回调内容未通过校验。' })
        return
      case 'message':
        if (result.eventId !== '') {
          if (this.seen.has(result.eventId)) {
            sendJson(res, 200, {})
            return
          }
          this.seen.add(result.eventId)
          if (this.seen.size > DEDUPE_LIMIT) this.seen.delete(this.seen.values().next().value as string)
        }
        sendJson(res, 200, {})
        this.options.onTrigger(result.trigger)
    }
  }

  /** Send a reply for an outbox message. Failures are reported as events and rethrown so the effect retries. */
  async deliver(message: OutboundMessage): Promise<void> {
    const cfg = this.options.config()
    if (!cfg.enabled) throw new Error('飞书来源未启用')
    const messageId = message.channel.address.messageId
    if (!messageId) throw new Error('飞书消息缺少要回复的 messageId')
    try {
      const token = await this.tenantToken(cfg)
      await this.request(cfg, `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, 'POST', {
        msg_type: 'text',
        content: JSON.stringify({ text: message.text }),
        uuid: message.id.slice(0, 50),
      }, token)
    } catch (error) {
      this.token = undefined
      this.emit({ kind: 'feishu.send_failed', level: 'warn', text: '飞书回复发送失败，将稍后重试', data: { error: describe(error) } })
      throw error
    }
  }

  /** Check the credentials by fetching the bot identity. Never throws; the message says what failed. */
  async test(): Promise<{ ok: boolean; message: string; botName?: string }> {
    const cfg = this.options.config()
    if (!cfg.appId || !cfg.appSecret) return { ok: false, message: '请先填写 App ID 和 App Secret。' }
    try {
      const bot = await this.botInfo(cfg)
      return { ok: true, message: '连接正常，已取得机器人信息。', ...(bot.name ? { botName: bot.name } : {}) }
    } catch (error) {
      return { ok: false, message: describe(error) }
    }
  }

  private emit(event: FeishuEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch {
      // Logging must never break the callback or the delivery.
    }
  }

  /** The bot's own open_id, cached per credential. Used for group mention matching by both transports. */
  async botOpenId(): Promise<string | undefined> {
    try {
      return (await this.botInfo(this.options.config())).openId
    } catch {
      return undefined
    }
  }

  private async botInfo(cfg: FeishuOptions): Promise<Bot> {
    const identity = credentialKey(cfg)
    if (this.bot?.key === identity) return this.bot.value
    const token = await this.tenantToken(cfg)
    const body = await this.request(cfg, '/open-apis/bot/v3/info', 'GET', undefined, token)
    const bot = isObject(body.bot) ? body.bot : {}
    const openId = typeof bot.open_id === 'string' ? bot.open_id : ''
    if (openId === '') throw new Error('飞书没有返回机器人信息')
    const value: Bot = { openId, name: typeof bot.app_name === 'string' ? bot.app_name : '' }
    this.bot = { key: identity, value }
    return value
  }

  private async tenantToken(cfg: FeishuOptions): Promise<string> {
    const identity = credentialKey(cfg)
    if (this.token && this.token.key === identity && this.now() < this.token.expiresAt - TOKEN_REFRESH_MS) return this.token.value
    this.tokenFlight ??= this.fetchToken(cfg).finally(() => {
      this.tokenFlight = undefined
    })
    return this.tokenFlight
  }

  private async fetchToken(cfg: FeishuOptions): Promise<string> {
    const body = await this.request(cfg, '/open-apis/auth/v3/tenant_access_token/internal', 'POST', {
      app_id: cfg.appId,
      app_secret: cfg.appSecret,
    })
    const value = body.tenant_access_token
    if (typeof value !== 'string' || value === '') throw new Error('飞书没有返回访问令牌')
    const seconds = typeof body.expire === 'number' ? body.expire : DEFAULT_TOKEN_SECONDS
    this.token = { key: credentialKey(cfg), value, expiresAt: this.now() + seconds * 1000 }
    return value
  }

  /** One Open API call. Errors name the HTTP status and Feishu's code only, never the request or its credentials. */
  private async request(
    cfg: FeishuOptions,
    path: string,
    method: 'GET' | 'POST',
    payload: unknown,
    token?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
    if (token) headers.authorization = `Bearer ${token}`
    let response: Response
    try {
      response = await this.doFetch(`${cfg.apiBase.replace(/\/+$/, '')}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      })
    } catch {
      throw new Error('连不上飞书接口，请检查网络或接口地址。')
    }
    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new Error(`飞书接口返回了无法解析的内容（HTTP ${response.status}）`)
    }
    const body = isObject(data) ? data : {}
    if (!response.ok || body.code !== 0) {
      throw new Error(`飞书接口调用失败（HTTP ${response.status}，错误码 ${String(body.code ?? 'unknown')}）`)
    }
    return body
  }
}

/** Identifies the app a cached token or bot identity belongs to, so a changed credential never reuses it. */
function credentialKey(cfg: FeishuOptions): string {
  return sha256Hex(`${cfg.apiBase}\n${cfg.appId}\n${cfg.appSecret}`)
}
