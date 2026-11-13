/**
 * The book library: opening books (from an idea through the setup model, or from a setup document), opening one ticket
 * per arc through the host's normal `ask` (so Eval, Decision and Mandate apply as for any request), budgets, reads and
 * export.
 *
 * Writing itself happens in `NovelExecutor`; this service never calls the Engine.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { callModel, type ModelTarget } from '../assessor/model-call.ts'
import type { Usage } from '../gateway/usage.ts'
import { BookFiles } from './files.ts'
import type { NovelStore, ChapterRow } from './store.ts'
import { BookSchema, SetupSchema, GENRE_LABELS } from './schemas.ts'
import type { Book, Genre, Setup, Contract, Delta, Review } from './schemas.ts'
import { SETUP_SYSTEM, parseSetup, setupUser } from './setup.ts'
import { bookBlock, currentArc, stripTitle } from './context.ts'
import type { ChapterSummary } from './context.ts'
import { normalizeDraft } from './pipeline.ts'
import type { Role } from './pipeline.ts'
import { CHAPTER_EDIT_SYSTEM, chapterEditUser } from './prompts.ts'
import { countChars } from './lint.ts'

/** One person-requested edit of a committed chapter; the old text is kept so it can be undone. */
export interface ChapterEdit {
  id: string
  n: number
  status: 'running' | 'done' | 'failed' | 'undone'
  note: string
  error?: string
  costUsd: number
  createdAt: string
  updatedAt: string
}

interface EditRow {
  id: string
  n: number
  status: string
  note: string
  error: string | null
  cost_usd: number
  created_at: string
  updated_at: string
}

const toEdit = (row: EditRow): ChapterEdit => ({
  id: row.id,
  n: row.n,
  status: row.status as ChapterEdit['status'],
  note: row.note,
  ...(row.error ? { error: row.error } : {}),
  costUsd: Number(row.cost_usd ?? 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const EDITS_TABLE = `
CREATE TABLE IF NOT EXISTS novel_edits (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS novel_edits_chapter ON novel_edits (book_id, n);
`

export interface ResolvedModel { provider: string; model: string; target: ModelTarget }

export class NovelError extends Error {
  constructor(readonly code: 'invalid' | 'not_found' | 'conflict' | 'disabled', message: string) { super(message) }
}

export interface NovelServiceOptions {
  db: DatabaseSync
  store: NovelStore
  root: string
  enabled: () => boolean
  resolve: (role: Role, bookId: string) => ResolvedModel | undefined
  /** Writes one ledger row (ticket id '' for setup calls) and returns its cost. */
  record: (entry: { ticketId: string; provider: string; model: string; status: number; usage?: Usage; latencyMs: number }) => number
  /** Opens a ticket for an arc through the host's `ask`, binding the trigger before the engine receives it. */
  startArc: (text: string, bind: { bookId: string; arc: number }) => Promise<{ ticketId?: string }>
  /** The ticket currently writing a book, if any. */
  writing?: (bookId: string) => string | undefined
  /** Today's novel spend, for the setup call's budget check. */
  dayUsd?: () => number
  dailyUsd?: () => number
  call?: typeof callModel
  fetch?: typeof fetch
  now?: () => Date
  idFactory?: () => string
  timeoutMs?: number
  /** Base delay before retrying a transient upstream error; multiplied by the retry count. Default 15s. */
  retryMs?: number
  sleep?: (ms: number) => Promise<void>
  onError?: (error: unknown) => void
}

export interface OpenBookInput {
  idea: string
  genre: Genre
  title?: string
  chapterChars?: [number, number]
  volumes?: number
  chaptersPerVolume?: number
}

export interface BookListItem {
  id: string
  title: string
  genre: Genre
  genreLabel: string
  phase: Book['phase'] | 'drafting' | 'failed'
  lastChapter: number
  chars: number
  costUsd: number
  flagged: number
  currentTicket?: string
  nextArc?: { n: number; title: string; chapters: number; status: string }
  error?: string
  createdAt: string
  updatedAt: string
}

const SETUP_TABLE = `
CREATE TABLE IF NOT EXISTS novel_setups (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The text of an arc request; `要求：` carries the person's note to the executor. */
export function arcRequestText(book: Book, arc: { n: number; title: string }, note?: string): string {
  return `写小说《${book.title}》第${arc.n}弧《${arc.title}》${note ? `。要求：${note}` : ''}`
}

export class NovelService {
  private readonly call: typeof callModel
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly drafting = new Set<string>()

  constructor(private readonly options: NovelServiceOptions) {
    this.call = options.call ?? callModel
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? (() => `b_${randomBytes(6).toString('hex')}`)
    options.db.exec(SETUP_TABLE)
    options.db.exec(EDITS_TABLE)
    // A setup or an edit that was running when the daemon stopped has lost its call.
    options.db.prepare("UPDATE novel_setups SET status = 'failed', error = '守护进程重启，开书中断', updated_at = ? WHERE status = 'drafting'")
      .run(this.now().toISOString())
    options.db.prepare("UPDATE novel_edits SET status = 'failed', error = '守护进程重启，修改中断，原稿没有动', updated_at = ? WHERE status = 'running'")
      .run(this.now().toISOString())
  }

  private files(bookId: string): BookFiles {
    try {
      return new BookFiles(this.options.root, bookId)
    } catch {
      throw new NovelError('not_found', '找不到这本书。')
    }
  }

  private requireEnabled(): void {
    if (!this.options.enabled()) throw new NovelError('disabled', '写小说功能没有开启，请先在「设置 → 小说」里打开。')
  }

  private requireBook(bookId: string): BookFiles {
    const files = this.files(bookId)
    if (!files.exists()) throw new NovelError('not_found', '找不到这本书。')
    return files
  }

  // --- Opening a book -----------------------------------------------------------------------------------------------

  /** Create a book directly from a setup document (CLI import, tests). */
  importBook(input: { title: string; genre: Genre; idea?: string; chapterChars?: [number, number]; volumes?: number; chaptersPerVolume?: number; setup: unknown }): Book {
    this.requireEnabled()
    const parsed = SetupSchema.safeParse(input.setup)
    if (!parsed.success) {
      throw new NovelError('invalid', `设定不合法：${parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}`)
    }
    return this.create(this.idFactory(), input, parsed.data)
  }

  private create(id: string, input: { title: string; genre: Genre; idea?: string; chapterChars?: [number, number]; volumes?: number; chaptersPerVolume?: number }, setup: Setup): Book {
    const at = this.now().toISOString()
    const book = BookSchema.parse({
      id,
      title: Array.from(input.title.trim()).slice(0, 60).join('') || '未命名',
      genre: input.genre,
      idea: Array.from(input.idea ?? '').slice(0, 4000).join(''),
      phase: 'ready',
      chapterChars: input.chapterChars ?? [2500, 3500],
      volumesPlanned: input.volumes ?? Math.max(1, setup.plan.volumes.length),
      chaptersPerVolume: input.chaptersPerVolume ?? 100,
      lastChapter: 0,
      createdAt: at,
      updatedAt: at,
    })
    BookFiles.create(this.options.root, book, setup)
    return book
  }

  /** Start drafting a setup from an idea in the background; returns the book id at once. */
  openBook(input: OpenBookInput): { id: string } {
    this.requireEnabled()
    const idea = input.idea.trim()
    if (!idea) throw new NovelError('invalid', '请写一句灵感。')
    if (Array.from(idea).length > 4000) throw new NovelError('invalid', '灵感不能超过 4000 字。')
    if (this.options.dailyUsd && this.options.dayUsd) {
      const cap = this.options.dailyUsd()
      if (cap > 0 && this.options.dayUsd() >= cap) throw new NovelError('invalid', '今天的小说预算已经用完。')
    }
    if (!this.options.resolve('planner', '')) throw new NovelError('invalid', '没有可用的小说规划模型，请在「设置 → 模型」或「设置 → 小说」里配置。')
    const id = this.idFactory()
    const at = this.now().toISOString()
    this.options.db.prepare('INSERT INTO novel_setups (id, status, input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'drafting', JSON.stringify({ ...input, idea }), at, at)
    this.drafting.add(id)
    void this.draft(id, { ...input, idea }).finally(() => this.drafting.delete(id))
    return { id }
  }

  private async draft(id: string, input: OpenBookInput): Promise<void> {
    const volumes = input.volumes ?? 3
    const perVolume = input.chaptersPerVolume ?? 100
    let reason: string | undefined
    let cost = 0
    // Transient upstream errors (rate limits, 5xx, dropped connections) back off and do not use up the format retries.
    let transient = 0
    const sleep = this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const resolved = this.options.resolve('planner', '')
        if (!resolved) throw new Error('没有可用的规划模型')
        const result = await this.call(resolved.target, {
          model: resolved.model,
          system: SETUP_SYSTEM,
          user: setupUser({ idea: input.idea, genre: input.genre, chapters: perVolume, volumes, ...(reason ? { retryReason: reason } : {}) }),
          maxTokens: 24000,
        }, { timeoutMs: this.options.timeoutMs ?? 900_000, sessionId: `novel-setup-${id}`, stream: true, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) })
        try {
          cost += this.options.record({ ticketId: '', provider: resolved.provider, model: resolved.model, status: result.status ?? 0, ...(result.usage ? { usage: result.usage } : {}), latencyMs: result.latencyMs })
        } catch (error) { this.options.onError?.(error) }
        if (!result.ok) {
          const status = result.status
          const retryable = status === undefined || status === 408 || status === 429 || status >= 500
          if (retryable && transient < 6) {
            transient++
            attempt--
            await sleep((this.options.retryMs ?? 15_000) * transient)
            continue
          }
          throw new Error(`模型调用失败：${result.error ?? status ?? ''}`)
        }
        const parsed = parseSetup(result.text)
        if (!parsed.ok) { reason = parsed.reason; continue }
        this.create(id, {
          title: input.title?.trim() || parsed.title || '未命名',
          genre: input.genre,
          idea: input.idea,
          ...(input.chapterChars ? { chapterChars: input.chapterChars } : {}),
          volumes,
          chaptersPerVolume: perVolume,
        }, parsed.setup)
        this.options.db.prepare("UPDATE novel_setups SET status = 'done', cost_usd = ?, error = NULL, updated_at = ? WHERE id = ?").run(cost, this.now().toISOString(), id)
        return
      }
      throw new Error(`设定连续 3 次不合格：${reason ?? ''}`)
    } catch (error) {
      this.options.db.prepare("UPDATE novel_setups SET status = 'failed', cost_usd = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(cost, describe(error).slice(0, 500), this.now().toISOString(), id)
      this.options.onError?.(error)
    }
  }

  /** Resolves once no setup is drafting; for tests and the CLI. */
  async idle(): Promise<void> {
    while (this.drafting.size) await new Promise(resolve => setTimeout(resolve, 20))
  }

  // --- Arcs ---------------------------------------------------------------------------------------------------------

  /** Open the ticket that writes the next arc of a book. */
  async startArc(bookId: string, note?: string): Promise<{ ticketId?: string; arc: number }> {
    this.requireEnabled()
    const files = this.requireBook(bookId)
    const writing = this.options.writing?.(bookId)
    if (writing) throw new NovelError('conflict', `这本书正在写（任务 ${writing}），写完这一弧再开下一弧。`)
    for (const binding of this.options.store.bindings(bookId)) {
      if (binding.ticketId === undefined) throw new NovelError('conflict', '上一弧的任务还在开票中，请稍后再试。')
    }
    const book = files.readBook()
    if (book.phase === 'done') throw new NovelError('conflict', '这本书已经完本了。')
    const canon = files.readCanon()
    const next = book.lastChapter + 1
    const open = currentArc(canon, next)
    const arc = open ?? [...canon.plan.arcs].sort((a, b) => a.n - b.n).find(item => item.status === 'skeleton')
    if (!arc) throw new NovelError('conflict', '计划里没有下一弧了。')
    const cleanNote = note?.trim() ? Array.from(note.trim()).slice(0, 500).join('') : undefined
    const result = await this.options.startArc(arcRequestText(book, arc, cleanNote), { bookId, arc: arc.n })
    if (book.phase !== 'writing') files.writeBook({ ...files.readBook(), phase: 'writing', updatedAt: this.now().toISOString() })
    return { ...(result.ticketId ? { ticketId: result.ticketId } : {}), arc: arc.n }
  }

  // --- Reads --------------------------------------------------------------------------------------------------------

  private bookCost(bookId: string): number {
    const row = this.options.db.prepare(`SELECT COALESCE(SUM(u.cost_usd), 0) AS usd FROM usage_calls u
      JOIN novel_tickets t ON u.ticket_id = t.ticket_id WHERE t.book_id = ?`).get(bookId) as { usd?: number } | undefined
    const setup = this.options.db.prepare('SELECT cost_usd FROM novel_setups WHERE id = ?').get(bookId) as { cost_usd?: number } | undefined
    return Number(row?.usd ?? 0) + Number(setup?.cost_usd ?? 0)
  }

  list(): BookListItem[] {
    const items: BookListItem[] = []
    const seen = new Set<string>()
    if (existsSync(this.options.root)) {
      for (const name of readdirSync(this.options.root)) {
        if (!/^b_[A-Za-z0-9]{1,32}$/.test(name)) continue
        try {
          items.push(this.summary(name))
          seen.add(name)
        } catch (error) { this.options.onError?.(error) }
      }
    }
    const setups = this.options.db.prepare("SELECT id, status, input_json, error, created_at, updated_at FROM novel_setups WHERE status != 'done' ORDER BY created_at DESC")
      .all() as { id: string; status: string; input_json: string; error: string | null; created_at: string; updated_at: string }[]
    for (const row of setups) {
      if (seen.has(row.id)) continue
      let input: Partial<OpenBookInput> = {}
      try { input = JSON.parse(row.input_json) as Partial<OpenBookInput> } catch { /* ignore */ }
      const genre: Genre = input.genre === 'xuanhuan' ? 'xuanhuan' : 'xianxia'
      items.push({
        id: row.id,
        title: input.title || Array.from(input.idea ?? '').slice(0, 20).join('') || '新书',
        genre,
        genreLabel: GENRE_LABELS[genre],
        phase: row.status === 'failed' ? 'failed' : 'drafting',
        lastChapter: 0, chars: 0, costUsd: this.bookCost(row.id), flagged: 0,
        ...(row.error ? { error: row.error } : {}),
        createdAt: row.created_at, updatedAt: row.updated_at,
      })
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  summary(bookId: string): BookListItem {
    const files = this.requireBook(bookId)
    const book = files.readBook()
    const rows = this.options.store.chapters(bookId)
    const canon = files.readCanon()
    const next = currentArc(canon, book.lastChapter + 1) ?? [...canon.plan.arcs].sort((a, b) => a.n - b.n).find(arc => arc.status === 'skeleton')
    const writing = this.options.writing?.(bookId)
    const current = writing ?? this.options.store.bindings(bookId)[0]?.ticketId
    return {
      id: book.id,
      title: book.title,
      genre: book.genre,
      genreLabel: GENRE_LABELS[book.genre],
      phase: book.phase,
      lastChapter: book.lastChapter,
      chars: rows.reduce((sum, row) => sum + row.chars, 0),
      costUsd: this.bookCost(bookId),
      flagged: rows.filter(row => row.status === 'flagged').length,
      ...(current ? { currentTicket: current } : {}),
      ...(next ? { nextArc: { n: next.n, title: next.title, chapters: next.chapters, status: next.status } } : {}),
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
    }
  }

  detail(bookId: string): { book: BookListItem; idea: string; chapterChars: [number, number]; plan: ReturnType<BookFiles['readCanon']>['plan']; chapters: ChapterRow[]; bible: ReturnType<BookFiles['readCanon']>['bible']; tickets: { ticketId?: string; arc: number; createdAt: string }[] } {
    const files = this.requireBook(bookId)
    const book = files.readBook()
    const canon = files.readCanon()
    return {
      book: this.summary(bookId),
      idea: book.idea,
      chapterChars: book.chapterChars,
      plan: canon.plan,
      bible: canon.bible,
      chapters: this.options.store.chapters(bookId),
      tickets: this.options.store.bindings(bookId).map(b => ({ ...(b.ticketId ? { ticketId: b.ticketId } : {}), arc: b.arc, createdAt: b.createdAt })),
    }
  }

  canon(bookId: string): ReturnType<BookFiles['readCanon']> {
    return this.requireBook(bookId).readCanon()
  }

  chapter(bookId: string, n: number): { n: number; text: string; summary?: ChapterSummary; row?: ChapterRow; notes: string[]; edit?: ChapterEdit; lastChapter: number } {
    const files = this.requireBook(bookId)
    const text = files.readChapter(n)
    if (text === undefined) throw new NovelError('not_found', `第 ${n} 章还没有写。`)
    const summary = files.readSummary<ChapterSummary>(n)
    const row = this.options.store.chapters(bookId).find(item => item.n === n)
    const notes = this.options.store.steps(bookId, n).filter(step => step.step === 'commit' && step.note).map(step => step.note)
    const edit = this.lastEdit(bookId, n)
    return { n, text, ...(summary ? { summary } : {}), ...(row ? { row } : {}), notes, ...(edit ? { edit } : {}), lastChapter: files.readBook().lastChapter }
  }

  // --- A person's edits to committed chapters -------------------------------------------------------------------------

  /** The latest edit of a chapter, if any; the reader shows its status and offers undo. */
  lastEdit(bookId: string, n: number): ChapterEdit | undefined {
    const row = this.options.db.prepare('SELECT * FROM novel_edits WHERE book_id = ? AND n = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(bookId, n) as EditRow | undefined
    return row ? toEdit(row) : undefined
  }

  /**
   * Rewrite one committed chapter's prose from a person's note, in the background. Facts stay as recorded (the prompt
   * forbids changing them), so the canon and later chapters are untouched; the old text is kept for undo.
   */
  editChapter(bookId: string, n: number, note: string): ChapterEdit {
    this.requireEnabled()
    const files = this.requireBook(bookId)
    const text = files.readChapter(n)
    if (text === undefined) throw new NovelError('not_found', `第 ${n} 章还没有写。`)
    const clean = Array.from(note.trim()).slice(0, 1000).join('')
    if (!clean) throw new NovelError('invalid', '请写一句要怎么改。')
    if (this.lastEdit(bookId, n)?.status === 'running') throw new NovelError('conflict', '这一章正在修改，等它改完再提新的意见。')
    if (!this.options.resolve('writer', bookId)) throw new NovelError('invalid', '没有可用的写手模型。')
    const id = `e_${randomBytes(6).toString('hex')}`
    const at = this.now().toISOString()
    this.options.db.prepare(`INSERT INTO novel_edits (id, book_id, n, status, note, old_text, created_at, updated_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`).run(id, bookId, n, clean, text, at, at)
    this.drafting.add(id)
    void this.runEdit(id, bookId, n, clean, text).finally(() => this.drafting.delete(id))
    return this.lastEdit(bookId, n)!
  }

  private async runEdit(id: string, bookId: string, n: number, note: string, text: string): Promise<void> {
    const files = this.files(bookId)
    const book = files.readBook()
    const summary = files.readSummary<ChapterSummary>(n)
    const ticketId = this.options.store.bindings(bookId).find(b => b.ticketId)?.ticketId ?? ''
    let cost = 0
    const fail = (why: string) => {
      this.options.db.prepare("UPDATE novel_edits SET status = 'failed', error = ?, cost_usd = ?, updated_at = ? WHERE id = ?")
        .run(why.slice(0, 500), cost, this.now().toISOString(), id)
    }
    try {
      const resolved = this.options.resolve('writer', bookId)
      if (!resolved) { fail('没有可用的写手模型'); return }
      let result: Awaited<ReturnType<typeof callModel>> | undefined
      for (let attempt = 0; attempt < 4; attempt++) {
        result = await this.call(resolved.target, {
          model: resolved.model,
          system: CHAPTER_EDIT_SYSTEM,
          user: chapterEditUser({ text, note, ...(summary?.summary ? { summary: summary.summary } : {}), targetChars: book.chapterChars }),
          maxTokens: 8192 + 8000,
          context: bookBlock(book, files.readCanon()),
        }, { timeoutMs: this.options.timeoutMs ?? 900_000, sessionId: `novel-${bookId}-writer`, stream: true, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) })
        try {
          cost += this.options.record({ ticketId, provider: resolved.provider, model: resolved.model, status: result.status ?? 0, ...(result.usage ? { usage: result.usage } : {}), latencyMs: result.latencyMs })
        } catch (error) { this.options.onError?.(error) }
        const status = result.status
        if (result.ok || !(status === undefined || status === 408 || status === 429 || status >= 500)) break
        await (this.options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms))))((this.options.retryMs ?? 15_000) * (attempt + 1))
      }
      if (!result?.ok || !result.text.trim()) { fail(`模型调用失败：${result?.error ?? result?.status ?? ''}`); return }
      if (result.truncated) { fail('改稿被截断，原稿没有动。'); return }
      const after = countChars(result.text)
      if (after < countChars(text) * 0.75 || after < book.chapterChars[0] * 0.75) { fail(`改稿只有 ${after} 字，比原稿短太多，原稿没有动。`); return }
      const fresh = normalizeDraft(result.text, summary?.title ?? `第${n}章`).text
      this.applyText(bookId, n, fresh)
      this.options.db.prepare("UPDATE novel_edits SET status = 'done', new_text = ?, cost_usd = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(fresh, cost, this.now().toISOString(), id)
    } catch (error) {
      fail(describe(error))
      this.options.onError?.(error)
    }
  }

  /** Put a chapter's text in place: file, search index and chapter row (length, hash, title). */
  private applyText(bookId: string, n: number, text: string): void {
    const files = this.files(bookId)
    files.writeChapter(n, text)
    const row = this.options.store.chapters(bookId).find(item => item.n === n)
    this.options.db.exec('BEGIN')
    try {
      this.options.store.indexChapter(bookId, n, stripTitle(text))
      if (row) {
        this.options.store.recordChapter({
          ...row,
          title: normalizeDraft(text, row.title).title,
          chars: countChars(text),
          sha256: createHash('sha256').update(text).digest('hex'),
        })
      }
      this.options.db.exec('COMMIT')
    } catch (error) {
      this.options.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Put back the text a chapter had before its latest finished edit. */
  undoEdit(bookId: string, n: number): ChapterEdit {
    this.requireBook(bookId)
    const last = this.lastEdit(bookId, n)
    if (!last || last.status !== 'done') throw new NovelError('conflict', '这一章没有可以撤销的修改。')
    const row = this.options.db.prepare('SELECT old_text FROM novel_edits WHERE id = ?').get(last.id) as { old_text: string }
    this.applyText(bookId, n, row.old_text)
    this.options.db.prepare("UPDATE novel_edits SET status = 'undone', updated_at = ? WHERE id = ?").run(this.now().toISOString(), last.id)
    return this.lastEdit(bookId, n)!
  }

  /** A person read a flagged chapter and accepts it. */
  markRead(bookId: string, n: number): void {
    this.requireBook(bookId)
    const row = this.options.store.chapters(bookId).find(item => item.n === n)
    if (!row) throw new NovelError('not_found', `第 ${n} 章还没有写。`)
    if (row.status === 'flagged') this.options.store.recordChapter({ ...row, status: 'committed' })
  }

  /** The in-progress chapter's work files, for the book page (contract, latest review). */
  work(bookId: string): { n: number; contract?: Contract; review?: Review; delta?: Delta } {
    const files = this.requireBook(bookId)
    const n = files.readBook().lastChapter + 1
    const parse = <T>(name: string): T | undefined => {
      const raw = files.readWork(n, name)
      if (!raw) return undefined
      try { return JSON.parse(raw) as T } catch { return undefined }
    }
    let review: Review | undefined
    for (let i = 5; i >= 0 && !review; i--) review = parse<Review>(`review-${i}.json`)
    const contract = parse<Contract>('contract.json')
    const delta = parse<Delta>('delta.json')
    return { n, ...(contract ? { contract } : {}), ...(review ? { review } : {}), ...(delta ? { delta } : {}) }
  }

  exportText(bookId: string, from = 1, to?: number): { title: string; text: string } {
    const files = this.requireBook(bookId)
    const book = files.readBook()
    const last = Math.min(to ?? book.lastChapter, book.lastChapter)
    if (last < from) throw new NovelError('invalid', '这个范围里还没有章节。')
    return { title: book.title, text: `《${book.title}》\n\n${files.exportText(from, last)}` }
  }

  /** Delete a book: its folder, rows and bindings. Refused while it is being written. */
  deleteBook(bookId: string): void {
    const files = this.files(bookId)
    if (this.options.writing?.(bookId)) throw new NovelError('conflict', '这本书正在写，先停止它的任务再删除。')
    this.options.store.deleteBook(bookId)
    this.options.db.prepare('DELETE FROM novel_setups WHERE id = ?').run(bookId)
    this.options.db.prepare('DELETE FROM novel_edits WHERE book_id = ?').run(bookId)
    rmSync(files.dir, { recursive: true, force: true })
  }

  // --- Budget -------------------------------------------------------------------------------------------------------

  /** Novel spend today (local day), across every book's tickets. */
  static dayUsd(db: DatabaseSync, now: Date): number {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const row = db.prepare(`SELECT COALESCE(SUM(u.cost_usd), 0) AS usd FROM usage_calls u
      JOIN novel_tickets t ON u.ticket_id = t.ticket_id WHERE u.at >= ? AND u.at < ?`).get(start.toISOString(), end.toISOString()) as { usd?: number } | undefined
    return Number(row?.usd ?? 0)
  }

  static bookUsd(db: DatabaseSync, bookId: string): number {
    const row = db.prepare(`SELECT COALESCE(SUM(u.cost_usd), 0) AS usd FROM usage_calls u
      JOIN novel_tickets t ON u.ticket_id = t.ticket_id WHERE t.book_id = ?`).get(bookId) as { usd?: number } | undefined
    return Number(row?.usd ?? 0)
  }

  /** Whether one more novel call may go out for a ticket. */
  static budget(input: {
    db: DatabaseSync
    ticketId: string
    bookId: string | undefined
    now: Date
    novel: { dailyUsd: number; arcUsd: number; bookUsd: number }
    global: { enabled: boolean; dailyUsd: number }
    ticketUsd: (ticketId: string) => number
    globalDayUsd: () => number
  }): { ok: true } | { ok: false; why: string } {
    const { novel, global } = input
    if (global.enabled && global.dailyUsd > 0) {
      const today = input.globalDayUsd()
      if (today >= global.dailyUsd) return { ok: false, why: `今天已花 $${today.toFixed(4)}，达到每日总上限 $${global.dailyUsd}` }
    }
    if (novel.dailyUsd > 0) {
      const today = NovelService.dayUsd(input.db, input.now)
      if (today >= novel.dailyUsd) return { ok: false, why: `小说今天已花 $${today.toFixed(4)}，达到小说每日上限 $${novel.dailyUsd}` }
    }
    if (novel.arcUsd > 0) {
      const spent = input.ticketUsd(input.ticketId)
      if (spent >= novel.arcUsd) return { ok: false, why: `这一弧已花 $${spent.toFixed(4)}，达到单弧上限 $${novel.arcUsd}` }
    }
    if (novel.bookUsd > 0 && input.bookId) {
      const spent = NovelService.bookUsd(input.db, input.bookId)
      if (spent >= novel.bookUsd) return { ok: false, why: `这本书已花 $${spent.toFixed(4)}，达到整书上限 $${novel.bookUsd}` }
    }
    return { ok: true }
  }

  /** Where the books live, for backups. */
  get root(): string { return this.options.root }

  /** Book folder names, for backups. */
  bookIds(): string[] {
    if (!existsSync(this.options.root)) return []
    return readdirSync(this.options.root).filter(name => /^b_[A-Za-z0-9]{1,32}$/.test(name) && existsSync(join(this.options.root, name, 'book.json')))
  }
}
