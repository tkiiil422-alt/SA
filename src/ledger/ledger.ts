/**
 * The usage ledger on the runtime's SQLite database.
 *
 * Every upstream call is one `usage_calls` row, including failed calls, whose cost is often zero. Rows store ISO (UTC)
 * timestamps; "days" are local calendar days, bounded by local midnight, so the daily budget matches what a person
 * sees on their own clock.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'

export interface UsageCallInput {
  at: string
  ticketId: string
  model: string
  status: number
  promptHit: number
  promptMiss: number
  completion: number
  costUsd: number
  latencyMs: number
  /** Provider id; '' when not given (calls recorded before providers existed). */
  provider?: string
}

export interface UsageCall extends UsageCallInput { id: number }

export interface UsageTotals {
  usd: number
  calls: number
  hit: number
  miss: number
  out: number
  hitRate: number
}

export type UsageRange = 'today' | '7d' | '30d'

export interface UsageSummary {
  totals: UsageTotals
  byDay: { day: string; usd: number; calls: number; hitRate: number }[]
  byModel: { provider: string; model: string; usd: number; calls: number; hitRate: number }[]
  topTickets: { ticketId: string; usd: number; calls: number }[]
}

export interface UsageCallsQuery {
  ticketId?: string
  /** Exact model label as stored on the row, matching the usage summary's `byModel[].model`. */
  model?: string
  limit?: number
  before?: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  prompt_hit INTEGER NOT NULL,
  prompt_miss INTEGER NOT NULL,
  completion INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS usage_calls_ticket ON usage_calls (ticket_id);
CREATE INDEX IF NOT EXISTS usage_calls_at ON usage_calls (at);
`

/** Adds the provider column to a table created before it existed. */
function addProviderColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(usage_calls)').all()
  if (!columns.some(column => column.name === 'provider')) {
    db.exec("ALTER TABLE usage_calls ADD COLUMN provider TEXT NOT NULL DEFAULT ''")
  }
}

const AGGREGATE = `
SELECT COALESCE(SUM(cost_usd), 0) AS usd,
       COUNT(*) AS calls,
       COALESCE(SUM(prompt_hit), 0) AS hit,
       COALESCE(SUM(prompt_miss), 0) AS miss,
       COALESCE(SUM(completion), 0) AS out
FROM usage_calls
`

const num = (value: unknown): number => Number(value ?? 0)
const rate = (hit: number, miss: number): number => hit + miss === 0 ? 0 : hit / (hit + miss)

/** Local midnight of the date's calendar day. */
function dayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

/** The local calendar day `days` away from `value`; the Date constructor rolls months and years over. */
function addDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days)
}

/** The local calendar day as `YYYY-MM-DD`. */
function dayKey(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${day}`
}

export class Ledger {
  private readonly now: () => Date
  private readonly insert: StatementSync
  private readonly ticketAggregate: StatementSync
  private readonly rangeAggregate: StatementSync
  private readonly modelAggregate: StatementSync
  private readonly ticketAggregateTop: StatementSync

  constructor(private readonly db: DatabaseSync, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date())
    db.exec(SCHEMA)
    addProviderColumn(db)
    this.insert = db.prepare(`
      INSERT INTO usage_calls
        (at, ticket_id, model, status, prompt_hit, prompt_miss, completion, cost_usd, latency_ms, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.ticketAggregate = db.prepare(`${AGGREGATE}WHERE ticket_id = ?`)
    this.rangeAggregate = db.prepare(`${AGGREGATE}WHERE at >= ? AND at < ?`)
    this.modelAggregate = db.prepare(`
      SELECT provider, model,
             COALESCE(SUM(cost_usd), 0) AS usd,
             COUNT(*) AS calls,
             COALESCE(SUM(prompt_hit), 0) AS hit,
             COALESCE(SUM(prompt_miss), 0) AS miss
      FROM usage_calls
      WHERE at >= ? AND at < ?
      GROUP BY provider, model
      ORDER BY usd DESC, model ASC, provider ASC
    `)
    this.ticketAggregateTop = db.prepare(`
      SELECT ticket_id,
             COALESCE(SUM(cost_usd), 0) AS usd,
             COUNT(*) AS calls
      FROM usage_calls
      WHERE at >= ? AND at < ?
      GROUP BY ticket_id
      ORDER BY usd DESC, ticket_id ASC
      LIMIT 10
    `)
  }

  record(input: UsageCallInput): void {
    this.insert.run(
      input.at,
      input.ticketId,
      input.model,
      input.status,
      input.promptHit,
      input.promptMiss,
      input.completion,
      input.costUsd,
      input.latencyMs,
      input.provider ?? '',
    )
  }

  ticketTotals(ticketId: string): UsageTotals {
    return this.totals(this.ticketAggregate.get(ticketId))
  }

  /** Cost of every ticket on the local calendar day, from its 00:00 to the next local 00:00. */
  dayUsd(day: Date = this.now()): number {
    return this.totals(this.rangeAggregate.get(...this.dayBounds(day))).usd
  }

  dayTotals(day: Date = this.now()): UsageTotals {
    return this.totals(this.rangeAggregate.get(...this.dayBounds(day)))
  }

  summary(range: UsageRange): UsageSummary {
    const days = range === 'today' ? 1 : range === '7d' ? 7 : 30
    const last = dayStart(this.now())
    const start = addDays(last, -(days - 1))
    const end = addDays(last, 1)
    const totals = this.totals(this.rangeAggregate.get(start.toISOString(), end.toISOString()))

    const byDay: UsageSummary['byDay'] = []
    for (let index = 0; index < days; index += 1) {
      const day = addDays(start, index)
      const next = addDays(day, 1)
      const aggregate = this.totals(this.rangeAggregate.get(day.toISOString(), next.toISOString()))
      byDay.push({ day: dayKey(day), usd: aggregate.usd, calls: aggregate.calls, hitRate: aggregate.hitRate })
    }

    const byModel = this.modelAggregate.all(start.toISOString(), end.toISOString()).map(row => ({
      provider: String(row.provider ?? ''),
      model: String(row.model),
      usd: num(row.usd),
      calls: num(row.calls),
      hitRate: rate(num(row.hit), num(row.miss)),
    }))
    const topTickets = this.ticketAggregateTop.all(start.toISOString(), end.toISOString()).map(row => ({
      ticketId: String(row.ticket_id),
      usd: num(row.usd),
      calls: num(row.calls),
    }))
    return { totals, byDay, byModel, topTickets }
  }

  /** Calls newest first; `before` is an exclusive id cursor. */
  calls(query: UsageCallsQuery = {}): UsageCall[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (query.ticketId !== undefined) {
      clauses.push('ticket_id = ?')
      params.push(query.ticketId)
    }
    if (query.model !== undefined) {
      clauses.push('model = ?')
      params.push(query.model)
    }
    if (query.before !== undefined) {
      clauses.push('id < ?')
      params.push(query.before)
    }
    params.push(Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500))
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    return this.db.prepare(`SELECT * FROM usage_calls${where} ORDER BY id DESC LIMIT ?`)
      .all(...params).map(row => this.call(row))
  }

  private dayBounds(day: Date): [string, string] {
    const start = dayStart(day)
    return [start.toISOString(), addDays(start, 1).toISOString()]
  }

  private totals(row: Record<string, unknown> | undefined): UsageTotals {
    const hit = num(row?.hit)
    const miss = num(row?.miss)
    return { usd: num(row?.usd), calls: num(row?.calls), hit, miss, out: num(row?.out), hitRate: rate(hit, miss) }
  }

  private call(row: Record<string, unknown>): UsageCall {
    return {
      id: num(row.id),
      at: String(row.at),
      ticketId: String(row.ticket_id),
      model: String(row.model),
      provider: String(row.provider ?? ''),
      status: num(row.status),
      promptHit: num(row.prompt_hit),
      promptMiss: num(row.prompt_miss),
      completion: num(row.completion),
      costUsd: num(row.cost_usd),
      latencyMs: num(row.latency_ms),
    }
  }
}
