/**
 * Novel-engine rows on the runtime's SQLite database: ticket bindings, committed chapters, per-chapter step records and
 * the trigram full-text index over chapter paragraphs.
 *
 * Same database as the councils and the ledger. The store never opens a transaction of its own: the caller wraps a
 * chapter commit (indexChapter, recordChapter, markStep) in BEGIN … COMMIT.
 */
import type { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS novel_tickets (
  ticket_id TEXT,
  trigger_id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  arc INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS novel_tickets_ticket ON novel_tickets (ticket_id);
CREATE INDEX IF NOT EXISTS novel_tickets_book ON novel_tickets (book_id);
CREATE TABLE IF NOT EXISTS novel_chapters (
  book_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  arc INTEGER NOT NULL,
  title TEXT NOT NULL,
  chars INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  score INTEGER,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (book_id, n)
);
CREATE TABLE IF NOT EXISTS novel_steps (
  book_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  step TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  PRIMARY KEY (book_id, n, step)
);
CREATE VIRTUAL TABLE IF NOT EXISTS novel_fts USING fts5(book_id UNINDEXED, n UNINDEXED, para, tokenize='trigram');
`

export interface NovelBinding {
  triggerId: string
  ticketId?: string
  bookId: string
  arc: number
  createdAt: string
}

export interface ChapterRow {
  bookId: string
  n: number
  arc: number
  title: string
  chars: number
  sha256: string
  status: 'committed' | 'flagged'
  costUsd: number
  score: number | null
  committedAt: string
}

export interface StepRecord {
  step: string
  attempt: number
  status: 'done' | 'failed'
  note: string
  at: string
}

interface BindingRow {
  ticket_id: string | null
  trigger_id: string
  book_id: string
  arc: number
  created_at: string
}

interface ChapterDbRow {
  book_id: string
  n: number
  arc: number
  title: string
  chars: number
  sha256: string
  status: 'committed' | 'flagged'
  cost_usd: number
  score: number | null
  committed_at: string
}

interface StepDbRow {
  step: string
  attempt: number
  status: 'done' | 'failed'
  note: string
  at: string
}

interface FtsRow {
  n: number
  para: string
}

function toBinding(row: BindingRow): NovelBinding {
  return {
    triggerId: row.trigger_id,
    ...(row.ticket_id === null ? {} : { ticketId: row.ticket_id }),
    bookId: row.book_id,
    arc: Number(row.arc),
    createdAt: row.created_at,
  }
}

function toChapter(row: ChapterDbRow): ChapterRow {
  return {
    bookId: row.book_id,
    n: Number(row.n),
    arc: Number(row.arc),
    title: row.title,
    chars: Number(row.chars),
    sha256: row.sha256,
    status: row.status,
    costUsd: Number(row.cost_usd),
    score: row.score === null ? null : Number(row.score),
    committedAt: row.committed_at,
  }
}

/** Escape LIKE wildcards so a short term matches itself literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, c => `\\${c}`)
}

/** CRUD for the novel tables and the paragraph index; each method is one short synchronous statement or a small set. */
export class NovelStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(SCHEMA)
  }

  /** Record a trigger that has not opened a ticket yet (ticket_id NULL). Throws if the trigger is already bound. */
  bindPending(triggerId: string, bookId: string, arc: number, at: string): void {
    this.db.prepare(`
      INSERT INTO novel_tickets (ticket_id, trigger_id, book_id, arc, created_at)
      VALUES (NULL, ?, ?, ?, ?)
    `).run(triggerId, bookId, arc, at)
  }

  /** Attach the ticket opened for a pending trigger. Throws when no such trigger is recorded. */
  bindTicket(triggerId: string, ticketId: string): void {
    const result = this.db.prepare('UPDATE novel_tickets SET ticket_id = ? WHERE trigger_id = ?').run(ticketId, triggerId)
    if (Number(result.changes) === 0) throw new Error(`未找到待开票的触发: ${triggerId}`)
  }

  byTrigger(triggerId: string): NovelBinding | undefined {
    const row = this.db.prepare('SELECT * FROM novel_tickets WHERE trigger_id = ?').get(triggerId) as unknown as BindingRow | undefined
    return row === undefined ? undefined : toBinding(row)
  }

  byTicket(ticketId: string): NovelBinding | undefined {
    const row = this.db.prepare('SELECT * FROM novel_tickets WHERE ticket_id = ?').get(ticketId) as unknown as BindingRow | undefined
    return row === undefined ? undefined : toBinding(row)
  }

  /** Bindings of one book, newest first. */
  bindings(bookId: string): NovelBinding[] {
    const rows = this.db.prepare('SELECT * FROM novel_tickets WHERE book_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(bookId) as unknown as BindingRow[]
    return rows.map(toBinding)
  }

  unbindTicket(ticketId: string): void {
    this.db.prepare('DELETE FROM novel_tickets WHERE ticket_id = ?').run(ticketId)
  }

  /** Drop a pending trigger; a trigger that already has a ticket is kept. */
  clearPending(triggerId: string): void {
    this.db.prepare('DELETE FROM novel_tickets WHERE trigger_id = ? AND ticket_id IS NULL').run(triggerId)
  }

  recordChapter(row: ChapterRow): void {
    this.db.prepare(`
      INSERT INTO novel_chapters (book_id, n, arc, title, chars, sha256, status, cost_usd, score, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (book_id, n) DO UPDATE SET
        arc = excluded.arc,
        title = excluded.title,
        chars = excluded.chars,
        sha256 = excluded.sha256,
        status = excluded.status,
        cost_usd = excluded.cost_usd,
        score = excluded.score,
        committed_at = excluded.committed_at
    `).run(row.bookId, row.n, row.arc, row.title, row.chars, row.sha256, row.status, row.costUsd, row.score, row.committedAt)
  }

  chapters(bookId: string): ChapterRow[] {
    const rows = this.db.prepare('SELECT * FROM novel_chapters WHERE book_id = ? ORDER BY n ASC')
      .all(bookId) as unknown as ChapterDbRow[]
    return rows.map(toChapter)
  }

  /** Remove chapter n and everything after it: chapter rows, step records and indexed paragraphs. */
  deleteChaptersFrom(bookId: string, n: number): void {
    this.db.prepare('DELETE FROM novel_chapters WHERE book_id = ? AND n >= ?').run(bookId, n)
    this.db.prepare('DELETE FROM novel_steps WHERE book_id = ? AND n >= ?').run(bookId, n)
    this.db.prepare('DELETE FROM novel_fts WHERE book_id = ? AND n >= ?').run(bookId, n)
  }

  markStep(bookId: string, n: number, step: string, attempt: number, status: 'done' | 'failed', note: string, at: string): void {
    this.db.prepare(`
      INSERT INTO novel_steps (book_id, n, step, attempt, status, note, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (book_id, n, step) DO UPDATE SET
        attempt = excluded.attempt,
        status = excluded.status,
        note = excluded.note,
        at = excluded.at
    `).run(bookId, n, step, attempt, status, note, at)
  }

  steps(bookId: string, n: number): StepRecord[] {
    const rows = this.db.prepare('SELECT step, attempt, status, note, at FROM novel_steps WHERE book_id = ? AND n = ? ORDER BY rowid ASC')
      .all(bookId, n) as unknown as StepDbRow[]
    return rows.map(row => ({ step: row.step, attempt: Number(row.attempt), status: row.status, note: row.note, at: row.at }))
  }

  clearSteps(bookId: string, n: number): void {
    this.db.prepare('DELETE FROM novel_steps WHERE book_id = ? AND n = ?').run(bookId, n)
  }

  /** Replace the indexed paragraphs of chapter n: split on line breaks, drop empty pieces, one row per paragraph. */
  indexChapter(bookId: string, n: number, text: string): void {
    this.db.prepare('DELETE FROM novel_fts WHERE book_id = ? AND n = ?').run(bookId, n)
    const insert = this.db.prepare('INSERT INTO novel_fts (book_id, n, para) VALUES (?, ?, ?)')
    for (const line of text.split(/\r?\n/)) {
      const para = line.trim()
      if (para !== '') insert.run(bookId, n, para)
    }
  }

  /**
   * Paragraphs from chapters before `beforeCh` that contain any of `terms`. Terms of three or more characters use the
   * trigram MATCH; shorter terms (1–2 characters) use LIKE. Ranked by how many distinct terms hit, then newest chapter.
   */
  search(bookId: string, terms: string[], beforeCh: number, limit: number): { n: number; para: string }[] {
    if (limit <= 0) return []
    const hits = new Map<string, { n: number; para: string; terms: Set<string> }>()
    for (const raw of terms) {
      const term = raw.trim()
      if (term === '') continue
      const rows = Array.from(term).length >= 3
        ? this.matchRows(bookId, term, beforeCh)
        : this.likeRows(bookId, term, beforeCh)
      for (const row of rows) {
        const key = `${row.n}\u0000${row.para}`
        const entry = hits.get(key) ?? { n: Number(row.n), para: row.para, terms: new Set<string>() }
        entry.terms.add(term)
        hits.set(key, entry)
      }
    }
    return [...hits.values()]
      .sort((a, b) => b.terms.size - a.terms.size || b.n - a.n)
      .slice(0, limit)
      .map(({ n, para }) => ({ n, para }))
  }

  private matchRows(bookId: string, term: string, beforeCh: number): FtsRow[] {
    const phrase = `"${term.replace(/"/g, '""')}"`
    return this.db.prepare('SELECT n, para FROM novel_fts WHERE novel_fts MATCH ? AND book_id = ? AND n < ?')
      .all(phrase, bookId, beforeCh) as unknown as FtsRow[]
  }

  private likeRows(bookId: string, term: string, beforeCh: number): FtsRow[] {
    return this.db.prepare("SELECT n, para FROM novel_fts WHERE book_id = ? AND n < ? AND para LIKE ? ESCAPE '\\'")
      .all(bookId, beforeCh, `%${escapeLike(term)}%`) as unknown as FtsRow[]
  }

  /** Remove every row of one book from all novel tables. */
  deleteBook(bookId: string): void {
    this.db.prepare('DELETE FROM novel_tickets WHERE book_id = ?').run(bookId)
    this.db.prepare('DELETE FROM novel_chapters WHERE book_id = ?').run(bookId)
    this.db.prepare('DELETE FROM novel_steps WHERE book_id = ?').run(bookId)
    this.db.prepare('DELETE FROM novel_fts WHERE book_id = ?').run(bookId)
  }
}
