/**
 * The chapter state machine end to end, with scripted model replies: a whole arc (plan → contract → draft → review →
 * extract → validate → commit → close), resuming after a stop mid-chapter without redrafting, refusing a fact conflict
 * with one question, and rolling back with `rewriteFrom`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BookFiles } from '../src/novel/files.ts'
import { NovelStore } from '../src/novel/store.ts'
import { NeedsPerson, NovelWriter, Stopped } from '../src/novel/pipeline.ts'
import type { Ask, Role } from '../src/novel/pipeline.ts'
import {
  ARC_CLOSE_SYSTEM, ARC_PLANNER_SYSTEM, EXTRACTOR_SYSTEM, PLANNER_SYSTEM, REVIEWER_SYSTEM, REVISER_SYSTEM, WRITER_SYSTEM,
} from '../src/novel/prompts.ts'
import { BookSchema, COOL_POINTS, HOOKS, SetupSchema } from '../src/novel/schemas.ts'

const char = (id: string, name: string, role: string) => ({
  id, name, aliases: [], role, realm: { id: 'qi', stage: 0 }, status: 'alive', anchors: ['坚韧'], relations: [], knows: [], firstCh: 0, lastSeenCh: 0,
})

const SETUP = SetupSchema.parse({
  bible: {
    premise: '废材少年得到一枚会吞噬功法的古戒，从此逆天改命。',
    sellingPoints: ['吞噬功法'],
    protagonistId: 'lin-feng',
    goldenFinger: { name: '噬法古戒', rules: ['吞噬功法化为己用'], limits: ['每月一次'], growth: '随境界提升' },
    style: { pov: '第三人称', rules: ['短段落'], banned: [] },
    taboos: [],
    compass: { endgame: '飞升', longLines: [] },
  },
  power: {
    realms: [
      { id: 'qi', name: '炼气', order: 1, stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
      { id: 'ji', name: '筑基', order: 2, stages: ['初期', '中期', '后期'], abilities: [], breakthrough: { requires: [], risk: '' } },
    ],
    crossRealmMaxGap: 1,
  },
  characters: [char('lin-feng', '林风', 'protagonist'), char('su-yao', '苏瑶', 'ally'), { ...char('old-wang', '王老', 'minor'), status: 'dead' }],
  world: {
    factions: [],
    locations: [{ id: 'qingyun', name: '青云宗', region: '东域', note: '' }, { id: 'heifeng', name: '黑风岭', region: '东域', note: '' }],
    routes: [{ from: 'qingyun', to: 'heifeng', days: 3 }],
  },
  plan: {
    volumes: [{ n: 1, title: '入门', goal: '入宗' }],
    arcs: [
      { n: 1, volume: 1, title: '入门试炼', template: '成长突破', goal: '入宗', chapters: 5, status: 'skeleton' },
      { n: 2, volume: 1, title: '宗门大比', template: '竞技对抗', goal: '大比', chapters: 5, status: 'skeleton' },
    ],
  },
})

/** A chapter body unique to `n` (seeded pseudo-random CJK), with one quotable sentence. */
function prose(n: number, seed = 0): string {
  let x = (n * 7919 + seed * 104_729 + 1) >>> 0
  const next = () => { x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0; return x >>> 8 }
  const paras: string[] = [quoteOf(n)]
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
const quoteOf = (n: number) => `林风在第${n}日握紧了拳头，眼神坚定。`

interface Script {
  calls: { role: Role; system: string }[]
  /** Extra character ids the extractor reports as appearing (to provoke a fact check). */
  extraAppeared?: string[]
  /** Review scores in call order; 8 once they run out. */
  reviewScores?: number[]
  /** The reviser answers with a stub far shorter than the draft. */
  shortRevision?: boolean
  /** The extractor answers with the location's id instead of its name. */
  locationAsId?: boolean
  /** The extractor adds a consume of an item that does not exist, next to a valid gain. */
  badItem?: boolean
}

function scriptedAsk(script: Script): Ask {
  let n = 0
  let revisions = 0
  return async (role, system, user) => {
    script.calls.push({ role, system })
    const json = (value: unknown) => ({ text: JSON.stringify(value), truncated: false, costUsd: 0.001 })
    if (system === ARC_PLANNER_SYSTEM) {
      const count = Number(/正好 (\d+) 行/.exec(user)?.[1] ?? 5)
      return json({ title: '入门试炼', goal: '入宗', outline: Array.from({ length: count }, (_, i) => `第${i + 1}个梗概，林风修炼`), next: [] })
    }
    if (system === PLANNER_SYSTEM) {
      n = Number(/请输出第 (\d+) 章/.exec(user)?.[1] ?? n + 1)
      return json({
        n, title: `试炼${n}`, pov: 'lin-feng', goal: '通过试炼', beats: ['入场', '交手', '取胜'], appearing: ['lin-feng'], location: '青云宗',
        coolPoint: { type: COOL_POINTS[n % COOL_POINTS.length], payoff: '击败对手' }, hook: { type: HOOKS[n % HOOKS.length], text: '有人窥视' },
        foreshadow: { plant: [], advance: [], resolve: [] }, plannedChanges: [], allowDead: [],
      })
    }
    if (system === WRITER_SYSTEM) return { text: prose(n), truncated: false, costUsd: 0.01 }
    if (system === REVISER_SYSTEM) {
      revisions++
      if (script.shortRevision) return { text: `# 短\n\n${quoteOf(n)}很短。`, truncated: false, costUsd: 0.01 }
      return { text: prose(n, revisions), truncated: false, costUsd: 0.01 }
    }
    if (system === REVIEWER_SYSTEM) return json({ issues: [], score: script.reviewScores?.shift() ?? 8 })
    if (system === EXTRACTOR_SYSTEM) {
      const last = Number(/【上一章结束】第 (\d+) 天/.exec(user)?.[1] ?? 0)
      const quote = quoteOf(n)
      return json({
        appeared: ['lin-feng', ...(script.extraAppeared ?? [])],
        items: [
          ...(n === 2 || script.badItem ? [{ op: 'gain', id: 'spirit-stone', name: '下品灵石', kind: '灵石', qty: 3, owner: 'lin-feng', quote }] : []),
          ...(script.badItem ? [{ op: 'consume', id: 'ghost-item', qty: 1, quote }] : []),
        ],
        foreshadow: n === 1 ? [{ op: 'plant', id: 'jade-pendant', content: '玉佩的来历', quote }] : [],
        time: { dayFrom: last, dayTo: last + 1, flashback: false },
        location: script.locationAsId ? 'qingyun' : '青云宗',
        summary: `第${n}章梗概：林风在宗门中修炼，遭遇挑战并化解危机，取得进展。`,
        coolPoint: COOL_POINTS[n % COOL_POINTS.length],
        hook: HOOKS[n % HOOKS.length],
      })
    }
    if (system === ARC_CLOSE_SYSTEM) {
      return json({ summary: '第一弧：林风拜入青云宗，历经数场试炼，崭露头角，结识同门苏瑶，击退来犯之敌，最终站稳脚跟，并在玉佩之谜上埋下了伏笔与悬念。' })
    }
    throw new Error(`unexpected system prompt for ${role}`)
  }
}

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function setup(script: Script, checkpoint?: (files: BookFiles) => void) {
  const root = mkdtempSync(join(tmpdir(), 'novel-pipeline-'))
  dirs.push(root)
  const at = new Date('2026-11-07T00:00:00Z').toISOString()
  const book = BookSchema.parse({
    id: 'b_test', title: '噬法', genre: 'xianxia', idea: '', phase: 'ready', chapterChars: [500, 3000],
    volumesPlanned: 1, chaptersPerVolume: 100, lastChapter: 0, createdAt: at, updatedAt: at,
  })
  const files = BookFiles.create(root, book, SETUP)
  const db = new DatabaseSync(':memory:')
  const store = new NovelStore(db)
  const writer = new NovelWriter({
    files, store, db, ask: scriptedAsk(script), now: () => new Date('2026-11-07T01:00:00Z'),
    ...(checkpoint ? { checkpoint: () => checkpoint(files) } : {}),
  })
  return { files, store, writer }
}

const drafts = (script: Script) => script.calls.filter(call => call.system === WRITER_SYSTEM).length

describe('NovelWriter', () => {
  it('writes and closes a whole arc, keeping the canon in step', async () => {
    const script: Script = { calls: [] }
    const { files, store, writer } = setup(script)
    const arc = await writer.nextArc()
    expect(arc.startCh).toBe(1)
    expect(arc.outline).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      const outcome = await writer.writeChapter(arc)
      expect(outcome.n).toBe(i + 1)
      expect(outcome.status).toBe('committed')
    }
    const closed = await writer.closeArc(arc)
    expect(closed.chapters).toBe(5)
    expect(closed.flagged).toEqual([])

    expect(files.readBook().lastChapter).toBe(5)
    expect(files.chapterNumbers()).toEqual([1, 2, 3, 4, 5])
    expect(store.chapters('b_test')).toHaveLength(5)
    const canon = files.readCanon()
    expect(canon.timeline.map(t => t.dayTo)).toEqual([1, 2, 3, 4, 5])
    expect(canon.pacing).toHaveLength(5)
    expect(canon.foreshadow.find(f => f.id === 'jade-pendant')?.plantedCh).toBe(1)
    expect(canon.items.find(i => i.id === 'spirit-stone')).toMatchObject({ qty: 3, owner: 'lin-feng', gotCh: 2 })
    expect(canon.characters.find(c => c.id === 'lin-feng')?.lastSeenCh).toBe(5)
    expect(canon.plan.arcs.find(a => a.n === 1)?.status).toBe('done')
    expect(store.search('b_test', ['握紧了拳头'], 6, 10).map(hit => hit.n).sort()).toEqual([1, 2, 3, 4, 5])
    // One draft per chapter: nothing needed a revision.
    expect(drafts(script)).toBe(5)
  })

  it('plans the arc that reaches the planned length as the finale, with no skeleton after it', async () => {
    const script: Script = { calls: [] }
    const { files, writer } = setup(script)
    files.writeBook({ ...files.readBook(), volumesPlanned: 1, chaptersPerVolume: 5 })
    const arc = await writer.nextArc()
    expect(arc.chapters).toBe(5)
    const canon = files.readCanon()
    expect(canon.plan.arcs.filter(a => a.status === 'skeleton')).toEqual([])
  })

  it('resumes a chapter stopped after its draft without drafting it again', async () => {
    const script: Script = { calls: [] }
    let stopOnce = true
    const { files, writer } = setup(script, f => {
      const n = f.readBook().lastChapter + 1
      if (stopOnce && f.readWork(n, 'draft-0.md')) { stopOnce = false; throw new Stopped() }
    })
    const arc = await writer.nextArc()
    await expect(writer.writeChapter(arc)).rejects.toBeInstanceOf(Stopped)
    expect(files.readBook().lastChapter).toBe(0)
    expect(drafts(script)).toBe(1)
    const outcome = await writer.writeChapter(arc)
    expect(outcome.n).toBe(1)
    expect(drafts(script)).toBe(1)
    expect(files.readCanon().timeline).toHaveLength(1)
  })

  it('refuses to commit a dead character acting, and asks one question', async () => {
    const script: Script = { calls: [], extraAppeared: ['old-wang'] }
    const { files, store, writer } = setup(script)
    const arc = await writer.nextArc()
    const error = await writer.writeChapter(arc).catch(e => e)
    expect(error).toBeInstanceOf(NeedsPerson)
    expect((error as NeedsPerson).question).toContain('王老')
    expect((error as NeedsPerson).question).toContain('默认')
    expect(files.readBook().lastChapter).toBe(0)
    expect(store.chapters('b_test')).toEqual([])
    // Two fact revisions were tried before asking.
    expect(script.calls.filter(call => call.system === REVISER_SYSTEM)).toHaveLength(2)
  })

  it('rejects a revision that shrinks the chapter and keeps the original draft', async () => {
    const script: Script = { calls: [], reviewScores: [4, 4, 4], shortRevision: true }
    const { files, writer } = setup(script)
    const arc = await writer.nextArc()
    await writer.writeChapter(arc)
    const text = files.readChapter(1) ?? ''
    expect(text).not.toContain('很短')
    expect(text).toContain(prose(1).split('\n\n')[2]!)
    expect(script.calls.filter(call => call.system === REVISER_SYSTEM)).toHaveLength(2)
  })

  it('commits the best-scoring draft, not simply the last one', async () => {
    // draft-0 scores 4, draft-1 scores 5, draft-2 scores 3: draft-1 wins.
    const script: Script = { calls: [], reviewScores: [4, 5, 3] }
    const { files, store, writer } = setup(script)
    const arc = await writer.nextArc()
    const outcome = await writer.writeChapter(arc)
    const text = files.readChapter(1) ?? ''
    expect(text).toContain(prose(1, 1).split('\n\n')[2]!)
    expect(outcome.score).toBe(5)
    expect(store.chapters('b_test')[0]?.score).toBe(5)
  })

  it('stores a location name even when the extractor answers with its id', async () => {
    const script: Script = { calls: [], locationAsId: true }
    const { files, writer } = setup(script)
    const arc = await writer.nextArc()
    await writer.writeChapter(arc)
    expect(files.readCanon().timeline[0]?.location).toBe('青云宗')
    expect(files.readSummary<{ location: string }>(1)?.location).toBe('青云宗')
  })

  it('drops only the extraction entry that fails validation and keeps the rest', async () => {
    const script: Script = { calls: [], badItem: true }
    const { files, store, writer } = setup(script)
    const arc = await writer.nextArc()
    const outcome = await writer.writeChapter(arc)
    expect(outcome.status).toBe('flagged')
    const canon = files.readCanon()
    expect(canon.items.find(i => i.id === 'spirit-stone')).toMatchObject({ qty: 3, owner: 'lin-feng' })
    expect(canon.items.find(i => i.id === 'ghost-item')).toBeUndefined()
    expect(canon.foreshadow.find(f => f.id === 'jade-pendant')?.plantedCh).toBe(1)
    expect(store.chapters('b_test')[0]?.status).toBe('flagged')
  })

  it('rolls back with rewriteFrom and writes on from there', async () => {
    const script: Script = { calls: [] }
    const { files, store, writer } = setup(script)
    const arc = await writer.nextArc()
    for (let i = 0; i < 4; i++) await writer.writeChapter(arc)
    const moved = writer.rewriteFrom(3)
    expect(moved).toBe(2)
    expect(files.readBook().lastChapter).toBe(2)
    expect(store.chapters('b_test').map(row => row.n)).toEqual([1, 2])
    const canon = files.readCanon()
    expect(canon.timeline.map(t => t.ch)).toEqual([1, 2])
    expect(canon.items.find(i => i.id === 'spirit-stone')?.qty).toBe(3)
    const again = canon.plan.arcs.find(a => a.n === 1)!
    const outcome = await writer.writeChapter(again)
    expect(outcome.n).toBe(3)
    expect(files.readCanon().timeline.map(t => t.dayTo)).toEqual([1, 2, 3])
  })
})
