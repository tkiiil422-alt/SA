/**
 * The novel engine inside the assembled daemon: routes answer 404 while `novel.enabled` is off, an imported book's arc
 * opens a ticket through the normal ask → Eval chain, the NovelExecutor writes the whole arc against a local fake model
 * server and ends the ticket with a ready report, ledger rows carry the arc ticket id, and an ordinary ticket still runs
 * on (fake) Pi. Nothing touches the network beyond 127.0.0.1.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, type Config } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'
import {
  ARC_CLOSE_SYSTEM, ARC_PLANNER_SYSTEM, EXTRACTOR_SYSTEM, PLANNER_SYSTEM, REVIEWER_SYSTEM, REVISER_SYSTEM, WRITER_SYSTEM,
} from '../src/novel/prompts.ts'
import { COOL_POINTS, HOOKS } from '../src/novel/schemas.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-novel-backups-'))

const runtimes: Runtime[] = []
const directories: string[] = []
const servers: Server[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-novel-'))
  directories.push(directory)
  return directory
}

function configFor(stateDir: string): Config {
  return parseConfig({
    stateDir,
    maxSlots: 2,
    operatorId: 'operator',
    launcher: { command: process.execPath, args: [FAKE_PI], env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' } },
    policy: {
      policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } },
      eval: { mode: 'auto' },
    },
  })
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) {
    try { await runtime.stop() } catch { /* already stopped */ }
  }
  for (const server of servers.splice(0)) server.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function apiFor(runtime: Runtime) {
  const token = readFileSync(join(runtime.stateDir, 'cli-token'), 'utf8').trim()
  return async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.adminUrl}/api${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json', 'x-sa-request': '1' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: response.status, json, text }
  }
}

async function until(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const quoteOf = (n: number) => `林风在第${n}日握紧了拳头，眼神坚定。`
function prose(n: number): string {
  let x = (n * 7919 + 1) >>> 0
  const next = () => { x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0; return x >>> 8 }
  const paras = [quoteOf(n)]
  for (let p = 0; p < 9; p++) {
    let s = ''
    for (let i = 0; i < 90; i++) {
      s += String.fromCharCode(0x4e00 + (next() % 20_000))
      if (i % 18 === 17) s += '。'
    }
    paras.push(s)
  }
  return `# 试炼${n}\n\n${paras.join('\n\n')}`
}

/** A fake OpenAI-compatible upstream that answers each novel role by its system prompt. */
async function fakeModel(): Promise<{ baseUrl: string; calls: string[] }> {
  const calls: string[] = []
  let n = 0
  const answer = (system: string, user: string): string => {
    if (system === ARC_PLANNER_SYSTEM) {
      const count = Number(/正好 (\d+) 行/.exec(user)?.[1] ?? 5)
      return JSON.stringify({ title: '入门试炼', goal: '入宗', outline: Array.from({ length: count }, (_, i) => `第${i + 1}个梗概，林风修炼`), next: [] })
    }
    if (system === PLANNER_SYSTEM) {
      n = Number(/请输出第 (\d+) 章/.exec(user)?.[1] ?? n + 1)
      return JSON.stringify({
        n, title: `试炼${n}`, pov: 'lin-feng', goal: '通过试炼', beats: ['入场', '交手', '取胜'], appearing: ['lin-feng'], location: '青云宗',
        coolPoint: { type: COOL_POINTS[n % COOL_POINTS.length], payoff: '击败对手' }, hook: { type: HOOKS[n % HOOKS.length], text: '有人窥视' },
        foreshadow: { plant: [], advance: [], resolve: [] }, plannedChanges: [], allowDead: [],
      })
    }
    if (system === WRITER_SYSTEM || system === REVISER_SYSTEM) return prose(n)
    if (system === REVIEWER_SYSTEM) return JSON.stringify({ issues: [], score: 8 })
    if (system === EXTRACTOR_SYSTEM) {
      const last = Number(/【上一章结束】第 (\d+) 天/.exec(user)?.[1] ?? 0)
      return JSON.stringify({
        appeared: ['lin-feng'], time: { dayFrom: last, dayTo: last + 1, flashback: false }, location: '青云宗',
        summary: `第${n}章梗概：林风在宗门中修炼，遭遇挑战并化解危机，取得进展。`,
        coolPoint: COOL_POINTS[n % COOL_POINTS.length], hook: HOOKS[n % HOOKS.length],
      })
    }
    if (system === ARC_CLOSE_SYSTEM) return JSON.stringify({ summary: '第一弧：林风拜入青云宗，历经数场试炼，崭露头角，最终站稳脚跟，为之后的宗门大比埋下了伏笔与悬念。' })
    return '{}'
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] }
      const system = body.messages[0]?.content ?? ''
      const user = body.messages[1]?.content ?? ''
      calls.push(system.slice(0, 20))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: answer(system, user) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 },
      }))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls }
}

const char = (id: string, name: string, role: string) => ({
  id, name, aliases: [], role, realm: { id: 'qi', stage: 0 }, status: 'alive', anchors: ['坚韧'], relations: [], knows: [], firstCh: 0, lastSeenCh: 0,
})
const SETUP = {
  bible: {
    premise: '废材少年得到一枚会吞噬功法的古戒，从此逆天改命。', sellingPoints: ['吞噬功法'], protagonistId: 'lin-feng',
    goldenFinger: { name: '噬法古戒', rules: ['吞噬功法化为己用'], limits: ['每月一次'], growth: '随境界提升' },
    style: { pov: '第三人称', rules: ['短段落'], banned: [] }, taboos: [], compass: { endgame: '飞升', longLines: [] },
  },
  power: {
    realms: [
      { id: 'qi', name: '炼气', order: 1, stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
      { id: 'ji', name: '筑基', order: 2, stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
    ],
    crossRealmMaxGap: 1,
  },
  characters: [char('lin-feng', '林风', 'protagonist'), char('su-yao', '苏瑶', 'ally')],
  world: { factions: [], locations: [{ id: 'qingyun', name: '青云宗', region: '东域', note: '' }], routes: [] },
  plan: {
    volumes: [{ n: 1, title: '入门', goal: '入宗' }],
    arcs: [
      { n: 1, volume: 1, title: '入门试炼', template: '成长突破', goal: '入宗', chapters: 5, status: 'skeleton' },
      { n: 2, volume: 1, title: '宗门大比', template: '竞技对抗', goal: '大比', chapters: 5, status: 'skeleton' },
    ],
  },
}

const price = { input: 0.3, cacheRead: 0.006, output: 1.2 }
const routing = {
  worker: { provider: 'default', model: 'fake-flash' },
  assessor: { enabled: false, provider: 'default', model: 'fake-flash', timeoutSec: 30 },
  autoSelect: false,
}
const novelSettings = {
  enabled: true,
  models: { planner: null, writer: null, reviewer: null, extractor: null },
  chapterChars: [500, 3000], maxRevisions: 2, minScore: 6, dailyUsd: 0, arcUsd: 0, bookUsd: 0, maxActiveBooks: 1, extraBanned: [],
}

describe('novel engine in the daemon', () => {
  it('stays dark while disabled and leaves ordinary tickets on Pi', async () => {
    const runtime = await createRuntime(configFor(tempDir()))
    runtimes.push(runtime)
    const api = apiFor(runtime)
    expect((await api('/novels')).status).toBe(404)
    expect((await api('/novels/import', { method: 'POST', body: { title: 'x', genre: 'xianxia', setup: SETUP } })).status).toBe(404)
    const created = await runtime.ask('写个 hello.py')
    expect(created.ticketId).toBeDefined()
    await until(() => runtime.ticket(created.ticketId!)?.status === 'ended', 'pi ticket to end')
    // Pi's launcher writes a per-ticket config directory; the novel executor never does.
    expect(existsSync(join(runtime.stateDir, 'pi-config', created.ticketId!, 'models.json'))).toBe(true)
    const bound = runtime.repo.db.prepare('SELECT COUNT(*) AS c FROM novel_tickets WHERE ticket_id = ?').get(created.ticketId!) as { c: number }
    expect(bound.c).toBe(0)
  }, 30_000)

  it('writes a whole arc through an arc ticket and ends it ready', async () => {
    const upstream = await fakeModel()
    const runtime = await createRuntime(configFor(tempDir()))
    runtimes.push(runtime)
    const api = apiFor(runtime)
    const providers = [{
      id: 'default', name: '假模型', api: 'openai-completions', baseUrl: upstream.baseUrl, apiKey: 'k-test', sessionHeader: '', enabled: true,
      models: [{ id: 'fake-flash', label: 'Fake', price }],
    }]
    const models = await api('/settings/models', { method: 'PUT', body: { providers, routing } })
    expect(models.status, models.text).toBe(200)
    const novel = await api('/settings/novel', { method: 'PUT', body: novelSettings })
    expect(novel.status, novel.text).toBe(200)

    const imported = await api('/novels/import', { method: 'POST', body: { title: '噬法', genre: 'xianxia', chapterChars: [500, 3000], setup: SETUP } })
    expect(imported.status, imported.text).toBe(200)
    const bookId = imported.json.id as string

    const arc = await api(`/novels/${bookId}/arcs`, { method: 'POST', body: { note: '节奏快一点' } })
    expect(arc.status, arc.text).toBe(200)
    const ticketId = arc.json.ticketId as string
    expect(ticketId).toBeDefined()
    expect(arc.json.arc).toBe(1)

    await until(() => runtime.ticket(ticketId)?.status === 'ended', 'arc ticket to end', 60_000)
    const view = runtime.ticket(ticketId)!
    expect(view.ended?.outcome).toBe('completed')

    const detail = await api(`/novels/${bookId}`)
    expect(detail.status, detail.text).toBe(200)
    expect(detail.json.book.lastChapter).toBe(5)
    expect(detail.json.chapters).toHaveLength(5)
    expect(detail.json.plan.arcs[0].status).toBe('done')
    expect(detail.json.book.costUsd).toBeGreaterThan(0)

    const chapter = await api(`/novels/${bookId}/chapters/3`)
    expect(chapter.status).toBe(200)
    expect(chapter.json.text).toContain(quoteOf(3))

    // Ledger rows carry the arc ticket id; the same ticket's cost shows on the ticket page.
    const rows = runtime.repo.db.prepare('SELECT COUNT(*) AS c FROM usage_calls WHERE ticket_id = ?').get(ticketId) as { c: number }
    expect(rows.c).toBeGreaterThanOrEqual(5 * 4)

    // A second arc request while nothing is writing opens the next arc.
    const exported = await fetch(`${runtime.adminUrl}/api/novels/${bookId}/export`, {
      headers: { authorization: `Bearer ${readFileSync(join(runtime.stateDir, 'cli-token'), 'utf8').trim()}` },
    })
    expect(exported.status).toBe(200)
    const text = await exported.text()
    expect(text).toContain('第1章')
    expect(text).toContain('第5章')
    expect(upstream.calls.length).toBeGreaterThanOrEqual(22)
  }, 90_000)
})
