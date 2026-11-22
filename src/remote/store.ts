/**
 * 远程执行节点与远程作业 SQLite 存储（`remote_nodes`、`remote_jobs`、`remote_usage_dedup`）。
 *
 * 覆盖：
 * - 节点注册、能力标签与 SSH 连接引用
 * - 稳定 `executionId` 幂等作业队列、租约领取、心跳续租、超时释放与取消
 * - 产物校验元信息与基于 `callId` 的账本去重结算表
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { RemoteJobRecord, RemoteNodeRecord } from '../shared/api-types.ts'

export type { RemoteJobRecord, RemoteNodeRecord }

interface NodeRow {
  id: string
  name: string
  ssh_connection: string | null
  capabilities_json: string
  status: string
  max_jobs: number
  last_heartbeat_at: string | null
  created_at: string
  updated_at: string
}

interface JobRow {
  id: string
  execution_id: string
  ticket_id: string | null
  node_id: string | null
  required_capabilities_json: string
  payload_json: string
  status: string
  lease_until: string | null
  artifacts_json: string
  summary: string
  error: string | null
  attempts: number
  created_at: string
  updated_at: string
}

function parseStrings(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseObj(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseArtifacts(raw: string): { path: string; sha256: string; bytes: number }[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function rowToNode(r: NodeRow): RemoteNodeRecord {
  return {
    id: r.id,
    name: r.name,
    sshConnection: r.ssh_connection,
    capabilities: parseStrings(r.capabilities_json),
    status: (r.status === 'online' || r.status === 'draining' ? r.status : 'offline'),
    maxJobs: r.max_jobs,
    lastHeartbeatAt: r.last_heartbeat_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToJob(r: JobRow): RemoteJobRecord {
  return {
    id: r.id,
    executionId: r.execution_id,
    ticketId: r.ticket_id,
    nodeId: r.node_id,
    requiredCapabilities: parseStrings(r.required_capabilities_json),
    payload: parseObj(r.payload_json),
    status: r.status as RemoteJobRecord['status'],
    leaseUntil: r.lease_until,
    artifacts: parseArtifacts(r.artifacts_json),
    summary: r.summary,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export class RemoteStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ssh_connection TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'online',
        max_jobs INTEGER NOT NULL DEFAULT 2,
        last_heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS remote_jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        ticket_id TEXT,
        node_id TEXT,
        required_capabilities_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        lease_until TEXT,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_remote_jobs_status ON remote_jobs(status, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_remote_jobs_node ON remote_jobs(node_id, status);

      CREATE TABLE IF NOT EXISTS remote_usage_dedup (
        call_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL
      );
    `)
  }

  upsertNode(input: {
    id?: string
    name: string
    sshConnection?: string | null
    capabilities?: string[]
    maxJobs?: number
  }, now = new Date()): RemoteNodeRecord {
    const id = input.id?.trim() || `rn_${randomBytes(4).toString('hex')}`
    const iso = now.toISOString()
    const caps = [...new Set((input.capabilities ?? []).map(s => s.trim().toLowerCase()).filter(Boolean))]
    const maxJobs = Math.max(1, Math.min(32, Math.trunc(input.maxJobs ?? 2)))
    this.db.prepare(`
      INSERT INTO remote_nodes (id, name, ssh_connection, capabilities_json, status, max_jobs, last_heartbeat_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        ssh_connection = excluded.ssh_connection,
        capabilities_json = excluded.capabilities_json,
        status = 'online',
        max_jobs = excluded.max_jobs,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at
    `).run(id, input.name.trim().slice(0, 100), input.sshConnection ?? null, JSON.stringify(caps), maxJobs, iso, iso, iso)
    return this.getNode(id)!
  }

  getNode(id: string): RemoteNodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM remote_nodes WHERE id = ?').get(id) as NodeRow | undefined
    return row ? rowToNode(row) : undefined
  }

  listNodes(): RemoteNodeRecord[] {
    const rows = this.db.prepare('SELECT * FROM remote_nodes ORDER BY updated_at DESC').all() as unknown as NodeRow[]
    return rows.map(rowToNode)
  }

  setNodeStatus(id: string, status: RemoteNodeRecord['status'], now = new Date()): void {
    this.db.prepare('UPDATE remote_nodes SET status = ?, updated_at = ? WHERE id = ?').run(status, now.toISOString(), id)
  }

  touchNodeHeartbeat(id: string, now = new Date()): RemoteNodeRecord | undefined {
    const iso = now.toISOString()
    this.db.prepare(`
      UPDATE remote_nodes SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?
    `).run(iso, iso, id)
    return this.getNode(id)
  }

  /** 按稳定 `executionId` 幂等入队远程作业：同 `executionId` 已存在直接返回原作业。 */
  enqueueJob(input: {
    executionId: string
    ticketId?: string | null
    requiredCapabilities?: string[]
    payload: Record<string, unknown>
  }, now = new Date()): { job: RemoteJobRecord; created: boolean } {
    const existing = this.getJobByExecutionId(input.executionId)
    if (existing) return { job: existing, created: false }
    const id = `rjob_${randomBytes(5).toString('hex')}`
    const iso = now.toISOString()
    const reqCaps = [...new Set((input.requiredCapabilities ?? []).map(s => s.trim().toLowerCase()).filter(Boolean))]
    this.db.prepare(`
      INSERT INTO remote_jobs (
        id, execution_id, ticket_id, node_id, required_capabilities_json, payload_json,
        status, lease_until, artifacts_json, summary, error, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, 'queued', NULL, '[]', '', NULL, 0, ?, ?)
    `).run(id, input.executionId, input.ticketId ?? null, JSON.stringify(reqCaps), JSON.stringify(input.payload), iso, iso)
    return { job: this.getJob(id)!, created: true }
  }

  getJob(id: string): RemoteJobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM remote_jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? rowToJob(row) : undefined
  }

  getJobByExecutionId(executionId: string): RemoteJobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM remote_jobs WHERE execution_id = ?').get(executionId) as JobRow | undefined
    return row ? rowToJob(row) : undefined
  }

  listJobs(filter: { status?: RemoteJobRecord['status']; nodeId?: string; limit?: number } = {}): RemoteJobRecord[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.status) { where.push('status = ?'); params.push(filter.status) }
    if (filter.nodeId) { where.push('node_id = ?'); params.push(filter.nodeId) }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(100, filter.limit ?? 50))
    const rows = this.db.prepare(`SELECT * FROM remote_jobs ${clause} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as unknown as JobRow[]
    return rows.map(rowToJob)
  }

  activeJobCount(nodeId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM remote_jobs WHERE node_id = ? AND status IN ('claimed', 'running')`,
    ).get(nodeId) as { c: number }
    return Number(row.c)
  }

  claimNextJob(node: RemoteNodeRecord, leaseSec: number, now = new Date()): RemoteJobRecord | undefined {
    if (node.status !== 'online') return undefined
    if (this.activeJobCount(node.id) >= node.maxJobs) return undefined
    const queued = this.db.prepare(
      `SELECT * FROM remote_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 30`,
    ).all() as unknown as JobRow[]

    const nodeCaps = new Set(node.capabilities.map(c => c.toLowerCase()))
    for (const row of queued) {
      const reqCaps = parseStrings(row.required_capabilities_json).map(c => c.toLowerCase())
      if (!reqCaps.every(c => nodeCaps.has(c))) continue
      const iso = now.toISOString()
      const leaseUntil = new Date(now.getTime() + leaseSec * 1000).toISOString()
      const res = this.db.prepare(`
        UPDATE remote_jobs
        SET node_id = ?, status = 'claimed', lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(node.id, leaseUntil, iso, row.id)
      if (Number(res.changes) > 0) return this.getJob(row.id)
    }
    return undefined
  }

  renewJobLease(jobId: string, nodeId: string, leaseSec: number, now = new Date()): RemoteJobRecord | undefined {
    const job = this.getJob(jobId)
    if (!job) return undefined
    if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') return job
    const iso = now.toISOString()
    const leaseUntil = new Date(now.getTime() + leaseSec * 1000).toISOString()
    this.db.prepare(`
      UPDATE remote_jobs
      SET node_id = ?, status = 'running', lease_until = ?, updated_at = ?
      WHERE id = ? AND status IN ('claimed', 'running', 'queued')
    `).run(nodeId, leaseUntil, iso, jobId)
    return this.getJob(jobId)
  }

  appendArtifact(jobId: string, artifact: { path: string; sha256: string; bytes: number }, now = new Date()): RemoteJobRecord | undefined {
    const job = this.getJob(jobId)
    if (!job) return undefined
    const next = [...job.artifacts.filter(a => a.path !== artifact.path), artifact]
    this.db.prepare('UPDATE remote_jobs SET artifacts_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), now.toISOString(), jobId)
    return this.getJob(jobId)
  }

  finishJob(jobId: string, outcome: { status: 'completed' | 'failed'; summary: string; error?: string }, now = new Date()): RemoteJobRecord | undefined {
    const job = this.getJob(jobId)
    if (!job) return undefined
    if (job.status === 'cancelled' || job.status === 'completed') return job
    this.db.prepare(`
      UPDATE remote_jobs
      SET status = ?, lease_until = NULL, summary = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(outcome.status, outcome.summary.slice(0, 2000), outcome.error ? outcome.error.slice(0, 1000) : null, now.toISOString(), jobId)
    return this.getJob(jobId)
  }

  cancelJob(jobId: string, reason = '已被人工或主控取消', now = new Date()): RemoteJobRecord | undefined {
    const job = this.getJob(jobId)
    if (!job) return undefined
    if (job.status === 'completed' || job.status === 'failed') return job
    this.db.prepare(`
      UPDATE remote_jobs
      SET status = 'cancelled', lease_until = NULL, error = ?, updated_at = ?
      WHERE id = ?
    `).run(reason.slice(0, 500), now.toISOString(), jobId)
    return this.getJob(jobId)
  }

  /** 扫描失联节点与超时租约：标记离线并将未完成作业重新释放回队列。 */
  sweepExpired(heartbeatTimeoutSec: number, now = new Date()): { offlineNodes: string[]; requeuedJobs: string[] } {
    const cutoff = new Date(now.getTime() - heartbeatTimeoutSec * 1000).toISOString()
    const iso = now.toISOString()
    const staleNodes = this.db.prepare(`
      SELECT id FROM remote_nodes WHERE status = 'online' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)
    `).all(cutoff) as unknown as { id: string }[]
    const offlineNodes = staleNodes.map(r => r.id)
    for (const id of offlineNodes) {
      this.db.prepare(`UPDATE remote_nodes SET status = 'offline', updated_at = ? WHERE id = ?`).run(iso, id)
    }

    const expiredJobs = this.db.prepare(`
      SELECT id FROM remote_jobs WHERE status IN ('claimed', 'running') AND lease_until IS NOT NULL AND lease_until < ?
    `).all(iso) as unknown as { id: string }[]
    const requeuedJobs = expiredJobs.map(r => r.id)
    for (const jid of requeuedJobs) {
      this.db.prepare(`
        UPDATE remote_jobs SET status = 'queued', node_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ?
      `).run(iso, jid)
    }

    return { offlineNodes, requeuedJobs }
  }

  /** 按 `callId` 去重写入用量记录：首次返回 `true`，重传返回 `false`。 */
  recordUsageDedup(callId: string, jobId: string, costUsd: number, now = new Date()): boolean {
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO remote_usage_dedup (call_id, job_id, cost_usd, recorded_at)
      VALUES (?, ?, ?, ?)
    `).run(callId, jobId, costUsd, now.toISOString())
    return Number(res.changes) > 0
  }
}
