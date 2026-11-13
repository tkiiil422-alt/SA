/**
 * The deterministic chapter state machine and the arc loop.
 *
 * Code decides every step; a model only produces a contract, prose, a review or a delta, each checked before code acts
 * on it. Every step leaves a file under `work/ch-NNNN/`, so a process killed at any point resumes at the step it was in,
 * and `book.lastChapter` is the single commit point: canon, chapter text, summary and index rows are rewritten from the
 * pre-chapter snapshot until that number moves, which makes a repeated commit idempotent.
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { BookFiles } from './files.ts'
import type { NovelStore } from './store.ts'
import {
  ArcCloseSchema, ArcPlanSchema, ContractSchema, DeltaSchema, ReviewSchema, extractJson,
} from './schemas.ts'
import type { Arc, Book, Canon, Contract, Delta, Issue, Review } from './schemas.ts'
import {
  arcBlock, bookBlock, castBlock, clamp, contractBlock, currentArc, handoffBlock, itemsBlock, pacingBlock, realmText,
  recallBlock, recallTerms, stripTitle, tail, threadsBlock,
} from './context.ts'
import type { ChapterSummary } from './context.ts'
import {
  ARC_CLOSE_SYSTEM, ARC_PLANNER_SYSTEM, EXTRACTOR_SYSTEM, PLANNER_SYSTEM, REVIEWER_SYSTEM, REVISER_SYSTEM, WRITER_SYSTEM,
  arcCloseUser, arcPlannerUser, contractProblems, extractorUser, issueLine, openingRules, plannerUser, reviewerUser,
  reviserUser, writerUser,
} from './prompts.ts'
import { applyDelta, validateDelta } from './checks.ts'
import type { CheckIssue } from './checks.ts'
import { countChars, lintChapter } from './lint.ts'
import type { LintIssue } from './lint.ts'

export type Role = 'planner' | 'writer' | 'reviewer' | 'extractor'

export interface CallResult { text: string; truncated: boolean; costUsd: number }
/** One model call for a role. Throws `Stopped`, `NeedsPerson` (budget) or `ModelFailure`; never returns a failed call. */
/** `context` is stable book material sent as its own earlier message so the upstream can cache it across calls. */
export type Ask = (role: Role, system: string, user: string, maxTokens: number, context?: string) => Promise<CallResult>

/** The work stops and waits for a person: one question, with a default answer in the text. */
export class NeedsPerson extends Error {
  constructor(readonly question: string, readonly summary: string) { super(summary) }
}
/** A person stopped or paused the ticket; the current step's result is discarded, its checkpoints stay. */
export class Stopped extends Error {
  constructor() { super('stopped') }
}
/** An upstream model kept failing after retries. */
export class ModelFailure extends Error {}

export interface WriterOptions {
  maxRevisions: number
  /** Review score below this triggers a revision. */
  minScore: number
  /** Fix-level issues (lint + review) at or above this count trigger a revision. */
  fixThreshold: number
  extraBanned?: string[]
  phrases?: string[]
}

export const DEFAULT_WRITER_OPTIONS: WriterOptions = { maxRevisions: 2, minScore: 6, fixThreshold: 3 }

export interface ChapterOutcome {
  n: number
  title: string
  chars: number
  costUsd: number
  status: 'committed' | 'flagged'
  score: number | null
  notes: string[]
}

export interface ArcOutcome {
  arc: number
  title: string
  chapters: number
  summary: string
  flagged: ChapterOutcome[]
  notes: string[]
}

export interface NovelWriterDeps {
  files: BookFiles
  store: NovelStore
  db: DatabaseSync
  ask: Ask
  now?: () => Date
  options?: Partial<WriterOptions>
  /** Called between steps; throws `Stopped` (or anything) to end the run there. */
  checkpoint?: () => void
}

const FACT_CODES = new Set(['deadActs', 'realmDrop', 'realmJump', 'itemGone', 'itemQty', 'resolvedAgain'])
const SOFT_CODES = new Set(['travel'])

const normalize = (text: string): string => text.replace(/[“”„‟"「」『』]/g, '"').replace(/[‘’']/g, "'").replace(/\s+/g, '')

/** Whether `quote` appears in `text` after both are stripped of whitespace and their quote marks unified. */
export function quoted(text: string, quote: string): boolean {
  const q = normalize(quote).replace(/^["']+|["']+$/g, '')
  return q.length >= 2 && normalize(text).includes(q)
}

/** Remove `null` values and empty strings everywhere, so optional keys a model filled with null parse as absent. */
export function dropEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropEmpty)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (v === null || v === '') continue
    out[key] = dropEmpty(v)
  }
  return out
}

/**
 * Cut every string a schema rejected as too long down to its maximum, in place on a copy. A model that writes a 420-char
 * summary for a 400-char field should not cost a whole retry; a cut quote is still a prefix of the real text, so the
 * quote check keeps its meaning. Returns undefined when no issue was a too-long string.
 */
export function trimTooLong(value: unknown, error: z.ZodError): unknown {
  // Lists too: a planner resolving four threads where the contract allows three (seen at chapter 89) keeps the first three.
  const fixes = error.issues.filter(issue => issue.code === 'too_big' && ['string', 'array'].includes(String((issue as { origin?: unknown }).origin)))
  if (!fixes.length) return undefined
  const copy = structuredClone(value)
  let changed = false
  for (const issue of fixes) {
    const max = Number((issue as { maximum?: unknown }).maximum)
    if (!Number.isFinite(max) || max < 1 || !issue.path.length) continue
    let parent: unknown = copy
    for (const key of issue.path.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object') { parent = undefined; break }
      parent = (parent as Record<PropertyKey, unknown>)[key as PropertyKey]
    }
    const last = issue.path[issue.path.length - 1] as PropertyKey
    if (parent === null || typeof parent !== 'object') continue
    const current = (parent as Record<PropertyKey, unknown>)[last]
    if (typeof current === 'string') {
      ;(parent as Record<PropertyKey, unknown>)[last] = Array.from(current.trim()).slice(0, max).join('')
      changed = true
    } else if (Array.isArray(current)) {
      ;(parent as Record<PropertyKey, unknown>)[last] = current.slice(0, max)
      changed = true
    }
  }
  return changed ? copy : undefined
}

/**
 * How far the protagonist must climb in this arc to reach the highest realm the endgame names, spread over the arcs
 * left (about 30 chapters each). Undefined when the endgame names no realm above the protagonist's.
 */
export function growthPlan(canon: Canon, remaining: number, chapters: number): string | undefined {
  const realms = [...canon.power.realms].sort((a, b) => a.order - b.order)
  const hero = canon.characters.find(c => c.id === canon.bible.protagonistId)
  const current = realms.find(r => r.id === hero?.realm?.id)
  const target = [...realms].reverse().find(r => canon.bible.compass.endgame.includes(r.name))
  if (!hero || !current || !target || target.order <= current.order) return undefined
  const ladder = realms.filter(r => r.order > current.order && r.order <= target.order)
  const arcsLeft = Math.max(1, Math.ceil(remaining / 30))
  const share = Math.min(ladder.length, Math.max(1, Math.round((ladder.length * chapters) / remaining)))
  const reach = ladder[share - 1]!
  return `主角现在是${current.name}，终局要到${target.name}，中间还有 ${ladder.length} 个大境界（${ladder.map(r => r.name).join('→')}），全书约剩 ${arcsLeft} 弧。本弧要让主角突破 ${share} 个大境界，弧末到达${reach.name}；突破分散在弧中不同章节。`
}

/** The most chapters one arc may plan (ArcPlanSchema's outline limit). */
export const MAX_ARC_CHAPTERS = 60

/** The book's planned length: volumesPlanned × chaptersPerVolume. */
export function bookTotal(book: Book): number {
  return book.volumesPlanned * book.chaptersPerVolume
}

function zodReason(error: z.ZodError): string {
  return error.issues.slice(0, 6).map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')
}

/** Normalise a draft to `# 标题\n\n正文`. */
export function normalizeDraft(raw: string, fallbackTitle: string): { title: string; text: string } {
  let text = raw.replace(/```[a-z]*\n?/gi, '').replace(/\r\n/g, '\n').trim()
  let title = fallbackTitle
  const first = /^#+\s*(.+)\n/.exec(text + '\n')
  if (first?.[1]) {
    title = first[1].replace(/^第[0-9零一二三四五六七八九十百千]+章[\s:：]*/, '').trim() || fallbackTitle
    text = text.slice(first[0].length)
  } else {
    const plain = /^第[0-9零一二三四五六七八九十百千]+章[\s:：]*([^\n]{1,30})\n/.exec(text + '\n')
    if (plain) { title = plain[1]?.trim() || fallbackTitle; text = text.slice(plain[0].length) }
  }
  title = Array.from(title).slice(0, 30).join('')
  return { title, text: `# ${title}\n\n${text.trim()}\n` }
}

export class NovelWriter {
  private readonly files: BookFiles
  private readonly store: NovelStore
  private readonly db: DatabaseSync
  private readonly ask: Ask
  private readonly now: () => Date
  private readonly opts: WriterOptions
  private readonly checkpoint: () => void

  constructor(deps: NovelWriterDeps) {
    this.files = deps.files
    this.store = deps.store
    this.db = deps.db
    this.ask = deps.ask
    this.now = deps.now ?? (() => new Date())
    this.opts = { ...DEFAULT_WRITER_OPTIONS, ...deps.options }
    this.checkpoint = deps.checkpoint ?? (() => undefined)
  }

  get book(): Book { return this.files.readBook() }

  // --- JSON calls ---------------------------------------------------------------------------------------------------

  private async askJson<T>(role: Role, system: string, user: (retry?: string) => string, schema: z.ZodType<T>, maxTokens: number,
    check?: (value: T) => string[], attempts = 3, context?: string): Promise<{ value: T; costUsd: number; problems: string[] }> {
    let reason: string | undefined
    let cost = 0
    let last: T | undefined
    let lastProblems: string[] = []
    for (let i = 0; i < attempts; i++) {
      this.checkpoint()
      const result = await this.ask(role, system, user(reason), maxTokens, context)
      cost += result.costUsd
      const raw = extractJson(result.text)
      if (raw === undefined) { reason = result.truncated ? '输出被截断，JSON 不完整，请写得更简短' : '没有找到 JSON 对象'; continue }
      const cleaned = dropEmpty(raw)
      let parsed = schema.safeParse(cleaned)
      if (!parsed.success) {
        const trimmed = trimTooLong(cleaned, parsed.error)
        if (trimmed !== undefined) parsed = schema.safeParse(trimmed)
      }
      if (!parsed.success) { reason = `JSON 不符合格式：${zodReason(parsed.error)}`; continue }
      const problems = check?.(parsed.data) ?? []
      last = parsed.data
      lastProblems = problems
      if (!problems.length) return { value: parsed.data, costUsd: cost, problems: [] }
      reason = problems.slice(0, 8).join('；')
    }
    if (last !== undefined) return { value: last, costUsd: cost, problems: lastProblems }
    throw new NeedsPerson(
      `${role === 'planner' ? '章纲' : role === 'extractor' ? '事实抽取' : role === 'reviewer' ? '审稿' : '规划'}连续 ${attempts} 次输出不合格（${reason ?? '未知'}）。要换一个模型后重试吗？默认：换成设置里的其他模型后点重试。`,
      `模型输出连续不合格：${reason ?? ''}`,
    )
  }

  // --- Arc planning -------------------------------------------------------------------------------------------------

  /** The arc containing the next chapter, planning it (and the skeleton after it) when it is still a skeleton. */
  async nextArc(note?: string): Promise<Arc> {
    let canon = this.files.readCanon()
    const book = this.book
    const next = book.lastChapter + 1
    const open = currentArc(canon, next)
    if (open) return open
    const total = bookTotal(book)
    const remaining = total - book.lastChapter
    if (remaining <= 0) throw new NeedsPerson(`全书计划的 ${total} 章已经写完。要续写吗？默认：不续写，全书完本。`, '全书已写完')
    const skeleton = [...canon.plan.arcs].sort((a, b) => a.n - b.n).find(arc => arc.status === 'skeleton')
    if (!skeleton) throw new NeedsPerson('计划里没有下一弧了，全书要在这里完结吗？默认：不完结，让规划模型续一弧骨架。', '没有可写的下一弧')
    // The book ends at volumesPlanned × chaptersPerVolume. When what is left fits one arc, this arc is the finale and
    // takes all of it; otherwise it leaves at least 20 chapters so the finale is not squeezed.
    const finale = remaining <= MAX_ARC_CHAPTERS
    const chapters = finale ? Math.max(5, remaining) : Math.min(skeleton.chapters, remaining - 20)
    const cast = castBlock(canon, this.mainCast(canon, next))
    const { value, costUsd } = await this.askJson('planner', ARC_PLANNER_SYSTEM, retry => arcPlannerUser({
      book: '',
      arc: arcBlock(canon, skeleton, next, this.files),
      threads: threadsBlock(canon, next),
      cast,
      chapters,
      ...(finale ? { finale: { lastCh: next + chapters - 1, endgame: canon.bible.compass.endgame } } : {}),
      ...(growthPlan(canon, remaining, chapters) ? { growth: growthPlan(canon, remaining, chapters) } : {}),
      ...(note ? { note } : {}),
      ...(retry ? { retryReason: retry } : {}),
    }), ArcPlanSchema, 8192, plan => plan.outline.length === chapters ? [] : [`outline 有 ${plan.outline.length} 行，要求正好 ${chapters} 行`], 3, bookBlock(book, canon))
    void costUsd
    canon = this.files.readCanon()
    const arcs = canon.plan.arcs.map(arc => arc.n !== skeleton.n ? arc : {
      ...arc,
      title: value.title,
      goal: value.goal,
      chapters: value.outline.length,
      outline: value.outline,
      startCh: next,
      status: 'planned' as const,
    })
    // Keep at least one skeleton ahead so the book always knows where it goes next; after the finale there is none.
    const later = arcs.filter(arc => arc.n > skeleton.n)
    if (finale) {
      const kept = arcs.filter(arc => !(arc.n > skeleton.n && arc.status === 'skeleton'))
      arcs.splice(0, arcs.length, ...kept)
    } else if (!later.length) {
      let lastN = skeleton.n
      let used = this.chaptersInVolume(canon, skeleton.volume) + value.outline.length
      let volume = skeleton.volume
      for (const item of value.next.slice(0, 1)) {
        if (used >= book.chaptersPerVolume && volume < book.volumesPlanned) { volume++; used = 0 }
        lastN++
        arcs.push({ n: lastN, volume, title: item.title, template: item.template === skeleton.template ? (skeleton.template === '宗门日常' ? '成长突破' : '宗门日常') : item.template, goal: item.goal, chapters: item.chapters, status: 'skeleton' })
        if (!canon.plan.volumes.some(v => v.n === volume)) canon.plan.volumes.push({ n: volume, title: `第${volume}卷`, goal: canon.bible.compass.endgame })
      }
    }
    canon.plan.arcs = arcs
    this.files.writeCanon(canon)
    const planned = canon.plan.arcs.find(arc => arc.n === skeleton.n)
    if (!planned) throw new Error('arc vanished while planning')
    return planned
  }

  private chaptersInVolume(canon: Canon, volume: number): number {
    return canon.plan.arcs.filter(arc => arc.volume === volume && arc.status !== 'skeleton').reduce((sum, arc) => sum + arc.chapters, 0)
  }

  /** The protagonist and the characters seen most recently, alive, at most `max`. */
  private mainCast(canon: Canon, n: number, max = 10): string[] {
    const hero = canon.bible.protagonistId
    const others = canon.characters.filter(c => c.id !== hero && c.status !== 'dead')
      .sort((a, b) => (b.lastSeenCh - a.lastSeenCh) || ((a.role === 'minor' ? 1 : 0) - (b.role === 'minor' ? 1 : 0)))
      .filter(c => c.role !== 'minor' || n - c.lastSeenCh <= 3)
      .slice(0, max - 1).map(c => c.id)
    return [hero, ...others]
  }

  /** Characters whose name or alias occurs in `text`. */
  private namedIn(canon: Canon, text: string): string[] {
    return canon.characters.filter(c => [c.name, ...c.aliases].some(name => Array.from(name).length >= 2 && text.includes(name))).map(c => c.id)
  }

  // --- One chapter --------------------------------------------------------------------------------------------------

  /** Write, check and commit chapter `n` (which must be `lastChapter + 1`) of `arc`. */
  async writeChapter(arc: Arc, steer?: string): Promise<ChapterOutcome> {
    const book = this.book
    const n = book.lastChapter + 1
    const notes: string[] = []
    let cost = 0
    const at = () => this.now().toISOString()
    const mark = (step: string, attempt: number, note = '') => this.store.markStep(book.id, n, step, attempt, 'done', note, at())

    // 1. Contract
    let canon = this.files.readCanon()
    let contract: Contract
    const saved = this.files.readWork(n, 'contract.json')
    if (saved) {
      contract = ContractSchema.parse(JSON.parse(saved))
    } else {
      const known = new Set(canon.characters.filter(c => c.status !== 'dead').map(c => c.id))
      const fsIds = new Set(canon.foreshadow.filter(f => f.status !== 'resolved' && f.status !== 'dropped').map(f => f.id))
      const recent = canon.pacing.filter(p => p.ch < n).slice(-2)
      const repeats = (c: Contract): string[] => {
        const out: string[] = []
        if (recent.length === 2 && recent.every(p => p.coolPoint === c.coolPoint.type)) out.push(`爽点类型「${c.coolPoint.type}」已连续两章使用，换一个`)
        if (recent.length === 2 && recent.every(p => p.hook === c.hook.type)) out.push(`钩子类型「${c.hook.type}」已连续两章使用，换一个`)
        return out
      }
      const planned = await this.askJson('planner', PLANNER_SYSTEM, retry => plannerUser({
        book: '',
        arc: arcBlock(canon, arc, n, this.files),
        cast: castBlock(canon, this.mainCast(canon, n, 12)),
        threads: threadsBlock(canon, n),
        pacing: pacingBlock(canon, n),
        handoff: handoffBlock(this.files, n, 800),
        n,
        rules: openingRules(n),
        ...(steer ? { steer } : {}),
        ...(retry ? { retryReason: retry } : {}),
      }), ContractSchema, 3000, c => [...contractProblems(c, known, fsIds), ...repeats(c)], 3, bookBlock(book, canon))
      cost += planned.costUsd
      contract = this.sanitizeContract(canon, planned.value, n)
      if (planned.problems.length) notes.push(`章纲未完全合格：${planned.problems.slice(0, 3).join('；')}`)
      this.files.writeWork(n, 'contract.json', JSON.stringify(contract, null, 2))
      mark('contract', 1)
    }
    this.checkpoint()

    // 2. Draft
    let draftIndex = 0
    let draft = this.files.readWork(n, 'draft-0.md')
    if (!draft) {
      const castIds = [...new Set([...contract.appearing, ...this.namedIn(canon, contract.beats.join(''))])]
      const result = await this.ask('writer', WRITER_SYSTEM, writerUser({
        book: '',
        arc: arcBlock(canon, arc, n, this.files),
        cast: castBlock(canon, castIds),
        threads: threadsBlock(canon, n, 8),
        items: itemsBlock(canon, castIds),
        pacing: '',
        handoff: handoffBlock(this.files, n),
        recall: recallBlock(this.store, book.id, recallTerms(canon, contract), n),
        contract: contractBlock(canon, contract),
        ...(steer ? { steer } : {}),
        targetChars: book.chapterChars,
      }), 8192, bookBlock(book, canon))
      cost += result.costUsd
      let raw = result.text
      if (result.truncated) {
        const more = await this.ask('writer', WRITER_SYSTEM, [
          contractBlock(canon, contract),
          `【本章已写部分的结尾】\n${tail(raw, 1500)}`,
          '上面这一章写到一半被截断了。请从断处直接接着写完本章，不重复已写内容，不写标题，只输出续写的正文。',
        ].join('\n\n'), 6000)
        cost += more.costUsd
        raw = `${raw}${more.text}`
      }
      draft = normalizeDraft(raw, contract.title).text
      this.files.writeWork(n, 'draft-0.md', draft)
      mark('draft', 1)
    } else {
      while (this.files.readWork(n, `draft-${draftIndex + 1}.md`)) draftIndex++
      draft = this.files.readWork(n, `draft-${draftIndex}.md`) ?? draft
    }
    this.checkpoint()

    // 3. Lint → review → revise
    const previous: string[] = []
    for (let ch = Math.max(1, n - 10); ch < n; ch++) {
      const text = this.files.readChapter(ch)
      if (text) previous.push(stripTitle(text))
    }
    const banned = [...canon.bible.style.banned, ...(this.opts.extraBanned ?? [])]
    const lint = (text: string) => lintChapter(text, { chars: book.chapterChars, banned, previous, ...(this.opts.phrases ? { phrases: this.opts.phrases } : {}) })
    const castIds = [...new Set([...contract.appearing, ...this.namedIn(canon, draft)])]
    let review: Review | undefined
    let lintIssues: LintIssue[] = []
    /** Every reviewed draft this run saw, so the best one is kept rather than simply the last. */
    const rounds: { draft: string; score: number; blocks: Issue[] }[] = []
    // Drafts reviewed before a restart still compete for "best".
    for (let i = 0; i < draftIndex; i++) {
      const earlier = this.files.readWork(n, `draft-${i}.md`)
      const earlierReview = this.files.readWork(n, `review-${i}.json`)
      if (!earlier || !earlierReview) continue
      try {
        const parsed = ReviewSchema.parse(JSON.parse(earlierReview))
        rounds.push({ draft: earlier, score: parsed.score, blocks: parsed.issues.filter(issue => issue.severity === 'block') })
      } catch { /* an unreadable review just drops out */ }
    }
    for (let round = draftIndex; ; round++) {
      lintIssues = lint(draft).issues
      const savedReview = this.files.readWork(n, `review-${round}.json`)
      if (savedReview) {
        review = ReviewSchema.parse(JSON.parse(savedReview))
      } else {
        const body = stripTitle(draft)
        const reviewed = await this.askJson('reviewer', REVIEWER_SYSTEM, () => reviewerUser({
          contract: contractBlock(canon, contract),
          cast: castBlock(canon, castIds),
          text: draft ?? '',
          lint: lintIssues.map(issue => issue.message),
        }), ReviewSchema, 3000, undefined, 4).catch(error => {
          // Four tries (was two: 4 of 26 chapters went out unreviewed). Over-long issue lists are now trimmed rather than
          // rejected. A reviewer that still cannot produce JSON must not stop the book: the chapter goes on flagged.
          if (error instanceof NeedsPerson) return undefined
          throw error
        })
        if (reviewed) {
          cost += reviewed.costUsd
          review = { score: reviewed.value.score, issues: reviewed.value.issues.filter((issue: Issue) => quoted(body, issue.quote)) }
        } else {
          review = { score: 5, issues: [] }
          notes.push('审稿模型输出不合格，本章未审')
        }
        this.files.writeWork(n, `review-${round}.json`, JSON.stringify(review, null, 2))
        mark(`review-${round}`, 1, `score ${review.score}`)
      }
      rounds.push({ draft, score: review.score, blocks: review.issues.filter(issue => issue.severity === 'block') })
      const blocks = review.issues.filter(issue => issue.severity === 'block')
      const fixes = review.issues.filter(issue => issue.severity === 'fix').length + lintIssues.filter(issue => issue.severity === 'fix').length
      // A length a little outside the range is not worth a rewrite (rewrites tend to shrink a chapter); only a far miss is.
      const chars = countChars(draft)
      const farOff = chars < book.chapterChars[0] * 0.8 || chars > book.chapterChars[1] * 1.35
      const needs = blocks.length > 0 || fixes >= this.opts.fixThreshold || review.score < this.opts.minScore || farOff
        || lintIssues.some(issue => issue.code === 'meta' || issue.code === 'banned')
      if (!needs || round >= this.opts.maxRevisions) break
      this.checkpoint()
      draft = await this.revise(canon, contract, castIds, draft, [
        ...review.issues.filter(issue => issue.severity !== 'note').map(issueLine),
        ...lintIssues.filter(issue => issue.severity === 'fix').map(issue => `［代码检查］${issue.message}`),
      ], book, c => { cost += c })
      this.files.writeWork(n, `draft-${round + 1}.md`, draft)
      mark(`revise-${round + 1}`, 1)
    }
    // Keep the best reviewed draft: fewest hard problems, then highest score, then the later one on a tie.
    // A draft that was revised after its last review has no review of its own, so only reviewed drafts compete.
    // Ties on hard problems and score go to the draft whose length is closer to the target range.
    const [minChars, maxChars] = book.chapterChars
    const lengthMiss = (text: string): number => {
      const c = countChars(text)
      return c < minChars ? minChars - c : c > maxChars ? c - maxChars : 0
    }
    const best = rounds.reduce<typeof rounds[number] | undefined>((acc, item) => {
      if (!acc) return item
      if (item.blocks.length !== acc.blocks.length) return item.blocks.length < acc.blocks.length ? item : acc
      if (item.score !== acc.score) return item.score > acc.score ? item : acc
      return lengthMiss(item.draft) <= lengthMiss(acc.draft) ? item : acc
    }, undefined)
    if (best && best.draft !== draft) {
      draft = best.draft
      notes.push(`采用了审稿分最高的一稿（${best.score} 分）`)
    }
    const unresolved = best?.blocks ?? review?.issues.filter(issue => issue.severity === 'block') ?? []
    if (best) review = { score: best.score, issues: review?.issues ?? [] }
    let flagged = unresolved.length > 0
    if (flagged) notes.push(`修订用完仍有硬伤：${unresolved.slice(0, 3).map(issue => issue.problem).join('；')}`)
    this.checkpoint()

    // 4. Extract → validate (the text is fixed for facts only when a fact check fails)
    const lastEntry = canon.timeline[canon.timeline.length - 1]
    const lastDay = lastEntry?.dayTo ?? 0
    const lastLocation = lastEntry?.location ?? ''
    const realms = `【境界 id 与阶段序号】\n${[...canon.power.realms].sort((a, b) => a.order - b.order).map(r => `〔${r.id}〕${r.name}：${r.stages.map((s, i) => `${i}=${s}`).join(' ')}`).join('\n')}`
    let delta: Delta | undefined
    const savedDelta = this.files.readWork(n, 'delta.json')
    if (savedDelta) delta = DeltaSchema.parse(JSON.parse(savedDelta))
    let factRounds = 0
    let extractRetries = 0
    let reason: string | undefined
    let issues: CheckIssue[] = []
    while (!savedDelta) {
      this.checkpoint()
      const text = stripTitle(draft)
      const ids = [...new Set([...contract.appearing, ...this.namedIn(canon, text)])]
      const extracted = await this.askJson('extractor', EXTRACTOR_SYSTEM, retry => extractorUser({
        cast: castBlock(canon, ids),
        items: itemsBlock(canon, ids, 25),
        threads: threadsBlock(canon, n, 15),
        realms,
        lastDay,
        lastLocation,
        text,
        ...(retry ?? reason ? { retryReason: [retry, reason].filter(Boolean).join('；') } : {}),
      }), DeltaSchema, 4096)
      cost += extracted.costUsd
      // Extractors often answer with a location id; the timeline and the travel check work on names.
      const place = canon.world.locations.find(l => l.id === extracted.value.location)
      delta = place ? { ...extracted.value, location: place.name } : extracted.value
      issues = validateDelta(canon, contract, delta, text, n).filter(issue => !SOFT_CODES.has(issue.code))
      if (!issues.length) break
      const facts = issues.filter(issue => FACT_CODES.has(issue.code))
      if (extractRetries < 2) {
        extractRetries++
        reason = `上一次抽取有问题：${issues.slice(0, 6).map(issue => issue.message).join('；')}。如果是你记错了就改正；如果正文确实如此，照实记录`
        continue
      }
      if (facts.length && factRounds < 2) {
        factRounds++
        extractRetries = 0
        reason = undefined
        draft = await this.revise(canon, contract, castIds, draft, facts.map(issue => `［设定冲突，必须改］${issue.message}`), book, c => { cost += c })
        this.files.writeWork(n, `draft-fact-${factRounds}.md`, draft)
        mark(`fact-revise-${factRounds}`, 1)
        continue
      }
      if (facts.length) {
        throw new NeedsPerson(
          `第 ${n} 章两次重写后仍与设定冲突：${facts.slice(0, 2).map(issue => issue.message).join('；')}。要按正文修改设定，还是删掉冲突情节重写？默认：删掉冲突情节重写。`,
          `第 ${n} 章与设定冲突，已暂停`,
        )
      }
      // Only extraction mistakes are left: keep the chapter and every entry that still validates, flag it for the arc report.
      delta = this.salvage(canon, contract, delta, text, n, lastDay)
      const remaining = validateDelta(canon, contract, delta, text, n).filter(issue => !SOFT_CODES.has(issue.code))
      if (remaining.length) {
        throw new NeedsPerson(`第 ${n} 章的事实抽取无法通过校验：${remaining[0]?.message ?? ''}。要跳过这一章的设定更新吗？默认：重写这一章。`, `第 ${n} 章抽取失败`)
      }
      flagged = true
      notes.push(`事实抽取部分丢弃（不合格的条目没有记入设定）：${issues.slice(0, 3).map(issue => issue.message).join('；')}`)
      break
    }
    if (!delta) throw new Error('no delta')
    if (!savedDelta) {
      this.files.writeWork(n, 'delta.json', JSON.stringify(delta, null, 2))
      this.files.writeWork(n, 'final.md', draft)
      mark('extract', 1)
    } else {
      draft = this.files.readWork(n, 'final.md') ?? draft
    }
    this.checkpoint()

    // 5. Commit
    const prior = this.files.readWork(n, 'meta.json')
    const meta = prior ? JSON.parse(prior) as { costUsd: number; flagged: boolean; notes: string[] } : { costUsd: 0, flagged: false, notes: [] }
    const totalCost = meta.costUsd + cost
    const isFlagged = meta.flagged || flagged
    const allNotes = [...meta.notes, ...notes]
    this.files.writeWork(n, 'meta.json', JSON.stringify({ costUsd: totalCost, flagged: isFlagged, notes: allNotes }))
    return this.commit(arc, contract, delta, draft, { costUsd: totalCost, flagged: isFlagged, notes: allNotes, score: review?.score ?? null })
  }

  private async revise(canon: Canon, contract: Contract, castIds: string[], draft: string, issues: string[], book: Book, addCost: (c: number) => void): Promise<string> {
    const result = await this.ask('writer', REVISER_SYSTEM, reviserUser({
      contract: contractBlock(canon, contract),
      cast: castBlock(canon, castIds),
      draft,
      issues,
      targetChars: book.chapterChars,
    }), 8192)
    addCost(result.costUsd)
    // A truncated revision, or one that lost a quarter of the chapter, is worse than the draft it replaces: rewrites
    // tend to compress, and a shrinking chapter drifts out of the target range after two rounds.
    const before = countChars(draft)
    const after = countChars(result.text)
    if (result.truncated || after < book.chapterChars[0] * 0.75 || after < before * 0.75) return draft
    return normalizeDraft(result.text, contract.title).text
  }

  private sanitizeContract(canon: Canon, raw: Contract, n: number): Contract {
    const alive = new Set(canon.characters.filter(c => c.status !== 'dead').map(c => c.id))
    const dead = new Set(canon.characters.filter(c => c.status === 'dead').map(c => c.id))
    const fsOpen = new Set(canon.foreshadow.filter(f => f.status !== 'resolved' && f.status !== 'dropped').map(f => f.id))
    const allowDead = raw.allowDead.filter(id => dead.has(id))
    const ok = (id: string) => alive.has(id) || allowDead.includes(id)
    const pov = ok(raw.pov) ? raw.pov : canon.bible.protagonistId
    const appearing = [...new Set([pov, ...raw.appearing.filter(ok)])]
    return {
      ...raw,
      n,
      pov,
      appearing,
      allowDead,
      foreshadow: {
        plant: raw.foreshadow.plant,
        advance: raw.foreshadow.advance.filter(id => fsOpen.has(id)),
        resolve: raw.foreshadow.resolve.filter(id => fsOpen.has(id)),
      },
    }
  }

  /**
   * The safe minimum of a delta plus every entry that still validates, added back one at a time in dependency order
   * (new characters first, then changes, items, threads, secrets), so one bad item reference costs only that entry.
   */
  private salvage(canon: Canon, contract: Contract, delta: Delta, text: string, n: number, lastDay: number): Delta {
    let kept = this.degrade(canon, contract, delta, lastDay)
    const ok = (candidate: Delta) => !validateDelta(canon, contract, candidate, text, n).some(issue => !SOFT_CODES.has(issue.code))
    if (!ok(kept)) return kept
    const fields = ['newCharacters', 'characterChanges', 'items', 'foreshadow', 'secretsRevealed'] as const
    for (const field of fields) {
      for (const entry of delta[field] as unknown[]) {
        const candidate = { ...kept, [field]: [...(kept[field] as unknown[]), entry] } as Delta
        if (ok(candidate)) kept = candidate
      }
    }
    // Characters only the dropped entries introduced are not on the page as far as the canon knows.
    const known = new Set([...canon.characters.map(c => c.id), ...kept.newCharacters.map(c => c.id)])
    const appeared = delta.appeared.filter(id => known.has(id))
    const withAppeared = { ...kept, appeared }
    return ok(withAppeared) ? withAppeared : kept
  }

  /** The safe minimum of a delta: who appeared, when and where, the summary and pacing types. */
  private degrade(canon: Canon, contract: Contract, delta: Delta, lastDay: number): Delta {
    const usable = new Set(canon.characters.filter(c => c.status !== 'dead' || contract.allowDead.includes(c.id)).map(c => c.id))
    return {
      appeared: delta.appeared.filter(id => usable.has(id)),
      newCharacters: [],
      characterChanges: [],
      items: [],
      foreshadow: [],
      secretsRevealed: [],
      time: { dayFrom: lastDay, dayTo: Math.max(lastDay, delta.time.dayTo), flashback: false },
      location: delta.location,
      summary: delta.summary,
      coolPoint: delta.coolPoint,
      hook: delta.hook,
    }
  }

  private commit(arc: Arc, contract: Contract, delta: Delta, draft: string, meta: { costUsd: number; flagged: boolean; notes: string[]; score: number | null }): ChapterOutcome {
    const book = this.book
    const n = book.lastChapter + 1
    // Start from the canon as it was before this chapter, whatever a crashed earlier commit left.
    if (this.files.hasSnapshot(n)) this.files.restore(n)
    else this.files.snapshot(n)
    const canon = applyDelta(this.files.readCanon(), contract, delta, n, arc.n)
    const { title } = normalizeDraft(draft, contract.title)
    const chars = countChars(draft)
    const summary: ChapterSummary = {
      n, arc: arc.n, title, summary: delta.summary, appeared: delta.appeared, location: delta.location, dayTo: delta.time.dayTo,
      coolPoint: delta.coolPoint, hook: delta.hook, hookText: contract.hook.text,
    }
    this.files.writeCanon(canon)
    this.files.writeChapter(n, draft)
    this.files.writeSummary(n, summary)
    const at = this.now().toISOString()
    const status = meta.flagged ? 'flagged' : 'committed'
    this.db.exec('BEGIN')
    try {
      this.store.indexChapter(book.id, n, stripTitle(draft))
      this.store.recordChapter({
        bookId: book.id, n, arc: arc.n, title, chars, sha256: createHash('sha256').update(draft).digest('hex'),
        status, costUsd: meta.costUsd, score: meta.score, committedAt: at,
      })
      this.store.markStep(book.id, n, 'commit', 1, 'done', meta.notes.join('；').slice(0, 500), at)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    // The commit point.
    this.files.writeBook({ ...book, lastChapter: n, phase: 'writing', updatedAt: at })
    this.files.writeWork(n, 'committed', at)
    const starts = new Set(canon.plan.arcs.map(a => a.startCh).filter((x): x is number => x !== undefined))
    this.files.pruneSnapshots(s => s > n - 40 || starts.has(s))
    this.files.clearWork(n)
    return { n, title, chars, costUsd: meta.costUsd, status, score: meta.score, notes: meta.notes }
  }

  // --- Arc close ----------------------------------------------------------------------------------------------------

  async closeArc(arc: Arc): Promise<ArcOutcome> {
    const book = this.book
    let canon = this.files.readCanon()
    const start = arc.startCh ?? 1
    const lines: string[] = []
    for (let ch = start; ch < start + arc.chapters; ch++) {
      const s = this.files.readSummary<ChapterSummary>(ch)
      if (s) lines.push(`第${ch}章《${s.title}》：${s.summary}`)
    }
    const next = book.lastChapter + 1
    let closed: z.infer<typeof ArcCloseSchema>
    try {
      closed = (await this.askJson('planner', ARC_CLOSE_SYSTEM, () => arcCloseUser({
        arc: `第${arc.n}弧《${arc.title}》：${arc.goal}`,
        summaries: clamp(lines.join('\n'), 12000),
        threads: threadsBlock(canon, next, 20),
        cast: castBlock(canon, this.mainCast(canon, next, 14)),
        nextCh: next,
      }), ArcCloseSchema, 4096, undefined, 2)).value
    } catch (error) {
      if (!(error instanceof NeedsPerson)) throw error
      closed = { summary: clamp(lines.map(line => line.replace(/^第\d+章《[^》]*》：/, '')).join(''), 1400) || arc.goal, defer: [], fixes: [], notes: ['弧末对账模型输出不合格，摘要由章节梗概拼接'] }
    }
    canon = this.files.readCanon()
    for (const item of closed.defer) {
      const f = canon.foreshadow.find(x => x.id === item.id)
      if (f && (f.status === 'open' || f.status === 'progressing') && item.dueBy > next) { f.status = 'deferred'; f.dueBy = item.dueBy }
    }
    for (const fix of closed.fixes) {
      const c = canon.characters.find(x => x.id === fix.id)
      if (!c) continue
      if (fix.location) c.location = fix.location
      // A death or resurrection is never inferred by reconciliation, only by a chapter's quoted delta.
      if (fix.status && fix.status !== 'dead' && c.status !== 'dead') c.status = fix.status
    }
    canon.plan.arcs = canon.plan.arcs.map(a => a.n === arc.n ? { ...a, status: 'done' as const, summary: Array.from(closed.summary).slice(0, 1500).join('') } : a)
    const volumeArcs = canon.plan.arcs.filter(a => a.volume === arc.volume)
    if (volumeArcs.every(a => a.status === 'done')) {
      canon.plan.volumes = canon.plan.volumes.map(v => v.n === arc.volume ? { ...v, summary: clamp(volumeArcs.map(a => a.summary ?? '').join(''), 1900) } : v)
    }
    this.files.writeCanon(canon)
    this.writeViews(canon)
    const rows = this.store.chapters(book.id).filter(row => row.arc === arc.n)
    const flagged = rows.filter(row => row.status === 'flagged').map(row => ({
      n: row.n, title: row.title, chars: row.chars, costUsd: row.costUsd, status: row.status, score: row.score,
      notes: this.store.steps(book.id, row.n).filter(s => s.step === 'commit').map(s => s.note).filter(Boolean),
    }))
    return { arc: arc.n, title: arc.title, chapters: rows.length, summary: closed.summary, flagged, notes: closed.notes }
  }

  /** Human-readable projections of the canon, rebuilt from it at every arc end. */
  writeViews(canon: Canon): void {
    const people = canon.characters.map(c => `| ${c.name} | ${c.role} | ${realmText(canon.power, c.realm)} | ${c.status} | ${c.location ?? ''} | ${c.firstCh}–${c.lastSeenCh} |`)
    this.files.writeView('人物', ['| 名字 | 定位 | 境界 | 状态 | 位置 | 出场 |', '|---|---|---|---|---|---|', ...people].join('\n'))
    const threads = canon.foreshadow.map(f => `| ${f.id} | ${f.kind} | ${f.content} | ${f.plantedCh} | ${f.dueBy ?? ''} | ${f.status} |`)
    this.files.writeView('伏笔', ['| id | 类型 | 内容 | 埋设 | 应收 | 状态 |', '|---|---|---|---|---|---|', ...threads].join('\n'))
    const items = canon.items.map(i => `| ${i.name} | ${i.kind} | ${i.qty} | ${canon.characters.find(c => c.id === i.owner)?.name ?? i.owner} | ${i.state} |`)
    this.files.writeView('物品', ['| 名称 | 类型 | 数量 | 持有人 | 状态 |', '|---|---|---|---|---|', ...items].join('\n'))
  }

  // --- Rewrite ------------------------------------------------------------------------------------------------------

  /** Roll back to just before chapter `from` and discard it and everything after; returns how many chapters went. */
  rewriteFrom(from: number): number {
    const book = this.book
    if (from < 1 || from > book.lastChapter) throw new Error(`没有第 ${from} 章可以重写`)
    if (!this.files.hasSnapshot(from)) throw new Error(`第 ${from} 章之前的快照已经清理，无法回滚到那里`)
    this.files.restore(from)
    const moved = this.files.discardFrom(from, this.now())
    this.store.deleteChaptersFrom(book.id, from)
    for (let ch = from; ch <= book.lastChapter + 1; ch++) this.files.clearWork(ch)
    this.files.pruneSnapshots(s => s <= from)
    const canon = this.files.readCanon()
    // Arcs that started after the rollback point go back to skeletons; the arc holding it keeps its outline.
    canon.plan.arcs = canon.plan.arcs.map(a => {
      if (a.startCh === undefined) return a
      if (a.startCh > from - 1 && a.startCh !== from && a.startCh > from) return { ...a, status: 'skeleton' as const, startCh: undefined, outline: undefined, summary: undefined }
      if (a.startCh + a.chapters > from) return { ...a, status: 'writing' as const, summary: undefined }
      return a
    }).map(a => {
      const copy = { ...a }
      if (copy.startCh === undefined) delete copy.startCh
      if (copy.outline === undefined) delete copy.outline
      if (copy.summary === undefined) delete copy.summary
      return copy
    })
    this.files.writeCanon(canon)
    this.files.writeBook({ ...book, lastChapter: from - 1, updatedAt: this.now().toISOString() })
    return moved
  }
}
