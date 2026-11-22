/**
 * DAG 任务计划与多步骤编排存储（SQLite `missions` + `mission_nodes`）。
 *
 * 支持：
 * - 任意有向无环图（DAG）节点依赖定义与严格环检测（DFS 三色染色）
 * - 节点级状态流转、上下游上下文传递、重试计数与审批卡点记录
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
  ticket_id: string | null
  council_id: string | null
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

function parseJsonArray(raw: string): string[] {
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
    ticketId: row.ticket_id,
    councilId: row.council_id,
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

  // 三色 DFS 环检测：0=未访问，1=访问中，2=已完成
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
        ticket_id TEXT,
        council_id TEXT,
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
    `)
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
      INSERT INTO missions (id, session_id, title, goal, status, auto_start, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
    `).run(id, input.sessionId?.trim() || null, title, goal, status, autoStart ? 1 : 0, iso, iso)

    const insNode = this.db.prepare(`
      INSERT INTO mission_nodes (
        id, mission_id, node_key, title, kind, prompt, depends_on_json, config_json,
        status, ticket_id, council_id, output_summary, error, retries, started_at, finished_at, order_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, '', NULL, 0, NULL, NULL, ?)
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
      ticketId?: string | null
      councilId?: string | null
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
    const ticketId = patch.ticketId !== undefined ? patch.ticketId : cur.ticketId
    const councilId = patch.councilId !== undefined ? patch.councilId : cur.councilId
    const outputSummary = patch.outputSummary !== undefined ? patch.outputSummary.slice(0, 4000) : cur.outputSummary
    const error = patch.error !== undefined ? (patch.error ? patch.error.slice(0, 1000) : null) : cur.error
    const retries = cur.retries + (patch.incrementRetries ? 1 : 0)
    const startedAt = patch.startedAt !== undefined ? patch.startedAt : cur.startedAt
    const finishedAt = patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt

    this.db.prepare(`
      UPDATE mission_nodes
      SET status = ?, ticket_id = ?, council_id = ?, output_summary = ?, error = ?,
          retries = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(status, ticketId, councilId, outputSummary, error, retries, startedAt, finishedAt, cur.id)
    this.db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(now.toISOString(), missionId)

    const updated = this.db.prepare('SELECT * FROM mission_nodes WHERE id = ?').get(cur.id) as NodeRow | undefined
    return updated ? rowToNode(updated) : undefined
  }

  findNodeByTicket(ticketId: string): { mission: MissionRecord; node: MissionNodeRecord } | undefined {
    const row = this.db.prepare('SELECT * FROM mission_nodes WHERE ticket_id = ? LIMIT 1').get(ticketId) as NodeRow | undefined
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
      return true
    }
    return false
  }
}
