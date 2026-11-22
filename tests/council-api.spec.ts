/**
 * HTTP contract of the council: auth and CSRF, create/list/detail/cancel/delete, commit rules, the ticket badge and the
 * council settings section (every validation rule).
 *
 * The server is real (login, cookie, CSRF headers); the admin host is a narrow fake and the models are a fake `fetch`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/admin/api.ts'
import { AdminAuth } from '../src/admin/auth.ts'
import { AdminError, type AdminHost, type TicketDetailView } from '../src/admin/host.ts'
import { defaultOptions, findModel, OptionsStore } from '../src/admin/options.ts'
import { createAdminServer, type AdminServer } from '../src/admin/server.ts'
import { CouncilService } from '../src/council/service.ts'
import { costOf } from '../src/gateway/pricing.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'

const CLI_TOKEN = 'cli-council-test'
const dirs: string[] = []
const servers: AdminServer[] = []
const services: CouncilService[] = []
let counter = 0

afterEach(async () => {
  while (servers.length) {
    try { await servers.pop()!.close() } catch { /* already closed */ }
  }
  while (services.length) services.pop()!.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-council-api-'))
  dirs.push(dir)
  return dir
}

interface FakeCall { role: string; system: string; user: string; round: number; topic: string }
interface FakeResult { status?: number; text?: string; body?: string; gate?: Promise<void> }
type Handler = (call: FakeCall) => FakeResult | Promise<FakeResult>

function fakeFetch(handler: Handler, calls: FakeCall[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { role: string; content: string }[] }
    const system = body.messages?.[0]?.content ?? ''
    const user = body.messages?.[1]?.content ?? ''
    const round = user.includes('这是第一轮') ? 1 : Number(/这是第 (\d+) 轮/.exec(user)?.[1] ?? 0)
    const call: FakeCall = {
      role: /^你是「([^」]+)」/.exec(system)?.[1] ?? '',
      system,
      user,
      round,
      topic: /<topic>\n([\s\S]*?)\n<\/topic>/.exec(user)?.[1] ?? '',
    }
    calls.push(call)
    const result = await handler(call)
    if (result.gate !== undefined) await result.gate
    if ((result.status ?? 200) >= 400) return new Response(result.body ?? '', { status: result.status ?? 500 })
    return new Response(JSON.stringify({
      choices: [{ message: { content: result.text ?? '' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

function briefText(): string {
  return [
    '# 修复登录页验证码',
    '## 目标', '登录可以用',
    '## 范围', '登录页',
    '## 不做', '无',
    '## 方案', '使用 A 方案',
    '## 步骤', '1. 改代码',
    '## 验收标准', 'pnpm check',
    '## 风险与约束', '无',
    '## 待你确认', '- 是否需要兼容旧接口？',
    '## 会商分歧', '无',
  ].join('\n')
}

function healthy(call: FakeCall): FakeResult {
  if (call.role === '主持人') return { text: briefText() }
  return { text: call.round <= 1 ? `${call.role}第一轮观点` : `${call.role}第二轮修正` }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

interface Harness {
  base: string
  cookie: string
  store: OptionsStore
  service: CouncilService
  created: { text: string; model?: string; secrets?: string[]; projectId?: string }[]
  calls: FakeCall[]
}

interface HarnessOptions {
  handler?: Handler
  configure?: (store: OptionsStore) => void
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = tempDir()
  const db = new DatabaseSync(':memory:')
  const store = new OptionsStore(join(dir, 'options.json'), defaultOptions({}))
  options.configure?.(store)
  const auth = new AdminAuth({ stateDir: dir })
  const password = auth.init().plaintext ?? ''
  const ledger = new Ledger(db)
  const events = new EventLog(db)
  const calls: FakeCall[] = []
  const created: Harness['created'] = []
  const service = new CouncilService({
    db,
    options: () => store.get(),
    dayUsd: () => ledger.dayTotals().usd,
    record: entry => {
      const found = findModel(store.get().models, { provider: entry.provider, model: entry.model })
      const cost = entry.usage && found ? costOf(found.model.price, entry.usage) : 0
      ledger.record({
        at: new Date().toISOString(),
        ticketId: '',
        provider: entry.provider,
        model: entry.model,
        status: entry.status,
        promptHit: entry.usage?.prompt_cache_hit_tokens ?? 0,
        promptMiss: entry.usage?.prompt_cache_miss_tokens ?? 0,
        completion: entry.usage?.completion_tokens ?? 0,
        costUsd: cost,
        latencyMs: entry.latencyMs,
      })
      return cost
    },
    event: input => { try { events.add(input) } catch { /* best effort */ } },
    requireProject: id => {
      if (id !== 'p_ok') throw new AdminError('invalid', '项目还没准备好。', 400)
    },
    projectProfile: id => id === 'p_ok' ? '项目档案：src/ 目录' : undefined,
    decisionTopic: id => id === 't1' ? '工单：修复登录\n原始问题：修复登录' : undefined,
    fetch: fakeFetch(options.handler ?? healthy, calls),
    now: () => new Date('2026-11-05T00:00:00.000Z'),
    idFactory: () => `c_${(++counter).toString(36).padStart(12, '0')}`,
  })
  services.push(service)

  const known: Record<string, unknown> = {
    createTicket: async (text: string, model?: string, secrets?: string[], projectId?: string) => {
      created.push({
        text,
        ...(model === undefined ? {} : { model }),
        ...(secrets === undefined ? {} : { secrets }),
        ...(projectId === undefined ? {} : { projectId }),
      })
      return { ticketId: 't1', triggerId: 'tr1', threadId: 'th1', threadKey: 'cli:th1' }
    },
    ticket: (id: string): TicketDetailView | undefined => id === 't1'
      ? ({
        id: 't1',
        title: '修复登录',
        status: 'open',
        stage: { stage: 'idle' },
        needsPerson: false,
        createdAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T00:00:00.000Z',
        costUsd: 0,
      } as unknown as TicketDetailView)
      : undefined,
    ticketSecrets: () => [],
    ticketPreviews: () => [],
    ticketLinks: () => [],
  }
  const host = new Proxy({} as AdminHost, {
    get(_target, property) {
      const value = known[String(property)]
      if (value !== undefined) return value
      return () => {
        throw new Error(`unexpected host call ${String(property)}`)
      }
    },
  })

  const api = createAdminApi({ host, auth, options: store, ledger, events, cliToken: CLI_TOKEN, councils: service })
  const server = createAdminServer({ api, staticHandler: () => false, port: 0 })
  servers.push(server)
  const { port } = await server.listen()
  const base = `http://127.0.0.1:${port}`

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sa-request': '1' },
    body: JSON.stringify({ password }),
  })
  expect(login.status).toBe(200)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { base, cookie, store, service, created, calls }
}

interface RequestOptions {
  method?: string
  body?: string
  csrf?: boolean
  cookie?: string | null
  bearer?: string
}

async function request(h: Harness, path: string, options: RequestOptions = {}) {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (options.cookie !== null) headers.cookie = options.cookie ?? h.cookie
  if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`
  if (method !== 'GET' && method !== 'HEAD' && options.csrf !== false) {
    headers['x-sa-request'] = '1'
    headers['content-type'] = 'application/json'
  }
  const response = await fetch(`${h.base}/api${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  })
  const text = await response.text()
  let json: any = null
  try { json = text === '' ? null : JSON.parse(text) } catch { json = null }
  return { status: response.status, json, text }
}

describe('council API security', () => {
  it('returns 401 without a session for every council route', async () => {
    const h = await harness()
    const routes: [string, string][] = [
      ['GET', '/councils'],
      ['POST', '/councils'],
      ['GET', '/councils/c_x'],
      ['POST', '/councils/c_x/cancel'],
      ['POST', '/councils/c_x/commit'],
      ['DELETE', '/councils/c_x'],
      ['GET', '/settings/council'],
      ['PUT', '/settings/council'],
    ]
    for (const [method, path] of routes) {
      const result = await request(h, path, { method, cookie: null, body: method === 'GET' ? undefined : '{}' })
      expect(result.status, `${method} ${path}`).toBe(401)
    }
  })

  it('returns 403 when a write has no X-SA-Request header and accepts the CLI bearer without it', async () => {
    const h = await harness()
    const blocked = await request(h, '/councils', {
      method: 'POST',
      body: JSON.stringify({ mode: 'brief', text: '修复登录' }),
      csrf: false,
    })
    expect(blocked.status).toBe(403)
    const allowed = await request(h, '/councils', {
      method: 'POST',
      body: JSON.stringify({ mode: 'brief', text: '修复登录' }),
      csrf: false,
      cookie: null,
      bearer: CLI_TOKEN,
    })
    expect(allowed.status).toBe(200)
    expect(allowed.json.id).toMatch(/^c_/)
    await h.service.whenIdle()
  })
})

describe('council create and read', () => {
  it('creates a brief council and serves the transcript and task book', async () => {
    const h = await harness()
    const created = await request(h, '/councils', {
      method: 'POST',
      body: JSON.stringify({ mode: 'brief', text: '修复登录页验证码', projectId: 'p_ok' }),
    })
    expect(created.status).toBe(200)
    const id = created.json.id as string
    await h.service.whenIdle()

    const detail = await request(h, `/councils/${id}`)
    expect(detail.status).toBe(200)
    expect(detail.json).toMatchObject({ id, mode: 'brief', status: 'done', phase: 'done', projectId: 'p_ok' })
    expect(detail.json.rounds).toHaveLength(2)
    expect(detail.json.rounds[0].turns).toHaveLength(5)
    expect(detail.json.rounds[0].turns[0]).toMatchObject({ roleId: 'analyst', name: '需求分析师', status: 'done' })
    expect(detail.json.brief).toContain('## 待你确认')
    expect(detail.json.brief).toContain('默认：')
    expect(detail.json.costUsd).toBeGreaterThan(0)

    const list = await request(h, '/councils?limit=10')
    expect(list.json.items.map((item: { id: string }) => item.id)).toContain(id)
    expect(list.json.items[0]).toHaveProperty('topic')
    expect((await request(h, '/councils?ticketId=other')).json.items).toHaveLength(0)
    expect((await request(h, '/councils/c_missing')).status).toBe(404)
  })

  it('records the ticket badge on the ticket detail', async () => {
    const h = await harness()
    const created = await request(h, '/councils', { method: 'POST', body: JSON.stringify({ mode: 'brief', text: '修复登录' }) })
    const id = created.json.id as string
    await h.service.whenIdle()
    const committed = await request(h, `/councils/${id}/commit`, { method: 'POST', body: '{}' })
    expect(committed.status).toBe(200)
    const ticket = await request(h, '/tickets/t1')
    expect(ticket.status).toBe(200)
    expect(ticket.json.council).toEqual({ id, status: 'done' })
  })

  it('cancels and deletes', async () => {
    const h = await harness()
    const created = await request(h, '/councils', { method: 'POST', body: JSON.stringify({ mode: 'brief', text: '修复登录' }) })
    const id = created.json.id as string
    expect((await request(h, `/councils/${id}/cancel`, { method: 'POST', body: '{}' })).status).toBe(200)
    expect((await request(h, `/councils/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await request(h, `/councils/${id}`)).status).toBe(404)
    expect((await request(h, `/councils/${id}/cancel`, { method: 'POST', body: '{}' })).status).toBe(404)
  })
})

describe('council create limits', () => {
  it('refuses an oversized topic, an unready project, an unknown seat and a disabled council', async () => {
    const h = await harness()
    const long = await request(h, '/councils', {
      method: 'POST',
      body: JSON.stringify({ mode: 'brief', text: 'a'.repeat(10_001) }),
    })
    expect(long.status).toBe(400)
    expect(long.json.message).toContain('10000')

    const badProject = await request(h, '/councils', {
      method: 'POST',
      body: JSON.stringify({ mode: 'brief', text: '修复登录', projectId: 'p_bad' }),
    })
    expect(badProject.status).toBe(400)
    expect(badProject.json.message).toContain('项目')

    const badRole = await request(h, '/councils', {
      method: 'POST',
      body: JSON.stringify({ mode: 'brief', text: '修复登录', roles: ['nobody'] }),
    })
    expect(badRole.status).toBe(400)

    h.store.update('council', { ...h.store.get().council, enabled: false })
    const disabled = await request(h, '/councils', {
      method: 'POST',
      body: JSON.stringify({ mode: 'brief', text: '修复登录' }),
    })
    expect(disabled.status).toBe(400)
    expect(disabled.json.message).toContain('没有启用')
    expect(h.calls).toHaveLength(0)
  })
})

describe('council commit', () => {
  it('commits a finished brief once and forwards the project', async () => {
    const h = await harness()
    const created = await request(h, '/councils', {
      method: 'POST',
      body: JSON.stringify({ mode: 'brief', text: '修复登录', projectId: 'p_ok' }),
    })
    const id = created.json.id as string
    await h.service.whenIdle()
    const committed = await request(h, `/councils/${id}/commit`, { method: 'POST', body: '{}' })
    expect(committed.status).toBe(200)
    expect(committed.json).toMatchObject({ ok: true, ticketId: 't1', triggerId: 'tr1' })
    expect(h.created).toHaveLength(1)
    expect(h.created[0]?.projectId).toBe('p_ok')
    expect(h.created[0]?.text).toContain('## 验收标准')

    const again = await request(h, `/councils/${id}/commit`, { method: 'POST', body: '{}' })
    expect(again.status).toBe(400)
    expect(again.json.message).toContain('已经开过')
    expect(h.created).toHaveLength(1)
  })

  it('uses an edited brief and rejects one over 10000 characters', async () => {
    const h = await harness()
    const created = await request(h, '/councils', { method: 'POST', body: JSON.stringify({ mode: 'brief', text: '修复登录' }) })
    const id = created.json.id as string
    await h.service.whenIdle()

    const tooLong = await request(h, `/councils/${id}/commit`, {
      method: 'POST',
      body: JSON.stringify({ brief: '字'.repeat(10_001) }),
    })
    expect(tooLong.status).toBe(400)
    expect(tooLong.json.message).toContain('10000')

    const edited = '# 我改过的任务书\n## 目标\n只做登录\n'
    const committed = await request(h, `/councils/${id}/commit`, {
      method: 'POST',
      body: JSON.stringify({ brief: edited, model: 'default/deepseek-v4.1-flash', secrets: [] }),
    })
    expect(committed.status).toBe(200)
    expect(h.created[0]?.text).toBe(edited.trim())
    expect(h.created[0]?.model).toBe('default/deepseek-v4.1-flash')
  })

  it('refuses a running council, a decision council and a missing council', async () => {
    const gate = deferred()
    const h = await harness({
      handler: call => call.role === '主持人' ? { text: briefText() } : { text: `${call.role}观点`, gate: gate.promise },
    })
    const created = await request(h, '/councils', { method: 'POST', body: JSON.stringify({ mode: 'brief', text: '修复登录' }) })
    const id = created.json.id as string
    const running = await request(h, `/councils/${id}/commit`, { method: 'POST', body: '{}' })
    expect(running.status).toBe(400)
    expect(running.json.message).toContain('还没完成')
    gate.resolve()
    await h.service.whenIdle()

    const decision = await request(h, '/councils', { method: 'POST', body: JSON.stringify({ mode: 'decision', text: '用哪个方案' }) })
    await h.service.whenIdle()
    const refused = await request(h, `/councils/${decision.json.id}/commit`, { method: 'POST', body: '{}' })
    expect(refused.status).toBe(400)
    expect(refused.json.message).toContain('任务书模式')

    expect((await request(h, '/councils/c_missing/commit', { method: 'POST', body: '{}' })).status).toBe(404)
  })
})

describe('council settings', () => {
  it('reads defaults, persists a valid change and reports it', async () => {
    const h = await harness()
    const initial = await request(h, '/settings/council')
    expect(initial.json).toMatchObject({ enabled: true, defaultOn: false, rounds: 2, maxCharsPerTurn: 600, moderator: null })
    expect(initial.json.roles).toHaveLength(5)

    const base = h.store.get().council
    const body = {
      ...base,
      rounds: 3,
      maxCharsPerTurn: 800,
      moderator: { provider: 'default', model: 'deepseek-v4.1-flash' },
      roles: base.roles.map((role, index) => index === 0 ? { ...role, name: '需求澄清' } : role),
    }
    const updated = await request(h, '/settings/council', { method: 'PUT', body: JSON.stringify(body) })
    expect(updated.status).toBe(200)
    expect(updated.json.changed).toEqual(expect.arrayContaining(['council.rounds', 'council.maxCharsPerTurn']))
    const after = await request(h, '/settings/council')
    expect(after.json.rounds).toBe(3)
    expect(after.json.roles[0].name).toBe('需求澄清')
    expect(after.json.moderator).toEqual({ provider: 'default', model: 'deepseek-v4.1-flash' })
  })

  it('rejects every invalid rule with a 400', async () => {
    const h = await harness({
      configure: store => {
        const models = store.get().models
        const model = structuredClone(models.providers[0]!.models[0]!)
        models.providers.push({
          id: 'off', name: 'Off', api: 'openai-completions', baseUrl: 'https://off.example.com/v1',
          apiKey: '', sessionHeader: '', enabled: false, models: [model],
        })
        store.updateModels(models)
      },
    })
    const base = h.store.get().council
    const cases: [string, unknown][] = [
      ['rounds 0', { ...base, rounds: 0 }],
      ['rounds 4', { ...base, rounds: 4 }],
      ['maxChars 99', { ...base, maxCharsPerTurn: 99 }],
      ['maxChars 2001', { ...base, maxCharsPerTurn: 2001 }],
      ['duplicate ids', { ...base, roles: base.roles.map((role, index) => index === 1 ? { ...role, id: base.roles[0]!.id } : role) }],
      ['invalid id', { ...base, roles: [{ ...base.roles[0]!, id: 'Upper_case' }, ...base.roles.slice(1)] }],
      ['no enabled role', { ...base, roles: base.roles.map(role => ({ ...role, enabled: false })) }],
      ['persona too long', { ...base, roles: [{ ...base.roles[0]!, persona: '字'.repeat(2001) }, ...base.roles.slice(1)] }],
      ['missing moderator model', { ...base, moderator: { provider: 'nope', model: 'x' } }],
      ['disabled provider', { ...base, moderator: { provider: 'off', model: base.roles[0]!.model?.model ?? 'deepseek-v4.1-flash' } }],
    ]
    for (const [label, body] of cases) {
      const result = await request(h, '/settings/council', { method: 'PUT', body: JSON.stringify(body) })
      expect(result.status, label).toBe(400)
      expect(result.json.message, label).toMatch(/[一-龥]/)
    }
  })
})
