/**
 * The human-facing event log on the runtime's SQLite database.
 *
 * Rows come from domain events and background actions, and the log keeps only a recent window: it trims itself while
 * writing, every {@link TRIM_EVERY} inserts or once its estimate passes the keep limit plus slack, so writes stay cheap
 * and no per-insert `COUNT` is needed.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { DomainEvent } from '../core/ports.ts'

export type EventLevel = 'info' | 'warn' | 'error'

export interface EventInput {
  kind: string
  text: string
  ticketId?: string
  level?: EventLevel
  data?: unknown
}

export interface StoredEvent {
  id: number
  at: string
  kind: string
  ticketId?: string
  level: EventLevel
  text: string
  data?: unknown
}

export interface EventQuery {
  ticketId?: string
  level?: EventLevel
  limit?: number
  before?: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ticket_id TEXT,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_ticket ON events (ticket_id);
CREATE INDEX IF NOT EXISTS events_id ON events (id);
`

const KEEP = 20_000
const TRIM_EVERY = 200
const TRIM_SLACK = 200
/** Human-facing one-liners stay short enough for the console's event list. */
const MAX_TEXT = 40

const limitOf = (value: number | undefined): number => Math.min(Math.max(Math.trunc(value ?? 100), 1), 500)

/** Truncate a line to {@link MAX_TEXT} characters, marking the cut with an ellipsis. */
const line = (text: string): string => text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`

function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const note = (kind: string, text: string, ticketId: string | undefined, level: EventLevel, data: unknown):
Omit<EventInput, 'data'> & { data?: unknown } => ({
  kind,
  text: line(text),
  ...(ticketId === undefined ? {} : { ticketId }),
  level,
  data,
})

export class EventLog {
  private readonly now: () => Date
  private readonly keep: number
  private readonly insert: StatementSync
  private readonly trimOnce: StatementSync
  private readonly countAll: StatementSync
  private estimated: number
  private sinceTrim = 0

  constructor(private readonly db: DatabaseSync, options: { now?: () => Date; keep?: number } = {}) {
    this.now = options.now ?? (() => new Date())
    this.keep = Math.max(1, Math.trunc(options.keep ?? KEEP))
    db.exec(SCHEMA)
    this.insert = db.prepare('INSERT INTO events (at, kind, ticket_id, level, text, data) VALUES (?, ?, ?, ?, ?, ?)')
    // The keep-th newest id: deleting up to it leaves exactly `keep` newer rows, and deletes nothing while there are fewer.
    this.trimOnce = db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)')
    this.countAll = db.prepare('SELECT COUNT(*) AS n FROM events')
    this.estimated = this.total()
  }

  add(input: EventInput): void {
    this.insert.run(
      this.now().toISOString(),
      input.kind,
      input.ticketId ?? null,
      input.level ?? 'info',
      input.text,
      input.data === undefined ? null : JSON.stringify(input.data),
    )
    this.estimated += 1
    this.sinceTrim += 1
    if (this.sinceTrim >= TRIM_EVERY || this.estimated > this.keep + TRIM_SLACK) {
      this.trimOnce.run(this.keep)
      this.estimated = this.total()
      this.sinceTrim = 0
    }
  }

  /** Events newest first; `before` is an exclusive id cursor. */
  list(query: EventQuery = {}): StoredEvent[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (query.ticketId !== undefined) {
      clauses.push('ticket_id = ?')
      params.push(query.ticketId)
    }
    if (query.level !== undefined) {
      clauses.push('level = ?')
      params.push(query.level)
    }
    if (query.before !== undefined) {
      clauses.push('id < ?')
      params.push(query.before)
    }
    params.push(limitOf(query.limit))
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    return this.db.prepare(`SELECT * FROM events${where} ORDER BY id DESC LIMIT ?`)
      .all(...params).map(row => this.stored(row))
  }

  recent(count = 15): StoredEvent[] {
    return this.list({ limit: count })
  }

  count(level?: EventLevel, sinceIso?: string): number {
    const clauses: string[] = []
    const params: string[] = []
    if (level !== undefined) {
      clauses.push('level = ?')
      params.push(level)
    }
    if (sinceIso !== undefined) {
      clauses.push('at >= ?')
      params.push(sinceIso)
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM events${where}`).get(...params)
    return Number(row?.n ?? 0)
  }

  private total(): number {
    return Number(this.countAll.get()?.n ?? 0)
  }

  private stored(row: Record<string, unknown>): StoredEvent {
    const ticketId = row.ticket_id === null || row.ticket_id === undefined ? undefined : String(row.ticket_id)
    const data = row.data === null || row.data === undefined ? undefined : parseData(String(row.data))
    return {
      id: Number(row.id),
      at: String(row.at),
      kind: String(row.kind),
      ...(ticketId === undefined ? {} : { ticketId }),
      level: String(row.level) as EventLevel,
      text: String(row.text),
      ...(data === undefined ? {} : { data }),
    }
  }
}

/**
 * Translate a domain event into one human-readable Chinese line for the event log; `undefined` means it is not worth
 * recording (trigger bookkeeping, for one, is too noisy for a person's event list).
 */
export function describeDomainEvent(event: DomainEvent):
Omit<EventInput, 'data'> & { data?: unknown } | undefined {
  switch (event.type) {
    case 'ticket.created':
      return note('ticket.created', '新任务已受理', event.data.ticketId, 'info', event.data)
    case 'ticket.resumed':
      return note('ticket.resumed', '任务继续执行', event.data.ticketId, 'info', event.data)
    case 'ticket.ended': {
      const { outcome, reason, ticketId } = event.data
      const outcomeText = outcome === 'completed' ? '任务完成'
        : outcome === 'merged' ? '任务完成，改动已合并'
        : outcome === 'closed' ? '任务结束，改动未合并'
        : outcome === 'dropped' ? '任务被放弃，无事可做'
        : '任务被停止'
      return note('ticket.ended', reason ? `${outcomeText}：${reason}` : outcomeText, ticketId, 'info', event.data)
    }
    case 'assignment.started':
      return note('assignment.started', '开始执行', event.data.ticketId, 'info', event.data)
    case 'assignment.ended': {
      const { reason, ticketId } = event.data
      const level: EventLevel = /fail|error/i.test(reason) ? 'warn' : 'info'
      return note('assignment.ended', `执行结束：${reason}`, ticketId, level, event.data)
    }
    case 'decision.recorded': {
      const { kind } = event.data
      const text = kind === 'unavailable' ? '判断失败'
        : kind === 'accept' ? '决定受理'
        : kind === 'ignore' ? '决定忽略'
        : kind === 'stop' ? '决定停止'
        : '决定重新打开'
      return note('decision.recorded', text, undefined, kind === 'unavailable' ? 'warn' : 'info', event.data)
    }
    case 'policy.changed':
      // The versions are hashes, meaningless to a person; they stay in `data` for audit.
      return note('policy.changed', '受理规则或配置已更新', undefined, 'info', event.data)
    case 'thread.unsubscribed':
      return note('thread.unsubscribed', event.data.by === 'executor' ? '执行端已取消关注该会话' : '已取消关注该会话',
        event.data.ticketId, 'info', event.data)
    default:
      return undefined
  }
}
