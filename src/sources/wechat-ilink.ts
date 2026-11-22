/**
 * Official WeChat Personal Bot ("微信插件" / ClawBot) connector over Tencent's iLink HTTP protocol.
 *
 * Protocol adapted from `@tencent-weixin/openclaw-weixin` v2.4.10 (MIT License, Tencent):
 *   - QR login: `POST ilink/bot/get_bot_qrcode?bot_type=3` + long-poll `GET ilink/bot/get_qrcode_status`
 *     (including IDC `scaned_but_redirect`, numeric `need_verifycode`, auto-refresh on `expired`, and `binded_redirect`)
 *   - Inbound:  long-poll `POST ilink/bot/getupdates` (no public IP or webhook required)
 *   - Outbound: `POST ilink/bot/sendmessage` echoing the user's `context_token`
 *   - Typing:   `POST ilink/bot/getconfig` + `POST ilink/bot/sendtyping`
 *
 * `botToken` is stored encrypted in the Vault (`WECHAT_ILINK_TOKEN`) and never returned in public views, logs, or errors.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Vault } from '../admin/vault.ts'
import { qrCodeDataUrl } from '../infra/qrcode.ts'

export const WECHAT_ILINK_SECRET = 'WECHAT_ILINK_TOKEN'
export const FIXED_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_ILINK_BOT_TYPE = '3'
export const STALE_TOKEN_ERRCODE = -14

const CHANNEL_VERSION = 'aq-wechat-2'
const QR_STATUS_CLIENT_VERSION = '1'
const MAX_SEND_CHUNK = 1500

const QR_TTL_MS = 5 * 60_000
const QR_POLL_TIMEOUT_MS = 35_000
const QR_WAIT_DEADLINE_MS = 8 * 60_000
const MAX_QR_REFRESH = 3

const DEFAULT_LONG_POLL_MS = 35_000
const DEFAULT_API_TIMEOUT_MS = 15_000
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000
const SESSION_PAUSE_MS = 60 * 60_000
const MAX_CONSECUTIVE_FAILURES = 3
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000

const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id'])

export interface WechatIlinkSession {
  botToken: string
  accountId: string
  userId: string
  baseUrl: string
  syncBuf: string
  contextTokens: Record<string, string>
  boundAt: string
}

export interface WechatIlinkPublicSession {
  bound: boolean
  accountId?: string
  userId?: string
  baseUrl?: string
  boundAt?: string
  pausedMinutes?: number
}

export type WechatQrLoginState =
  | 'idle'
  | 'waiting'
  | 'scanned'
  | 'need_verifycode'
  | 'confirmed'
  | 'expired'
  | 'error'

export interface WechatQrStatusView {
  active: boolean
  status: WechatQrLoginState
  qrcodeUrl?: string
  qrSvgDataUrl?: string
  message: string
  updatedAt: string
  accountId?: string
  userId?: string
}

export interface WechatIlinkStore {
  load(): WechatIlinkSession | undefined
  save(session: WechatIlinkSession): void
  updateSyncBuf(syncBuf: string): void
  setContextToken(userId: string, token: string): void
  getContextToken(userId: string): string | undefined
  clear(): void
}

/** In-memory store used by unit tests or ephemeral runtimes without SQLite/Vault. */
export class InMemoryIlinkStore implements WechatIlinkStore {
  private current?: WechatIlinkSession

  load(): WechatIlinkSession | undefined {
    return this.current ? { ...this.current, contextTokens: { ...this.current.contextTokens } } : undefined
  }

  save(session: WechatIlinkSession): void {
    this.current = { ...session, contextTokens: { ...session.contextTokens } }
  }

  updateSyncBuf(syncBuf: string): void {
    if (this.current) this.current.syncBuf = syncBuf
  }

  setContextToken(userId: string, token: string): void {
    if (!this.current || !userId || !token) return
    this.current.contextTokens[userId] = token
  }

  getContextToken(userId: string): string | undefined {
    return this.current?.contextTokens[userId]
  }

  clear(): void {
    this.current = undefined
  }
}

/** Durable store: metadata + cursor + contextTokens in SQLite, `botToken` encrypted in Vault (`WECHAT_ILINK_TOKEN`). */
export class SqliteVaultIlinkStore implements WechatIlinkStore {
  private readonly secretName: string

  constructor(private readonly deps: { db: DatabaseSync; vault: Vault; secretName?: string }) {
    this.secretName = deps.secretName ?? WECHAT_ILINK_SECRET
    deps.db.exec(`
      CREATE TABLE IF NOT EXISTS wechat_ilink_session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        base_url TEXT NOT NULL,
        sync_buf TEXT NOT NULL DEFAULT '',
        context_tokens TEXT NOT NULL DEFAULT '{}',
        bound_at TEXT NOT NULL
      )
    `)
  }

  load(): WechatIlinkSession | undefined {
    const row = this.deps.db.prepare(
      'SELECT account_id, user_id, base_url, sync_buf, context_tokens, bound_at FROM wechat_ilink_session WHERE id = 1',
    ).get() as {
      account_id: string
      user_id: string
      base_url: string
      sync_buf: string
      context_tokens: string
      bound_at: string
    } | undefined
    if (!row || !this.deps.vault.has(this.secretName)) return undefined
    let botToken = ''
    try {
      botToken = this.deps.vault.reveal(this.secretName)
    } catch {
      return undefined
    }
    if (!botToken) return undefined
    let contextTokens: Record<string, string> = {}
    try {
      const parsed = JSON.parse(row.context_tokens) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v) contextTokens[k] = v
        }
      }
    } catch {
      contextTokens = {}
    }
    return {
      botToken,
      accountId: row.account_id,
      userId: row.user_id,
      baseUrl: row.base_url || FIXED_ILINK_BASE_URL,
      syncBuf: row.sync_buf,
      contextTokens,
      boundAt: row.bound_at,
    }
  }

  save(session: WechatIlinkSession): void {
    if (this.deps.vault.has(this.secretName)) {
      this.deps.vault.update(this.secretName, {
        value: session.botToken,
        description: '个人微信插件（iLink）扫码绑定令牌',
        origin: 'operator',
      })
    } else {
      this.deps.vault.create(this.secretName, session.botToken, '个人微信插件（iLink）扫码绑定令牌', 'operator')
    }
    this.deps.db.prepare(`
      INSERT INTO wechat_ilink_session (id, account_id, user_id, base_url, sync_buf, context_tokens, bound_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        user_id = excluded.user_id,
        base_url = excluded.base_url,
        sync_buf = excluded.sync_buf,
        context_tokens = excluded.context_tokens,
        bound_at = excluded.bound_at
    `).run(
      session.accountId,
      session.userId,
      session.baseUrl || FIXED_ILINK_BASE_URL,
      session.syncBuf,
      JSON.stringify(session.contextTokens),
      session.boundAt,
    )
  }

  updateSyncBuf(syncBuf: string): void {
    this.deps.db.prepare('UPDATE wechat_ilink_session SET sync_buf = ? WHERE id = 1').run(syncBuf)
  }

  setContextToken(userId: string, token: string): void {
    if (!userId || !token) return
    const row = this.deps.db.prepare('SELECT context_tokens FROM wechat_ilink_session WHERE id = 1').get() as { context_tokens?: string } | undefined
    if (!row) return
    let map: Record<string, string> = {}
    try {
      const parsed = JSON.parse(row.context_tokens ?? '{}') as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, string>
    } catch { /* ignore */ }
    if (map[userId] === token) return
    map[userId] = token
    this.deps.db.prepare('UPDATE wechat_ilink_session SET context_tokens = ? WHERE id = 1').run(JSON.stringify(map))
  }

  getContextToken(userId: string): string | undefined {
    const row = this.deps.db.prepare('SELECT context_tokens FROM wechat_ilink_session WHERE id = 1').get() as { context_tokens?: string } | undefined
    if (!row) return undefined
    try {
      const parsed = JSON.parse(row.context_tokens ?? '{}') as Record<string, unknown>
      return typeof parsed[userId] === 'string' ? parsed[userId] as string : undefined
    } catch {
      return undefined
    }
  }

  clear(): void {
    this.deps.db.prepare('DELETE FROM wechat_ilink_session WHERE id = 1').run()
    if (this.deps.vault.has(this.secretName)) {
      try { this.deps.vault.remove(this.secretName) } catch { /* ignore */ }
    }
  }
}

/** Quote uint64 message identifiers before JSON.parse so message IDs never lose precision. */
export function parseWeixinApiJson<T>(rawText: string): T {
  let output = ''
  let index = 0
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++]
      continue
    }
    const stringStart = index
    index += 1
    let escaped = false
    while (index < rawText.length) {
      const char = rawText[index++]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') break
    }
    const stringToken = rawText.slice(stringStart, index)
    output += stringToken
    let cursor = index
    while (/\s/.test(rawText[cursor] ?? '')) cursor += 1
    if (rawText[cursor] !== ':') continue
    let keyName: unknown
    try { keyName = JSON.parse(stringToken) } catch { continue }
    if (typeof keyName !== 'string' || !LOSSLESS_ID_FIELDS.has(keyName)) continue
    output += rawText.slice(index, cursor + 1)
    cursor += 1
    while (/\s/.test(rawText[cursor] ?? '')) output += rawText[cursor++]
    const numberStart = cursor
    if (rawText[cursor] === '-') cursor += 1
    while (/\d/.test(rawText[cursor] ?? '')) cursor += 1
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
      output += `"${rawText.slice(numberStart, cursor)}"`
      index = cursor
    } else {
      index = numberStart
    }
  }
  return JSON.parse(output) as T
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

function baseInfo() {
  // 对齐 ai-ak47-main 极简模式，仅携带 channel_version，避免触发新版高风控指纹
  return { channel_version: CHANNEL_VERSION }
}

function getHeaders(extra?: Record<string, string>, relayToken?: string): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) }
  if (relayToken?.trim()) h['X-Ilink-Relay-Token'] = relayToken.trim()
  return h
}

function postHeaders(token?: string, relayToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  }
  if (token?.trim()) h.Authorization = `Bearer ${token.trim()}`
  if (relayToken?.trim()) h['X-Ilink-Relay-Token'] = relayToken.trim()
  return h
}

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

interface IlinkMessageItem {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  voice_item?: { text?: string }
  ref_msg?: {
    title?: string
    svr_id?: string
    message_item?: IlinkMessageItem
  }
}

interface IlinkMessage {
  message_id?: string
  from_user_id?: string
  to_user_id?: string
  message_type?: number
  context_token?: string
  create_time_ms?: number
  item_list?: IlinkMessageItem[]
}

interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: IlinkMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

interface QrCodeApiResponse {
  ret?: number
  errmsg?: string
  qrcode?: string
  qrcode_img_content?: string
}

interface QrStatusApiResponse {
  status?:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

function extractItemBody(items?: IlinkMessageItem[]): string {
  if (!items?.length) return ''
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text != null) return String(item.text_item.text).trim()
    if (item.type === 3 && item.voice_item?.text) return String(item.voice_item.text).trim()
  }
  return ''
}

function extractInboundText(msg: IlinkMessage): string {
  const body = extractItemBody(msg.item_list)
  if (!body) return ''
  const refItem = msg.item_list?.find(i => i.ref_msg)
  if (!refItem?.ref_msg) return body
  const quoteParts: string[] = []
  if (refItem.ref_msg.title?.trim()) quoteParts.push(refItem.ref_msg.title.trim())
  if (refItem.ref_msg.message_item) {
    const q = extractItemBody([refItem.ref_msg.message_item])
    if (q) quoteParts.push(q)
  }
  return quoteParts.length > 0 ? `> 引用：${quoteParts.join(' | ')}\n${body}` : body
}

function chunkText(text: string, maxChars = 3800): string[] {
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface WechatIlinkOptions {
  store?: WechatIlinkStore
  enabled: () => boolean
  /** 可选中继网关配置：配置后所有 iLink 请求（扫码、轮询、发信）均通过固定 IP 中继服务器转发。 */
  relay?: () => { url: string; token?: string } | undefined
  /** 是否启用 sendtyping 输入状态提示；默认 false（对齐 ai-ak47-main，减少高频接口调用）。 */
  enableTyping?: boolean
  onInbound: (msg: { from: string; chatId: string; messageId: string; text: string }) => void
  onConnected?: (info: { accountId: string; userId: string; baseUrl: string }) => void
  onError?: (text: string) => void
  onRecovered?: () => void
  onStateChange?: () => void
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

interface ActiveQrSession {
  id: string
  qrcode: string
  qrcodeUrl: string
  qrSvgDataUrl: string
  startedAt: number
  updatedAt: string
  status: WechatQrLoginState
  message: string
  pollBaseUrl: string
  pendingVerifyCode?: string
  verifyWake?: () => void
  abort: AbortController
  accountId?: string
  userId?: string
}

export class WechatIlinkBridge {
  private readonly store: WechatIlinkStore
  private readonly doFetch: typeof globalThis.fetch
  private readonly doNow: () => Date
  private qr?: ActiveQrSession
  private monitorAbort?: AbortController
  private monitorPromise?: Promise<void>
  private monitorConnecting = false
  private monitorConnected = false
  private pauseUntilMs = 0
  private typingCache = new Map<string, { ticket: string; expiresAt: number }>()

  constructor(private readonly opts: WechatIlinkOptions) {
    this.store = opts.store ?? new InMemoryIlinkStore()
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.doNow = opts.now ?? (() => new Date())
  }

  sessionInfo(): WechatIlinkPublicSession {
    const s = this.store.load()
    if (!s) return { bound: false }
    const nowMs = this.doNow().getTime()
    const pausedMinutes = this.pauseUntilMs > nowMs ? Math.ceil((this.pauseUntilMs - nowMs) / 60_000) : undefined
    return {
      bound: true,
      accountId: s.accountId,
      ...(s.userId ? { userId: s.userId } : {}),
      baseUrl: s.baseUrl,
      boundAt: s.boundAt,
      ...(pausedMinutes ? { pausedMinutes } : {}),
    }
  }

  isRunning(): boolean {
    return this.monitorConnected
  }

  isConnecting(): boolean {
    return this.monitorConnecting
  }

  qrStatus(): WechatQrStatusView {
    if (!this.qr) {
      const s = this.store.load()
      if (s) {
        return {
          active: false,
          status: 'confirmed',
          message: `已连接个人微信（账号 ${s.accountId}${s.userId ? ` · 用户 ${s.userId}` : ''}）`,
          updatedAt: s.boundAt,
          accountId: s.accountId,
          ...(s.userId ? { userId: s.userId } : {}),
        }
      }
      return {
        active: false,
        status: 'idle',
        message: '尚未绑定个人微信，点击「生成扫码二维码」用手机微信扫一扫即可直连。',
        updatedAt: this.doNow().toISOString(),
      }
    }
    const fresh = this.doNow().getTime() - this.qr.startedAt < QR_TTL_MS
    const active = fresh && (this.qr.status === 'waiting' || this.qr.status === 'scanned' || this.qr.status === 'need_verifycode')
    if (!fresh && active) {
      this.qr.status = 'expired'
      this.qr.message = '二维码已过期，请点击「刷新二维码」重新生成。'
    }
    return {
      active,
      status: this.qr.status,
      ...(active || this.qr.status === 'waiting' || this.qr.status === 'scanned' || this.qr.status === 'need_verifycode'
        ? { qrcodeUrl: this.qr.qrcodeUrl, qrSvgDataUrl: this.qr.qrSvgDataUrl }
        : {}),
      message: this.qr.message,
      updatedAt: this.qr.updatedAt,
      ...(this.qr.accountId ? { accountId: this.qr.accountId } : {}),
      ...(this.qr.userId ? { userId: this.qr.userId } : {}),
    }
  }

  private resolveEndpoint(fallbackBaseUrl?: string): { baseUrl: string; relayToken?: string; usingRelay: boolean } {
    const relay = this.opts.relay?.()
    const relayUrl = relay?.url?.trim() ?? ''
    if (relayUrl) {
      return {
        baseUrl: relayUrl,
        ...(relay?.token?.trim() ? { relayToken: relay.token.trim() } : {}),
        usingRelay: true,
      }
    }
    return { baseUrl: fallbackBaseUrl || FIXED_ILINK_BASE_URL, usingRelay: false }
  }

  /** Request a fresh official WeChat plugin QR code and begin polling scan status in the background. */
  async startQrLogin(input: { force?: boolean; botType?: string } = {}): Promise<WechatQrStatusView> {
    const nowMs = this.doNow().getTime()
    if (
      !input.force
      && this.qr
      && nowMs - this.qr.startedAt < QR_TTL_MS - 30_000
      && (this.qr.status === 'waiting' || this.qr.status === 'scanned' || this.qr.status === 'need_verifycode')
    ) {
      return this.qrStatus()
    }
    this.cancelQrPoll()
    const botType = input.botType ?? DEFAULT_ILINK_BOT_TYPE
    const target = this.resolveEndpoint(FIXED_ILINK_BASE_URL)
    const qrData = await this.fetchQrCode(target.baseUrl, botType, target.relayToken)
    if (!qrData.qrcode || !qrData.qrcode_img_content) {
      throw new Error(`获取微信二维码失败：${qrData.errmsg ?? '未返回二维码内容'}`)
    }
    const session: ActiveQrSession = {
      id: randomUUID(),
      qrcode: qrData.qrcode,
      qrcodeUrl: qrData.qrcode_img_content,
      qrSvgDataUrl: qrCodeDataUrl(qrData.qrcode_img_content, { size: 260, level: 'M' }),
      startedAt: nowMs,
      updatedAt: this.doNow().toISOString(),
      status: 'waiting',
      message: '请打开手机微信「扫一扫」扫描二维码连接个人微信',
      pollBaseUrl: target.baseUrl,
      abort: new AbortController(),
    }
    this.qr = session
    void this.pollQrLoop(session, botType)
    return this.qrStatus()
  }

  /** Submit the numeric pairing code displayed on phone WeChat when `status === 'need_verifycode'`. */
  submitVerifyCode(code: string): WechatQrStatusView {
    const trimmed = code.trim()
    if (!trimmed) throw new Error('请输入手机微信上显示的配对码数字')
    if (!this.qr || (this.qr.status !== 'need_verifycode' && this.qr.status !== 'scanned' && this.qr.status !== 'waiting')) {
      throw new Error('当前没有等待输入配对码的扫码会话')
    }
    this.qr.pendingVerifyCode = trimmed
    this.qr.message = '正在校验配对码…'
    this.qr.updatedAt = this.doNow().toISOString()
    this.qr.verifyWake?.()
    return this.qrStatus()
  }

  cancelQrPoll(): void {
    if (!this.qr) return
    this.qr.abort.abort()
    this.qr.verifyWake?.()
  }

  /** Disconnect personal WeChat, notify upstream best-effort, and wipe stored credentials. */
  async logout(): Promise<void> {
    this.cancelQrPoll()
    this.qr = undefined
    const existing = this.store.load()
    this.stop()
    if (existing?.botToken) {
      try {
        const ep = this.resolveEndpoint(existing.baseUrl)
        await this.apiPost({
          baseUrl: ep.baseUrl,
          endpoint: 'ilink/bot/msg/notifystop',
          body: { base_info: baseInfo() },
          token: existing.botToken,
          relayToken: ep.relayToken,
          timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
        })
      } catch { /* best effort */ }
    }
    this.store.clear()
    this.pauseUntilMs = 0
    this.typingCache.clear()
    this.opts.onStateChange?.()
  }

  start(): void {
    if (this.monitorAbort) return
    const session = this.store.load()
    if (!session?.botToken || !this.opts.enabled()) return
    const abort = new AbortController()
    this.monitorAbort = abort
    this.monitorConnecting = true
    this.monitorPromise = this.runMonitor(abort.signal).finally(() => {
      if (this.monitorAbort === abort) {
        this.monitorAbort = undefined
        this.monitorConnecting = false
        this.monitorConnected = false
      }
    })
  }

  stop(): void {
    const abort = this.monitorAbort
    this.monitorAbort = undefined
    this.monitorConnecting = false
    this.monitorConnected = false
    abort?.abort()
  }

  async restart(): Promise<void> {
    this.stop()
    try { await this.monitorPromise } catch { /* ignore */ }
    this.start()
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const session = this.store.load()
    if (!session?.botToken) {
      return { ok: false, message: '尚未扫码绑定个人微信，请先点击「生成扫码二维码」并用手机微信扫描。' }
    }
    if (this.pauseUntilMs > this.doNow().getTime()) {
      const mins = Math.ceil((this.pauseUntilMs - this.doNow().getTime()) / 60_000)
      return { ok: false, message: `微信会话凭据已失效（冷却剩余 ${mins} 分钟），请点击「重新扫码」更新绑定。` }
    }
    const ep = this.resolveEndpoint(session.baseUrl)
    try {
      if (session.userId) {
        const ctx = session.contextTokens[session.userId]
        const raw = await this.apiPost({
          baseUrl: ep.baseUrl,
          endpoint: 'ilink/bot/getconfig',
          body: { ilink_user_id: session.userId, ...(ctx ? { context_token: ctx } : {}), base_info: baseInfo() },
          token: session.botToken,
          relayToken: ep.relayToken,
          timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
        })
        const data = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string }
        if ((data.ret && data.ret !== 0) || (data.errcode && data.errcode !== 0)) {
          return { ok: false, message: `微信插件状态校验异常（${data.errcode ?? data.ret}）：${this.scrub(data.errmsg ?? '请重新扫码绑定', session.botToken, ep.relayToken)}` }
        }
      }
      return {
        ok: true,
        message: `个人微信插件已连接（Bot: ${session.accountId}${session.userId ? ` · 微信用户: ${session.userId}` : ''}${ep.usingRelay ? ' · 经服务器中继' : ''}），长轮询通道正常。`,
      }
    } catch (error) {
      return { ok: false, message: `微信插件连通性检查失败：${this.scrub(describe(error), session.botToken, ep.relayToken)}` }
    }
  }

  async sendTyping(to?: string, status: 1 | 2 = 1): Promise<void> {
    // 默认关闭输入状态心跳（对齐 ai-ak47-main 极简模式，避免高频调用触发腾讯风控）
    if (!this.opts.enableTyping) return
    const session = this.store.load()
    if (!session?.botToken) return
    if (this.pauseUntilMs > this.doNow().getTime()) return
    const target = (to && to !== '@all' ? to : '') || session.userId
    if (!target) return
    const contextToken = this.store.getContextToken(target) ?? (session.userId ? this.store.getContextToken(session.userId) : undefined)
    await this.sendTypingBestEffort(session, target, contextToken, status)
  }

  async sendText(to: string | undefined, text: string): Promise<{ messageIds: string[]; missingMessageId: boolean }> {
    const session = this.store.load()
    if (!session?.botToken) {
      throw new Error('个人微信尚未扫码绑定，请先在「设置 → 微信」扫码连接。')
    }
    if (this.pauseUntilMs > this.doNow().getTime()) {
      throw new Error('个人微信登录态已过期（errcode -14），请重新扫码绑定。')
    }
    const target = (to && to !== '@all' ? to : '') || session.userId
    if (!target) {
      throw new Error('缺少目标微信用户 ID：请先用手机微信给机器人发一条消息，或在参数中指定目标用户。')
    }
    const contextToken = this.store.getContextToken(target) ?? (session.userId ? this.store.getContextToken(session.userId) : undefined)
    const ep = this.resolveEndpoint(session.baseUrl)
    const messageIds: string[] = []
    let missingMessageId = false
    for (const chunk of chunkText(text, MAX_SEND_CHUNK)) {
      const clientId = randomUUID()
      const raw = await this.apiPost({
        baseUrl: ep.baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token: session.botToken,
        relayToken: ep.relayToken,
        timeoutMs: DEFAULT_API_TIMEOUT_MS,
        body: {
          msg: {
            client_id: clientId,
            from_user_id: '',
            to_user_id: target,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            item_list: [{ type: 1, text_item: { text: chunk } }],
            ...(contextToken ? { context_token: contextToken } : {}),
          },
          base_info: baseInfo(),
        },
      })
      const resp = parseWeixinApiJson<{ ret?: number; errcode?: number; errmsg?: string; message_id?: string }>(raw)
      if ((resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0)) {
        if (resp.ret === STALE_TOKEN_ERRCODE || resp.errcode === STALE_TOKEN_ERRCODE) {
          this.pauseUntilMs = this.doNow().getTime() + SESSION_PAUSE_MS
        }
        throw new Error(`微信插件发送失败（${resp.errcode ?? resp.ret}）：${this.scrub(resp.errmsg ?? '未知错误', session.botToken, ep.relayToken)}`)
      }
      if (resp.message_id) {
        messageIds.push(resp.message_id)
      } else {
        missingMessageId = true
      }
    }
    return { messageIds, missingMessageId }
  }

  // --- Internal QR login loop ---

  private async fetchQrCode(baseUrl: string, botType: string, relayToken?: string): Promise<QrCodeApiResponse> {
    // 对齐 ai-ak47-main：使用 GET ilink/bot/get_bot_qrcode?bot_type=3，不附加新版指纹头与 local_token_list
    const raw = await this.apiGet({
      baseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      relayToken,
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
    })
    return JSON.parse(raw) as QrCodeApiResponse
  }

  private async pollQrLoop(session: ActiveQrSession, botType: string): Promise<void> {
    const deadline = this.doNow().getTime() + QR_WAIT_DEADLINE_MS
    let refreshCount = 0

    while (!session.abort.signal.aborted && this.qr === session && this.doNow().getTime() < deadline) {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`
      const sentVerifyCode = session.pendingVerifyCode
      if (sentVerifyCode) endpoint += `&verify_code=${encodeURIComponent(sentVerifyCode)}`
      const ep = this.resolveEndpoint(session.pollBaseUrl)

      let resp: QrStatusApiResponse
      try {
        const raw = await this.apiGet({
          baseUrl: ep.usingRelay ? ep.baseUrl : session.pollBaseUrl,
          endpoint,
          headers: { 'iLink-App-ClientVersion': QR_STATUS_CLIENT_VERSION },
          relayToken: ep.relayToken,
          timeoutMs: QR_POLL_TIMEOUT_MS,
          signal: session.abort.signal,
        })
        resp = JSON.parse(raw) as QrStatusApiResponse
      } catch (err) {
        if (session.abort.signal.aborted || this.qr !== session) return
        if (err instanceof Error && err.name === 'AbortError') {
          resp = { status: 'wait' }
        } else {
          await this.sleepAbortable(1500, session.abort.signal)
          continue
        }
      }

      if (session.abort.signal.aborted || this.qr !== session) return
      session.updatedAt = this.doNow().toISOString()

      switch (resp.status) {
        case 'wait':
        case undefined:
          break

        case 'scaned':
          if (sentVerifyCode) session.pendingVerifyCode = undefined
          session.status = 'scanned'
          session.message = '已扫码！请在手机微信上点击「确认连接」…'
          this.opts.onStateChange?.()
          break

        case 'scaned_but_redirect':
          if (resp.redirect_host && !ep.usingRelay) {
            session.pollBaseUrl = `https://${resp.redirect_host}`
          }
          session.status = 'scanned'
          session.message = '已扫码，正在完成就近节点验证，请在手机确认…'
          this.opts.onStateChange?.()
          continue

        case 'need_verifycode': {
          const wrongBefore = Boolean(sentVerifyCode)
          session.pendingVerifyCode = undefined
          session.status = 'need_verifycode'
          session.message = wrongBefore
            ? '配对码不匹配，请重新输入手机微信上显示的数字：'
            : '请在下方输入手机微信上显示的数字配对码：'
          this.opts.onStateChange?.()
          await new Promise<void>(resolve => {
            session.verifyWake = () => {
              session.verifyWake = undefined
              resolve()
            }
          })
          continue
        }

        case 'verify_code_blocked':
        case 'expired': {
          session.pendingVerifyCode = undefined
          refreshCount += 1
          if (refreshCount > MAX_QR_REFRESH) {
            session.status = 'expired'
            session.message = resp.status === 'verify_code_blocked'
              ? '配对码多次输入错误，请点击「刷新二维码」重新开始。'
              : '二维码已过期，请点击「刷新二维码」重新获取。'
            this.opts.onStateChange?.()
            return
          }
          try {
            const refreshEp = this.resolveEndpoint(FIXED_ILINK_BASE_URL)
            const nextQr = await this.fetchQrCode(refreshEp.baseUrl, botType, refreshEp.relayToken)
            if (nextQr.qrcode && nextQr.qrcode_img_content) {
              session.qrcode = nextQr.qrcode
              session.qrcodeUrl = nextQr.qrcode_img_content
              session.qrSvgDataUrl = qrCodeDataUrl(nextQr.qrcode_img_content, { size: 260, level: 'M' })
              session.startedAt = this.doNow().getTime()
              session.pollBaseUrl = refreshEp.baseUrl
              session.status = 'waiting'
              session.message = `二维码已自动刷新（${refreshCount}/${MAX_QR_REFRESH}），请用手机微信扫描`
              this.opts.onStateChange?.()
              continue
            }
          } catch {
            // Fall through to expired state
          }
          session.status = 'expired'
          session.message = '二维码已过期，请点击「刷新二维码」重新生成。'
          this.opts.onStateChange?.()
          return
        }

        case 'binded_redirect': {
          const prev = this.store.load()
          if (prev?.botToken) {
            session.status = 'confirmed'
            session.accountId = prev.accountId
            session.userId = prev.userId
            session.message = '该微信插件已绑定当前实例，无需重复连接！'
            this.pauseUntilMs = 0
            this.opts.onConnected?.({ accountId: prev.accountId, userId: prev.userId, baseUrl: prev.baseUrl })
            this.opts.onStateChange?.()
            return
          }
          session.status = 'error'
          session.message = '微信提示已绑定旧会话但本地无凭据，请在手机微信解绑后重新扫码。'
          this.opts.onStateChange?.()
          return
        }

        case 'confirmed': {
          if (!resp.ilink_bot_id || !resp.bot_token) {
            session.status = 'error'
            session.message = '扫码确认后未返回完整机器人凭据，请重新扫码。'
            this.opts.onStateChange?.()
            return
          }
          const prev = this.store.load()
          const baseUrl = (resp.baseurl && /^https?:\/\//i.test(resp.baseurl) ? resp.baseurl : FIXED_ILINK_BASE_URL).replace(/\/+$/, '')
          const userId = (resp.ilink_user_id ?? '').trim()
          const saved: WechatIlinkSession = {
            botToken: resp.bot_token,
            accountId: resp.ilink_bot_id,
            userId,
            baseUrl,
            syncBuf: prev?.accountId === resp.ilink_bot_id ? prev.syncBuf : '',
            contextTokens: prev?.accountId === resp.ilink_bot_id ? prev.contextTokens : {},
            boundAt: this.doNow().toISOString(),
          }
          this.store.save(saved)
          this.pauseUntilMs = 0
          session.status = 'confirmed'
          session.accountId = saved.accountId
          session.userId = saved.userId
          session.message = `连接成功！已绑定个人微信（${saved.userId || saved.accountId}）`
          this.opts.onConnected?.({ accountId: saved.accountId, userId: saved.userId, baseUrl: saved.baseUrl })
          this.opts.onStateChange?.()
          return
        }
      }

      await this.sleepAbortable(1000, session.abort.signal)
    }

    if (this.qr === session && session.status !== 'confirmed') {
      session.status = 'expired'
      session.message = '二维码等待超时，请点击「刷新二维码」重新扫码。'
      this.opts.onStateChange?.()
    }
  }

  // --- Internal getUpdates long-poll monitor ---

  private async runMonitor(signal: AbortSignal): Promise<void> {
    const initial = this.store.load()
    if (!initial?.botToken) return

    let nextTimeoutMs = DEFAULT_LONG_POLL_MS
    let consecutiveFailures = 0

    while (!signal.aborted && this.opts.enabled()) {
      const session = this.store.load()
      if (!session?.botToken) break

      const nowMs = this.doNow().getTime()
      if (this.pauseUntilMs > nowMs) {
        this.monitorConnected = false
        this.monitorConnecting = false
        await this.sleepAbortable(Math.min(60_000, this.pauseUntilMs - nowMs), signal)
        continue
      }

      const ep = this.resolveEndpoint(session.baseUrl)
      try {
        const raw = await this.apiPost({
          baseUrl: ep.baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: session.syncBuf ?? '', base_info: baseInfo() },
          token: session.botToken,
          relayToken: ep.relayToken,
          timeoutMs: nextTimeoutMs,
          signal,
        })
        const resp = parseWeixinApiJson<GetUpdatesResponse>(raw)
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms
        }
        const apiFailed = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)
        if (apiFailed) {
          if (resp.ret === STALE_TOKEN_ERRCODE || resp.errcode === STALE_TOKEN_ERRCODE) {
            this.pauseUntilMs = this.doNow().getTime() + SESSION_PAUSE_MS
            this.monitorConnected = false
            this.monitorConnecting = false
            this.opts.onError?.('个人微信插件登录态已失效（errcode -14），请在微信设置中重新扫码连接。')
            continue
          }
          consecutiveFailures += 1
          this.opts.onError?.(`微信长轮询返回异常（${resp.errcode ?? resp.ret}）：${this.scrub(resp.errmsg ?? '未知错误', session.botToken, ep.relayToken)}`)
          await this.sleepAbortable(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
          continue
        }

        consecutiveFailures = 0
        this.monitorConnecting = false
        this.monitorConnected = true
        this.opts.onRecovered?.()

        if (resp.get_updates_buf && resp.get_updates_buf !== session.syncBuf) {
          session.syncBuf = resp.get_updates_buf
          this.store.updateSyncBuf(resp.get_updates_buf)
        }

        for (const msg of resp.msgs ?? []) {
          // Skip bot's own outbound messages echoed in sync stream
          if (msg.message_type === 2) continue
          const from = (msg.from_user_id ?? '').trim()
          if (!from) continue
          if (!session.userId) {
            session.userId = from
            this.store.save(session)
            this.opts.onConnected?.({ accountId: session.accountId, userId: from, baseUrl: session.baseUrl })
          }
          if (msg.context_token) {
            this.store.setContextToken(from, msg.context_token)
          }
          const text = extractInboundText(msg)
          if (!text) continue
          const msgId = (msg.message_id ?? '').trim()
            || msg.item_list?.find(i => i.msg_id)?.msg_id?.trim()
            || `${msg.create_time_ms ?? Date.now()}-${from}`

          if (this.opts.enableTyping) {
            void this.sendTypingBestEffort(session, from, msg.context_token)
          }

          this.opts.onInbound({ from, chatId: from, messageId: msgId, text })
        }
      } catch (err) {
        if (signal.aborted) return
        if (err instanceof Error && err.name === 'AbortError') {
          // Normal client-side long-poll timeout: connection is healthy, loop immediately
          consecutiveFailures = 0
          this.monitorConnecting = false
          this.monitorConnected = true
          this.opts.onRecovered?.()
          continue
        }
        consecutiveFailures += 1
        this.opts.onError?.(`微信长轮询网络异常：${this.scrub(describe(err), session.botToken, ep.relayToken)}`)
        await this.sleepAbortable(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      }
    }
  }

  private async sendTypingBestEffort(session: WechatIlinkSession, userId: string, contextToken?: string, status: 1 | 2 = 1): Promise<void> {
    try {
      const ep = this.resolveEndpoint(session.baseUrl)
      const nowMs = this.doNow().getTime()
      let cached = this.typingCache.get(userId)
      if (!cached || cached.expiresAt <= nowMs) {
        const raw = await this.apiPost({
          baseUrl: ep.baseUrl,
          endpoint: 'ilink/bot/getconfig',
          body: { ilink_user_id: userId, ...(contextToken ? { context_token: contextToken } : {}), base_info: baseInfo() },
          token: session.botToken,
          relayToken: ep.relayToken,
          timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
        })
        const cfg = JSON.parse(raw) as { typing_ticket?: string }
        if (cfg.typing_ticket) {
          cached = { ticket: cfg.typing_ticket, expiresAt: nowMs + 10 * 60_000 }
          this.typingCache.set(userId, cached)
        }
      }
      if (!cached?.ticket) return
      await this.apiPost({
        baseUrl: ep.baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        body: { ilink_user_id: userId, typing_ticket: cached.ticket, status, base_info: baseInfo() },
        token: session.botToken,
        relayToken: ep.relayToken,
        timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      })
    } catch { /* typing indicator is purely cosmetic */ }
  }

  // --- Low-level HTTP helpers ---

  private async apiGet(params: {
    baseUrl: string
    endpoint: string
    headers?: Record<string, string>
    relayToken?: string
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<string> {
    const url = new URL(params.endpoint, ensureSlash(params.baseUrl))
    const { signal, cleanup } = this.withTimeout(params.timeoutMs, params.signal)
    try {
      const res = await this.doFetch(url.toString(), {
        method: 'GET',
        headers: getHeaders(params.headers, params.relayToken),
        signal,
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${this.scrub(text.slice(0, 200), undefined, params.relayToken)}`)
      return text
    } finally {
      cleanup()
    }
  }

  private async apiPost(params: {
    baseUrl: string
    endpoint: string
    body: unknown
    token?: string
    relayToken?: string
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<string> {
    const url = new URL(params.endpoint, ensureSlash(params.baseUrl))
    const { signal, cleanup } = this.withTimeout(params.timeoutMs, params.signal)
    try {
      const res = await this.doFetch(url.toString(), {
        method: 'POST',
        headers: postHeaders(params.token, params.relayToken),
        body: JSON.stringify(params.body),
        signal,
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${this.scrub(text.slice(0, 200), params.token, params.relayToken)}`)
      return text
    } finally {
      cleanup()
    }
  }

  private withTimeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    if (!external) {
      return { signal: controller.signal, cleanup: () => clearTimeout(timer) }
    }
    if (external.aborted) {
      clearTimeout(timer)
      controller.abort()
      return { signal: controller.signal, cleanup: () => {} }
    }
    const onAbort = () => controller.abort()
    external.addEventListener('abort', onAbort, { once: true })
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer)
        external.removeEventListener('abort', onAbort)
      },
    }
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      timer.unref?.()
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private scrub(text: string, ...secrets: (string | undefined)[]): string {
    if (!text) return text
    let out = text
    for (const secret of secrets) {
      if (secret && secret.length > 0) out = out.split(secret).join('***')
    }
    return out
  }
}
