/**
 * WeChat as a bidirectional Source & Outbox channel.
 *
 * Supports four modes so an operator can link their personal or team WeChat without fragile unofficial hacks:
 *   1. `ilink` (recommended for personal WeChat): Official WeChat Personal Bot ("微信插件" / ClawBot) via Tencent's
 *      iLink protocol — scan a QR code directly with personal WeChat, outbound long-polling, zero public IP needed.
 *   2. `wecom`: WeCom self-built app. Enabling WeCom's built-in "微信插件" lets team members chat inside personal WeChat.
 *   3. `mp`: WeChat Official Account / Service Account (plaintext or AES-encrypted XML callback + customer service API).
 *   4. `webhook`: Group bot / push channel (WeCom bot, ServerChan, PushPlus) and/or custom JSON HTTP bridge.
 *
 * Secrets (`corpSecret`, `appSecret`, `callbackToken`, `encodingAesKey`, `webhookUrl`, `bridgeToken`, `botToken`) are never
 * logged, echoed in errors, or placed inside Triggers.
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WechatOptions } from '../admin/options.ts'
import { key } from '../core/ids.ts'
import type { Trigger } from '../core/model.ts'
import type { OutboundMessage, ScopeResult, SourceScope } from '../core/ports.ts'
import {
  WechatIlinkBridge,
  type WechatIlinkPublicSession,
  type WechatIlinkStore,
  type WechatQrStatusView,
} from './wechat-ilink.ts'

export const WECHAT_SOURCE = 'wechat'

export interface WechatEvent {
  kind: 'wechat.received' | 'wechat.ignored' | 'wechat.sent' | 'wechat.failed' | 'wechat.connected'
  level: 'info' | 'warn'
  text: string
  data?: Record<string, unknown>
}

export interface WechatStatus {
  state: 'off' | 'connecting' | 'connected' | 'ready' | 'error'
  mode: WechatOptions['mode']
  lastEventAt?: string
  lastError?: string
  received: number
  sent: number
  ilink?: WechatIlinkPublicSession
  qr?: WechatQrStatusView
}

export interface WechatTestResult {
  ok: boolean
  message: string
  detail?: string
}

export interface WechatSourceOptions {
  config: () => WechatOptions
  onTrigger: (trigger: Trigger) => void
  onEvent?: (event: WechatEvent) => void
  ilinkStore?: WechatIlinkStore
  onIlinkConnected?: (info: { accountId: string; userId: string; baseUrl: string }) => void
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

const MAX_CALLBACK_BODY = 512 * 1024

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Official WeChat / WeCom SHA-1 signature over sorted `[token, timestamp, nonce, encrypt?]`. */
export function wechatSignature(parts: readonly string[]): string {
  const joined = [...parts].sort().join('')
  return createHash('sha1').update(joined).digest('hex')
}

/**
 * Decrypt an official WeChat / WeCom AES-256-CBC payload.
 * Layout after PKCS#7 unpadding: 16 random bytes | 4-byte big-endian msg length | UTF-8 msg | receiveId (corpId/appId).
 */
export function decryptWechatPayload(encodingAesKey: string, encryptedBase64: string, expectedReceiveId?: string): string {
  const trimmedKey = encodingAesKey.trim()
  if (trimmedKey.length !== 43) throw new Error('EncodingAESKey 必须是 43 位字符')
  const aesKey = Buffer.from(`${trimmedKey}=`, 'base64')
  if (aesKey.length !== 32) throw new Error('EncodingAESKey 解码长度无效')
  const iv = aesKey.subarray(0, 16)
  const cipher = Buffer.from(encryptedBase64.trim(), 'base64')
  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv)
  decipher.setAutoPadding(false)
  const raw = Buffer.concat([decipher.update(cipher), decipher.final()])
  if (raw.length < 21) throw new Error('密文内容过短')
  const pad = raw[raw.length - 1]!
  if (pad < 1 || pad > 32 || pad > raw.length) throw new Error('PKCS#7 填充无效')
  for (let i = raw.length - pad; i < raw.length; i += 1) {
    if (raw[i] !== pad) throw new Error('PKCS#7 填充字节校验失败')
  }
  const unpadded = raw.subarray(0, raw.length - pad)
  if (unpadded.length < 20) throw new Error('解密后消息长度无效')
  const msgLen = unpadded.readUInt32BE(16)
  if (20 + msgLen > unpadded.length) throw new Error('解密后消息长度越界')
  const msg = unpadded.subarray(20, 20 + msgLen).toString('utf8')
  const receiveId = unpadded.subarray(20 + msgLen).toString('utf8')
  if (expectedReceiveId && expectedReceiveId.trim() !== '' && receiveId !== expectedReceiveId.trim()) {
    throw new Error('回调 ReceiveId 与配置不匹配')
  }
  return msg
}

/** Extract a tag value from WeChat XML (handles both CDATA and plain element text). */
export function xmlTag(xml: string, tag: string): string {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(xml)
  if (cdata) return cdata[1] ?? ''
  const plain = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, 'i').exec(xml)
  return plain ? (plain[1] ?? '').trim() : ''
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_CALLBACK_BODY) {
        reject(new Error('回调请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function textResponse(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/** Split long text into chunks under maxChars for WeChat message limits. */
function chunkText(text: string, maxChars = 1800): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.5) cut = maxChars
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

interface TokenCache {
  key: string
  token: string
  expiresAt: number
}

export class WechatSource implements SourceScope {
  readonly source = WECHAT_SOURCE
  private readonly doFetch: typeof globalThis.fetch
  private readonly doNow: () => Date
  private readonly ilink: WechatIlinkBridge
  private tokenCache?: TokenCache
  private state: { lastEventAt?: string; lastError?: string; received: number; sent: number } = { received: 0, sent: 0 }

  constructor(private readonly options: WechatSourceOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.doNow = options.now ?? (() => new Date())
    this.ilink = new WechatIlinkBridge({
      ...(options.ilinkStore ? { store: options.ilinkStore } : {}),
      enabled: () => {
        const cfg = this.options.config()
        return cfg.enabled && cfg.mode === 'ilink'
      },
      relay: () => {
        const cfg = this.options.config()
        return cfg.ilinkRelayUrl ? { url: cfg.ilinkRelayUrl, token: cfg.ilinkRelayToken } : undefined
      },
      onInbound: msg => {
        this.dispatchInbound(this.options.config(), msg)
      },
      onConnected: info => {
        this.state.lastError = undefined
        this.state.lastEventAt = this.doNow().toISOString()
        this.emit({
          kind: 'wechat.connected',
          level: 'info',
          text: `已扫码连接个人微信插件（${info.userId || info.accountId}）`,
          data: { accountId: info.accountId, ...(info.userId ? { userId: info.userId } : {}) },
        })
        this.options.onIlinkConnected?.(info)
      },
      onError: text => {
        this.recordError(this.options.config(), text)
      },
      onRecovered: () => {
        this.state.lastError = undefined
      },
      fetch: this.doFetch,
      now: this.doNow,
    })
  }

  start(): void {
    const cfg = this.options.config()
    if (cfg.enabled && cfg.mode === 'ilink') this.ilink.start()
    else this.ilink.stop()
  }

  stop(): void {
    this.ilink.cancelQrPoll()
    this.ilink.stop()
  }

  async restart(): Promise<void> {
    const cfg = this.options.config()
    if (cfg.enabled && cfg.mode === 'ilink') await this.ilink.restart()
    else this.ilink.stop()
  }

  startQrLogin(input: { force?: boolean } = {}): Promise<WechatQrStatusView> {
    return this.ilink.startQrLogin(input)
  }

  qrStatus(): WechatQrStatusView {
    return this.ilink.qrStatus()
  }

  submitQrVerifyCode(code: string): WechatQrStatusView {
    return this.ilink.submitVerifyCode(code)
  }

  async logoutIlink(): Promise<void> {
    await this.ilink.logout()
  }

  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    if (input.source !== WECHAT_SOURCE || !this.options.config().enabled) {
      return { listened: false, reason: 'source_disabled' }
    }
    return { listened: true, observed: false }
  }

  status(): WechatStatus {
    const cfg = this.options.config()
    if (cfg.mode === 'ilink') {
      const ilink = this.ilink.sessionInfo()
      const qr = this.ilink.qrStatus()
      let state: WechatStatus['state']
      if (!cfg.enabled) state = 'off'
      else if (!ilink.bound) state = 'connecting'
      else if (ilink.pausedMinutes || this.state.lastError) state = 'error'
      else if (this.ilink.isRunning()) state = 'connected'
      else if (this.ilink.isConnecting()) state = 'connecting'
      else state = 'ready'
      return {
        state,
        mode: cfg.mode,
        ...(this.state.lastEventAt ? { lastEventAt: this.state.lastEventAt } : {}),
        ...(this.state.lastError ? { lastError: this.state.lastError } : {}),
        received: this.state.received,
        sent: this.state.sent,
        ilink,
        qr,
      }
    }
    const state: WechatStatus['state'] = !cfg.enabled ? 'off' : this.state.lastError ? 'error' : 'ready'
    return {
      state,
      mode: cfg.mode,
      ...(this.state.lastEventAt ? { lastEventAt: this.state.lastEventAt } : {}),
      ...(this.state.lastError ? { lastError: this.state.lastError } : {}),
      received: this.state.received,
      sent: this.state.sent,
    }
  }

  /** Handle GET (URL verification) and POST (inbound messages) on `/wechat/events`. */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cfg = this.options.config()
    if (!cfg.enabled) {
      textResponse(res, 503, 'wechat disabled')
      return
    }
    if (cfg.mode === 'ilink') {
      jsonResponse(res, 200, { ok: true, mode: 'ilink', message: '个人微信插件模式通过官方 iLink 长轮询直连，无需配置回调地址。' })
      return
    }
    const url = new URL(req.url ?? '/wechat/events', 'http://wechat.invalid')
    const method = (req.method ?? 'GET').toUpperCase()

    // Webhook / custom bridge JSON inbound path: always require a configured shared token.
    if (cfg.mode === 'webhook') {
      if (method !== 'POST') {
        jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      const expectedToken = (cfg.bridgeToken || cfg.callbackToken).trim()
      if (!expectedToken) {
        jsonResponse(res, 401, { ok: false, error: 'callback_token_not_configured' })
        return
      }
      const auth = String(req.headers.authorization ?? '')
      const headerToken = String(req.headers['x-wechat-token'] ?? '')
      const provided = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? headerToken.trim()
      if (!provided || !safeEqual(expectedToken, provided)) {
        jsonResponse(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      let raw: string
      try {
        raw = await readRequestBody(req)
      } catch (error) {
        jsonResponse(res, 400, { ok: false, error: describe(error) })
        return
      }
      let data: Record<string, unknown>
      try {
        data = JSON.parse(raw) as Record<string, unknown>
      } catch {
        jsonResponse(res, 400, { ok: false, error: 'invalid_json' })
        return
      }
      const from = String(data.from ?? data.userId ?? data.sender ?? '').trim()
      const text = String(data.text ?? data.content ?? '').trim()
      const chatId = String(data.chatId ?? from).trim()
      const messageId = String(data.messageId ?? data.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).trim()
      if (!from || !text) {
        jsonResponse(res, 400, { ok: false, error: 'missing from or text' })
        return
      }
      const accepted = this.dispatchInbound(cfg, { from, chatId, messageId, text })
      jsonResponse(res, 200, { ok: true, accepted })
      return
    }

    // Official WeCom & Official Account (MP) GET URL verification.
    const timestamp = url.searchParams.get('timestamp') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''
    const msgSignature = url.searchParams.get('msg_signature') ?? ''
    const signature = url.searchParams.get('signature') ?? ''
    const echostr = url.searchParams.get('echostr') ?? ''

    if (method === 'GET') {
      if (!cfg.callbackToken) {
        textResponse(res, 400, 'callbackToken not configured')
        return
      }
      if (msgSignature && cfg.encodingAesKey) {
        const expected = wechatSignature([cfg.callbackToken, timestamp, nonce, echostr])
        if (!safeEqual(expected, msgSignature)) {
          textResponse(res, 403, 'invalid signature')
          return
        }
        try {
          const receiveId = cfg.mode === 'wecom' ? cfg.corpId : cfg.appId
          const plain = decryptWechatPayload(cfg.encodingAesKey, echostr, receiveId)
          textResponse(res, 200, plain)
        } catch (error) {
          textResponse(res, 400, `decrypt failed: ${this.scrub(describe(error), cfg)}`)
        }
        return
      }
      const expected = wechatSignature([cfg.callbackToken, timestamp, nonce])
      if (!signature || !safeEqual(expected, signature)) {
        textResponse(res, 403, 'invalid signature')
        return
      }
      textResponse(res, 200, echostr)
      return
    }

    if (method !== 'POST') {
      textResponse(res, 405, 'method not allowed')
      return
    }

    if (!cfg.callbackToken) {
      textResponse(res, 403, 'callbackToken not configured')
      return
    }

    let body: string
    try {
      body = await readRequestBody(req)
    } catch (error) {
      textResponse(res, 400, describe(error))
      return
    }

    let xml = body
    const encrypted = xmlTag(body, 'Encrypt')
    if (encrypted) {
      if (!cfg.encodingAesKey) {
        textResponse(res, 400, 'callback encryption not configured')
        return
      }
      const expected = wechatSignature([cfg.callbackToken, timestamp, nonce, encrypted])
      if (!msgSignature || !safeEqual(expected, msgSignature)) {
        textResponse(res, 403, 'invalid signature')
        return
      }
      try {
        const receiveId = cfg.mode === 'wecom' ? cfg.corpId : cfg.appId
        xml = decryptWechatPayload(cfg.encodingAesKey, encrypted, receiveId)
      } catch (error) {
        this.recordError(cfg, `微信消息解密失败：${describe(error)}`)
        textResponse(res, 400, 'decrypt failed')
        return
      }
    } else if (cfg.mode === 'wecom' && cfg.encodingAesKey) {
      textResponse(res, 403, 'encrypted payload required')
      return
    } else {
      const expected = wechatSignature([cfg.callbackToken, timestamp, nonce])
      if (!signature || !safeEqual(expected, signature)) {
        textResponse(res, 403, 'invalid signature')
        return
      }
    }

    const msgType = xmlTag(xml, 'MsgType').toLowerCase()
    const from = xmlTag(xml, 'FromUserName').trim()
    const msgId = xmlTag(xml, 'MsgId').trim() || `${xmlTag(xml, 'CreateTime')}-${from}`
    const content = xmlTag(xml, 'Content').trim()

    if (msgType === 'text' && from && content) {
      this.dispatchInbound(cfg, { from, chatId: from, messageId: msgId, text: content })
    }
    textResponse(res, 200, 'success')
  }

  /** Best-effort "typing..." indicator (1 = typing, 2 = cancel) for personal WeChat iLink mode. */
  async sendTyping(to?: string, status: 1 | 2 = 1): Promise<void> {
    const cfg = this.options.config()
    if (!cfg.enabled || cfg.mode !== 'ilink') return
    await this.ilink.sendTyping(to || cfg.allowedUsers[0], status)
  }

  /** Deliver an outbox reply back to the originating WeChat user/chat. */
  async deliver(message: OutboundMessage): Promise<void> {
    const cfg = this.options.config()
    if (!cfg.enabled) throw new Error('微信来源未启用')
    const to = (message.channel.address.from ?? message.channel.address.chatId ?? '').trim()
    await this.sendNew({ to: to || undefined, text: message.text, ticketId: message.ticketId })
  }

  /** Send a proactive message or notification to WeChat. */
  async sendNew(input: { to?: string; title?: string; text: string; ticketId?: string }): Promise<void> {
    const cfg = this.options.config()
    if (!cfg.enabled) throw new Error('微信连接未启用，请先在「连接 → 微信」中开启。')
    const text = input.title ? `${input.title}\n\n${input.text}` : input.text
    try {
      let ilinkResult: { messageIds: string[]; missingMessageId: boolean } | undefined
      if (cfg.mode === 'ilink') {
        ilinkResult = await this.ilink.sendText(input.to || cfg.allowedUsers[0], text)
      } else if (cfg.mode === 'wecom') {
        await this.sendWecom(cfg, input.to || cfg.allowedUsers[0] || '@all', text)
      } else if (cfg.mode === 'mp') {
        const target = input.to || cfg.allowedUsers[0]
        if (!target) throw new Error('公众号发消息需要目标用户的 OpenID（请填写允许的用户或在回复对话中使用）。')
        await this.sendMp(cfg, target, text)
      } else {
        await this.sendWebhookOrBridge(cfg, input.to, input.title, input.text)
      }
      this.state.sent += 1
      this.state.lastEventAt = this.doNow().toISOString()
      this.state.lastError = undefined
      if (ilinkResult?.missingMessageId) {
        this.emit({
          kind: 'wechat.sent',
          level: 'warn',
          text: `微信接口返回成功但未分配 message_id（疑似被腾讯 iLink 后端静默丢弃，微信端可能未收到）${input.to ? `：${input.to}` : ''}`,
          data: { mode: cfg.mode, ticketId: input.ticketId ?? '', silentDropSuspected: true },
        })
      } else {
        this.emit({
          kind: 'wechat.sent',
          level: 'info',
          text: `已发送微信消息${input.to ? `给 ${input.to}` : ''}`,
          data: {
            mode: cfg.mode,
            ticketId: input.ticketId ?? '',
            ...(ilinkResult?.messageIds.length ? { serverMessageId: ilinkResult.messageIds.at(-1) } : {}),
          },
        })
      }
    } catch (error) {
      const msg = this.scrub(describe(error), cfg)
      this.recordError(cfg, `微信发送失败：${msg}`)
      throw new Error(`微信发送失败：${msg}`)
    }
  }

  /** Verify credentials and connectivity without leaking any secrets. */
  async test(): Promise<WechatTestResult> {
    const cfg = this.options.config()
    try {
      if (cfg.mode === 'ilink') {
        const res = await this.ilink.test()
        if (res.ok) this.state.lastError = undefined
        return res
      }
      if (cfg.mode === 'wecom') {
        if (!cfg.corpId || !cfg.agentId || !cfg.corpSecret) {
          return { ok: false, message: '请先填写企业微信 Corp ID、Agent ID 和应用 Secret。' }
        }
        const token = await this.fetchWecomToken(cfg, true)
        const base = (cfg.apiBase || 'https://qyapi.weixin.qq.com').replace(/\/+$/, '')
        const res = await this.doFetch(`${base}/cgi-bin/agent/get?access_token=${encodeURIComponent(token)}&agentid=${encodeURIComponent(cfg.agentId)}`)
        const data = await res.json() as { errcode?: number; errmsg?: string; name?: string }
        if (data.errcode && data.errcode !== 0) {
          return { ok: false, message: `企业微信校验失败（${data.errcode}）：${this.scrub(data.errmsg ?? '未知错误', cfg)}` }
        }
        this.state.lastError = undefined
        return { ok: true, message: `企业微信连接正常${data.name ? `（应用：${data.name}）` : ''}，可在个人微信插件中直接收发消息。` }
      }
      if (cfg.mode === 'mp') {
        if (!cfg.appId || !cfg.appSecret) {
          return { ok: false, message: '请先填写公众号 AppID 和 AppSecret。' }
        }
        await this.fetchMpToken(cfg, true)
        this.state.lastError = undefined
        return { ok: true, message: '微信公众号接口凭据验证成功。' }
      }
      if (!cfg.webhookUrl && !cfg.bridgeUrl) {
        return { ok: false, message: '请填写微信推送 Webhook 地址或自定义桥接地址。' }
      }
      await this.sendWebhookOrBridge(cfg, cfg.allowedUsers[0], 'SuperAgent 连通性测试', '微信通道测试成功，可正常接收任务结果与安全告警。')
      this.state.lastError = undefined
      return { ok: true, message: '测试消息已发送，请检查微信是否收到。' }
    } catch (error) {
      const msg = this.scrub(describe(error), cfg)
      this.state.lastError = msg
      return { ok: false, message: `微信测试失败：${msg}` }
    }
  }

  private dispatchInbound(cfg: WechatOptions, msg: { from: string; chatId: string; messageId: string; text: string }): boolean {
    if (cfg.allowedUsers.length > 0 && !cfg.allowedUsers.includes(msg.from)) {
      this.emit({
        kind: 'wechat.ignored',
        level: 'info',
        text: `微信用户 ${msg.from} 不在允许名单里，已忽略`,
        data: { from: msg.from },
      })
      return false
    }
    const threadId = `${cfg.mode}:${msg.chatId}`
    const trigger: Trigger = {
      id: key('trigger', WECHAT_SOURCE, msg.messageId),
      source: WECHAT_SOURCE,
      threads: [{ source: WECHAT_SOURCE, id: threadId }],
      actor: { source: WECHAT_SOURCE, id: msg.from },
      human: true,
      addressed: 'direct',
      at: this.doNow().toISOString(),
      text: msg.text,
      channel: {
        source: WECHAT_SOURCE,
        thread: threadId,
        address: { from: msg.from, chatId: msg.chatId, messageId: msg.messageId },
      },
      meta: { direct: true, mode: cfg.mode },
    }
    this.state.received += 1
    this.state.lastEventAt = trigger.at
    this.state.lastError = undefined
    this.options.onTrigger(trigger)
    return true
  }

  private async timedFetch(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this.doFetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchWecomToken(cfg: WechatOptions, force = false): Promise<string> {
    const cacheKey = `wecom:${cfg.corpId}:${cfg.agentId}:${cfg.corpSecret}`
    const nowMs = this.doNow().getTime()
    if (!force && this.tokenCache && this.tokenCache.key === cacheKey && this.tokenCache.expiresAt > nowMs + 60_000) {
      return this.tokenCache.token
    }
    const base = (cfg.apiBase || 'https://qyapi.weixin.qq.com').replace(/\/+$/, '')
    const res = await this.timedFetch(`${base}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.corpSecret)}`)
    const data = await res.json() as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number }
    if (!res.ok || (data.errcode && data.errcode !== 0) || !data.access_token) {
      throw new Error(`获取企业微信 access_token 失败：${data.errmsg ?? `HTTP ${res.status}`}`)
    }
    this.tokenCache = { key: cacheKey, token: data.access_token, expiresAt: nowMs + (data.expires_in ?? 7200) * 1000 }
    return data.access_token
  }

  private async fetchMpToken(cfg: WechatOptions, force = false): Promise<string> {
    const cacheKey = `mp:${cfg.appId}:${cfg.appSecret}`
    const nowMs = this.doNow().getTime()
    if (!force && this.tokenCache && this.tokenCache.key === cacheKey && this.tokenCache.expiresAt > nowMs + 60_000) {
      return this.tokenCache.token
    }
    const base = (cfg.apiBase && !cfg.apiBase.includes('qyapi.') ? cfg.apiBase : 'https://api.weixin.qq.com').replace(/\/+$/, '')
    const res = await this.timedFetch(`${base}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appId)}&secret=${encodeURIComponent(cfg.appSecret)}`)
    const data = await res.json() as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number }
    if (!res.ok || (data.errcode && data.errcode !== 0) || !data.access_token) {
      throw new Error(`获取公众号 access_token 失败：${data.errmsg ?? `HTTP ${res.status}`}`)
    }
    this.tokenCache = { key: cacheKey, token: data.access_token, expiresAt: nowMs + (data.expires_in ?? 7200) * 1000 }
    return data.access_token
  }

  private async sendWecom(cfg: WechatOptions, touser: string, text: string): Promise<void> {
    let token = await this.fetchWecomToken(cfg)
    const base = (cfg.apiBase || 'https://qyapi.weixin.qq.com').replace(/\/+$/, '')
    const agentid = Number(cfg.agentId)
    for (const part of chunkText(text, 1800)) {
      const postChunk = async (tok: string): Promise<{ ok: boolean; status: number; data: { errcode?: number; errmsg?: string } }> => {
        const res = await this.timedFetch(`${base}/cgi-bin/message/send?access_token=${encodeURIComponent(tok)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            touser,
            msgtype: 'text',
            agentid: Number.isFinite(agentid) && agentid > 0 ? agentid : cfg.agentId,
            text: { content: part },
          }),
        })
        const data = await res.json() as { errcode?: number; errmsg?: string }
        return { ok: res.ok, status: res.status, data }
      }
      let result = await postChunk(token)
      if (result.data.errcode === 40001 || result.data.errcode === 40014 || result.data.errcode === 42001) {
        this.tokenCache = undefined
        token = await this.fetchWecomToken(cfg, true)
        result = await postChunk(token)
      }
      if (!result.ok || (result.data.errcode && result.data.errcode !== 0)) {
        throw new Error(`企业微信发送接口返回错误（${result.data.errcode ?? result.status}）：${result.data.errmsg ?? '未知错误'}`)
      }
    }
  }

  private async sendMp(cfg: WechatOptions, touser: string, text: string): Promise<void> {
    let token = await this.fetchMpToken(cfg)
    const base = (cfg.apiBase && !cfg.apiBase.includes('qyapi.') ? cfg.apiBase : 'https://api.weixin.qq.com').replace(/\/+$/, '')
    for (const part of chunkText(text, 1800)) {
      const postChunk = async (tok: string): Promise<{ ok: boolean; status: number; data: { errcode?: number; errmsg?: string } }> => {
        const res = await this.timedFetch(`${base}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(tok)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ touser, msgtype: 'text', text: { content: part } }),
        })
        const data = await res.json() as { errcode?: number; errmsg?: string }
        return { ok: res.ok, status: res.status, data }
      }
      let result = await postChunk(token)
      if (result.data.errcode === 40001 || result.data.errcode === 40014 || result.data.errcode === 42001) {
        this.tokenCache = undefined
        token = await this.fetchMpToken(cfg, true)
        result = await postChunk(token)
      }
      if (!result.ok || (result.data.errcode && result.data.errcode !== 0)) {
        throw new Error(`公众号发送接口返回错误（${result.data.errcode ?? result.status}）：${result.data.errmsg ?? '未知错误'}`)
      }
    }
  }

  private async sendWebhookOrBridge(cfg: WechatOptions, to: string | undefined, title: string | undefined, text: string): Promise<void> {
    if (cfg.bridgeUrl) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cfg.bridgeToken) headers.authorization = `Bearer ${cfg.bridgeToken}`
      const res = await this.timedFetch(cfg.bridgeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: to ?? '', title: title ?? '', text }),
      })
      if (!res.ok) throw new Error(`微信桥接返回 HTTP ${res.status}`)
      return
    }
    if (!cfg.webhookUrl) throw new Error('未配置微信 Webhook 地址')
    const url = cfg.webhookUrl.trim()
    let payload: unknown
    const isWecomWebhook = /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send/i.test(url)
    if (isWecomWebhook) {
      let md = title ? `### ${title}\n${text}` : text
      // WeCom group bot markdown enforces a strict 4096 UTF-8 byte ceiling.
      if (Buffer.byteLength(md, 'utf8') > 3950) {
        while (Buffer.byteLength(md, 'utf8') > 3920 && md.length > 0) md = md.slice(0, Math.floor(md.length * 0.9))
        md += '\n…（内容已截断）'
      }
      payload = { msgtype: 'markdown', markdown: { content: md } }
    } else if (/sctapi\.ftqq\.com/i.test(url)) {
      payload = { title: title || 'SuperAgent 通知', desp: text }
    } else if (/pushplus\.plus/i.test(url)) {
      payload = { title: title || 'SuperAgent 通知', content: text, template: 'markdown' }
    } else {
      payload = { title: title ?? 'SuperAgent', text, to: to ?? '' }
    }
    const res = await this.timedFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`Webhook 返回 HTTP ${res.status}`)
    if (isWecomWebhook) {
      try {
        const data = await res.json() as { errcode?: number; errmsg?: string }
        if (typeof data.errcode === 'number' && data.errcode !== 0) {
          throw new Error(`企微群机器人返回错误（${data.errcode}）：${data.errmsg ?? '未知错误'}`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('企微群机器人返回错误')) throw error
      }
    }
  }

  private recordError(cfg: WechatOptions, text: string): void {
    const clean = this.scrub(text, cfg)
    this.state.lastError = clean
    this.emit({ kind: 'wechat.failed', level: 'warn', text: clean })
  }

  private scrub(text: string, cfg: WechatOptions): string {
    let out = text
    for (const secret of [cfg.corpSecret, cfg.appSecret, cfg.callbackToken, cfg.encodingAesKey, cfg.webhookUrl, cfg.bridgeToken, cfg.ilinkRelayToken]) {
      if (secret && secret.length > 0) out = out.split(secret).join('***')
    }
    return out
  }

  private emit(event: WechatEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch {
      // Logging must never break callback handling or message delivery.
    }
  }
}
