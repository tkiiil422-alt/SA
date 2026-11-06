/**
 * Gmail as a Source: an IMAP poll loop turns allowed mail into Triggers, and the outbox channel replies over SMTP.
 *
 * The transport is hidden behind two small interfaces (`ImapClientLike`, `SmtpTransportLike`) so tests drive the whole
 * path with fakes and never open a socket. The app password comes from the vault through `config()`; it never appears in
 * a Trigger, an event, a status or an error message.
 *
 * Attachments are staged under `<stateDir>/inbox/<triggerId>/` (safe file names, size capped by `maxAttachmentMb`); the
 * launcher copies that directory into the ticket workspace's `inbox/` on its next start. See `runtime.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { createTransport } from 'nodemailer'
import type { EmailOptions } from '../admin/options.ts'
import { key } from '../core/ids.ts'
import type { Trigger } from '../core/model.ts'
import type { OutboundMessage, ScopeResult, SourceScope } from '../core/ports.ts'

export const EMAIL_SOURCE = 'email'
export const EMAIL_HOST = 'imap.gmail.com'
export const EMAIL_IMAP_PORT = 993
export const EMAIL_SMTP_HOST = 'smtp.gmail.com'
export const EMAIL_SMTP_PORT = 465
/** The IMAP keyword (Gmail label) added after a message was handled. */
export const EMAIL_KEYWORD = 'superagent'

/** The options plus the vault password, read live so a console change applies to the next poll. */
export type EmailConfig = EmailOptions & { password: string }

export interface RawEmail {
  uid: number
  source: Buffer
}

/** The IMAP operations the poll loop needs; the default implementation wraps `ImapFlow`. */
export interface ImapClientLike {
  connect(): Promise<void>
  fetchUnseen(): Promise<RawEmail[]>
  markProcessed(uid: number, keyword: string): Promise<void>
  logout(): Promise<void>
}

export interface SmtpMessage {
  from: string
  to: string
  subject: string
  text: string
  inReplyTo?: string
  references?: string
}

/** The SMTP operations the channel needs; the default implementation wraps `nodemailer`. */
export interface SmtpTransportLike {
  send(message: SmtpMessage): Promise<void>
  verify(): Promise<void>
  close?(): void
}

export type EmailEventKind = 'email.received' | 'email.ignored' | 'email.sent' | 'email.failed'

export interface EmailEvent {
  kind: EmailEventKind
  level: 'info' | 'warn'
  text: string
  data?: Record<string, unknown>
}

export interface EmailStatus {
  state: 'off' | 'connecting' | 'connected' | 'error'
  lastPollAt?: string
  lastError?: string
  processed: number
}

export interface EmailTestResult {
  ok: boolean
  message: string
  imap: { ok: boolean; message: string }
  smtp: { ok: boolean; message: string }
}

export interface EmailSourceOptions {
  config: () => EmailConfig
  /** Receives each allowed message, after it was marked processed. */
  onTrigger: (trigger: Trigger) => void
  /** Ignored/failed/sent notifications; never carries a body or the password. */
  onEvent?: (event: EmailEvent) => void
  /** Directory attachments are staged under, keyed by trigger id. */
  attachmentRoot: string
  imapFactory?: (config: EmailConfig) => ImapClientLike
  smtpFactory?: (config: EmailConfig) => SmtpTransportLike
  now?: () => Date
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function headerText(mail: ParsedMail, name: string): string {
  const value = mail.headers.get(name)
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => String(item)).join(', ')
  if (typeof value === 'object' && value !== null && 'value' in value) return String((value as { value: unknown }).value)
  return ''
}

/** The first sender address, lower-cased; empty when the message has no usable From. */
function senderOf(mail: ParsedMail): string {
  const first = mail.from?.value?.[0]?.address
  return typeof first === 'string' ? first.trim().toLowerCase() : ''
}

function messageIdOf(mail: ParsedMail): string {
  const value = typeof mail.messageId === 'string' ? mail.messageId.trim() : ''
  return value
}

/** The thread root: the first References entry, else the message's own Message-ID. */
function rootOf(mail: ParsedMail, messageId: string): string {
  const references = mail.references
  const first = Array.isArray(references) ? references[0] : references
  const value = typeof first === 'string' ? first.trim() : ''
  return value !== '' ? value : messageId
}

/** Body text up to the first quoted-reply line (`>`); the quoted original is not part of the request. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/)
  const firstQuote = lines.findIndex(line => /^\s*>/.test(line))
  const kept = firstQuote === -1 ? lines : lines.slice(0, firstQuote)
  return kept.join('\n').replace(/\s+$/u, '')
}

/** A file name that cannot leave the staging directory or surprise the host filesystem. */
export function safeFileName(name: string, fallback: string): string {
  const base = name
    .replace(/[\\/]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return base === '' ? fallback : base.slice(0, 200)
}

/** Why a message was ignored; kept stable so the event can name it without the payload. */
export type EmailSkip = 'unknown_sender' | 'auto_submitted' | 'mailing_list' | 'bulk' | 'self_sent'

function skipReason(mail: ParsedMail, config: EmailConfig, sender: string): EmailSkip | undefined {
  const autoSubmitted = headerText(mail, 'auto-submitted').trim().toLowerCase()
  if (autoSubmitted !== '' && autoSubmitted !== 'no') return 'auto_submitted'
  // mailparser folds List-Id/List-Unsubscribe/List-Post into one structured `list` header; accept both shapes.
  const list = mail.headers.get('list')
  if ((typeof list === 'object' && list !== null)
    || headerText(mail, 'list-id').trim() !== ''
    || headerText(mail, 'list-unsubscribe').trim() !== '') return 'mailing_list'
  const precedence = headerText(mail, 'precedence').trim().toLowerCase()
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return 'bulk'
  if (sender !== '' && sender === config.address.trim().toLowerCase()) return 'self_sent'
  if (!config.allowedSenders.some(allowed => allowed.trim().toLowerCase() === sender)) return 'unknown_sender'
  return undefined
}

const SKIP_TEXT: Record<EmailSkip, string> = {
  unknown_sender: '发件人不在允许名单里，已忽略',
  auto_submitted: '自动发送的邮件，已忽略',
  mailing_list: '邮件列表邮件，已忽略',
  bulk: '批量邮件，已忽略',
  self_sent: '自己发出的邮件，已忽略',
}

/** Build the Trigger for one allowed message. */
export function triggerFromMail(
  mail: ParsedMail,
  input: { uid: number; now: Date; config: EmailConfig; skippedAttachments?: readonly string[] },
): Trigger {
  const messageId = messageIdOf(mail) || `<uid-${input.uid}@superagent.local>`
  const root = rootOf(mail, messageId)
  const sender = senderOf(mail)
  const subject = (mail.subject ?? '').trim()
  let body = stripQuoted(mail.text ?? '')
  for (const name of input.skippedAttachments ?? []) {
    body += `${body === '' ? '' : '\n\n'}（附件 ${name} 超过 ${input.config.maxAttachmentMb} MB，已跳过）`
  }
  const text = subject === '' ? body : `${subject}\n\n${body}`
  const at = mail.date instanceof Date && Number.isFinite(mail.date.getTime()) ? mail.date.toISOString() : input.now.toISOString()
  return {
    id: key('trigger', EMAIL_SOURCE, messageId),
    source: EMAIL_SOURCE,
    threads: [{ source: EMAIL_SOURCE, id: root }],
    actor: { source: EMAIL_SOURCE, id: sender },
    human: true,
    addressed: 'direct',
    at,
    text,
    channel: { source: EMAIL_SOURCE, thread: root, address: { messageId, subject, from: sender } },
    meta: { direct: true },
  }
}

// --- Default transports --------------------------------------------------------------------------------------------

function defaultImap(config: EmailConfig): ImapClientLike {
  const client = new ImapFlow({
    host: EMAIL_HOST,
    port: EMAIL_IMAP_PORT,
    secure: true,
    auth: { user: config.address, pass: config.password },
    logger: false,
  })
  return {
    connect: async () => { await client.connect() },
    fetchUnseen: async () => {
      const lock = await client.getMailboxLock('INBOX')
      try {
        const found = await client.search({ seen: false }, { uid: true })
        const uids = Array.isArray(found) ? found : []
        if (uids.length === 0) return []
        const out: RawEmail[] = []
        for await (const message of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
          if (message.source === undefined) continue
          out.push({ uid: Number(message.uid), source: Buffer.from(message.source) })
        }
        return out
      } finally {
        lock.release()
      }
    },
    markProcessed: async (uid, keyword) => {
      // Seen first: if a server refuses the custom keyword (Gmail labels), the message must not be fetched again.
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
      try {
        await client.messageFlagsAdd(uid, [keyword], { uid: true })
      } catch {
        // A label the server does not accept is cosmetic; the message is already handled.
      }
    },
    logout: async () => { await client.logout() },
  }
}

function defaultSmtp(config: EmailConfig): SmtpTransportLike {
  const transport = createTransport({
    host: EMAIL_SMTP_HOST,
    port: EMAIL_SMTP_PORT,
    secure: true,
    auth: { user: config.address, pass: config.password },
  })
  return {
    send: async message => {
      await transport.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
        ...(message.references === undefined ? {} : { references: message.references }),
      })
    },
    verify: async () => { await transport.verify() },
    close: () => transport.close(),
  }
}

/** Whether a reply subject already carries a reply prefix. */
const REPLY_PREFIX = /^\s*(re|aw|sv|答复)\s*:/i

export class EmailSource implements SourceScope {
  readonly source = EMAIL_SOURCE
  private readonly doNow: () => Date
  private readonly imapFactory: (config: EmailConfig) => ImapClientLike
  private readonly smtpFactory: (config: EmailConfig) => SmtpTransportLike
  private state: EmailStatus = { state: 'off', processed: 0 }
  private timer?: NodeJS.Timeout
  private running = false
  private polling = false

  constructor(private readonly options: EmailSourceOptions) {
    this.doNow = options.now ?? (() => new Date())
    this.imapFactory = options.imapFactory ?? defaultImap
    this.smtpFactory = options.smtpFactory ?? defaultSmtp
  }

  /** A direct mail is listened to only while the source is enabled. */
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    if (input.source !== EMAIL_SOURCE || !this.options.config().enabled) return { listened: false, reason: 'source_disabled' }
    return { listened: true, observed: false }
  }

  status(): EmailStatus {
    return { ...this.state }
  }

  /** Start polling if it is not already running; the first poll runs at once. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.poll()
  }

  /** Stop the loop. Safe when it never started. */
  stop(): void {
    this.running = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.state = { ...this.state, state: 'off' }
  }

  /** Restart so changed credentials, interval or whitelist apply; a running poll finishes and schedules nothing. */
  async restart(): Promise<void> {
    this.stop()
    this.start()
  }

  /** Log in to IMAP and verify SMTP. Never throws and never echoes the password. */
  async test(): Promise<EmailTestResult> {
    const config = this.options.config()
    if (config.address.trim() === '' || config.password === '') {
      const message = '请先填写邮箱地址和应用专用密码。'
      return { ok: false, message, imap: { ok: false, message }, smtp: { ok: false, message } }
    }
    let imap: { ok: boolean; message: string }
    try {
      const client = this.imapFactory(config)
      try {
        await client.connect()
        imap = { ok: true, message: 'IMAP 登录成功。' }
      } finally {
        try { await client.logout() } catch { /* a failed login has nothing to log out */ }
      }
    } catch (error) {
      imap = { ok: false, message: this.scrub(`IMAP 登录失败：${describe(error)}`, config) }
    }
    let smtp: { ok: boolean; message: string }
    try {
      const transport = this.smtpFactory(config)
      try {
        await transport.verify()
        smtp = { ok: true, message: 'SMTP 验证成功。' }
      } finally {
        transport.close?.()
      }
    } catch (error) {
      smtp = { ok: false, message: this.scrub(`SMTP 验证失败：${describe(error)}`, config) }
    }
    const ok = imap.ok && smtp.ok
    return { ok, message: ok ? '连接正常，可以收信和回信。' : '连接失败，请检查地址、应用专用密码和网络。', imap, smtp }
  }

  /** Reply in-thread through SMTP. Failures are emitted and rethrown so the outbox effect retries. */
  async deliver(message: OutboundMessage): Promise<void> {
    const config = this.options.config()
    if (!config.enabled) throw new Error('邮箱来源未启用')
    const address = message.channel.address
    const to = (address.from ?? '').trim()
    if (to === '') throw new Error('这封邮件缺少回复地址')
    const original = (address.subject ?? '').trim()
    const subject = REPLY_PREFIX.test(original) ? original : `Re: ${original}`
    const from = config.displayName.trim() === ''
      ? config.address
      : `"${config.displayName.trim().replace(/"/g, '')}" <${config.address}>`
    const messageId = (address.messageId ?? '').trim()
    try {
      const transport = this.smtpFactory(config)
      try {
        await transport.send({
          from,
          to,
          subject,
          text: message.text,
          ...(messageId === '' ? {} : { inReplyTo: messageId, references: messageId }),
        })
      } finally {
        transport.close?.()
      }
      this.emit({ kind: 'email.sent', level: 'info', text: '邮件回复已发送', data: { ticketId: message.ticketId ?? '' } })
    } catch (error) {
      const text = this.scrub(describe(error), config)
      this.emit({ kind: 'email.failed', level: 'warn', text: `邮件回复发送失败，将稍后重试：${text}` })
      throw error
    }
  }

  private schedule(): void {
    if (!this.running) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    const seconds = Math.max(15, Math.min(3600, Math.trunc(this.options.config().pollSeconds)))
    this.timer = setTimeout(() => { void this.poll() }, seconds * 1000)
    this.timer.unref()
  }

  private async poll(): Promise<void> {
    if (!this.running) return
    if (this.polling) {
      this.schedule()
      return
    }
    this.polling = true
    const config = this.options.config()
    try {
      if (!config.enabled || config.address.trim() === '' || config.password === '') {
        this.state = { ...this.state, state: 'off' }
        return
      }
      this.state = { ...this.state, state: 'connecting' }
      const client = this.imapFactory(config)
      try {
        await client.connect()
        this.state = { ...this.state, state: 'connected' }
        const messages = await client.fetchUnseen()
        for (const raw of messages) {
          await this.processOne(client, raw, config)
        }
      } finally {
        try { await client.logout() } catch { /* the connection may already be gone */ }
      }
      this.state = {
        state: 'connected',
        lastPollAt: this.doNow().toISOString(),
        processed: this.state.processed,
        ...(this.state.lastError === undefined ? {} : { lastError: this.state.lastError }),
      }
    } catch (error) {
      const message = this.scrub(describe(error), config)
      this.state = { ...this.state, state: 'error', lastError: message, lastPollAt: this.doNow().toISOString() }
      this.emit({ kind: 'email.failed', level: 'warn', text: `收信失败：${message}` })
    } finally {
      this.polling = false
      this.schedule()
    }
  }

  private async processOne(client: ImapClientLike, raw: RawEmail, config: EmailConfig): Promise<void> {
    let mail: ParsedMail
    try {
      mail = await simpleParser(raw.source)
    } catch (error) {
      this.emit({ kind: 'email.failed', level: 'warn', text: `无法解析一封邮件：${this.scrub(describe(error), config)}` })
      await this.mark(client, raw.uid, config)
      return
    }
    const sender = senderOf(mail)
    const skip = skipReason(mail, config, sender)
    if (skip !== undefined) {
      this.emit({
        kind: 'email.ignored',
        level: 'info',
        text: SKIP_TEXT[skip],
        // The reason and sender are enough to explain a skip; the message body and subject stay out of the log.
        data: { reason: skip, from: sender },
      })
      this.state = { ...this.state, processed: this.state.processed + 1 }
      await this.mark(client, raw.uid, config)
      return
    }

    const messageId = messageIdOf(mail) || `<uid-${raw.uid}@superagent.local>`
    const triggerId = key('trigger', EMAIL_SOURCE, messageId)
    const skippedAttachments = this.saveAttachments(mail, triggerId, config)
    const trigger = triggerFromMail(mail, { uid: raw.uid, now: this.doNow(), config, skippedAttachments })
    try {
      this.options.onTrigger(trigger)
    } finally {
      this.state = { ...this.state, processed: this.state.processed + 1 }
      await this.mark(client, raw.uid, config)
    }
  }

  /** Stage attachments; returns the names that exceeded the cap. Never throws for one bad attachment. */
  private saveAttachments(mail: ParsedMail, triggerId: string, config: EmailConfig): string[] {
    if (mail.attachments.length === 0) return []
    const maxBytes = config.maxAttachmentMb * 1024 * 1024
    const directory = join(this.options.attachmentRoot, triggerId)
    const skipped: string[] = []
    let created = false
    mail.attachments.forEach((attachment, index) => {
      const original = attachment.filename ?? `attachment-${index + 1}`
      const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.alloc(0)
      if (content.length > maxBytes) {
        skipped.push(original)
        return
      }
      const name = safeFileName(original, `attachment-${index + 1}`)
      try {
        if (!created) {
          mkdirSync(directory, { recursive: true, mode: 0o700 })
          created = true
        }
        writeFileSync(join(directory, name), content, { mode: 0o600 })
      } catch {
        // A single unwritable attachment must not drop the message; the worker simply sees no file for it.
        skipped.push(original)
      }
    })
    return skipped
  }

  private async mark(client: ImapClientLike, uid: number, config: EmailConfig): Promise<void> {
    try {
      await client.markProcessed(uid, EMAIL_KEYWORD)
    } catch (error) {
      this.emit({ kind: 'email.failed', level: 'warn', text: `无法标记邮件为已处理：${this.scrub(describe(error), config)}` })
    }
  }

  private scrub(text: string, config: EmailConfig): string {
    let value = text
    if (config.password !== '') value = value.split(config.password).join('***')
    return value
  }

  private emit(event: EmailEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch {
      // Logging must never break the poll loop or a delivery.
    }
  }
}
