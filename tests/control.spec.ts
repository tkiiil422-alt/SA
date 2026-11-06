/**
 * The control HTTP interface: token authentication, the person's actions, and the CLI Source's thread follow-up.
 *
 * The server really listens on a loopback port; the host is a stub, because these tests are about routing, status codes,
 * and request shapes, not the domain behind them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createControlServer, type ControlHost, type ControlServer, type Overview, type TicketView } from '../src/control/server.ts'
import { UserError } from '../src/core/errors.ts'
import { key } from '../src/core/ids.ts'
import { CliSource } from '../src/sources/cli.ts'

const TOKEN = 'test-token'

const view: TicketView = {
  id: 'known',
  title: 'Fix',
  status: 'open',
  stage: { stage: 'person', action: 'answer' },
  attention: { question: 'Which branch?' },
  canRetry: false,
  messages: [],
}

interface Calls {
  ask: string[]
  stop: [string, string | undefined][]
  retry: string[]
  reply: [string, string][]
  delete: [string, { deleteWorkspace: boolean; force: boolean }][]
}

function createHost(overrides: Partial<ControlHost> = {}): { host: ControlHost; calls: Calls } {
  const calls: Calls = { ask: [], stop: [], retry: [], reply: [], delete: [] }
  const host: ControlHost = {
    ask: async text => { calls.ask.push(text); return { triggerId: 't', threadId: 'th', threadKey: 'cli:th', ticketId: 'known' } },
    ticket: id => id === 'known' ? view : undefined,
    tickets: () => [],
    stop: (id, reason) => { calls.stop.push([id, reason]) },
    retry: id => { calls.retry.push(id) },
    reply: (id, text) => { calls.reply.push([id, text]) },
    delete: (id, options) => { calls.delete.push([id, options]); return { freedBytes: 42 } },
    overview: (): Overview => ({
      needsPerson: [{ id: 'known', title: 'Fix', stage: { stage: 'person', action: 'answer' }, question: 'Which branch?' }],
      open: 1,
    }),
    ...overrides,
  }
  return { host, calls }
}

const servers: ControlServer[] = []

async function start(host: ControlHost, options?: { token?: string }): Promise<string> {
  const server = createControlServer(host, options)
  servers.push(server)
  const { port } = await server.listen()
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const auth = (token = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` })

function post(url: string, body?: unknown, options: { token?: string | null; contentType?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(options.token === null ? {} : auth(options.token ?? TOKEN)),
    'content-type': options.contentType ?? 'application/json',
  }
  return fetch(url, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('control server', () => {
  it('refuses every route without the configured token', async () => {
    const url = await start(createHost().host, { token: TOKEN })

    for (const path of ['/tickets', '/tickets/known', '/overview']) {
      const missing = await fetch(`${url}${path}`)
      expect(missing.status, path).toBe(401)
      expect(await missing.json()).toEqual({ error: 'unauthorized' })
      const wrong = await fetch(`${url}${path}`, { headers: auth('not-the-token') })
      expect(wrong.status, path).toBe(401)
    }
    expect((await post(`${url}/ask`, { text: 'hi' }, { token: 'not-the-token' })).status).toBe(401)
    expect((await post(`${url}/tickets/known/retry`, {}, { token: null })).status).toBe(401)

    const accepted = await fetch(`${url}/tickets`, { headers: auth() })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ tickets: [] })
  })

  it('keeps the old unauthenticated behaviour when no token is configured', async () => {
    const url = await start(createHost().host)
    const response = await fetch(`${url}/tickets`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tickets: [] })
  })

  it('routes the person actions to the host', async () => {
    const { host, calls } = createHost()
    const url = await start(host, { token: TOKEN })

    const stopped = await post(`${url}/tickets/known/stop`, { reason: 'done with it' })
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ ok: true })

    const retried = await post(`${url}/tickets/known/retry`, {})
    expect(retried.status).toBe(200)

    const replied = await post(`${url}/tickets/known/reply`, { text: '  main  ' })
    expect(replied.status).toBe(200)

    const overview = await fetch(`${url}/overview`, { headers: auth() })
    expect(overview.status).toBe(200)
    expect(await overview.json()).toMatchObject({ open: 1, needsPerson: [{ id: 'known', question: 'Which branch?' }] })

    expect(calls.stop).toEqual([['known', 'done with it']])
    expect(calls.retry).toEqual(['known'])
    expect(calls.reply).toEqual([['known', 'main']])
  })

  it('requires a JSON content type and a text for write routes', async () => {
    const url = await start(createHost().host, { token: TOKEN })

    const noType = await fetch(`${url}/tickets/known/stop`, { method: 'POST', headers: auth() })
    expect(noType.status).toBe(415)
    expect(await noType.json()).toMatchObject({ error: 'content_type_required' })

    // An empty body is fine for stop; text that is not JSON is refused.
    const invalid = await fetch(`${url}/tickets/known/stop`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_json' })

    const noText = await post(`${url}/tickets/known/reply`, { text: '   ' })
    expect(noText.status).toBe(400)
    expect(await noText.json()).toEqual({ error: 'text_required' })
  })

  it('maps host errors to 404, 409, or 500', async () => {
    const { host } = createHost({
      stop: () => { throw new UserError('unknownTicket') },
      retry: () => { throw new UserError('notRetryable') },
      reply: () => { throw Object.assign(new Error('delivery in flight'), { status: 409, code: 'delivery_conflict' }) },
      overview: () => { throw new Error('boom') },
    })
    const url = await start(host, { token: TOKEN })

    const missing = await post(`${url}/tickets/nope/stop`, {})
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: 'unknownTicket', message: 'Unknown ticket' })

    const refused = await post(`${url}/tickets/known/retry`, {})
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'notRetryable' })

    const conflict = await post(`${url}/tickets/known/reply`, { text: 'hi' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'delivery_conflict', message: 'delivery in flight' })

    const failure = await fetch(`${url}/overview`, { headers: auth() })
    expect(failure.status).toBe(500)
    expect(await failure.json()).toMatchObject({ error: 'control_failure' })
  })

  it('keeps the ticket detail route and its unknown-ticket response', async () => {
    const url = await start(createHost().host, { token: TOKEN })
    const known = await fetch(`${url}/tickets/known`, { headers: auth() })
    expect(known.status).toBe(200)
    expect(await known.json()).toMatchObject({ id: 'known', attention: { question: 'Which branch?' }, canRetry: false })
    const unknown = await fetch(`${url}/tickets/missing`, { headers: auth() })
    expect(unknown.status).toBe(404)
  })

  it('deletes a ticket through the token-protected DELETE route', async () => {
    const { host, calls } = createHost()
    const url = await start(host, { token: TOKEN })

    const denied = await fetch(`${url}/tickets/known`, { method: 'DELETE' })
    expect(denied.status).toBe(401)

    const deleted = await fetch(`${url}/tickets/known`, {
      method: 'DELETE',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ deleteWorkspace: false, force: true }),
    })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ freedBytes: 42 })
    expect(calls.delete).toEqual([['known', { deleteWorkspace: false, force: true }]])
  })
})

describe('CliSource follow-up', () => {
  it('keeps the thread and gives each message on it a unique trigger id', () => {
    const source = new CliSource({ operatorId: 'operator', now: () => '2026-09-23T00:00:00.000Z' })
    const first = source.followup('thread-1', 'one')
    const second = source.followup('thread-1', 'two')

    expect(first.threads).toEqual([{ source: 'cli', id: 'thread-1' }])
    expect(first.channel).toMatchObject({ source: 'cli', thread: 'thread-1' })
    expect(first.actor).toEqual({ source: 'cli', id: 'operator' })
    expect(first.human).toBe(true)
    expect(first.text).toBe('one')
    expect(first.id).not.toBe(second.id)
  })

  it('leaves ask on a fresh thread with its deterministic id', () => {
    let next = 0
    const source = new CliSource({
      operatorId: 'operator',
      now: () => '2026-09-23T00:00:00.000Z',
      newThreadId: () => `thread-${++next}`,
    })
    const asked = source.ask('hello')

    expect(asked.id).toBe(key('trigger', 'cli', 'thread-1'))
    expect(asked.threads).toEqual([{ source: 'cli', id: 'thread-1' }])
    expect(source.ask('again').threads).toEqual([{ source: 'cli', id: 'thread-2' }])
  })
})
