/**
 * Durable council rows on the runtime's SQLite database.
 *
 * Same database as the ledger, choices and projects: the table is created on construction, every method is a short
 * synchronous statement, and `data_json` holds the whole turn transcript so a progress poll always sees the latest
 * completed speech.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { CouncilData, CouncilMode, CouncilPhase, CouncilRecord, CouncilStatus } from './types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS councils (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  topic TEXT NOT NULL,
  project_id TEXT,
  ticket_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  brief TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS councils_created ON councils (created_at);
CREATE INDEX IF NOT EXISTS councils_ticket ON councils (ticket_id);
`

interface Row {
  id: string
  mode: string
  status: string
  phase: string
  topic: string
  project_id: string | null
  ticket_id: string | null
  data_json: string
  brief: string | null
  cost_usd: number
  error: string | null
  created_at: string
  updated_at: string
}

const EMPTY_DATA: CouncilData = {
  roundsPlanned: 1,
  seats: [],
  rounds: [],
  moderator: { provider: '', model: '' },
}

function parseData(raw: string): CouncilData {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return structuredClone(EMPTY_DATA)
    const record = value as Partial<CouncilData>
    return {
      roundsPlanned: typeof record.roundsPlanned === 'number' ? record.roundsPlanned : 1,
      seats: Array.isArray(record.seats) ? record.seats : [],
      rounds: Array.isArray(record.rounds) ? record.rounds : [],
      moderator: record.moderator ?? { provider: '', model: '' },
      ...(record.autoStart === true ? { autoStart: true } : {}),
    }
  } catch {
    return structuredClone(EMPTY_DATA)
  }
}

function toRecord(row: Row): CouncilRecord {
  return {
    id: row.id,
    mode: row.mode as CouncilMode,
    status: row.status as CouncilStatus,
    phase: row.phase as CouncilPhase,
    topic: row.topic,
    ...(row.project_id === null || row.project_id === '' ? {} : { projectId: row.project_id }),
    ...(row.ticket_id === null || row.ticket_id === '' ? {} : { ticketId: row.ticket_id }),
    data: parseData(row.data_json),
    ...(row.brief === null || row.brief === '' ? {} : { brief: row.brief }),
    costUsd: Number(row.cost_usd),
    ...(row.error === null || row.error === '' ? {} : { error: row.error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface CouncilPatch {
  status?: CouncilStatus
  phase?: CouncilPhase
  data?: CouncilData
  brief?: string | null
  costUsd?: number
  error?: string | null
  ticketId?: string | null
  updatedAt: string
}

/** CRUD for `councils`; the runner reads a row, applies its change and writes it back in one synchronous step. */
export class CouncilStore {
  private readonly db: DatabaseSync
  private readonly insertRow: StatementSync
  private readonly selectRow: StatementSync
  private readonly selectRecent: StatementSync
  private readonly selectByTicket: StatementSync
  private readonly updateRow: StatementSync
  private readonly deleteRow: StatementSync
  private readonly interruptRows: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(SCHEMA)
    this.insertRow = db.prepare(`
      INSERT INTO councils
        (id, mode, status, phase, topic, project_id, ticket_id, data_json, brief, cost_usd, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.selectRow = db.prepare('SELECT * FROM councils WHERE id = ?')
    this.selectRecent = db.prepare('SELECT * FROM councils ORDER BY created_at DESC, id DESC LIMIT ?')
    this.selectByTicket = db.prepare('SELECT * FROM councils WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    this.updateRow = db.prepare(`
      UPDATE councils SET
        status = ?, phase = ?, project_id = ?, ticket_id = ?, data_json = ?, brief = ?, cost_usd = ?, error = ?,
        updated_at = ?
      WHERE id = ?
    `)
    this.deleteRow = db.prepare('DELETE FROM councils WHERE id = ?')
    this.interruptRows = db.prepare(`
      UPDATE councils SET status = 'failed', error = ?, updated_at = ? WHERE status = 'running'
    `)
  }

  insert(record: CouncilRecord): void {
    this.insertRow.run(
      record.id,
      record.mode,
      record.status,
      record.phase,
      record.topic,
      record.projectId ?? null,
      record.ticketId ?? null,
      JSON.stringify(record.data),
      record.brief ?? null,
      record.costUsd,
      record.error ?? null,
      record.createdAt,
      record.updatedAt,
    )
  }

  get(id: string): CouncilRecord | undefined {
    const row = this.selectRow.get(id) as Row | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  list(limit: number, ticketId?: string): CouncilRecord[] {
    const rows = ticketId === undefined
      ? this.selectRecent.all(limit) as unknown as Row[]
      : this.selectByTicket.all(ticketId, limit) as unknown as Row[]
    return rows.map(toRecord)
  }

  /** Apply a patch to an existing row; a row deleted meanwhile is left alone. */
  update(id: string, patch: CouncilPatch): void {
    const current = this.get(id)
    if (current === undefined) return
    this.updateRow.run(
      patch.status ?? current.status,
      patch.phase ?? current.phase,
      current.projectId ?? null,
      patch.ticketId === undefined ? (current.ticketId ?? null) : patch.ticketId,
      JSON.stringify(patch.data ?? current.data),
      patch.brief === undefined ? (current.brief ?? null) : patch.brief,
      patch.costUsd ?? current.costUsd,
      patch.error === undefined ? (current.error ?? null) : patch.error,
      patch.updatedAt,
      id,
    )
  }

  /** The most recent council started from one ticket, if any. */
  forTicket(ticketId: string): CouncilRecord | undefined {
    return this.list(1, ticketId)[0]
  }

  delete(id: string): void {
    this.deleteRow.run(id)
  }

  /** A new process owns no in-flight calls: every row still marked running is interrupted. */
  interruptRunning(error: string, at: string): number {
    const result = this.interruptRows.run(error, at)
    return Number(result.changes)
  }
}
