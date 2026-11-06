/**
 * Durable project rows on the runtime's SQLite database.
 *
 * Same database as the ledger and choices: the schema is created on construction (`CREATE TABLE IF NOT EXISTS`) and
 * every method is a fast, synchronous statement. Upload staging metadata is not stored here; it lives beside the
 * `.part` files so an interrupted upload can be resumed after a restart.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'

export type ProjectStatus = 'uploading' | 'extracting' | 'ready' | 'failed'

export interface ProjectRecord {
  id: string
  name: string
  sourceName: string
  archiveBytes: number
  files: number
  bytes: number
  status: ProjectStatus
  error?: string
  warnings: string[]
  createdAt: string
  updatedAt: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_name TEXT NOT NULL,
  archive_bytes INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_projects (
  trigger_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_projects (
  ticket_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_projects_project ON ticket_projects(project_id);
`

interface Row {
  id: string
  name: string
  source_name: string
  archive_bytes: number
  files: number
  bytes: number
  status: string
  error: string | null
  warnings_json: string
  created_at: string
  updated_at: string
}

function toRecord(row: Row): ProjectRecord {
  let warnings: string[] = []
  try {
    const parsed = JSON.parse(row.warnings_json) as unknown
    if (Array.isArray(parsed)) warnings = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    warnings = []
  }
  return {
    id: row.id,
    name: row.name,
    sourceName: row.source_name,
    archiveBytes: Number(row.archive_bytes),
    files: Number(row.files),
    bytes: Number(row.bytes),
    status: row.status as ProjectStatus,
    ...(row.error === null || row.error === '' ? {} : { error: row.error }),
    warnings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** CRUD for `projects` plus the trigger and ticket associations the runtime needs before a ticket exists. */
export class ProjectStore {
  private readonly db: DatabaseSync
  private readonly insertRow: StatementSync
  private readonly selectRow: StatementSync
  private readonly selectAll: StatementSync
  private readonly updateRow: StatementSync
  private readonly deleteRow: StatementSync
  private readonly upsertPending: StatementSync
  private readonly selectPending: StatementSync
  private readonly deletePending: StatementSync
  private readonly upsertTicket: StatementSync
  private readonly selectTicket: StatementSync
  private readonly deleteRefs: StatementSync
  private readonly deletePendingRefs: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(SCHEMA)
    this.insertRow = db.prepare(`
      INSERT INTO projects (id, name, source_name, archive_bytes, files, bytes, status, error, warnings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.selectRow = db.prepare('SELECT * FROM projects WHERE id = ?')
    this.selectAll = db.prepare('SELECT * FROM projects ORDER BY created_at DESC')
    this.updateRow = db.prepare(`
      UPDATE projects SET
        name = ?, files = ?, bytes = ?, status = ?, error = ?, warnings_json = ?, updated_at = ?
      WHERE id = ?
    `)
    this.deleteRow = db.prepare('DELETE FROM projects WHERE id = ?')
    this.upsertPending = db.prepare(`
      INSERT INTO pending_projects (trigger_id, project_id) VALUES (?, ?)
      ON CONFLICT(trigger_id) DO UPDATE SET project_id = excluded.project_id
    `)
    this.selectPending = db.prepare('SELECT project_id FROM pending_projects WHERE trigger_id = ?')
    this.deletePending = db.prepare('DELETE FROM pending_projects WHERE trigger_id = ?')
    this.upsertTicket = db.prepare(`
      INSERT INTO ticket_projects (ticket_id, project_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET project_id = excluded.project_id
    `)
    this.selectTicket = db.prepare('SELECT project_id FROM ticket_projects WHERE ticket_id = ?')
    this.deleteRefs = db.prepare('DELETE FROM ticket_projects WHERE project_id = ?')
    this.deletePendingRefs = db.prepare('DELETE FROM pending_projects WHERE project_id = ?')
  }

  insert(record: ProjectRecord): void {
    this.insertRow.run(
      record.id,
      record.name,
      record.sourceName,
      record.archiveBytes,
      record.files,
      record.bytes,
      record.status,
      record.error ?? null,
      JSON.stringify(record.warnings),
      record.createdAt,
      record.updatedAt,
    )
  }

  update(id: string, patch: {
    name?: string
    files?: number
    bytes?: number
    status?: ProjectStatus
    error?: string | null
    warnings?: string[]
    updatedAt: string
  }): void {
    const current = this.get(id)
    if (current === undefined) return
    this.updateRow.run(
      patch.name ?? current.name,
      patch.files ?? current.files,
      patch.bytes ?? current.bytes,
      patch.status ?? current.status,
      patch.error === undefined ? (current.error ?? null) : patch.error,
      JSON.stringify(patch.warnings ?? current.warnings),
      patch.updatedAt,
      id,
    )
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.selectRow.get(id) as Row | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  list(): ProjectRecord[] {
    return (this.selectAll.all() as unknown as Row[]).map(toRecord)
  }

  delete(id: string): void {
    this.deleteRow.run(id)
    this.deleteRefs.run(id)
    this.deletePendingRefs.run(id)
  }

  /** Remember which project a trigger asked for, before the ticket exists. */
  setPending(triggerId: string, projectId: string): void {
    this.upsertPending.run(triggerId, projectId)
  }

  /** The first associated project among a ticket's triggers, if any. */
  pendingFor(triggerIds: readonly string[]): string | undefined {
    for (const triggerId of triggerIds) {
      const row = this.selectPending.get(triggerId) as { project_id?: string } | undefined
      if (row?.project_id !== undefined) return row.project_id
    }
    return undefined
  }

  clearPending(triggerIds: readonly string[]): void {
    for (const triggerId of triggerIds) this.deletePending.run(triggerId)
  }

  bindTicket(ticketId: string, projectId: string, at: string): void {
    this.upsertTicket.run(ticketId, projectId, at)
  }

  projectForTicket(ticketId: string): string | undefined {
    const row = this.selectTicket.get(ticketId) as { project_id?: string } | undefined
    return row?.project_id
  }
}
