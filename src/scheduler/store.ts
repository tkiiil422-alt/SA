/**
 * 主动调度引擎 SQLite 存储（`schedules`、`schedule_runs`、`schedule_watch_state`）。
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ScheduleActionKind,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleTriggerKind,
} from '../shared/api-types.ts'
import { nextCronTime, parseCron } from './cron.ts'

export type { ScheduleActionKind, ScheduleRecord, ScheduleRunRecord, ScheduleTriggerKind }

export interface ScheduleCreateInput {
  name: string
  description?: string
  enabled?: boolean
  triggerKind: ScheduleTriggerKind
  cronExpr?: string | null
  intervalSec?: number | null
  runAt?: string | null
  actionKind: ScheduleActionKind
  actionConfig: Record<string, unknown>
  respectPause?: boolean
}

export interface ScheduleUpdateInput {
  name?: string
  description?: string
  enabled?: boolean
  triggerKind?: ScheduleTriggerKind
  cronExpr?: string | null
  intervalSec?: number | null
  runAt?: string | null
  actionKind?: ScheduleActionKind
  actionConfig?: Record<string, unknown>
  respectPause?: boolean
}

export interface WatchSnapshot {
  scheduleId: string
  lastStatusCode: number | null
  lastHash: string | null
  lastEtag: string | null
  lastBodySnippet: string
  updatedAt: string
}

interface ScheduleRow {
  id: string
  name: string
  description: string
  enabled: number
  trigger_kind: string
  cron_expr: string | null
  interval_sec: number | null
  run_at: string | null
  action_kind: string
  action_config_json: string
  respect_pause: number
  next_run_at: string | null
  last_run_at: string | null
  last_status: string
  last_summary: string
  run_count: number
  fail_count: number
  created_at: string
  updated_at: string
}

interface RunRow {
  id: string
  schedule_id: string
  started_at: string
  finished_at: string | null
  status: string
  summary: string
  ticket_id: string | null
  error: string | null
  duration_ms: number | null
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function rowToSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    triggerKind: row.trigger_kind as ScheduleTriggerKind,
    cronExpr: row.cron_expr,
    intervalSec: row.interval_sec,
    runAt: row.run_at,
    actionKind: row.action_kind as ScheduleActionKind,
    actionConfig: parseJsonObject(row.action_config_json),
    respectPause: row.respect_pause === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as ScheduleRecord['lastStatus'],
    lastSummary: row.last_summary,
    runCount: row.run_count,
    failCount: row.fail_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRun(row: RunRow): ScheduleRunRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as ScheduleRunRecord['status'],
    summary: row.summary,
    ticketId: row.ticket_id,
    error: row.error,
    durationMs: row.duration_ms,
  }
}

/** 校验触发配置并计算下一次触发时间。 */
export function computeNextRunAt(
  spec: { triggerKind: ScheduleTriggerKind; cronExpr?: string | null; intervalSec?: number | null; runAt?: string | null; enabled: boolean },
  now: Date,
): string | null {
  if (!spec.enabled) return null
  if (spec.triggerKind === 'cron') {
    const expr = (spec.cronExpr ?? '').trim()
    parseCron(expr)
    return nextCronTime(expr, now).toISOString()
  }
  if (spec.triggerKind === 'interval') {
    const sec = Number(spec.intervalSec)
    if (!Number.isFinite(sec) || sec < 30 || sec > 30 * 86_400) {
      throw new Error('间隔秒数必须在 30 到 2592000（30天）之间')
    }
    return new Date(now.getTime() + Math.trunc(sec) * 1000).toISOString()
  }
  // once
  const raw = (spec.runAt ?? '').trim()
  const ts = Date.parse(raw)
  if (!raw || !Number.isFinite(ts)) {
    throw new Error('一次性定时任务必须提供合法的 ISO 时间 runAt')
  }
  return new Date(ts).toISOString()
}

export class SchedulerStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_kind TEXT NOT NULL,
        cron_expr TEXT,
        interval_sec INTEGER,
        run_at TEXT,
        action_kind TEXT NOT NULL,
        action_config_json TEXT NOT NULL DEFAULT '{}',
        respect_pause INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'never',
        last_summary TEXT NOT NULL DEFAULT '',
        run_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        ticket_id TEXT,
        error TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_sched ON schedule_runs(schedule_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS schedule_watch_state (
        schedule_id TEXT PRIMARY KEY,
        last_status_code INTEGER,
        last_hash TEXT,
        last_etag TEXT,
        last_body_snippet TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
    `)
  }

  /** 启动时清理进程意外中断遗留的 running 运行记录。 */
  recoverInterrupted(now = new Date()): number {
    const iso = now.toISOString()
    const res = this.db.prepare(`
      UPDATE schedule_runs
      SET status = 'error', finished_at = ?, error = '服务重启导致本次执行中断'
      WHERE status = 'running'
    `).run(iso)
    this.db.prepare(`
      UPDATE schedules SET last_status = 'error', last_summary = '服务重启中断' WHERE last_status = 'running'
    `).run()
    return Number(res.changes)
  }

  create(input: ScheduleCreateInput, now = new Date()): ScheduleRecord {
    const name = input.name.trim().slice(0, 120)
    if (!name) throw new Error('定时任务名称不能为空')
    const enabled = input.enabled !== false
    const cronExpr = input.triggerKind === 'cron' ? (input.cronExpr ?? '').trim() : null
    const intervalSec = input.triggerKind === 'interval' ? Math.trunc(Number(input.intervalSec)) : null
    const runAt = input.triggerKind === 'once' ? (input.runAt ?? '').trim() : null

    // 即使初始禁用也要校验表达式合法性
    computeNextRunAt({ triggerKind: input.triggerKind, cronExpr, intervalSec, runAt, enabled: true }, now)
    const nextRunAt = computeNextRunAt({ triggerKind: input.triggerKind, cronExpr, intervalSec, runAt, enabled }, now)

    const id = makeId('sch')
    const iso = now.toISOString()
    this.db.prepare(`
      INSERT INTO schedules (
        id, name, description, enabled, trigger_kind, cron_expr, interval_sec, run_at,
        action_kind, action_config_json, respect_pause, next_run_at, last_run_at,
        last_status, last_summary, run_count, fail_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'never', '', 0, 0, ?, ?)
    `).run(
      id,
      name,
      (input.description ?? '').trim().slice(0, 500),
      enabled ? 1 : 0,
      input.triggerKind,
      cronExpr,
      intervalSec,
      runAt,
      input.actionKind,
      JSON.stringify(input.actionConfig ?? {}),
      input.respectPause === false ? 0 : 1,
      nextRunAt,
      iso,
      iso,
    )
    return this.get(id)!
  }

  get(id: string): ScheduleRecord | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined
    return row ? rowToSchedule(row) : undefined
  }

  list(filter: { enabled?: boolean } = {}): ScheduleRecord[] {
    const where = filter.enabled === undefined ? '' : 'WHERE enabled = ?'
    const rows = (filter.enabled === undefined
      ? this.db.prepare(`SELECT * FROM schedules ORDER BY enabled DESC, created_at DESC`).all()
      : this.db.prepare(`SELECT * FROM schedules ${where} ORDER BY created_at DESC`).all(filter.enabled ? 1 : 0)) as unknown as ScheduleRow[]
    return rows.map(rowToSchedule)
  }

  update(id: string, patch: ScheduleUpdateInput, now = new Date()): ScheduleRecord | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 120) : cur.name
    if (!name) throw new Error('定时任务名称不能为空')
    const description = patch.description !== undefined ? patch.description.trim().slice(0, 500) : cur.description
    const enabled = patch.enabled !== undefined ? patch.enabled : cur.enabled
    const triggerKind = patch.triggerKind ?? cur.triggerKind
    const cronExpr = triggerKind === 'cron' ? (patch.cronExpr !== undefined ? (patch.cronExpr ?? '').trim() : (cur.cronExpr ?? '')) : null
    const intervalSec = triggerKind === 'interval' ? Math.trunc(Number(patch.intervalSec ?? cur.intervalSec)) : null
    const runAt = triggerKind === 'once' ? (patch.runAt !== undefined ? (patch.runAt ?? '').trim() : (cur.runAt ?? '')) : null
    const actionKind = patch.actionKind ?? cur.actionKind
    const actionConfig = patch.actionConfig ?? cur.actionConfig
    const respectPause = patch.respectPause !== undefined ? patch.respectPause : cur.respectPause

    computeNextRunAt({ triggerKind, cronExpr, intervalSec, runAt, enabled: true }, now)
    const nextRunAt = computeNextRunAt({ triggerKind, cronExpr, intervalSec, runAt, enabled }, now)

    this.db.prepare(`
      UPDATE schedules
      SET name = ?, description = ?, enabled = ?, trigger_kind = ?, cron_expr = ?,
          interval_sec = ?, run_at = ?, action_kind = ?, action_config_json = ?,
          respect_pause = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name, description, enabled ? 1 : 0, triggerKind, cronExpr, intervalSec, runAt,
      actionKind, JSON.stringify(actionConfig), respectPause ? 1 : 0, nextRunAt, now.toISOString(), id,
    )
    return this.get(id)
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id)
    if (Number(res.changes) > 0) {
      this.db.prepare('DELETE FROM schedule_runs WHERE schedule_id = ?').run(id)
      this.db.prepare('DELETE FROM schedule_watch_state WHERE schedule_id = ?').run(id)
      return true
    }
    return false
  }

  /** 查出所有已到期且处于启用状态的任务。 */
  listDue(now = new Date()): ScheduleRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(now.toISOString()) as unknown as ScheduleRow[]
    return rows.map(rowToSchedule)
  }

  startRun(schedule: ScheduleRecord, now = new Date()): ScheduleRunRecord {
    const id = makeId('run')
    const iso = now.toISOString()
    // 先推进 next_run_at，避免长任务执行期间重复触发；一次性任务执行即停用。
    const nextEnabled = schedule.triggerKind === 'once' ? false : schedule.enabled
    const nextRunAt = nextEnabled
      ? computeNextRunAt({
        triggerKind: schedule.triggerKind,
        cronExpr: schedule.cronExpr,
        intervalSec: schedule.intervalSec,
        runAt: schedule.runAt,
        enabled: true,
      }, now)
      : null

    this.db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, started_at, finished_at, status, summary, ticket_id, error, duration_ms)
      VALUES (?, ?, ?, NULL, 'running', '', NULL, NULL, NULL)
    `).run(id, schedule.id, iso)
    this.db.prepare(`
      UPDATE schedules
      SET enabled = ?, next_run_at = ?, last_run_at = ?, last_status = 'running', updated_at = ?
      WHERE id = ?
    `).run(nextEnabled ? 1 : 0, nextRunAt, iso, iso, schedule.id)
    return this.getRun(id)!
  }

  finishRun(
    runId: string,
    scheduleId: string,
    outcome: { status: 'ok' | 'skipped' | 'changed' | 'error'; summary: string; ticketId?: string; error?: string },
    startedMs: number,
    now = new Date(),
  ): ScheduleRunRecord | undefined {
    const iso = now.toISOString()
    const durationMs = Math.max(0, now.getTime() - startedMs)
    const summary = outcome.summary.slice(0, 600)
    const errText = outcome.error ? outcome.error.slice(0, 1000) : null
    this.db.prepare(`
      UPDATE schedule_runs
      SET finished_at = ?, status = ?, summary = ?, ticket_id = ?, error = ?, duration_ms = ?
      WHERE id = ?
    `).run(iso, outcome.status, summary, outcome.ticketId ?? null, errText, durationMs, runId)
    this.db.prepare(`
      UPDATE schedules
      SET last_status = ?, last_summary = ?,
          run_count = run_count + ?, fail_count = fail_count + ?, updated_at = ?
      WHERE id = ?
    `).run(
      outcome.status,
      summary,
      outcome.status === 'skipped' ? 0 : 1,
      outcome.status === 'error' ? 1 : 0,
      iso,
      scheduleId,
    )
    // 每个任务最多保留最近 100 条运行记录，防止数据库无限膨胀
    this.db.prepare(`
      DELETE FROM schedule_runs
      WHERE schedule_id = ? AND id NOT IN (
        SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 100
      )
    `).run(scheduleId, scheduleId)
    return this.getRun(runId)
  }

  getRun(runId: string): ScheduleRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(runId) as RunRow | undefined
    return row ? rowToRun(row) : undefined
  }

  listRuns(scheduleId: string, limit = 30): ScheduleRunRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?
    `).all(scheduleId, Math.max(1, Math.min(100, limit))) as unknown as RunRow[]
    return rows.map(rowToRun)
  }

  getWatchState(scheduleId: string): WatchSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM schedule_watch_state WHERE schedule_id = ?').get(scheduleId) as {
      schedule_id: string
      last_status_code: number | null
      last_hash: string | null
      last_etag: string | null
      last_body_snippet: string
      updated_at: string
    } | undefined
    if (!row) return undefined
    return {
      scheduleId: row.schedule_id,
      lastStatusCode: row.last_status_code,
      lastHash: row.last_hash,
      lastEtag: row.last_etag,
      lastBodySnippet: row.last_body_snippet,
      updatedAt: row.updated_at,
    }
  }

  saveWatchState(state: WatchSnapshot): void {
    this.db.prepare(`
      INSERT INTO schedule_watch_state (schedule_id, last_status_code, last_hash, last_etag, last_body_snippet, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(schedule_id) DO UPDATE SET
        last_status_code = excluded.last_status_code,
        last_hash = excluded.last_hash,
        last_etag = excluded.last_etag,
        last_body_snippet = excluded.last_body_snippet,
        updated_at = excluded.updated_at
    `).run(
      state.scheduleId,
      state.lastStatusCode,
      state.lastHash,
      state.lastEtag,
      state.lastBodySnippet.slice(0, 600),
      state.updatedAt,
    )
  }
}
