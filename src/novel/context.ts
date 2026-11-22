/**
 * Context assembly for the novel engine's model calls.
 *
 * Blocks are ordered from most stable to most volatile so the upstream prompt cache keeps hitting: the book block (premise,
 * golden finger, realm ladder, style) changes only when a person edits the setup; the arc block changes once per arc; the
 * chapter block (cast cards, hand-off, recall, contract) changes every chapter. Every block has a character budget and is
 * clamped, never silently dropped, so a call's size stays predictable over hundreds of chapters.
 *
 * Only structural interfaces are used for the book's files and the search index, so this module has no disk access of
 * its own and is tested with plain objects.
 */
import type { Arc, Book, Canon, Character, Contract, Foreshadow, Item, Power, RealmPos } from './schemas.ts'
import { GENRE_LABELS } from './schemas.ts'

/** What `summaries/ch-NNNN.json` holds, written at commit. */
export interface ChapterSummary {
  n: number
  arc: number
  title: string
  summary: string
  appeared: string[]
  location: string
  dayTo: number
  coolPoint: string
  hook: string
  /** The hook text the chapter ended on, for the next chapter's hand-off. */
  hookText?: string
}

export interface ChapterSource {
  readChapter(n: number): string | undefined
  readSummary<T = unknown>(n: number): T | undefined
}

export interface Recall {
  search(bookId: string, terms: string[], beforeCh: number, limit: number): { n: number; para: string }[]
}

/** Character budgets per block (Chinese characters, roughly 1.5 tokens each). */
export const BUDGET = {
  book: 3500,
  arc: 3000,
  cast: 4000,
  handoff: 3200,
  recall: 2000,
  contract: 1500,
} as const

export function clamp(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** The last `max` characters, for the hand-off tail of the previous chapter. */
export function tail(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  // Start at a paragraph boundary when one is near, so the tail does not open mid-sentence.
  let start = chars.length - max
  const joined = chars.slice(start).join('')
  const cut = joined.indexOf('\n')
  if (cut >= 0 && cut < 200) return joined.slice(cut + 1)
  start = Math.max(0, start)
  return joined
}

export function realmText(power: Power, pos: RealmPos | undefined): string {
  if (!pos) return '凡人'
  const realm = power.realms.find(r => r.id === pos.id)
  if (!realm) return '未知境界'
  return `${realm.name}·${realm.stages[pos.stage] ?? realm.stages[realm.stages.length - 1] ?? ''}`
}

const STATUS_LABEL: Record<Character['status'], string> = { alive: '在世', dead: '已死', missing: '失踪', sealed: '被封印' }

// --- Book block (stable) ---------------------------------------------------------------------------------------------

export function bookBlock(book: Book, canon: Canon): string {
  const { bible, power } = canon
  const hero = canon.characters.find(c => c.id === bible.protagonistId)
  const ladder = [...power.realms].sort((a, b) => a.order - b.order)
    .map(r => `${r.order}. ${r.name}（${r.stages.join('/')}）${r.abilities.length ? `：${r.abilities.slice(0, 3).join('；')}` : ''}`)
    .join('\n')
  const lines = [
    `【书】《${book.title}》，${GENRE_LABELS[book.genre]}，${bible.style.pov}，每章 ${book.chapterChars[0]}–${book.chapterChars[1]} 字`,
    `【核心设定】${bible.premise}`,
    bible.sellingPoints.length ? `【卖点】${bible.sellingPoints.join('；')}` : '',
    `【金手指·${bible.goldenFinger.name}】规则：${bible.goldenFinger.rules.join('；')}。限制：${bible.goldenFinger.limits.join('；') || '无'}。成长：${bible.goldenFinger.growth}`,
    hero ? `【主角】${hero.name}，人设锚点：${hero.anchors.join('、') || '无'}${hero.speech ? `；说话：${hero.speech}` : ''}` : '',
    `【境界体系，从低到高】\n${ladder}\n越级战斗最多跨 ${power.crossRealmMaxGap} 个大境界，且必须写清凭什么能赢。`,
    `【终局方向】${bible.compass.endgame}${bible.compass.longLines.length ? `；长线：${bible.compass.longLines.join('；')}` : ''}`,
    bible.style.rules.length ? `【文风】${bible.style.rules.join('；')}` : '',
    bible.taboos.length ? `【禁区】${bible.taboos.join('；')}` : '',
  ]
  return clamp(lines.filter(Boolean).join('\n'), BUDGET.book)
}

// --- Arc block (changes per arc) -------------------------------------------------------------------------------------

export function currentArc(canon: Canon, n: number): Arc | undefined {
  return canon.plan.arcs.find(arc => arc.startCh !== undefined && n >= arc.startCh && n < arc.startCh + arc.chapters)
}

export function arcBlock(canon: Canon, arc: Arc, n: number, source: ChapterSource): string {
  const volumes = canon.plan.volumes.filter(v => v.n <= arc.volume)
    .map(v => `第${v.n}卷《${v.title}》：${v.summary ?? v.goal}`)
  const earlierArcs = canon.plan.arcs.filter(a => a.n < arc.n && a.summary).slice(-3)
    .map(a => `第${a.n}弧《${a.title}》：${a.summary}`)
  const start = arc.startCh ?? n
  const index = n - start
  const outline = (arc.outline ?? []).map((line, i) => `${i === index ? '→' : ' '} 第${start + i}章：${line}`)
  // This arc's chapters already written, as one-line summaries (only the latest 12 in full).
  const written: string[] = []
  for (let ch = start; ch < n; ch++) {
    const s = source.readSummary<ChapterSummary>(ch)
    if (s) written.push(ch >= n - 12 ? `第${ch}章《${s.title}》：${s.summary}` : `第${ch}章《${s.title}》`)
  }
  const lines = [
    `【卷】\n${volumes.join('\n')}`,
    earlierArcs.length ? `【前几弧】\n${earlierArcs.join('\n')}` : '',
    `【本弧】第${arc.n}弧《${arc.title}》，模板：${arc.template}，目标：${arc.goal}，共 ${arc.chapters} 章（第${start}–${start + arc.chapters - 1}章），高潮放在最后两成。`,
    outline.length ? `【本弧章纲】\n${outline.join('\n')}` : '',
    written.length ? `【本弧已写】\n${written.join('\n')}` : '',
  ]
  return clamp(lines.filter(Boolean).join('\n'), BUDGET.arc)
}

// --- Cast and ledgers (changes per chapter) --------------------------------------------------------------------------

export function characterCard(canon: Canon, c: Character): string {
  const relations = c.relations.slice(-6).map(r => {
    const other = canon.characters.find(o => o.id === r.to)
    return `${other?.name ?? r.to}（${r.kind}）`
  })
  const knows = c.knows.map(id => canon.secrets.find(s => s.id === id)).filter(s => s !== undefined).slice(-4).map(s => s.truth)
  const items = canon.items.filter(i => i.owner === c.id && (i.state === 'intact' || i.state === 'damaged')).slice(0, 8)
    .map(i => `${i.name}${i.qty > 1 ? `×${i.qty}` : ''}${i.state === 'damaged' ? '（受损）' : ''}`)
  return [
    `- ${c.name}〔${c.id}〕${c.aliases.length ? `又名${c.aliases.join('、')}，` : ''}${realmText(canon.power, c.realm)}，${STATUS_LABEL[c.status]}`,
    c.faction ? `，${c.faction}` : '',
    c.location ? `，现在${c.location}` : '',
    c.anchors.length ? `；锚点：${c.anchors.join('、')}` : '',
    c.speech ? `；说话：${c.speech}` : '',
    relations.length ? `；关系：${relations.join('、')}` : '',
    items.length ? `；持有：${items.join('、')}` : '',
    knows.length ? `；已知秘密：${knows.join('；')}` : '',
    `；最近出场第${c.lastSeenCh}章`,
  ].join('')
}

/** The cast cards for the given ids, protagonist first, then by id order given. Unknown ids are skipped. */
export function castBlock(canon: Canon, ids: string[]): string {
  const hero = canon.bible.protagonistId
  const ordered = [hero, ...ids.filter(id => id !== hero)]
  const cards = [...new Set(ordered)].map(id => canon.characters.find(c => c.id === id)).filter(c => c !== undefined)
    .map(c => characterCard(canon, c))
  return clamp(`【人物卡】\n${cards.join('\n')}`, BUDGET.cast)
}

export function foreshadowLine(f: Foreshadow): string {
  return `〔${f.id}〕${f.kind === 'promise' ? '承诺' : '伏笔'}：${f.content}（第${f.plantedCh}章埋，${f.dueBy ? `应在第${f.dueBy}章前收，` : ''}${f.priority === 'high' ? '高优先' : f.priority === 'mid' ? '中优先' : '低优先'}，${f.status}）`
}

/** Open threads: due soon first, then other open/progressing ones, capped. */
export function threadsBlock(canon: Canon, n: number, max = 12): string {
  const open = canon.foreshadow.filter(f => f.status === 'open' || f.status === 'progressing' || f.status === 'deferred')
  const rank = (f: Foreshadow) => (f.dueBy !== undefined && f.dueBy <= n + 3 ? 0 : 1) * 10 + (f.priority === 'high' ? 0 : f.priority === 'mid' ? 1 : 2)
  const picked = [...open].sort((a, b) => rank(a) - rank(b) || (a.dueBy ?? 1e9) - (b.dueBy ?? 1e9)).slice(0, max)
  const secrets = canon.secrets.filter(s => s.revealedToReaderCh === undefined).slice(0, 6)
  const lines = [
    picked.length ? `【未收的伏笔与承诺】\n${picked.map(foreshadowLine).join('\n')}` : '【未收的伏笔与承诺】无',
    secrets.length ? `【读者还不知道的真相（正文里不能直接揭露，除非合同要求）】\n${secrets.map(s => `〔${s.id}〕${s.truth}`).join('\n')}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

export function itemsBlock(canon: Canon, owners: string[], max = 15): string {
  const held = canon.items.filter((i: Item) => owners.includes(i.owner) && (i.state === 'intact' || i.state === 'damaged')).slice(0, max)
  if (!held.length) return ''
  return `【相关物品】\n${held.map(i => `〔${i.id}〕${i.name}，${i.kind}${i.grade ? `·${i.grade}` : ''}，数量 ${i.qty}，持有人 ${canon.characters.find(c => c.id === i.owner)?.name ?? i.owner}${i.state === 'damaged' ? '，受损' : ''}`).join('\n')}`
}

/** The last few chapters' types, so the planner avoids three in a row. */
export function pacingBlock(canon: Canon, n: number, last = 6): string {
  const recent = canon.pacing.filter(p => p.ch < n).slice(-last)
  if (!recent.length) return ''
  return `【最近几章的爽点/钩子类型】${recent.map(p => `第${p.ch}章 ${p.coolPoint}/${p.hook}`).join('；')}。同一爽点类型、同一钩子类型都不能连续三章。`
}

// --- Hand-off from the previous chapters ------------------------------------------------------------------------------

export function handoffBlock(source: ChapterSource, n: number, tailChars = 1500): string {
  const summaries: string[] = []
  for (let ch = Math.max(1, n - 3); ch < n; ch++) {
    const s = source.readSummary<ChapterSummary>(ch)
    if (s) summaries.push(`第${ch}章《${s.title}》（${s.location}，第${s.dayTo}天）：${s.summary}`)
  }
  const prev = n > 1 ? source.readChapter(n - 1) : undefined
  const prevSummary = n > 1 ? source.readSummary<ChapterSummary>(n - 1) : undefined
  const lines = [
    summaries.length ? `【最近几章】\n${summaries.join('\n')}` : '',
    prev ? `【上一章结尾原文】\n${tail(stripTitle(prev), tailChars)}` : '',
    prevSummary?.hookText ? `【上一章留下的钩子，本章开头要接住】${prevSummary.hookText}` : '',
  ]
  return clamp(lines.filter(Boolean).join('\n'), BUDGET.handoff)
}

export function stripTitle(text: string): string {
  return text.replace(/^#[^\n]*\n+/, '')
}

// --- Recall ----------------------------------------------------------------------------------------------------------

/** Names worth searching for: cast names, item names, location; at most 8. */
export function recallTerms(canon: Canon, contract: Pick<Contract, 'appearing' | 'location'>): string[] {
  const names = contract.appearing.map(id => canon.characters.find(c => c.id === id)?.name).filter((x): x is string => !!x)
  const items = canon.items.filter(i => contract.appearing.includes(i.owner) && i.state === 'intact').map(i => i.name).slice(0, 3)
  const terms = [...names.filter(name => name !== canon.characters.find(c => c.id === canon.bible.protagonistId)?.name), contract.location, ...items]
  return [...new Set(terms.filter(t => Array.from(t).length >= 2))].slice(0, 8)
}

export function recallBlock(recall: Recall | undefined, bookId: string, terms: string[], n: number, limit = 5): string {
  // Only chapters older than the hand-off window are worth recalling; the last three are already summarised.
  if (!recall || !terms.length || n <= 4) return ''
  const hits = recall.search(bookId, terms, n - 3, limit)
  if (!hits.length) return ''
  return clamp(`【旧章节相关段落（供保持一致，不要照抄）】\n${hits.map(h => `第${h.n}章：${clamp(h.para, 380)}`).join('\n')}`, BUDGET.recall)
}

// --- Contract text ---------------------------------------------------------------------------------------------------

export function contractBlock(canon: Canon, c: Contract): string {
  const name = (id: string) => canon.characters.find(x => x.id === id)?.name ?? id
  const fs = (id: string) => canon.foreshadow.find(f => f.id === id)?.content ?? id
  const lines = [
    `【本章合同】第${c.n}章《${c.title}》，视角：${name(c.pov)}，地点：${c.location}`,
    `目标：${c.goal}`,
    `情节点（按顺序全部写到）：\n${c.beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}`,
    `出场：${c.appearing.map(name).join('、')}`,
    `爽点（${c.coolPoint.type}）：${c.coolPoint.payoff}`,
    `章末钩子（${c.hook.type}）：${c.hook.text}`,
    c.foreshadow.plant.length ? `新埋伏笔：${c.foreshadow.plant.join('；')}` : '',
    c.foreshadow.advance.length ? `推进伏笔：${c.foreshadow.advance.map(fs).join('；')}` : '',
    c.foreshadow.resolve.length ? `回收伏笔：${c.foreshadow.resolve.map(fs).join('；')}` : '',
    c.plannedChanges.length ? `计划中的状态变化：${c.plannedChanges.join('；')}` : '本章没有计划境界突破，不要写突破。',
  ]
  return clamp(lines.filter(Boolean).join('\n'), BUDGET.contract)
}
