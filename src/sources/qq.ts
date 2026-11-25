/**
 * QQ 官方开放平台机器人（q.qq.com API v2）渠道：
 * - 零新增依赖：原生 `fetch` 换取 `access_token`、`node:crypto` Ed25519 验签与地址校验（`op=13`）、原生 `WebSocket` 长连接
 * - 同时支持 WebSocket 长连接与 HTTP Webhook（`POST /qq/events`）双接入方式
 * - 支持主动 / 被动消息发送（自动维护 5 分钟内最新被动 `msg_id` 与递增 `msg_seq`）
 * - 支持发送 QQ 原生 Keyboard 可点击按钮 / Markdown；若网关返回未开通高阶权限错误（如 304057 / 50040 / not allowed），自动降级重发 QQ 优化排版纯文本，绝不丢消息
 * - 凭据安全：所有状态与错误文本均严格脱敏，绝不泄露 `appSecret` 或 `access_token`
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  decodeQqAction,
  formatTextForQq,
  splitForQq,
  type QqInteractionAction,
  type QqKeyboard,
  type QqMarkdown,
} from './qq-cards.ts'

export const QQ_SOURCE = 'qq'
const DEFAULT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const DEFAULT_PROD_API = 'https://api.sgroup.qq.com'
const DEFAULT_SANDBOX_API = 'https://sandbox.api.sgroup.qq.com'
const MAX_BODY_BYTES = 1024 * 1024
const PASSIVE_MSG_TTL_MS = 4 * 60_000 + 30_000
const RICH_FALLBACK_COOLDOWN_MS = 10 * 60_000

/** PKCS#8 Ed25519 私钥 DER 前缀（16 字节 + 32 字节 seed = 48 字节）。 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface QqConfig {
  enabled: boolean
  mode: 'ws' | 'webhook'
  appId: string
  appSecret: string
  sandbox: boolean
  apiBase: string
  groupMode: 'mention' | 'all'
  allowedUsers: string[]
  routingMode: 'director' | 'direct'
  interactiveButtons: boolean
  markdownTemplateId: string
  keyboardTemplateId: string
}

export interface QqStatus {
  state: 'off' | 'connecting' | 'connected' | 'error'
  mode: 'ws' | 'webhook'
  since?: string
  lastEventAt?: string
  lastError?: string
  received: number
  sent: number
  richDisabled?: boolean
}

export interface QqEvent {
  kind: 'qq.ws' | 'qq.webhook' | 'qq.send' | 'qq.fallback'
  level: 'info' | 'warn'
  text: string
  data?: Record<string, unknown>
}

export interface QqInboundMessage {
  chatType: 'c2c' | 'group'
  from: string
  chatId: string
  messageId: string
  text: string
  at: string
}

export interface QqInteractionEvent {
  interactionId: string
  operatorId: string
  chatId: string
  chatType: 'c2c' | 'group'
  messageId?: string
  rawTag: string
  action?: QqInteractionAction
}

export interface QqInteractionResponse {
  code?: 0 | 1 | 2 | 3 | 4
  replyText?: string
  keyboard?: QqKeyboard
  markdown?: QqMarkdown
}

export interface QqWsLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (ev: any) => void): void
}

export interface QqSourceOptions {
  config: () => QqConfig
  onMessage: (msg: QqInboundMessage) => void
  onInteraction?: (event: QqInteractionEvent) => Promise<QqInteractionResponse | void>
  onEvent?: (event: QqEvent) => void
  onError?: (error: Error) => void
  fetch?: typeof fetch
  tokenUrl?: string
  wsFactory?: (url: string) => QqWsLike
}

function scrub(text: string, cfg: QqConfig, accessToken?: string): string {
  let out = text
  for (const s of [cfg.appSecret, accessToken ?? '']) {
    if (s) out = out.split(s).join('***')
  }
  return out
}

function resolveApiBase(cfg: QqConfig): string {
  if (cfg.sandbox) return DEFAULT_SANDBOX_API
  return (cfg.apiBase || DEFAULT_PROD_API).replace(/\/+$/, '')
}

/** 按 QQ 开放平台规范，用 `appSecret` 重复填充 32 字节种子推导 Ed25519 公私钥对。 */
export function deriveQqEd25519Keys(appSecret: string) {
  let seed = Buffer.from(appSecret, 'utf8')
  if (seed.length === 0) throw new Error('AppSecret 不能为空')
  while (seed.length < 32) {
    seed = Buffer.concat([seed, seed])
  }
  const seed32 = seed.subarray(0, 32)
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed32]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = createPublicKey(privateKey)
  return { privateKey, publicKey }
}

/** 响应 QQ Webhook 回调地址配置验证（`op = 13`）。 */
export function signQqValidation(appSecret: string, eventTs: string, plainToken: string): {
  plain_token: string
  signature: string
} {
  const { privateKey } = deriveQqEd25519Keys(appSecret)
  const sig = edSign(null, Buffer.from(`${eventTs}${plainToken}`, 'utf8'), privateKey)
  return {
    plain_token: plainToken,
    signature: sig.toString('hex'),
  }
}

/** 校验 QQ Webhook 请求头 `X-Signature-Ed25519` 与 `X-Signature-Timestamp`。 */
export function verifyQqWebhookSignature(
  appSecret: string,
  timestamp: string,
  rawBody: string,
  signatureHex: string,
): boolean {
  if (!appSecret || !timestamp || !signatureHex) return false
  let sigBuf: Buffer
  try {
    sigBuf = Buffer.from(signatureHex.trim(), 'hex')
    if (sigBuf.length !== 64) return false
    const { publicKey } = deriveQqEd25519Keys(appSecret)
    return edVerify(null, Buffer.from(`${timestamp}${rawBody}`, 'utf8'), publicKey, sigBuf)
  } catch {
    return false
  }
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        done = true
        req.destroy()
        reject(new Error('QQ 回调请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', err => {
      if (done) return
      done = true
      reject(err)
    })
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function looksLikeRichUnsupported(status: number, bodyText: string): boolean {
  if (status >= 500) return false
  return /not allowed|keyboard|markdown|template|304057|40054005|11292|50040|无权限|不支持/i.test(bodyText)
}

export class QqSource {
  private readonly doFetch: typeof fetch
  private readonly tokenUrl: string
  private tokenCache?: { value: string; expiresAtMs: number; key: string }
  private passiveReplyMap = new Map<string, { msgId: string; expiresAt: number; seq: number }>()
  private ws?: QqWsLike
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private generation = 0
  private lastSeq: number | null = null
  private sessionId = ''
  private reconnectAttempt = 0
  private richDisabledUntilMs = 0
  private receivedCount = 0
  private sentCount = 0
  private statusState: QqStatus = { state: 'off', mode: 'ws', received: 0, sent: 0 }

  constructor(private readonly deps: QqSourceOptions) {
    this.doFetch = deps.fetch ?? fetch
    this.tokenUrl = deps.tokenUrl ?? DEFAULT_TOKEN_URL
  }

  status(): QqStatus {
    const cfg = this.deps.config()
    return {
      ...this.statusState,
      mode: cfg.mode,
      received: this.receivedCount,
      sent: this.sentCount,
      ...(Date.now() < this.richDisabledUntilMs ? { richDisabled: true } : {}),
    }
  }

  async start(): Promise<void> {
    const cfg = this.deps.config()
    if (!cfg.enabled) {
      this.stop()
      return
    }
    if (cfg.mode === 'webhook') {
      this.closeSocketOnly()
      this.statusState = {
        state: cfg.appId && cfg.appSecret ? 'connected' : 'error',
        mode: 'webhook',
        since: new Date().toISOString(),
        ...(cfg.appId && cfg.appSecret ? {} : { lastError: '缺少 AppID 或 AppSecret' }),
        ...(this.statusState.lastEventAt ? { lastEventAt: this.statusState.lastEventAt } : {}),
        received: this.receivedCount,
        sent: this.sentCount,
      }
      return
    }
    if (!cfg.appId || !cfg.appSecret) {
      this.statusState = {
        state: 'error',
        mode: 'ws',
        since: new Date().toISOString(),
        lastError: '缺少 QQ 机器人 AppID 或 AppSecret',
        received: this.receivedCount,
        sent: this.sentCount,
      }
      return
    }
    if (this.ws) return
    await this.connectWs(false)
  }

  stop(): void {
    this.generation += 1
    this.closeSocketOnly()
    this.statusState = {
      state: 'off',
      mode: this.deps.config().mode,
      ...(this.statusState.lastEventAt ? { lastEventAt: this.statusState.lastEventAt } : {}),
      ...(this.statusState.lastError ? { lastError: this.statusState.lastError } : {}),
      received: this.receivedCount,
      sent: this.sentCount,
    }
  }

  async restart(): Promise<void> {
    this.tokenCache = undefined
    this.richDisabledUntilMs = 0
    this.sessionId = ''
    this.lastSeq = null
    this.reconnectAttempt = 0
    this.stop()
    await this.start()
  }

  private closeSocketOnly(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    const sock = this.ws
    this.ws = undefined
    if (sock) {
      try { sock.close(1000, 'shutdown') } catch { /* ignore */ }
    }
  }

  private emit(event: QqEvent): void {
    try { this.deps.onEvent?.(event) } catch { /* ignore */ }
  }

  /** 获取并缓存 QQ 开放平台 Access Token。 */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const cfg = this.deps.config()
    if (!cfg.appId || !cfg.appSecret) throw new Error('尚未配置 QQ 机器人 AppID 或 AppSecret')
    const cacheKey = `${cfg.appId}:${cfg.appSecret}`
    const now = Date.now()
    if (!forceRefresh && this.tokenCache && this.tokenCache.key === cacheKey && this.tokenCache.expiresAtMs > now + 60_000) {
      return this.tokenCache.value
    }
    const res = await this.doFetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.appSecret }),
    })
    const raw = await res.text()
    let parsed: { access_token?: unknown; expires_in?: unknown; message?: unknown } = {}
    try { parsed = JSON.parse(raw) as typeof parsed } catch { /* ignore */ }
    if (!res.ok || typeof parsed.access_token !== 'string' || !parsed.access_token) {
      throw new Error(`获取 QQ AccessToken 失败（HTTP ${res.status}）：${scrub(raw.slice(0, 200), cfg)}`)
    }
    const expiresSec = typeof parsed.expires_in === 'number' ? parsed.expires_in : Number(parsed.expires_in) || 7200
    this.tokenCache = {
      value: parsed.access_token,
      expiresAtMs: now + Math.max(120, expiresSec) * 1000,
      key: cacheKey,
    }
    return parsed.access_token
  }

  /** 连通性测试：校验凭据换取 Token 并尝试拉取网关地址（不打印密钥）。 */
  async test(): Promise<{ ok: boolean; message: string }> {
    const cfg = this.deps.config()
    if (!cfg.appId || !cfg.appSecret) return { ok: false, message: '请先填写 QQ 机器人 AppID 与 AppSecret。' }
    let token = ''
    try {
      token = await this.getAccessToken(true)
      const gwUrl = await this.fetchGatewayUrl(token, cfg)
      return {
        ok: true,
        message: `QQ 机器人鉴权通过（${cfg.sandbox ? '沙箱环境' : '正式环境'} · 网关可达 ${new URL(gwUrl).host}）。`,
      }
    } catch (err) {
      return { ok: false, message: scrub(err instanceof Error ? err.message : String(err), cfg, token) }
    }
  }

  private async fetchGatewayUrl(token: string, cfg: QqConfig): Promise<string> {
    const res = await this.doFetch(`${resolveApiBase(cfg)}/gateway`, {
      method: 'GET',
      headers: { authorization: `QQBot ${token}` },
    })
    const raw = await res.text()
    let json: { url?: unknown } = {}
    try { json = JSON.parse(raw) as typeof json } catch { /* ignore */ }
    if (!res.ok || typeof json.url !== 'string' || !json.url) {
      throw new Error(`获取 QQ WebSocket 网关地址失败（HTTP ${res.status}）：${scrub(raw.slice(0, 200), cfg, token)}`)
    }
    return json.url
  }

  private async connectWs(resume: boolean): Promise<void> {
    const gen = this.generation
    const cfg = this.deps.config()
    this.statusState = {
      ...this.statusState,
      state: 'connecting',
      mode: 'ws',
      since: new Date().toISOString(),
    }
    let token = ''
    try {
      token = await this.getAccessToken(false)
      const wsUrl = await this.fetchGatewayUrl(token, cfg)
      if (gen !== this.generation) return
      const WsCtor = globalThis.WebSocket
      if (!this.deps.wsFactory && typeof WsCtor !== 'function') {
        throw new Error('当前 Node 运行时缺少 WebSocket 支持')
      }
      const sock = this.deps.wsFactory ? this.deps.wsFactory(wsUrl) : new WsCtor!(wsUrl) as unknown as QqWsLike
      this.ws = sock

      sock.addEventListener('message', (ev: { data: unknown }) => {
        if (gen !== this.generation) return
        void this.onWsMessage(sock, String(ev?.data ?? ''), token, resume, gen)
      })
      sock.addEventListener('error', (ev: { message?: unknown }) => {
        if (gen !== this.generation) return
        const msg = scrub(String(ev?.message ?? 'WebSocket 连接异常'), cfg, token)
        this.statusState = { ...this.statusState, state: 'error', lastError: msg }
        this.emit({ kind: 'qq.ws', level: 'warn', text: `QQ 长连接错误：${msg}` })
      })
      sock.addEventListener('close', () => {
        if (gen !== this.generation) return
        this.ws = undefined
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined }
        if (!this.deps.config().enabled || this.deps.config().mode !== 'ws') return
        this.scheduleReconnect(gen)
      })
    } catch (err) {
      if (gen !== this.generation) return
      const msg = scrub(err instanceof Error ? err.message : String(err), cfg, token)
      this.statusState = { ...this.statusState, state: 'error', since: new Date().toISOString(), lastError: msg }
      this.emit({ kind: 'qq.ws', level: 'warn', text: `QQ 长连接启动失败：${msg}` })
      this.deps.onError?.(err instanceof Error ? err : new Error(msg))
      this.scheduleReconnect(gen)
    }
  }

  private scheduleReconnect(gen: number): void {
    if (this.reconnectTimer || gen !== this.generation) return
    const delayMs = Math.min(60_000, 3_000 * Math.max(1, ++this.reconnectAttempt))
    this.statusState = { ...this.statusState, state: 'connecting', since: new Date().toISOString() }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (gen !== this.generation) return
      void this.connectWs(Boolean(this.sessionId && this.lastSeq !== null))
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  private async onWsMessage(sock: QqWsLike, rawText: string, token: string, wantResume: boolean, gen: number): Promise<void> {
    let pkt: { op?: number; s?: number; t?: string; d?: any }
    try {
      pkt = JSON.parse(rawText) as typeof pkt
    } catch { return }

    if (typeof pkt.s === 'number') this.lastSeq = pkt.s

    if (pkt.op === 10) {
      const interval = Math.max(5_000, Number(pkt.d?.heartbeat_interval ?? 41_250))
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => {
        if (gen !== this.generation || sock.readyState !== 1) return
        try { sock.send(JSON.stringify({ op: 1, d: this.lastSeq })) } catch { /* ignore */ }
      }, interval)
      this.heartbeatTimer.unref?.()

      if (wantResume && this.sessionId && this.lastSeq !== null) {
        sock.send(JSON.stringify({
          op: 6,
          d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
        }))
      } else {
        // 1<<25 (GROUP_AND_C2C_EVENT) | 1<<26 (INTERACTION)
        const intents = (1 << 25) | (1 << 26)
        sock.send(JSON.stringify({
          op: 2,
          d: { token: `QQBot ${token}`, intents, shard: [0, 1] },
        }))
      }
      return
    }

    if (pkt.op === 7) {
      // 网关要求重连 Resume
      this.closeSocketOnly()
      void this.connectWs(true)
      return
    }

    if (pkt.op === 9) {
      // Invalid session -> 清理会话重鉴权
      this.sessionId = ''
      this.lastSeq = null
      this.closeSocketOnly()
      this.scheduleReconnect(gen)
      return
    }

    if (pkt.op === 0 && pkt.t) {
      await this.dispatchGatewayEvent(pkt.t, pkt.d)
    }
  }

  /** 处理 HTTP Webhook 回调请求（`POST /qq/events`）。 */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    const cfg = this.deps.config()
    let rawBody = ''
    try {
      rawBody = await readRawBody(req)
    } catch (err) {
      sendJson(res, 413, { error: 'payload_too_large', message: err instanceof Error ? err.message : 'too large' })
      return
    }
    let pkt: { op?: number; t?: string; d?: any }
    try {
      pkt = JSON.parse(rawBody) as typeof pkt
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }

    if (pkt.op === 13) {
      const plainToken = typeof pkt.d?.plain_token === 'string' ? pkt.d.plain_token : ''
      const eventTs = typeof pkt.d?.event_ts === 'string' ? pkt.d.event_ts : String(pkt.d?.event_ts ?? '')
      if (!plainToken || !eventTs || !cfg.appSecret) {
        sendJson(res, 400, { error: 'invalid_validation_payload' })
        return
      }
      sendJson(res, 200, signQqValidation(cfg.appSecret, eventTs, plainToken))
      this.emit({ kind: 'qq.webhook', level: 'info', text: 'QQ Webhook 回调地址校验通过' })
      return
    }

    const sigHex = typeof req.headers['x-signature-ed25519'] === 'string' ? req.headers['x-signature-ed25519'] : ''
    const ts = typeof req.headers['x-signature-timestamp'] === 'string' ? req.headers['x-signature-timestamp'] : ''
    if (!verifyQqWebhookSignature(cfg.appSecret, ts, rawBody, sigHex)) {
      this.emit({ kind: 'qq.webhook', level: 'warn', text: '拦截伪造/验签失败的 QQ Webhook 请求' })
      sendJson(res, 401, { error: 'invalid_signature' })
      return
    }

    // 先快速回包确认，避免触发 QQ 重推
    sendJson(res, 200, { op: 12 })
    if (pkt.op === 0 && pkt.t) {
      this.statusState = {
        ...this.statusState,
        state: 'connected',
        mode: 'webhook',
        lastEventAt: new Date().toISOString(),
      }
      await this.dispatchGatewayEvent(pkt.t, pkt.d)
    }
  }

  private async dispatchGatewayEvent(eventType: string, d: any): Promise<void> {
    const nowIso = new Date().toISOString()
    this.statusState = { ...this.statusState, lastEventAt: nowIso }

    if (eventType === 'READY' || eventType === 'RESUMED') {
      if (typeof d?.session_id === 'string' && d.session_id) this.sessionId = d.session_id
      this.reconnectAttempt = 0
      this.statusState = {
        ...this.statusState,
        state: 'connected',
        mode: 'ws',
        since: nowIso,
        lastError: undefined,
      }
      this.emit({ kind: 'qq.ws', level: 'info', text: eventType === 'RESUMED' ? 'QQ 长连接已恢复' : 'QQ 长连接已就绪' })
      return
    }

    const cfg = this.deps.config()
    if (!cfg.enabled) return

    if (eventType === 'C2C_MESSAGE_CREATE') {
      const from = String(d?.author?.user_openid || d?.author?.id || '').trim()
      const msgId = String(d?.id || '').trim()
      const text = String(d?.content || '').trim()
      if (!from || !text) return
      if (!this.isSenderAllowed(cfg, from)) return
      if (msgId) this.rememberPassiveMsg(`c2c:${from}`, msgId)
      this.receivedCount += 1
      this.deps.onMessage({
        chatType: 'c2c',
        from,
        chatId: from,
        messageId: msgId || `qq_${Date.now()}`,
        text,
        at: String(d?.timestamp || nowIso),
      })
      return
    }

    if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      const from = String(d?.author?.member_openid || d?.author?.id || '').trim()
      const groupId = String(d?.group_openid || '').trim()
      const msgId = String(d?.id || '').trim()
      const text = String(d?.content || '').replace(/<@![^>]+>\s*/g, '').trim()
      if (!from || !groupId || !text) return
      if (!this.isSenderAllowed(cfg, from)) return
      if (msgId) this.rememberPassiveMsg(`group:${groupId}`, msgId)
      this.receivedCount += 1
      this.deps.onMessage({
        chatType: 'group',
        from,
        chatId: groupId,
        messageId: msgId || `qqg_${Date.now()}`,
        text,
        at: String(d?.timestamp || nowIso),
      })
      return
    }

    if (eventType === 'INTERACTION_CREATE') {
      const interactionId = String(d?.id || '').trim()
      const chatType: 'c2c' | 'group' = d?.group_openid || d?.chat_type === 2 ? 'group' : 'c2c'
      const operatorId = String(d?.data?.resolved?.user_id || d?.user?.id || d?.user_openid || d?.group_member_openid || '').trim()
      const chatId = String(d?.group_openid || operatorId || '').trim()
      const rawTag = String(d?.data?.tag || d?.data?.resolved?.button_data || d?.data?.button_data || '').trim()
      const messageId = typeof d?.data?.message_id === 'string' ? d.data.message_id : undefined
      if (!interactionId || !operatorId) return
      if (!this.isSenderAllowed(cfg, operatorId)) {
        await this.ackInteraction(interactionId, 4).catch(() => undefined)
        return
      }
      this.receivedCount += 1
      const action = decodeQqAction(rawTag)
      // QQ 要求 3 秒内必须回包 PUT /interactions/{id}：先快速调用业务回调，若未主动指定 code 则自动补回 code:0
      let acked = false
      const ackOnce = async (code: 0 | 1 | 2 | 3 | 4 = 0) => {
        if (acked) return
        acked = true
        await this.ackInteraction(interactionId, code).catch(() => undefined)
      }
      const timeoutGuard = setTimeout(() => { void ackOnce(0) }, 1800)
      timeoutGuard.unref?.()
      try {
        const resp = await this.deps.onInteraction?.({
          interactionId,
          operatorId,
          chatId,
          chatType,
          ...(messageId ? { messageId } : {}),
          rawTag,
          ...(action ? { action } : {}),
        })
        clearTimeout(timeoutGuard)
        await ackOnce(resp?.code ?? 0)
        if (resp?.replyText) {
          await this.send({
            chatType,
            to: chatId,
            text: resp.replyText,
            ...(resp.keyboard ? { keyboard: resp.keyboard } : {}),
            ...(resp.markdown ? { markdown: resp.markdown } : {}),
          }).catch(() => undefined)
        }
      } catch (err) {
        clearTimeout(timeoutGuard)
        await ackOnce(1)
        this.deps.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  private isSenderAllowed(cfg: QqConfig, openId: string): boolean {
    if (cfg.allowedUsers.length === 0) return true
    return cfg.allowedUsers.some(u => u.trim() === openId)
  }

  private rememberPassiveMsg(targetKey: string, msgId: string): void {
    this.passiveReplyMap.set(targetKey, {
      msgId,
      expiresAt: Date.now() + PASSIVE_MSG_TTL_MS,
      seq: 1,
    })
    if (this.passiveReplyMap.size > 200) {
      const now = Date.now()
      for (const [k, v] of this.passiveReplyMap) {
        if (v.expiresAt <= now) this.passiveReplyMap.delete(k)
      }
    }
  }

  private nextPassiveRef(targetKey: string, explicitReplyTo?: string): { msgId: string; seq: number } | undefined {
    const existing = this.passiveReplyMap.get(targetKey)
    if (explicitReplyTo && (!existing || existing.msgId !== explicitReplyTo)) {
      const next = { msgId: explicitReplyTo, expiresAt: Date.now() + PASSIVE_MSG_TTL_MS, seq: 1 }
      this.passiveReplyMap.set(targetKey, next)
      return { msgId: next.msgId, seq: next.seq }
    }
    if (!existing || existing.expiresAt <= Date.now()) return undefined
    existing.seq += 1
    return { msgId: existing.msgId, seq: existing.seq }
  }

  /** 回应 QQ 按钮交互（3 秒内调用 PUT /interactions/{interaction_id} 消除客户端 loading）。 */
  async ackInteraction(interactionId: string, code: 0 | 1 | 2 | 3 | 4 = 0): Promise<void> {
    const cfg = this.deps.config()
    const token = await this.getAccessToken(false)
    const res = await this.doFetch(`${resolveApiBase(cfg)}/interactions/${encodeURIComponent(interactionId)}`, {
      method: 'PUT',
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`QQ 互动回包失败（HTTP ${res.status}）：${scrub(txt.slice(0, 160), cfg, token)}`)
    }
  }

  /** 向指定单聊/群聊发送消息：自动带被动 `msg_id` 序号、自动格式化分段，并在按钮无权限时无感降级纯文本重发。 */
  async send(input: {
    to: string
    chatType?: 'c2c' | 'group'
    text: string
    replyTo?: string
    keyboard?: QqKeyboard
    markdown?: QqMarkdown
  }): Promise<void> {
    const cfg = this.deps.config()
    if (!cfg.enabled) throw new Error('QQ 机器人未启用')
    const chatType = input.chatType ?? 'c2c'
    const targetKey = `${chatType}:${input.to}`
    const path = chatType === 'group'
      ? `/v2/groups/${encodeURIComponent(input.to)}/messages`
      : `/v2/users/${encodeURIComponent(input.to)}/messages`
    const plainFormatted = formatTextForQq(input.text, { markdownMode: false })
    const parts = splitForQq(plainFormatted, 1500)
    if (parts.length === 0) return

    const canTryRich = cfg.interactiveButtons && Date.now() >= this.richDisabledUntilMs && Boolean(input.keyboard || input.markdown)

    for (let i = 0; i < parts.length; i += 1) {
      const isLast = i === parts.length - 1
      const partText = parts[i]!
      const passive = this.nextPassiveRef(targetKey, i === 0 ? input.replyTo : undefined)

      if (isLast && canTryRich) {
        const richPayload: Record<string, unknown> = {}
        if (input.markdown) {
          richPayload.msg_type = 2
          richPayload.markdown = input.markdown
        } else if (cfg.markdownTemplateId) {
          richPayload.msg_type = 2
          richPayload.markdown = {
            custom_template_id: cfg.markdownTemplateId,
            params: [{ key: 'content', values: [partText] }],
          }
        } else {
          richPayload.msg_type = 2
          richPayload.markdown = { content: formatTextForQq(input.text, { markdownMode: true }).slice(0, 2000) }
        }
        if (input.keyboard) {
          richPayload.keyboard = cfg.keyboardTemplateId
            ? { id: cfg.keyboardTemplateId, ...input.keyboard }
            : input.keyboard
        }
        if (passive) {
          richPayload.msg_id = passive.msgId
          richPayload.msg_seq = passive.seq
        }
        const okRich = await this.postMessageWithRetry(cfg, path, richPayload, true)
        if (okRich === 'sent') {
          this.sentCount += 1
          continue
        }
        // 高阶按钮/Markdown 权限未开通：记下冷却并立刻自动补发优化排版纯文本
        this.richDisabledUntilMs = Date.now() + RICH_FALLBACK_COOLDOWN_MS
        this.emit({ kind: 'qq.fallback', level: 'info', text: 'QQ 自定义按钮/Markdown 未获授权，已自动切换纯文本优化排版下发' })
        const fallbackPassive = this.nextPassiveRef(targetKey)
        const plainPayload: Record<string, unknown> = {
          msg_type: 0,
          content: partText,
          ...(fallbackPassive ? { msg_id: fallbackPassive.msgId, msg_seq: fallbackPassive.seq } : {}),
        }
        await this.postMessageWithRetry(cfg, path, plainPayload, false)
        this.sentCount += 1
        continue
      }

      const plainPayload: Record<string, unknown> = {
        msg_type: 0,
        content: partText,
        ...(passive ? { msg_id: passive.msgId, msg_seq: passive.seq } : {}),
      }
      await this.postMessageWithRetry(cfg, path, plainPayload, false)
      this.sentCount += 1
    }
  }

  private async postMessageWithRetry(
    cfg: QqConfig,
    path: string,
    payload: Record<string, unknown>,
    allowRichFallback: boolean,
  ): Promise<'sent' | 'fallback'> {
    const url = `${resolveApiBase(cfg)}${path}`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.getAccessToken(attempt > 0)
      const res = await this.doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `QQBot ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (res.ok) return 'sent'
      const txt = await res.text().catch(() => '')
      if (res.status === 401 && attempt === 0) continue
      if (allowRichFallback && looksLikeRichUnsupported(res.status, txt)) {
        return 'fallback'
      }
      throw new Error(`发送 QQ 消息失败（HTTP ${res.status}）：${scrub(txt.slice(0, 200), cfg, token)}`)
    }
    throw new Error('发送 QQ 消息鉴权失败')
  }
}
