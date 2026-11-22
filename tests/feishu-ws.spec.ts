import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/admin/api.ts'
import { AdminAuth } from '../src/admin/auth.ts'
import type { AdminHost } from '../src/admin/host.ts'
import { OptionsStore, defaultOptions } from '../src/admin/options.ts'
import { createAdminServer } from '../src/admin/server.ts'
import { key } from '../src/core/ids.ts'
import type { Trigger } from '../src/core/model.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { parseEvent, type ParseResult } from '../src/sources/feishu.ts'
import { FeishuWs, triggerFromMessageEvent, type FeishuWsEvent, type WsClientLike, type WsClientParams } from '../src/sources/feishu-ws.ts'

const TOKEN = 'verify-token'
const SECRET = 'app-secret-value'
const CLI = 'cli-test-token'
const CFG = {
  appId: 'cli_test',
  appSecret: SECRET,
  verificationToken: TOKEN,
  encryptKey: '',
  groupMode: 'mention' as const,
}
const OPTIONS = { botOpenId: 'ou_bot', groupMode: 'mention' as const }
const BOT_MENTION = [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'SA' }]

const closers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
})

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'feishu-ws-spec-'))
}

interface EventOptions {
  messageId?: string
  eventId?: string
  chatType?: 'p2p' | 'group'
  messageType?: string
  content?: string
  mentions?: unknown[]
  rootId?: string
  senderType?: string
  openId?: string
}

/** The payload the SDK hands the `im.message.receive_v1` handler: header fields and the 2.0 event merged flat. */
function wsEvent(o: EventOptions = {}): Record<string, unknown> {
  return {
    event_id: o.eventId ?? 'ev-1',
    event_type: 'im.message.receive_v1',
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
  }
}

/** The same logical event as an HTTP callback body, for parity checks against `parseEvent`. */
function httpBody(event: Record<string, unknown>): string {
  return JSON.stringify({
    schema: '2.0',
    header: { event_id: event.event_id, event_type: event.event_type, token: TOKEN },
    event: { sender: event.sender, message: event.message },
  })
}

function triggerOf(result: Trigger | { ignored: string }): Trigger {
  if ('ignored' in result) throw new Error(`expected a trigger, got ignored: ${result.ignored}`)
  return result
}

function httpTriggerOf(result: ParseResult): Trigger {
  if (result.kind !== 'message') throw new Error(`expected a message, got ${result.kind}`)
  return result.trigger
}

function fakeTransport() {
  const calls = { started: 0, closed: 0, dispatchers: [] as EventDispatcher[], params: [] as WsClientParams[] }
  const factory = (params: WsClientParams): WsClientLike => {
    calls.params.push(params)
    return {
      start: async ({ eventDispatcher }) => {
        calls.started += 1
        calls.dispatchers.push(eventDispatcher)
      },
      close: () => {
        calls.closed += 1
      },
    }
  }
  return { factory, calls, callbacks: () => calls.params[0]! }
}

describe('triggerFromMessageEvent parity with the HTTP callback', () => {
  it('turns a direct text message into the same Trigger as parseEvent', () => {
    const event = wsEvent()
    const fromWs = triggerOf(triggerFromMessageEvent(event, OPTIONS))
    const fromHttp = httpTriggerOf(parseEvent(httpBody(event), { verificationToken: TOKEN, ...OPTIONS }))
    expect(fromWs).toEqual(fromHttp)
    expect(fromWs).toMatchObject({
      id: key('trigger', 'feishu', 'om_1'),
      source: 'feishu',
      addressed: 'direct',
      human: true,
      text: 'hi',
      threads: [{ source: 'feishu', id: 'oc_chat:om_1' }],
      actor: { source: 'feishu', id: 'ou_user' },
      channel: { source: 'feishu', thread: 'oc_chat:om_1', address: { chatId: 'oc_chat', messageId: 'om_1' } },
      meta: { chatType: 'p2p', chatId: 'oc_chat', direct: true },
    })
  })

  it('ignores an unmentioned group message under the mention mode, like the callback', () => {
    const event = wsEvent({ chatType: 'group' })
    expect(triggerFromMessageEvent(event, OPTIONS)).toEqual({ ignored: 'group_mention_required' })
    expect(parseEvent(httpBody(event), { verificationToken: TOKEN, ...OPTIONS })).toEqual({ kind: 'ignore' })
  })

  it('accepts a group message that mentions the bot and strips the placeholder', () => {
    const event = wsEvent({
      chatType: 'group',
      mentions: BOT_MENTION,
      content: JSON.stringify({ text: '@_user_1 请 看看' }),
    })
    const trigger = triggerOf(triggerFromMessageEvent(event, OPTIONS))
    expect(trigger).toEqual(httpTriggerOf(parseEvent(httpBody(event), { verificationToken: TOKEN, ...OPTIONS })))
    expect(trigger.addressed).toBe('mention')
    expect(trigger.text).toBe('请 看看')
    expect(trigger.meta).toMatchObject({ chatType: 'group', direct: false })
  })

  it('accepts unmentioned group messages under the all mode without an addressed flag', () => {
    const trigger = triggerOf(triggerFromMessageEvent(wsEvent({ chatType: 'group' }), { botOpenId: 'ou_bot', groupMode: 'all' }))
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
    const event = wsEvent({ messageType: 'post', content })
    expect(triggerOf(triggerFromMessageEvent(event, OPTIONS)).text).toBe('第一行\n第二行 链接')
    expect(triggerOf(triggerFromMessageEvent(event, OPTIONS))).toEqual(
      httpTriggerOf(parseEvent(httpBody(event), { verificationToken: TOKEN, ...OPTIONS })),
    )
  })

  it('uses the root message as the thread when a reply has one', () => {
    const trigger = triggerOf(triggerFromMessageEvent(wsEvent({ rootId: 'om_root' }), OPTIONS))
    expect(trigger.threads[0]?.id).toBe('oc_chat:om_root')
  })

  it('marks unsupported message types instead of reading them', () => {
    const trigger = triggerOf(triggerFromMessageEvent(wsEvent({ messageType: 'image', content: JSON.stringify({ image_key: 'x' }) }), OPTIONS))
    expect(trigger.text).toBe('[不支持的消息类型: image]')
  })

  it('reports the reason for a malformed event', () => {
    expect(triggerFromMessageEvent({}, OPTIONS)).toEqual({ ignored: 'missing_message' })
    expect(triggerFromMessageEvent({ message: {} }, OPTIONS)).toEqual({ ignored: 'missing_sender' })
  })
})

describe('FeishuWs transport', () => {
  it('starts with an injected client, registers the message handler and reports status transitions', async () => {
    const received: Trigger[] = []
    const events: FeishuWsEvent[] = []
    const fake = fakeTransport()
    const ws = new FeishuWs({
      config: () => CFG,
      onTrigger: trigger => { received.push(trigger) },
      onEvent: event => { events.push(event) },
      botOpenId: async () => 'ou_bot',
      clientFactory: fake.factory,
    })

    expect(ws.status()).toEqual({ state: 'off' })
    await ws.start()
    expect(fake.calls.started).toBe(1)
    expect(ws.status().state).toBe('connecting')

    const dispatcher = fake.calls.dispatchers[0]!
    const handler = dispatcher.handles.get('im.message.receive_v1')
    expect(typeof handler).toBe('function')

    fake.callbacks().onReady?.()
    expect(ws.status()).toMatchObject({ state: 'connected' })
    expect(events.some(event => event.kind === 'feishu.ws' && event.text.includes('已连接'))).toBe(true)

    await handler!(wsEvent())
    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe('hi')
    expect(ws.status().lastEventAt).toBeTruthy()

    ws.stop()
    expect(fake.calls.closed).toBe(1)
    expect(ws.status().state).toBe('off')
  })

  it('ignores a group message that does not mention the bot', async () => {
    const received: Trigger[] = []
    const fake = fakeTransport()
    const ws = new FeishuWs({
      config: () => CFG,
      onTrigger: trigger => { received.push(trigger) },
      botOpenId: async () => 'ou_bot',
      clientFactory: fake.factory,
    })
    await ws.start()
    await fake.calls.dispatchers[0]!.handles.get('im.message.receive_v1')!(wsEvent({ chatType: 'group' }))
    expect(received).toHaveLength(0)
  })

  it('stops and restarts without leaking a client', async () => {
    const fake = fakeTransport()
    const ws = new FeishuWs({ config: () => CFG, onTrigger: () => {}, clientFactory: fake.factory })
    await ws.start()
    ws.stop()
    expect(ws.status().state).toBe('off')
    await ws.restart()
    expect(fake.calls.started).toBe(2)
    expect(ws.status().state).toBe('connecting')
    ws.stop()
  })

  it('records a scrubbed error and never exposes a secret', async () => {
    const errors: Error[] = []
    const events: FeishuWsEvent[] = []
    const fake = fakeTransport()
    const ws = new FeishuWs({
      config: () => CFG,
      onTrigger: () => {},
      onEvent: event => { events.push(event) },
      onError: error => { errors.push(error) },
      clientFactory: fake.factory,
    })
    await ws.start()
    fake.callbacks().onError?.(new Error(`connect failed with ${SECRET}`))
    expect(ws.status().state).toBe('error')
    expect(ws.status().lastError).toContain('***')
    expect(ws.status().lastError).not.toContain(SECRET)
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain(SECRET)
    ws.stop()
  })

  it('reports missing credentials without building a client', async () => {
    const fake = fakeTransport()
    const ws = new FeishuWs({ config: () => ({ ...CFG, appSecret: '' }), onTrigger: () => {}, clientFactory: fake.factory })
    await ws.start()
    expect(fake.calls.started).toBe(0)
    expect(ws.status()).toMatchObject({ state: 'error', lastError: '缺少 App ID 或 App Secret' })
  })
})

describe('feishu mode option', () => {
  it('defaults to webhook and fills it into an existing file without the field', () => {
    expect(defaultOptions({}).feishu.mode).toBe('webhook')
    const file = join(tempDir(), 'options.json')
    writeFileSync(file, JSON.stringify({
      feishu: { enabled: false, appId: '', appSecret: '', verificationToken: '', encryptKey: '', apiBase: 'https://open.feishu.cn', groupMode: 'mention' },
    }))
    expect(new OptionsStore(file, defaultOptions({})).get().feishu.mode).toBe('webhook')
  })

  it('accepts ws, keeps it on an omitted write, and rejects an unknown mode', () => {
    const store = new OptionsStore(join(tempDir(), 'options.json'), defaultOptions({}))
    const base = { enabled: false, appId: 'cli', appSecret: '', verificationToken: '', encryptKey: '', apiBase: 'https://open.feishu.cn', groupMode: 'mention' as const }
    store.updateFeishu({ ...base, mode: 'ws' })
    expect(store.getPublic().feishu.mode).toBe('ws')
    store.updateFeishu(base)
    expect(store.get().feishu.mode).toBe('ws')
    expect(() => store.updateFeishu({ ...base, mode: 'socket' })).toThrow(/mode|取值/)
  })
})

describe('admin API feishu status routes', () => {
  it('returns the mode and connection state, and restarts on demand', async () => {
    const dir = tempDir()
    const db = new DatabaseSync(':memory:')
    const auth = new AdminAuth({ stateDir: dir, env: { SA_ADMIN_PASSWORD: 'test-password-123' } })
    auth.init()
    const store = new OptionsStore(join(dir, 'options.json'), defaultOptions({}))
    let reconnects = 0
    const host = {
      feishuStatus: () => ({ mode: 'ws' as const, state: 'connected' as const, since: '2026-01-01T00:00:00.000Z' }),
      reconnectFeishu: async () => {
        reconnects += 1
        return { mode: 'ws' as const, state: 'connecting' as const }
      },
    } as unknown as AdminHost
    const api = createAdminApi({
      host,
      auth,
      options: store,
      ledger: new Ledger(db),
      events: new EventLog(db),
      cliToken: CLI,
    })
    const server = createAdminServer({ api, staticHandler: () => false, port: 0 })
    const { port } = await server.listen()
    closers.push(() => server.close())
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: `Bearer ${CLI}`, 'content-type': 'application/json' }

    const status = await fetch(`${base}/api/settings/feishu/status`, { headers })
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ mode: 'ws', state: 'connected', since: '2026-01-01T00:00:00.000Z' })

    const again = await fetch(`${base}/api/settings/feishu/reconnect`, { method: 'POST', headers })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ mode: 'ws', state: 'connecting' })
    expect(reconnects).toBe(1)
  })

  it('keeps a stored ws mode and the secrets when a settings write omits them', async () => {
    const dir = tempDir()
    const db = new DatabaseSync(':memory:')
    const auth = new AdminAuth({ stateDir: dir, env: { SA_ADMIN_PASSWORD: 'test-password-123' } })
    auth.init()
    const store = new OptionsStore(join(dir, 'options.json'), defaultOptions({}))
    const base = { enabled: false, appId: 'cli', appSecret: SECRET, verificationToken: TOKEN, encryptKey: '', apiBase: 'https://open.feishu.cn', groupMode: 'mention' as const }
    store.updateFeishu({ ...base, mode: 'ws' })
    const api = createAdminApi({
      host: {} as AdminHost,
      auth,
      options: store,
      ledger: new Ledger(db),
      events: new EventLog(db),
      cliToken: CLI,
    })
    const server = createAdminServer({ api, staticHandler: () => false, port: 0 })
    const { port } = await server.listen()
    closers.push(() => server.close())
    const headers = { authorization: `Bearer ${CLI}`, 'content-type': 'application/json' }

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/feishu`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled: false, appId: 'cli2', apiBase: 'https://open.feishu.cn', groupMode: 'mention' }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain(SECRET)
    expect(store.get().feishu).toMatchObject({ appId: 'cli2', mode: 'ws', appSecret: SECRET, verificationToken: TOKEN })
  })
})
