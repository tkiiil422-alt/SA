/**
 * The Gmail source: whitelist and skip rules, Trigger shape, attachments, replies, status and secret hygiene.
 *
 * IMAP and SMTP are fakes; `simpleParser` still parses real RFC 822 bytes, so the header and MIME behaviour under test is
 * the same one the default transports feed it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmailSource, EMAIL_KEYWORD, type EmailConfig, type EmailEvent, type ImapClientLike, type RawEmail, type SmtpMessage, type SmtpTransportLike } from '../src/sources/email.ts'
import { key } from '../src/core/ids.ts'
import type { Trigger } from '../src/core/model.ts'

const PASSWORD = 'app-password-super-secret'
const NOW = new Date('2026-01-02T03:04:05.000Z')

const dirs: string[] = []
const sources: EmailSource[] = []

afterEach(() => {
  for (const source of sources.splice(0)) source.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-email-'))
  dirs.push(dir)
  return dir
}

function config(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    enabled: true,
    address: 'me@example.com',
    displayName: 'Me',
    allowedSenders: ['friend@example.com'],
    pollSeconds: 60,
    maxAttachmentMb: 1,
    password: PASSWORD,
    ...overrides,
  }
}

class FakeImap implements ImapClientLike {
  connected = false
  loggedOut = false
  marked: { uid: number; keyword: string }[] = []
  constructor(private readonly messages: RawEmail[], private readonly failConnect?: Error) {}
  async connect(): Promise<void> {
    if (this.failConnect) throw this.failConnect
    this.connected = true
  }
  async fetchUnseen(): Promise<RawEmail[]> {
    return this.messages
  }
  async markProcessed(uid: number, keyword: string): Promise<void> {
    this.marked.push({ uid, keyword })
  }
  async logout(): Promise<void> {
    this.loggedOut = true
  }
}

class FakeSmtp implements SmtpTransportLike {
  sent: SmtpMessage[] = []
  verified = false
  closed = false
  constructor(private readonly failVerify?: Error) {}
  async send(message: SmtpMessage): Promise<void> {
    this.sent.push(message)
  }
  async verify(): Promise<void> {
    if (this.failVerify) throw this.failVerify
    this.verified = true
  }
  close(): void {
    this.closed = true
  }
}

interface MessageInput {
  from?: string
  subject?: string
  messageId?: string
  references?: string[]
  headers?: Record<string, string>
  text?: string
  attachments?: { filename: string; content: Buffer }[]
}

/** Build RFC 822 bytes the way a mail client would. */
function rawMail(input: MessageInput = {}): Buffer {
  const from = input.from ?? 'Friend <friend@example.com>'
  const subject = input.subject ?? 'Please fix the typo'
  const messageId = input.messageId ?? '<msg-1@example.com>'
  const lines = [
    `From: ${from}`,
    'To: me@example.com',
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: Fri, 02 Jan 2026 03:04:05 +0000`,
    ...(input.references && input.references.length > 0 ? [`References: ${input.references.join(' ')}`] : []),
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
  ]
  const text = input.text ?? 'Fix the typo please.\n> quoted original'
  const attachments = input.attachments ?? []
  if (attachments.length === 0) {
    lines.push('Content-Type: text/plain; charset=utf-8', '', text)
    return Buffer.from(lines.join('\r\n'))
  }
  lines.push('MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="BOUND"', '')
  lines.push('--BOUND', 'Content-Type: text/plain; charset=utf-8', '', text)
  for (const attachment of attachments) {
    lines.push(
      '--BOUND',
      `Content-Type: application/octet-stream; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      attachment.content.toString('base64'),
    )
  }
  lines.push('--BOUND--', '')
  return Buffer.from(lines.join('\r\n'))
}

interface Harness {
  source: EmailSource
  triggers: Trigger[]
  events: EmailEvent[]
  imaps: FakeImap[]
  smtp: FakeSmtp
  attachmentRoot: string
}

function harness(messages: RawEmail[], options: {
  cfg?: Partial<EmailConfig>
  failConnect?: Error
  failVerify?: Error
} = {}): Harness {
  const triggers: Trigger[] = []
  const events: EmailEvent[] = []
  const imaps: FakeImap[] = []
  const smtp = new FakeSmtp(options.failVerify)
  const attachmentRoot = tempDir()
  const source = new EmailSource({
    config: () => config(options.cfg),
    onTrigger: trigger => { triggers.push(trigger) },
    onEvent: event => { events.push(event) },
    attachmentRoot,
    imapFactory: () => {
      const imap = new FakeImap(messages, options.failConnect)
      imaps.push(imap)
      return imap
    },
    smtpFactory: () => smtp,
    now: () => NOW,
  })
  sources.push(source)
  return { source, triggers, events, imaps, smtp, attachmentRoot }
}

/** Start the poll loop and wait until one successful pass finished. */
async function pollOnce(h: Harness): Promise<void> {
  h.source.start()
  await vi.waitFor(() => {
    expect(h.source.status().state).toBe('connected')
    expect(h.source.status().lastPollAt).toBe(NOW.toISOString())
  })
}

describe('EmailSource intake', () => {
  it('turns allowed mail into a direct Trigger with the subject, unquoted body, root thread and channel address', async () => {
    const h = harness([{ uid: 11, source: rawMail({ references: ['<root@example.com>', '<parent@example.com>'] }) }])
    await pollOnce(h)

    expect(h.triggers).toHaveLength(1)
    const trigger = h.triggers[0]!
    expect(trigger.id).toBe(key('trigger', 'email', '<msg-1@example.com>'))
    expect(trigger.source).toBe('email')
    expect(trigger.threads).toEqual([{ source: 'email', id: '<root@example.com>' }])
    expect(trigger.actor).toEqual({ source: 'email', id: 'friend@example.com' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.at).toBe('2026-01-02T03:04:05.000Z')
    expect(trigger.text).toBe('Please fix the typo\n\nFix the typo please.')
    expect(trigger.channel).toEqual({
      source: 'email',
      thread: '<root@example.com>',
      address: { messageId: '<msg-1@example.com>', subject: 'Please fix the typo', from: 'friend@example.com' },
    })
    expect(trigger.meta).toEqual({ direct: true })
    expect(h.imaps[0]!.marked).toEqual([{ uid: 11, keyword: EMAIL_KEYWORD }])
    expect(h.source.status()).toMatchObject({ state: 'connected', processed: 1, lastPollAt: NOW.toISOString() })
  })

  it('uses the Message-ID as the root when References is absent', async () => {
    const h = harness([{ uid: 12, source: rawMail({ messageId: '<solo@example.com>' }) }])
    await pollOnce(h)

    expect(h.triggers[0]!.threads).toEqual([{ source: 'email', id: '<solo@example.com>' }])
  })

  it('ignores unknown senders, auto-submitted mail, mailing-list mail and bulk mail, and marks each processed', async () => {
    const h = harness([
      { uid: 1, source: rawMail({ from: 'Stranger <stranger@example.com>', messageId: '<unknown@example.com>' }) },
      { uid: 2, source: rawMail({ headers: { 'Auto-Submitted': 'auto-replied' }, messageId: '<auto@example.com>' }) },
      { uid: 3, source: rawMail({ headers: { 'List-Id': '<list.example.com>' }, messageId: '<list@example.com>' }) },
      { uid: 4, source: rawMail({ headers: { Precedence: 'bulk' }, messageId: '<bulk@example.com>' }) },
      { uid: 5, source: rawMail({ from: 'Me <me@example.com>', messageId: '<self@example.com>' }) },
    ])
    await pollOnce(h)

    expect(h.triggers).toHaveLength(0)
    expect(h.events.filter(event => event.kind === 'email.ignored').map(event => event.data?.reason)).toEqual([
      'unknown_sender', 'auto_submitted', 'mailing_list', 'bulk', 'self_sent',
    ])
    expect(h.imaps[0]!.marked.map(item => item.uid)).toEqual([1, 2, 3, 4, 5])
    expect(h.source.status().processed).toBe(5)
  })
})

describe('EmailSource attachments', () => {
  it('saves a safe file name and reports an attachment over the size cap in the body', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 1)
    const h = harness([{
      uid: 20,
      source: rawMail({
        messageId: '<attach@example.com>',
        attachments: [
          { filename: '../../evil.txt', content: Buffer.from('hello') },
          { filename: 'big.bin', content: big },
        ],
      }),
    }])
    await pollOnce(h)

    const trigger = h.triggers[0]!
    const directory = join(h.attachmentRoot, trigger.id)
    const names = readdirSync(directory)
    expect(names).toHaveLength(1)
    expect(names[0]).not.toMatch(/[\\/]/)
    expect(names[0]).not.toMatch(/^\./)
    expect(readFileSync(join(directory, names[0]!)).toString()).toBe('hello')
    expect(trigger.text).toContain('附件 big.bin 超过 1 MB，已跳过')
  })
})

describe('EmailSource delivery and status', () => {
  it('replies in thread with In-Reply-To/References and a Re: subject', async () => {
    const h = harness([])
    await h.source.deliver({
      id: 'reply-1',
      channel: {
        source: 'email',
        thread: '<root@example.com>',
        address: { messageId: '<msg-1@example.com>', subject: 'Please fix the typo', from: 'friend@example.com' },
      },
      text: 'Done.',
      kind: 'reply',
      ticketId: 't1',
    })

    expect(h.smtp.sent).toHaveLength(1)
    expect(h.smtp.sent[0]).toMatchObject({
      from: '"Me" <me@example.com>',
      to: 'friend@example.com',
      subject: 'Re: Please fix the typo',
      text: 'Done.',
      inReplyTo: '<msg-1@example.com>',
      references: '<msg-1@example.com>',
    })
    expect(h.smtp.closed).toBe(true)
    expect(h.events.map(event => event.kind)).toEqual(['email.sent'])
  })

  it('does not double the reply prefix', async () => {
    const h = harness([])
    await h.source.deliver({
      id: 'reply-2',
      channel: { source: 'email', thread: '<root>', address: { messageId: '<m>', subject: 'Re: Already', from: 'friend@example.com' } },
      text: 'Again.',
      kind: 'reply',
    })
    expect(h.smtp.sent[0]!.subject).toBe('Re: Already')
  })

  it('moves to error without leaking the password, and test() reports both sides', async () => {
    const failing = harness([], { failConnect: new Error(`login failed for ${PASSWORD}`) })
    failing.source.start()
    await vi.waitFor(() => expect(failing.source.status().state).toBe('error'))
    expect(failing.source.status().state).toBe('error')
    expect(failing.source.status().lastError).toContain('login failed')
    expect(JSON.stringify(failing.events)).not.toContain(PASSWORD)
    expect(JSON.stringify(failing.source.status())).not.toContain(PASSWORD)

    const good = harness([])
    const result = await good.source.test()
    expect(result).toEqual({
      ok: true,
      message: '连接正常，可以收信和回信。',
      imap: { ok: true, message: 'IMAP 登录成功。' },
      smtp: { ok: true, message: 'SMTP 验证成功。' },
    })
    expect(good.smtp.verified).toBe(true)
  })

  it('stops polling and reports off', async () => {
    const h = harness([{ uid: 30, source: rawMail() }])
    await pollOnce(h)
    h.source.stop()
    expect(h.source.status().state).toBe('off')
  })
})
