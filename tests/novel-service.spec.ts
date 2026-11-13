/**
 * The book library's setup drafting: a transient upstream error (429/5xx) backs off and does not use up the format
 * retries, a malformed reply is retried with its reason, a permanent error fails the setup, and the result is a book
 * folder with a schema-valid canon.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { NovelService } from '../src/novel/service.ts'
import { NovelStore } from '../src/novel/store.ts'
import { BookFiles } from '../src/novel/files.ts'
import type { callModel, ModelCallResult } from '../src/assessor/model-call.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const RAW_SETUP = {
  title: '噬丹鼎',
  bible: {
    premise: '药铺学徒捡到会吃丹毒的青铜小鼎。', sellingPoints: ['捡废丹修行'], protagonistId: 'chen-mo',
    goldenFinger: { name: '青铜小鼎', rules: ['提纯废丹'], limits: ['反噬寿元'], growth: '随境界提升' },
    style: { pov: '第三人称', rules: ['短段落'], banned: ['仿佛'] }, taboos: [], compass: { endgame: '飞升', longLines: [] },
  },
  power: {
    realms: [
      { id: 'qi', name: '炼气', stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
      { id: 'ji', name: '筑基', stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
    ],
    crossRealmMaxGap: 1,
  },
  characters: [{ id: 'chen-mo', name: '陈默', role: 'protagonist', realm: { id: 'qi', stage: 0 }, anchors: ['隐忍'] }],
  world: { factions: [], locations: [{ id: 'town', name: '边陲小镇', region: '南荒' }], routes: [] },
  plan: { volumes: [{ n: 1, title: '废丹', goal: '入宗' }], arcs: [{ n: 1, volume: 1, title: '坠崖', template: '成长突破', goal: '得鼎', chapters: 30 }] },
}

function harness(replies: Partial<ModelCallResult>[]) {
  const root = mkdtempSync(join(tmpdir(), 'novel-service-'))
  dirs.push(root)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE usage_calls (id INTEGER PRIMARY KEY, at TEXT, ticket_id TEXT, model TEXT, status INTEGER, prompt_hit INTEGER, prompt_miss INTEGER, completion INTEGER, cost_usd REAL, latency_ms INTEGER, provider TEXT)')
  const store = new NovelStore(db)
  const users: string[] = []
  const sleeps: number[] = []
  const call = (async (_target, request) => {
    users.push(request.user)
    const next = replies.shift() ?? { ok: false, status: 400, error: 'no more replies' }
    return { ok: false, text: '', latencyMs: 1, ...next } as ModelCallResult
  }) as typeof callModel
  const service = new NovelService({
    db, store, root,
    enabled: () => true,
    resolve: () => ({ provider: 'p', model: 'm', target: { api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k' } }),
    record: () => 0.01,
    startArc: async () => ({}),
    call,
    sleep: async ms => { sleeps.push(ms) },
    retryMs: 1,
    idFactory: () => 'b_test',
  })
  const status = () => db.prepare('SELECT status, error FROM novel_setups WHERE id = ?').get('b_test') as { status: string; error: string | null }
  return { service, root, users, sleeps, status, store, db }
}

/** A book from a valid setup, with chapter 1 committed and flagged. */
async function withChapter(replies: Partial<ModelCallResult>[], oldText: string) {
  const h = harness([{ ok: true, status: 200, text: JSON.stringify(RAW_SETUP) }, ...replies])
  h.service.openBook({ idea: '药铺学徒捡到小鼎', genre: 'xianxia' })
  await h.service.idle()
  const files = new BookFiles(h.root, 'b_test')
  files.writeChapter(1, oldText)
  h.store.recordChapter({ bookId: 'b_test', n: 1, arc: 1, title: '旧题', chars: 2000, sha256: 'x', status: 'flagged', costUsd: 0, score: 6, committedAt: '2026-11-07T00:00:00Z' })
  return { ...h, files }
}

describe('NovelService chapter edits', () => {
  const OLD = `# 旧题\n\n${'旧'.repeat(2000)}\n`
  const NEW = `# 新题\n\n${'新'.repeat(2100)}`

  it('rewrites one chapter from a note, keeps the old text, and undoes it', async () => {
    const h = await withChapter([{ ok: true, status: 200, text: NEW }], OLD)
    const started = h.service.editChapter('b_test', 1, '打斗写得更紧凑')
    expect(started.status).toBe('running')
    await h.service.idle()
    expect(h.service.lastEdit('b_test', 1)?.status).toBe('done')
    expect(h.files.readChapter(1)).toContain('新新新')
    expect(h.store.chapters('b_test')[0]).toMatchObject({ title: '新题', chars: 2100 })
    expect(h.users.at(-1)).toContain('打斗写得更紧凑')
    h.service.undoEdit('b_test', 1)
    expect(h.files.readChapter(1)).toBe(OLD)
    expect(h.service.lastEdit('b_test', 1)?.status).toBe('undone')
    expect(() => h.service.undoEdit('b_test', 1)).toThrow('没有可以撤销')
  })

  it('refuses a rewrite that came back much shorter and leaves the chapter alone', async () => {
    const h = await withChapter([{ ok: true, status: 200, text: `# 短\n\n${'短'.repeat(300)}` }], OLD)
    h.service.editChapter('b_test', 1, '改改')
    await h.service.idle()
    expect(h.service.lastEdit('b_test', 1)).toMatchObject({ status: 'failed' })
    expect(h.files.readChapter(1)).toBe(OLD)
  })

  it('marks a flagged chapter read', async () => {
    const h = await withChapter([], OLD)
    h.service.markRead('b_test', 1)
    expect(h.store.chapters('b_test')[0]?.status).toBe('committed')
  })
})

describe('NovelService setup drafting', () => {
  it('backs off on 429 without spending format retries, then retries a malformed reply with its reason', async () => {
    const h = harness([
      { ok: false, status: 429, error: 'rate limited' },
      { ok: false, status: 429, error: 'rate limited' },
      { ok: true, status: 200, text: '不是 JSON' },
      { ok: false, status: 503, error: 'busy' },
      { ok: true, status: 200, text: JSON.stringify(RAW_SETUP) },
    ])
    h.service.openBook({ idea: '药铺学徒捡到小鼎', genre: 'xianxia' })
    await h.service.idle()
    expect(h.status()).toMatchObject({ status: 'done', error: null })
    expect(h.sleeps).toHaveLength(3)
    // The call after the malformed reply carries the reason; the one after 503 still does.
    expect(h.users[3]).toContain('上一次输出不合格')
    const files = new BookFiles(h.root, 'b_test')
    expect(files.readBook().title).toBe('噬丹鼎')
    const canon = files.readCanon()
    expect(canon.power.realms.map(r => r.order)).toEqual([1, 2])
    expect(canon.plan.arcs[0]?.status).toBe('skeleton')
    expect(h.service.list()[0]).toMatchObject({ id: 'b_test', phase: 'ready' })
  })

  it('fails the setup on a permanent upstream error and lists it as failed', async () => {
    const h = harness([{ ok: false, status: 401, error: 'bad key' }])
    h.service.openBook({ idea: '灵感', genre: 'xianxia' })
    await h.service.idle()
    expect(h.status().status).toBe('failed')
    expect(h.status().error).toContain('bad key')
    expect(h.sleeps).toEqual([])
    expect(h.service.list()[0]).toMatchObject({ id: 'b_test', phase: 'failed' })
  })

  it('gives up after repeated transient errors', async () => {
    const h = harness(Array.from({ length: 10 }, () => ({ ok: false, status: 429, error: 'rate limited' })))
    h.service.openBook({ idea: '灵感', genre: 'xianxia' })
    await h.service.idle()
    expect(h.status().status).toBe('failed')
    expect(h.sleeps).toHaveLength(6)
  })
})
