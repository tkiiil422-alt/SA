/**
 * DAG 任务计划与多步骤编排存储（SQLite `missions` + `mission_nodes` + `mission_approvals`）。
 *
 * 支持：
 * - 任意有向无环图（DAG）节点依赖定义与严格环检测（DFS 三色染色）
 * - 计划版本号（`planVersion`）、稳定执行 ID（`executionId`）供中断恢复防重复派单
 * - 节点产出交接（实际文件路径 `artifacts` 与 Git 提交 `commitSha`）
 * - 绑定真实操作人、节点与计划版本的幂等人工审批审计表（同一批准提交两次不重复触发）
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  MissionNodeKind,
  MissionNodeRecord,
  MissionNodeStatus,
  MissionRecord,
  MissionStatus,
} from '../shared/api-types.ts'

export type { MissionNodeKind, MissionNodeRecord, MissionNodeStatus, MissionRecord, MissionStatus }

export interface MissionNodeInput {
  key: string
  title: string
  kind?: MissionNodeKind
  prompt: string
  dependsOn?: string[]
  config?: Record<string, unknown>
}

export interface MissionCreateInput {
  sessionId?: string | null
  title: string
  goal: string
  autoStart?: boolean
  nodes: MissionNodeInput[]
}

interface MissionRow {
  id: string
  session_id: string | null
  title: string
  goal: string
  status: string
  plan_version: number
  auto_start: number
  summary: string
  created_at: string
  updated_at: string
}

interface NodeRow {
  id: string
  mission_id: string
  node_key: string
  title: string
  kind: string
  prompt: string
  depends_on_json: string
  config_json: string
  status: string
  execution_id: string | null
  ticket_id: string | null
  council_id: string | null
  artifacts_json: string
  commit_sha: string | null
  approved_by: string | null
  approved_plan_version: number | null
  approval_idempotency_key: string | null
  output_summary: string
  error: string | null
  retries: number
  started_at: string | null
  finished_at: string | null
  order_index: number
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseJsonObj(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function rowToNode(row: NodeRow): MissionNodeRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    key: row.node_key,
    title: row.title,
    kind: row.kind as MissionNodeKind,
    prompt: row.prompt,
    dependsOn: parseJsonArray(row.depends_on_json),
    config: parseJsonObj(row.config_json),
    status: row.status as MissionNodeStatus,
    executionId: row.execution_id ?? null,
    ticketId: row.ticket_id,
    councilId: row.council_id,
    artifacts: parseJsonArray(row.artifacts_json),
    commitSha: row.commit_sha ?? null,
    approvedBy: row.approved_by ?? null,
    approvedPlanVersion: row.approved_plan_version ?? null,
    approvalIdempotencyKey: row.approval_idempotency_key ?? null,
    outputSummary: row.output_summary,
    error: row.error,
    retries: row.retries,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    orderIndex: row.order_index,
  }
}

/** 校验节点数组合法性：key 唯一、依赖存在、无循环依赖（DAG 拓扑校验）。 */
export function validateMissionDag(nodes: readonly MissionNodeInput[]): void {
  if (nodes.length === 0) throw new Error('任务计划至少需要 1 个执行节点')
  if (nodes.length > 30) throw new Error('单个任务计划最多包含 30 个节点')

  const map = new Map<string, MissionNodeInput>()
  for (const n of nodes) {
    const k = n.key.trim()
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(k)) {
      throw new Error(`节点标识 key「${n.key}」不合法（仅允许字母、数字、下划线和短横线，最长 40 字符）`)
    }
    if (map.has(k)) throw new Error(`节点 key「${k}」重复`)
    if (!n.title.trim()) throw new Error(`节点「${k}」缺少标题`)
    if (!n.prompt.trim()) throw new Error(`节点「${k}」缺少执行指令 prompt`)
    map.set(k, n)
  }

  for (const n of nodes) {
    for (const dep of n.dependsOn ?? []) {
      const dk = dep.trim()
      if (dk === n.key.trim()) throw new Error(`节点「${n.key}」不能依赖自身`)
      if (!map.has(dk)) throw new Error(`节点「${n.key}」依赖的前置节点「${dk}」不存在`)
    }
  }

  const color = new Map<string, 0 | 1 | 2>()
  const dfs = (k: string, path: string[]): void => {
    color.set(k, 1)
    const node = map.get(k)!
    for (const dep of node.dependsOn ?? []) {
      const dk = dep.trim()
      const c = color.get(dk) ?? 0
      if (c === 1) throw new Error(`任务计划存在循环依赖：${[...path, dk].join(' -> ')}`)
      if (c === 0) dfs(dk, [...path, dk])
    }
    color.set(k, 2)
  }
  for (const k of map.keys()) {
    if ((color.get(k) ?? 0) === 0) dfs(k, [k])
  }
}

export class MissionStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        plan_version INTEGER NOT NULL DEFAULT 1,
        auto_start INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_missions_session ON missions(session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS mission_nodes (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'ticket',
        prompt TEXT NOT NULL,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        execution_id TEXT,
        ticket_id TEXT,
        council_id TEXT,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        commit_sha TEXT,
        approved_by TEXT,
        approved_plan_version INTEGER,
        approval_idempotency_key TEXT,
        output_summary TEXT NOT NULL DEFAULT '',
        error TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        finished_at TEXT,
        order_index INTEGER NOT NULL DEFAULT 0,
        UNIQUE(mission_id, node_key)
      );
      CREATE INDEX IF NOT EXISTS idx_mission_nodes_mission ON mission_nodes(mission_id, order_index ASC);
      CREATE INDEX IF NOT EXISTS idx_mission_nodes_ticket ON mission_nodes(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_mission_nodes_council ON mission_nodes(council_id);
      CREATE INDEX IF NOT EXISTS idx_mission_nodes_exec ON mission_nodes(execution_id);

      CREATE TABLE IF NOT EXISTS mission_approvals (
        mission_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        approved_at TEXT NOT NULL,
        PRIMARY KEY (mission_id, node_key, plan_version, idempotency_key)
      );
    `)
    this.ensureMigrations()
  }

  private ensureMigrations(): void {
    const mCols = new Set(
      (this.db.prepare('PRAGMA table_info(missions)').all() as unknown as { name: string }[]).map(c => c.name),
    )
    if (!mCols.has('plan_version')) {
      this.db.exec('ALTER TABLE missions ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 1')
    }

    const nCols = new Set(
      (this.db.prepare('PRAGMA table_info(mission_nodes)').all() as unknown as { name: string }[]).map(c => c.name),
    )
    const addN = (name: string, ddl: string): void => {
      if (!nCols.has(name)) this.db.exec(`ALTER TABLE mission_nodes ADD COLUMN ${ddl}`)
    }
    addN('execution_id', 'execution_id TEXT')
    addN('artifacts_json', `artifacts_json TEXT NOT NULL DEFAULT '[]'`)
    addN('commit_sha', 'commit_sha TEXT')
    addN('approved_by', 'approved_by TEXT')
    addN('approved_plan_version', 'approved_plan_version INTEGER')
    addN('approval_idempotency_key', 'approval_idempotency_key TEXT')
  }

  private hydrate(row: MissionRow): MissionRecord {
    const nodes = (this.db.prepare(`
      SELECT * FROM mission_nodes WHERE mission_id = ? ORDER BY order_index ASC
    `).all(row.id) as unknown as NodeRow[]).map(rowToNode)
    return {
      id: row.id,
      sessionId: row.session_id,
      title: row.title,
      goal: row.goal,
      status: row.status as MissionStatus,
      planVersion: row.plan_version ?? 1,
      autoStart: row.auto_start === 1,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodes,
    }
  }

  create(input: MissionCreateInput, now = new Date()): MissionRecord {
    const title = input.title.trim().slice(0, 160)
    const goal = input.goal.trim().slice(0, 8_000)
    if (!title) throw new Error('任务计划标题不能为空')
    if (!goal) throw new Error('任务计划目标描述不能为空')
    validateMissionDag(input.nodes)

    const id = makeId('ms')
    const iso = now.toISOString()
    const autoStart = input.autoStart !== false
    const status: MissionStatus = autoStart ? 'running' : 'draft'

    this.db.prepare(`
      INSERT INTO missions (id, session_id, title, goal, status, plan_version, auto_start, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, '', ?, ?)
    `).run(id, input.sessionId?.trim() || null, title, goal, status, autoStart ? 1 : 0, iso, iso)

    const insNode = this.db.prepare(`
      INSERT INTO mission_nodes (
        id, mission_id, node_key, title, kind, prompt, depends_on_json, config_json,
        status, execution_id, ticket_id, council_id, artifacts_json, commit_sha,
        approved_by, approved_plan_version, approval_idempotency_key,
        output_summary, error, retries, started_at, finished_at, order_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, '', NULL, 0, NULL, NULL, ?)
    `)

    input.nodes.forEach((n, index) => {
      const kind: MissionNodeKind = n.kind === 'council' || n.kind === 'director' || n.kind === 'approval' ? n.kind : 'ticket'
      const deps = [...new Set((n.dependsOn ?? []).map(d => d.trim()).filter(Boolean))]
      insNode.run(
        makeId('nd'),
        id,
        n.key.trim(),
        n.title.trim().slice(0, 160),
        kind,
        n.prompt.trim().slice(0, 10_000),
        JSON.stringify(deps),
        JSON.stringify(n.config ?? {}),
        index,
      )
    })

    return this.get(id)!
  }

  get(id: string): MissionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | undefined
    return row ? this.hydrate(row) : undefined
  }

  list(filter: { sessionId?: string; status?: MissionStatus; limit?: number } = {}): { items: MissionRecord[]; total: number } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.sessionId) { where.push('session_id = ?'); params.push(filter.sessionId) }
    if (filter.status) { where.push('status = ?'); params.push(filter.status) }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM missions ${clause}`).get(...params) as { c: number }
    const limit = Math.max(1, Math.min(100, filter.limit ?? 30))
    const rows = this.db.prepare(`
      SELECT * FROM missions ${clause} ORDER BY updated_at DESC LIMIT ?
    `).all(...params, limit) as unknown as MissionRow[]
    return { items: rows.map(r => this.hydrate(r)), total: Number(totalRow.c) }
  }

  /** 修订计划目标或版本时递增 `plan_version`，使旧版本未提交的审批自动失效。 */
  bumpPlanVersion(id: string, nextGoal?: string, now = new Date()): MissionRecord | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    this.db.prepare(`
      UPDATE missions SET plan_version = plan_version + 1, goal = ?, updated_at = ? WHERE id = ?
    `).run(nextGoal?.trim() || cur.goal, now.toISOString(), id)
    return this.get(id)
  }

  setMissionStatus(id: string, status: MissionStatus, summary?: string, now = new Date()): MissionRecord | undefined {
    const iso = now.toISOString()
    if (summary !== undefined) {
      this.db.prepare('UPDATE missions SET status = ?, summary = ?, updated_at = ? WHERE id = ?').run(status, summary.slice(0, 4000), iso, id)
    } else {
      this.db.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?').run(status, iso, id)
    }
    return this.get(id)
  }

  updateNode(
    missionId: string,
    nodeKey: string,
    patch: {
      status?: MissionNodeStatus
      executionId?: string | null
      ticketId?: string | null
      councilId?: string | null
      artifacts?: string[]
      commitSha?: string | null
      approvedBy?: string | null
      approvedPlanVersion?: number | null
      approvalIdempotencyKey?: string | null
      outputSummary?: string
      error?: string | null
      incrementRetries?: boolean
      startedAt?: string | null
      finishedAt?: string | null
    },
    now = new Date(),
  ): MissionNodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM mission_nodes WHERE mission_id = ? AND node_key = ?').get(missionId, nodeKey) as NodeRow | undefined
    if (!row) return undefined
    const cur = rowToNode(row)
    const status = patch.status ?? cur.status
    const executionId = patch.executionId !== undefined ? patch.executionId : cur.executionId
    const ticketId = patch.ticketId !== undefined ? patch.ticketId : cur.ticketId
    const councilId = patch.councilId !== undefined ? patch.councilId : cur.councilId
    const artifacts = patch.artifacts !== undefined ? patch.artifacts : cur.artifacts
    const commitSha = patch.commitSha !== undefined ? patch.commitSha : cur.commitSha
    const approvedBy = patch.approvedBy !== undefined ? patch.approvedBy : cur.approvedBy
    const approvedPlanVersion = patch.approvedPlanVersion !== undefined ? patch.approvedPlanVersion : cur.approvedPlanVersion
    const approvalIdempotencyKey = patch.approvalIdempotencyKey !== undefined ? patch.approvalIdempotencyKey : cur.approvalIdempotencyKey
    const outputSummary = patch.outputSummary !== undefined ? patch.outputSummary.slice(0, 4000) : cur.outputSummary
    const error = patch.error !== undefined ? (patch.error ? patch.error.slice(0, 1000) : null) : cur.error
    const retries = cur.retries + (patch.incrementRetries ? 1 : 0)
    const startedAt = patch.startedAt !== undefined ? patch.startedAt : cur.startedAt
    const finishedAt = patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt

    this.db.prepare(`
      UPDATE mission_nodes
      SET status = ?, execution_id = ?, ticket_id = ?, council_id = ?, artifacts_json = ?, commit_sha = ?,
          approved_by = ?, approved_plan_version = ?, approval_idempotency_key = ?,
          output_summary = ?, error = ?, retries = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      status,
      executionId,
      ticketId,
      councilId,
      JSON.stringify(artifacts),
      commitSha,
      approvedBy,
      approvedPlanVersion,
      approvalIdempotencyKey,
      outputSummary,
      error,
      retries,
      startedAt,
      finishedAt,
      cur.id,
    )
    this.db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(now.toISOString(), missionId)

    const updated = this.db.prepare('SELECT * FROM mission_nodes WHERE id = ?').get(cur.id) as NodeRow | undefined
    return updated ? rowToNode(updated) : undefined
  }

  /** 原子记录幂等审批；若同一 `(missionId, nodeKey, planVersion, idempotencyKey)` 已存在，返回 `{ inserted: false }`。 */
  recordApprovalIdempotent(input: {
    missionId: string
    nodeKey: string
    planVersion: number
    idempotencyKey: string
    actorId: string
    note: string
    approvedAt: string
  }): { inserted: boolean } {
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO mission_approvals (
        mission_id, node_key, plan_version, idempotency_key, actor_id, note, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.missionId,
      input.nodeKey,
      input.planVersion,
      input.idempotencyKey,
      input.actorId,
      input.note.slice(0, 600),
      input.approvedAt,
    )
    return { inserted: Number(res.changes) > 0 }
  }

  listDispatchingOrRunningNodes(): { mission: MissionRecord; node: MissionNodeRecord }[] {
    const rows = this.db.prepare(`
      SELECT n.* FROM mission_nodes n
      INNER JOIN missions m ON m.id = n.mission_id
      WHERE m.status = 'running' AND n.status IN ('dispatching', 'running')
      ORDER BY m.updated_at ASC, n.order_index ASC
    `).all() as unknown as NodeRow[]
    const out: { mission: MissionRecord; node: MissionNodeRecord }[] = []
    for (const r of rows) {
      const m = this.get(r.mission_id)
      const n = m?.nodes.find(x => x.id === r.id)
      if (m && n) out.push({ mission: m, node: n })
    }
    return out
  }

  findNodeByTicket(ticketId: string): { mission: MissionRecord; node: MissionNodeRecord } | undefined {
    const row = this.db.prepare('SELECT * FROM mission_nodes WHERE ticket_id = ? LIMIT 1').get(ticketId) as NodeRow | undefined
    if (!row) return undefined
    const mission = this.get(row.mission_id)
    if (!mission) return undefined
    const node = mission.nodes.find(n => n.id === row.id)
    return node ? { mission, node } : undefined
  }

  findNodeByExecutionId(executionId: string): { mission: MissionRecord; node: MissionNodeRecord } | undefined {
    const row = this.db.prepare('SELECT * FROM mission_nodes WHERE execution_id = ? LIMIT 1').get(executionId) as NodeRow | undefined
    if (!row) return undefined
    const mission = this.get(row.mission_id)
    if (!mission) return undefined
    const node = mission.nodes.find(n => n.id === row.id)
    return node ? { mission, node } : undefined
  }

  findNodeByCouncil(councilId: string): { mission: MissionRecord; node: MissionNodeRecord } | undefined {
    const row = this.db.prepare('SELECT * FROM mission_nodes WHERE council_id = ? LIMIT 1').get(councilId) as NodeRow | undefined
    if (!row) return undefined
    const mission = this.get(row.mission_id)
    if (!mission) return undefined
    const node = mission.nodes.find(n => n.id === row.id)
    return node ? { mission, node } : undefined
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM missions WHERE id = ?').run(id)
    if (Number(res.changes) > 0) {
      this.db.prepare('DELETE FROM mission_nodes WHERE mission_id = ?').run(id)
      this.db.prepare('DELETE FROM mission_approvals WHERE mission_id = ?').run(id)
      return true
    }
    return false
  }
}
