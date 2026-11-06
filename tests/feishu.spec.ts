import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/admin/api.ts'
import { AdminAuth } from '../src/admin/auth.ts'
import type { AdminHost } from '../src/admin/host.ts'
import { OptionsStore, defaultOptions, type FeishuOptions } from '../src/admin/options.ts'
import { createAdminServer } from '../src/admin/server.ts'
import type { Trigger } from '../src/core/model.ts'
import { key } from '../src/core/ids.ts'
import type { OutboundMessage } from '../src/core/ports.ts'
import { Effects } from '../src/effects/effects.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { Outbox } from '../src/outbox/outbox.ts'
import { CliSource } from '../src/sources/cli.ts'
import { CompositeScope } from '../src/sources/composite.ts'
import { FeishuSource, decryptEvent, parseEvent, verifySignature, type FeishuEvent } from '../src/sources/feishu.ts'

const TOKEN = 'verify-token'
const SECRET = 'app-secret-value'
const ENCRYPT = 'encrypt-key-value'
const CLI = 'cli-test-token'
const BASE: FeishuOptions = {
  enabled: true,
  mode: 'webhook',
  appId: 'cli_test',
  appSecret: SECRET,
  verificationToken: TOKEN,
  encryptKey: '',
  apiBase: 'https://feishu.test',
  groupMode: 'mention',
}

const closers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
})

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'feishu-spec-'))
}

function encryptFor(plain: string, encryptKey: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), iv)
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

interface MessageOptions {
  messageId?: string
  eventId?: string
  chatType?: 'p2p' | 'group'
  messageType?: string
  content?: string
  mentions?: unknown[]
  rootId?: string
  token?: string
  senderType?: string
  openId?: string
}

function messageEvent(o: MessageOptions = {}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: o.eventId ?? 'ev-1',
      event_type: 'im.message.receive_v1',
      token: o.token ?? TOKEN,
      create_time: '1700000000000',
      app_id: 'cli_test',
      tenant_key: 'tenant',
    },
    event: {
      sender: { sender_id: { open_id: o.openId ?? 'ou_user' }, sender_type: o.senderType ?? 'user' },
      message: {
        message_id: o.messageId ?? 'om_1',
        chat_id: 'oc_chat',
        chat_type: o.chatType ?? 'p2p',
        message_type: o.messageType ?? 'text',
        content: o.content ?? JSON.stringify({ text: 'hi' }),
        create_time: '1700000000000',
        mentions: o.mentions ?? [],
        ...(o.rootId ? { root_id: o.rootId } : {}),
      },
    },
  }
}

const BOT_MENTION = [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'SA' }]

function parse(body: unknown, extra: Partial<Parameters<typeof parseEvent>[1]> = {}): ReturnType<typeof parseEvent> {
  return parseEvent(JSON.stringify(body), { verificationToken: TOKEN, groupMode: 'mention', botOpenId: 'ou_bot', ...extra })
}

function triggerOf(result: ReturnType<typeof parseEvent>): Trigger {
  if (result.kind !== 'message') throw new Error(`expected a message, got ${result.kind}`)
  return result.trigger
}

/** A fake Feishu Open API: serves the token, bot info and reply endpoints, and records every call. */
function fakeFeishu(options: { replyCode?: number } = {}) {
  const calls: { url: string; method: string; body?: Record<string, unknown>; auth?: string }[] = []
  let tokenCalls = 0
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    calls.push({ url, method, ...(body ? { body } : {}), ...(auth ? { auth } : {}) })
    const json = (status: number, data: unknown): Response =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      tokenCalls += 1
      return json(200, { code: 0, tenant_access_token: `tok-${tokenCalls}`, expire: 7200 })
    }
    if (url.endsWith('/open-apis/bot/v3/info')) return json(200, { code: 0, bot: { open_id: 'ou_bot', app_name: 'SA 助手' } })
    if (url.includes('/open-apis/im/v1/messages/')) return json(200, { code: options.replyCode ?? 0, data: {} })
    return json(404, { code: 99 })
  }) as typeof fetch
  return { fetch: fetchFn, calls, tokenCalls: () => tokenCalls }
}

async function startCallback(config: FeishuOptions) {
  const received: Trigger[] = []
  const events: FeishuEvent[] = []
  const fake = fakeFeishu()
  const source = new FeishuSource({
    config: () => config,
    onTrigger: trigger => { received.push(trigger) },
    onEvent: event => { events.push(event) },
    fetch: fake.fetch,
  })
  const server = createServer((req, res) => { void source.handleHttp(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  closers.push(() => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const port = (server.address() as AddressInfo).port
  return { source, received, events, calls: fake.calls, url: `http://127.0.0.1:${port}/feishu/events` }
}

describe('decryptEvent and verifySignature', () => {
  it('round-trips an encrypted body with the key-derived AES key', () => {
    const plain = JSON.stringify({ hello: '你好' })
    expect(decryptEvent(encryptFor(plain, ENCRYPT), ENCRYPT)).toBe(plain)
  })

  it('verifies the signature over timestamp, nonce, key and raw body', () => {
    const sig = sha256Hex('1700nonce' + ENCRYPT + '{"a":1}')
    expect(verifySignature('1700', 'nonce', ENCRYPT, '{"a":1}', sig)).toBe(true)
    expect(verifySignature('1700', 'nonce', ENCRYPT, '{"a":2}', sig)).toBe(false)
    expect(verifySignature('1700', 'nonce', ENCRYPT, '{"a":1}', 'abc')).toBe(false)
  })
})

describe('parseEvent', () => {
  it('answers a url_verification challenge when the token matches', () => {
    expect(parse({ type: 'url_verification', token: TOKEN, challenge: 'c-1' })).toEqual({ kind: 'challenge', challenge: 'c-1' })
  })

  it('rejects a challenge with the wrong token', () => {
    expect(parse({ type: 'url_verification', token: 'bad', challenge: 'c-1' })).toEqual({ kind: 'reject', reason: 'token' })
  })

  it('rejects an event with the wrong token', () => {
    expect(parse(messageEvent({ token: 'bad' }))).toEqual({ kind: 'reject', reason: 'token' })
  })

  it('ignores event types other than im.message.receive_v1', () => {
    const event = messageEvent()
    event.header = { ...(event.header as object), event_type: 'im.chat.member.bot.added_v1' }
    expect(parse(event)).toEqual({ kind: 'ignore' })
  })

  it('turns a direct text message into a Trigger with its ids, thread and channel', () => {
    const trigger = triggerOf(parse(messageEvent()))
    expect(trigger.id).toBe(key('trigger', 'feishu', 'om_1'))
    expect(trigger.source).toBe('feishu')
    expect(trigger.threads).toEqual([{ source: 'feishu', id: 'oc_chat:om_1' }])
    expect(trigger.actor).toEqual({ source: 'feishu', id: 'ou_user' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.text).toBe('hi')
    expect(trigger.channel).toEqual({ source: 'feishu', thread: 'oc_chat:om_1', address: { chatId: 'oc_chat', messageId: 'om_1' } })
    expect(trigger.meta).toEqual({ chatType: 'p2p', chatId: 'oc_chat', direct: true })
  })

  it('uses the root message as the thread when a reply has one', () => {
    const trigger = triggerOf(parse(messageEvent({ rootId: 'om_root' })))
    expect(trigger.threads[0]?.id).toBe('oc_chat:om_root')
  })

  it('ignores an unmentioned group message under the mention mode', () => {
    expect(parse(messageEvent({ chatType: 'group' }))).toEqual({ kind: 'ignore' })
  })

  it('ignores a group message that mentions another user under the mention mode', () => {
    const mentions = [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: 'Other' }]
    expect(parse(messageEvent({ chatType: 'group', mentions }))).toEqual({ kind: 'ignore' })
  })

  it('accepts a group message that mentions the bot, stripping the placeholder', () => {
    const trigger = triggerOf(parse(messageEvent({
      chatType: 'group',
      mentions: BOT_MENTION,
      content: JSON.stringify({ text: '@_user_1 请 看看' }),
    })))
    expect(trigger.addressed).toBe('mention')
    expect(trigger.text).toBe('请 看看')
    expect(trigger.meta).toMatchObject({ chatType: 'group', direct: false })
  })

  it('accepts unmentioned group messages under the all mode without an addressed flag', () => {
    const trigger = triggerOf(parse(messageEvent({ chatType: 'group' }), { groupMode: 'all' }))
    expect(trigger.addressed).toBeUndefined()
  })

  it('joins the text of a post message', () => {
    const content = JSON.stringify({
      zh_cn: {
        title: '',
        content: [
          [{ tag: 'text', text: '第一行' }],
          [{ tag: 'text', text: '第二行 ' }, { tag: 'a', text: '链接', href: 'https://example.test' }],
        ],
      },
    })
    const trigger = triggerOf(parse(messageEvent({ messageType: 'post', content })))
    expect(trigger.text).toBe('第一行\n第二行 链接')
  })

  it('marks unsupported message types instead of reading them', () => {
    const trigger = triggerOf(parse(messageEvent({ messageType: 'image', content: JSON.stringify({ image_key: 'x' }) })))
    expect(trigger.text).toBe('[不支持的消息类型: image]')
  })

  it('decrypts an encrypted body when an encrypt key is set', () => {
    const body = { encrypt: encryptFor(JSON.stringify(messageEvent({ messageId: 'om_enc' })), ENCRYPT) }
    const result = parseEvent(JSON.stringify(body), { verificationToken: TOKEN, encryptKey: ENCRYPT, groupMode: 'mention' })
    expect(triggerOf(result).id).toBe(key('trigger', 'feishu', 'om_enc'))
  })
})

describe('FeishuSource callback', () => {
  it('answers a challenge over HTTP', async () => {
    const s = await startCallback(BASE)
    const response = await fetch(s.url, { method: 'POST', body: JSON.stringify({ type: 'url_verification', token: TOKEN, challenge: 'xyz' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge: 'xyz' })
  })


  it('accepts a 2.0-style challenge that carries the token in the header', () => {
    expect(parse({ schema: '2.0', type: 'url_verification', header: { token: TOKEN }, challenge: 'c-2' }))
      .toEqual({ kind: 'challenge', challenge: 'c-2' })
  })

  it('answers a challenge without calling Feishu first', async () => {
    const s = await startCallback(BASE)
    const response = await fetch(s.url, { method: 'POST', body: JSON.stringify({ type: 'url_verification', token: TOKEN, challenge: 'fast' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge: 'fast' })
    // The URL check must not wait on the bot lookup: no outbound request at all.
    expect(s.calls).toEqual([])
  })

  it('rejects a bad token before calling Feishu', async () => {
    const s = await startCallback(BASE)
    const response = await fetch(s.url, { method: 'POST', body: JSON.stringify(messageEvent({ token: 'bad' })) })
    expect(response.status).toBe(401)
    expect(s.calls).toEqual([])
    expect(s.events.some(event => event.kind === 'feishu.rejected')).toBe(true)
  })


  it('answers a plain challenge even when a key is stored on our side', async () => {
    // Feishu sends the challenge in the clear when the app has no encryption enabled.
    const s = await startCallback({ ...BASE, encryptKey: 'stored-but-unused' })
    const response = await fetch(s.url, { method: 'POST', body: JSON.stringify({ type: 'url_verification', token: TOKEN, challenge: 'plain-ok' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge: 'plain-ok' })
  })

  it('rejects an encrypted body signed with the wrong key and says why', async () => {
    const s = await startCallback({ ...BASE, encryptKey: ENCRYPT })
    const body = JSON.stringify({ encrypt: 'AAAA' })
    const response = await fetch(s.url, {
      method: 'POST', body,
      headers: { 'x-lark-request-timestamp': '1', 'x-lark-request-nonce': 'n', 'x-lark-signature': 'deadbeef' },
    })
    expect(response.status).toBe(401)
    expect(s.events.some(event => event.kind === 'feishu.rejected' && (event.data as any)?.encrypted === true)).toBe(true)
  })

  it('answers 404 while the source is disabled', async () => {
    const s = await startCallback({ ...BASE, enabled: false })
    const response = await fetch(s.url, { method: 'POST', body: JSON.stringify(messageEvent()) })
    expect(response.status).toBe(404)
    expect(s.received).toHaveLength(0)
  })

  it('hands on a message once per event_id', async () => {
    const s = await startCallback(BASE)
    const body = JSON.stringify(messageEvent({ eventId: 'ev-dedupe' }))
    const first = await fetch(s.url, { method: 'POST', body })
    const second = await fetch(s.url, { method: 'POST', body })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(s.received).toHaveLength(1)
    expect(s.received[0]?.addressed).toBe('direct')
  })

  it('rejects a bad token with 401 and logs only the reason', async () => {
    const s = await startCallback(BASE)
    const response = await fetch(s.url, { method: 'POST', body: JSON.stringify(messageEvent({ token: 'bad' })) })
    expect(response.status).toBe(401)
    expect(s.received).toHaveLength(0)
    expect(s.events[0]?.kind).toBe('feishu.rejected')
    expect(s.events[0]?.data).toEqual({ reason: 'token' })
    expect(JSON.stringify(s.events)).not.toContain(TOKEN)
  })

  it('checks the signature when an encrypt key is set', async () => {
    const s = await startCallback({ ...BASE, encryptKey: ENCRYPT })
    const body = JSON.stringify({ encrypt: encryptFor(JSON.stringify(messageEvent({ eventId: 'ev-sig', messageId: 'om_sig' })), ENCRYPT) })
    const headers = (sig: string) => ({
      'x-lark-request-timestamp': '1700',
      'x-lark-request-nonce': 'abc',
      'x-lark-signature': sig,
    })
    const bad = await fetch(s.url, { method: 'POST', body, headers: headers('deadbeef') })
    expect(bad.status).toBe(401)
    expect(s.events[0]?.data).toMatchObject({ reason: 'signature', encrypted: true })
    expect(s.received).toHaveLength(0)

    const good = await fetch(s.url, { method: 'POST', body, headers: headers(sha256Hex('1700abc' + ENCRYPT + body)) })
    expect(good.status).toBe(200)
    expect(s.received.map(t => t.id)).toEqual([key('trigger', 'feishu', 'om_sig')])
  })
})

describe('FeishuSource delivery and test', () => {
  it('replies through the reply endpoint with one cached tenant token', async () => {
    const fake = fakeFeishu()
    const source = new FeishuSource({ config: () => BASE, onTrigger: () => {}, fetch: fake.fetch })
    const message = (id: string): OutboundMessage => ({
      id,
      channel: { source: 'feishu', thread: 'oc_chat:om_1', address: { chatId: 'oc_chat', messageId: 'om_1' } },
      text: '收到',
      kind: 'reply',
    })
    await source.deliver(message('out-aaaa'))
    await source.deliver(message('out-bbbb'))
    const replies = fake.calls.filter(call => call.url.includes('/open-apis/im/v1/messages/'))
    expect(replies).toHaveLength(2)
    expect(replies[0]?.url).toBe('https://feishu.test/open-apis/im/v1/messages/om_1/reply')
    expect(replies[0]?.auth).toBe('Bearer tok-1')
    expect(replies[0]?.body).toEqual({ msg_type: 'text', content: JSON.stringify({ text: '收到' }), uuid: 'out-aaaa' })
    expect(fake.tokenCalls()).toBe(1)
  })

  it('reports Feishu errors without the secret or the token', async () => {
    const fake = fakeFeishu({ replyCode: 230001 })
    const source = new FeishuSource({ config: () => BASE, onTrigger: () => {}, fetch: fake.fetch })
    let message = ''
    try {
      await source.deliver({
        id: 'out-cccc',
        channel: { source: 'feishu', thread: 't', address: { messageId: 'om_1' } },
        text: 'x',
        kind: 'reply',
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('230001')
    expect(message).not.toContain(SECRET)
    expect(message).not.toContain('tok-1')
  })

  it('test() reports the bot name, and reports missing credentials without calling Feishu', async () => {
    const fake = fakeFeishu()
    const source = new FeishuSource({ config: () => BASE, onTrigger: () => {}, fetch: fake.fetch })
    expect(await source.test()).toEqual({ ok: true, message: expect.any(String), botName: 'SA 助手' })
    const empty = new FeishuSource({ config: () => ({ ...BASE, appSecret: '' }), onTrigger: () => {}, fetch: fake.fetch })
    expect((await empty.test()).ok).toBe(false)
  })
})

describe('CompositeScope', () => {
  it('routes each scope to the source it names and listens to nothing else', () => {
    const cli = new CliSource({ operatorId: 'op' })
    const feishu = new FeishuSource({ config: () => BASE, onTrigger: () => {}, fetch: fakeFeishu().fetch })
    const composite = new CompositeScope([cli, feishu])
    expect(composite.scope({ source: 'feishu', meta: { chatType: 'group' } })).toEqual({ listened: true, observed: true, row: 'group' })
    expect(composite.scope({ source: 'cli', meta: {} })).toMatchObject({ listened: true })
    expect(composite.scope({ source: 'slack', meta: {} })).toEqual({ listened: false, reason: 'source_disabled' })
  })

  it('does not listen to Feishu while the source is disabled', () => {
    const feishu = new FeishuSource({ config: () => ({ ...BASE, enabled: false }), onTrigger: () => {}, fetch: fakeFeishu().fetch })
    expect(new CompositeScope([feishu]).scope({ source: 'feishu', meta: {} })).toEqual({ listened: false, reason: 'source_disabled' })
  })
})

describe('feishu options section', () => {
  it('hides the secrets in the public view and keeps them when a write omits them', () => {
    const store = new OptionsStore(join(tempDir(), 'options.json'), defaultOptions({}))
    store.updateFeishu({ enabled: false, appId: 'cli', appSecret: SECRET, verificationToken: TOKEN, encryptKey: '', apiBase: 'https://open.feishu.cn', groupMode: 'mention' })
    const pub = store.getPublic().feishu
    expect(pub).toMatchObject({ appId: 'cli', appSecretSet: true, verificationTokenSet: true, encryptKeySet: false })
    expect('appSecret' in pub).toBe(false)
    expect(JSON.stringify(pub)).not.toContain(SECRET)

    store.updateFeishu({ enabled: false, appId: 'cli2', appSecret: '', verificationToken: undefined, encryptKey: 'enc', apiBase: 'https://open.feishu.cn', groupMode: 'all' })
    expect(store.get().feishu).toMatchObject({ appId: 'cli2', appSecret: SECRET, verificationToken: TOKEN, encryptKey: 'enc', groupMode: 'all' })
  })

  it('refuses to enable Feishu without its credentials', () => {
    const store = new OptionsStore(join(tempDir(), 'options.json'), defaultOptions({}))
    expect(() => store.updateFeishu({ enabled: true, appId: '', appSecret: '', verificationToken: '', encryptKey: '', apiBase: 'https://open.feishu.cn', groupMode: 'mention' }))
      .toThrow(/开启飞书/)
  })

  it('loads an options file that has no feishu section, using the defaults', () => {
    const file = join(tempDir(), 'options.json')
    writeFileSync(file, JSON.stringify({ budget: { enabled: true, perTicketUsd: 0.5, dailyUsd: 3 } }))
    const feishu = new OptionsStore(file, defaultOptions({})).get().feishu
    expect(feishu).toMatchObject({ enabled: false, groupMode: 'mention', apiBase: 'https://open.feishu.cn' })
  })
})

describe('admin API for feishu settings and callback', () => {
  it('serves the public view, keeps secrets on omitted writes, and gates the callback by enabled', async () => {
    const dir = tempDir()
    const store = new OptionsStore(join(dir, 'options.json'), defaultOptions({}))
    const db = new DatabaseSync(':memory:')
    const auth = new AdminAuth({ stateDir: dir, env: { SA_ADMIN_PASSWORD: 'test-password-123' } })
    auth.init()
    const feishu = new FeishuSource({ config: () => store.get().feishu, onTrigger: () => {}, fetch: fakeFeishu().fetch })
    const api = createAdminApi({
      host: {} as AdminHost,
      auth,
      options: store,
      ledger: new Ledger(db),
      events: new EventLog(db),
      cliToken: CLI,
    })
    const server = createAdminServer({
      api,
      staticHandler: () => false,
      port: 0,
      callbacks: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://admin.invalid')
        if (url.pathname !== '/feishu/events') return false
        await feishu.handleHttp(req, res)
        return true
      },
    })
    const { port } = await server.listen()
    closers.push(() => server.close())
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: `Bearer ${CLI}`, 'content-type': 'application/json' }
    const challenge = JSON.stringify({ type: 'url_verification', token: TOKEN, challenge: 'c' })

    const initial = await (await fetch(`${base}/api/settings/feishu`, { headers })).json() as Record<string, unknown>
    expect(initial).toMatchObject({ enabled: false, appSecretSet: false })
    expect('appSecret' in initial).toBe(false)

    const closed = await fetch(`${base}/feishu/events`, { method: 'POST', body: challenge })
    expect(closed.status).toBe(404)

    const saved = await fetch(`${base}/api/settings/feishu`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled: true, appId: 'cli_test', appSecret: SECRET, verificationToken: TOKEN, encryptKey: '', apiBase: 'https://feishu.test', groupMode: 'mention' }),
    })
    expect(saved.status).toBe(200)
    const text = await saved.text()
    expect(text).not.toContain(SECRET)

    const kept = await fetch(`${base}/api/settings/feishu`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled: true, appId: 'cli_test', apiBase: 'https://feishu.test', groupMode: 'all' }),
    })
    expect(kept.status).toBe(200)
    expect(store.get().feishu).toMatchObject({ appSecret: SECRET, verificationToken: TOKEN, groupMode: 'all' })

    // A page that echoes the GET view back must not be rejected for its read-only markers.
    const view = await (await fetch(`${base}/api/settings/feishu`, { headers })).json() as Record<string, unknown>
    const echoed = await fetch(`${base}/api/settings/feishu`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...view, enabled: true }),
    })
    expect(echoed.status, await echoed.clone().text()).toBe(200)
  })
})

describe('Outbox channels', () => {
  const waitUntil = (check: () => boolean, ms = 3000): Promise<void> => new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (check()) {
        resolve()
        return
      }
      if (Date.now() - started > ms) {
        reject(new Error('timed out'))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })

  const feishuMessage = (id: string): OutboundMessage => ({
    id,
    channel: { source: 'feishu', thread: 'oc_chat:om_1', address: { chatId: 'oc_chat', messageId: 'om_1' } },
    text: `reply ${id}`,
    kind: 'reply',
  })

  it('delivers a registered channel message and marks it sent', async () => {
    const db = new DatabaseSync(':memory:')
    const effects = new Effects(db, { pollMs: 5 })
    const outbox = new Outbox({ db, effects, retry: [1, 2] })
    const sent: string[] = []
    outbox.registerChannel('feishu', async message => { sent.push(message.text) })
    effects.start()
    outbox.send(feishuMessage('out-1'))
    await waitUntil(() => outbox.status('out-1') === 'sent')
    expect(sent).toEqual(['reply out-1'])
    await effects.drain()
  })

  it('retries a failing delivery until it succeeds', async () => {
    const db = new DatabaseSync(':memory:')
    const effects = new Effects(db, { pollMs: 5 })
    const outbox = new Outbox({ db, effects, retry: [1, 2] })
    let calls = 0
    outbox.registerChannel('feishu', async () => {
      calls += 1
      if (calls < 3) throw new Error('network down')
    })
    effects.start()
    outbox.send(feishuMessage('out-2'))
    await waitUntil(() => outbox.status('out-2') === 'sent')
    expect(calls).toBe(3)
    await effects.drain()
  })

  it('marks a message failed after six attempts', async () => {
    const db = new DatabaseSync(':memory:')
    const effects = new Effects(db, { pollMs: 5 })
    const outbox = new Outbox({ db, effects, retry: [1, 1] })
    let calls = 0
    outbox.registerChannel('feishu', async () => {
      calls += 1
      throw new Error('always down')
    })
    effects.start()
    outbox.send(feishuMessage('out-3'))
    await waitUntil(() => outbox.status('out-3') === 'failed')
    expect(calls).toBe(6)
    await effects.drain()
  })

  it('queues pending messages of a channel again when it is registered after a restart', async () => {
    const db = new DatabaseSync(':memory:')
    const firstEffects = new Effects(db, { pollMs: 5 })
    const first = new Outbox({ db, effects: firstEffects })
    first.send(feishuMessage('out-4'))
    expect(first.status('out-4')).toBe('pending')

    const effects = new Effects(db, { pollMs: 5 })
    const outbox = new Outbox({ db, effects })
    const sent: string[] = []
    outbox.registerChannel('feishu', async message => { sent.push(message.id) })
    effects.start()
    await waitUntil(() => outbox.status('out-4') === 'sent')
    expect(sent).toEqual(['out-4'])
    await effects.drain()
  })
})
