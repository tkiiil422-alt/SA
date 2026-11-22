/**
 * 统一任务约定（Task Contract）SQLite 存储。
 *
 * 对话、Web、定时调度与 DAG 计划共用同一套约定模型：
 * - 保存目标、交付物、逐项验收条件、关键假设、预算与授权范围；
 * - 简单任务可通过 `ensureDefault` 自动补全；
 * - 用户中途纠正要求时生成新版本（`version + 1`），旧版本快照永久不可变保留。
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AmendmentScope,
  ContractCriterion,
  ContractTargetKind,
  TaskContractRecord,
  TaskContractVersionRecord,
} from '../shared/api-types.ts'

export type {
  AmendmentScope,
  ContractCriterion,
  ContractTargetKind,
  TaskContractRecord,
  TaskContractVersionRecord,
}

export interface ContractSaveInput {
  targetKind: ContractTargetKind
  targetId: string
  projectId?: string | null
  goal: string
  deliverables?: string[]
  criteria?: (string | ContractCriterion)[]
  assumptions?: string[]
  budgetUsd?: number | null
  allowedScope?: string
  amendmentScope?: AmendmentScope
  amendmentReason?: string
}

export interface ContractAmendPatch {
  goal?: string
  deliverables?: string[]
  criteria?: (string | ContractCriterion)[]
  /** 仅追加新的验收条件而不清空原有条件。 */
  addCriteria?: (string | ContractCriterion)[]
  assumptions?: string[]
  budgetUsd?: number | null
  allowedScope?: string
  projectId?: string | null
}

interface ContractRow {
  id: string
  target_kind: string
  target_id: string
  version: number
  project_id: string | null
  goal: string
  deliverables_json: string
  criteria_json: string
  assumptions_json: string
  budget_usd: number | null
  allowed_scope: string
  amendment_scope: string
  amendment_reason: string
  created_at: string
  updated_at: string
}

interface ContractVersionRow {
  contract_id: string
  version: number
  goal: string
  deliverables_json: string
  criteria_json: string
  assumptions_json: string
  budget_usd: number | null
  allowed_scope: string
  amendment_scope: string
  reason: string
  created_at: string
}

function makeId(): string {
  return `ctr_${randomBytes(5).toString('hex')}`
}

function parseStringArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
  } catch {
    return []
  }
}

function parseCriteria(raw: string): ContractCriterion[] {
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x, idx) => ({
        id: typeof x.id === 'string' && x.id.trim() ? x.id.trim() : `c${idx + 1}`,
        text: typeof x.text === 'string' ? x.text.trim() : '',
        required: x.required !== false,
      }))
      .filter(c => c.text.length > 0)
  } catch {
    return []
  }
}

export function normalizeCriteria(items: readonly (string | ContractCriterion)[] | undefined): ContractCriterion[] {
  if (!items || items.length === 0) return []
  const out: ContractCriterion[] = []
  const seen = new Set<string>()
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i]!
    const text = (typeof raw === 'string' ? raw : raw.text).trim().slice(0, 500)
    if (!text) continue
    let id = typeof raw === 'string' ? `c${out.length + 1}` : (raw.id.trim() || `c${out.length + 1}`)
    while (seen.has(id)) id = `c${out.length + 1}_${randomBytes(2).toString('hex')}`
    seen.add(id)
    out.push({
      id,
      text,
      required: typeof raw === 'string' ? true : raw.required !== false,
    })
  }
  return out
}

function normalizeStrings(items: readonly string[] | undefined, max = 30): string[] {
  if (!items) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const clean = raw.trim().slice(0, 400)
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= max) break
  }
  return out
}

function rowToContract(row: ContractRow): TaskContractRecord {
  return {
    id: row.id,
    targetKind: row.target_kind as ContractTargetKind,
    targetId: row.target_id,
    version: row.version,
    projectId: row.project_id,
    goal: row.goal,
    deliverables: parseStringArray(row.deliverables_json),
    criteria: parseCriteria(row.criteria_json),
    assumptions: parseStringArray(row.assumptions_json),
    budgetUsd: row.budget_usd,
    allowedScope: row.allowed_scope,
    amendmentScope: (row.amendment_scope as AmendmentScope) || 'once',
    amendmentReason: row.amendment_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToVersion(row: ContractVersionRow): TaskContractVersionRecord {
  return {
    contractId: row.contract_id,
    version: row.version,
    goal: row.goal,
    deliverables: parseStringArray(row.deliverables_json),
    criteria: parseCriteria(row.criteria_json),
    assumptions: parseStringArray(row.assumptions_json),
    budgetUsd: row.budget_usd,
    allowedScope: row.allowed_scope,
    amendmentScope: (row.amendment_scope as AmendmentScope) || 'once',
    reason: row.reason,
    createdAt: row.created_at,
  }
}

export class ContractStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_contracts (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        project_id TEXT,
        goal TEXT NOT NULL,
        deliverables_json TEXT NOT NULL DEFAULT '[]',
        criteria_json TEXT NOT NULL DEFAULT '[]',
        assumptions_json TEXT NOT NULL DEFAULT '[]',
        budget_usd REAL,
        allowed_scope TEXT NOT NULL DEFAULT 'workspace_only',
        amendment_scope TEXT NOT NULL DEFAULT 'once',
        amendment_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(target_kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_contracts_target ON task_contracts(target_kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_task_contracts_project ON task_contracts(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_contract_versions (
        contract_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        goal TEXT NOT NULL,
        deliverables_json TEXT NOT NULL DEFAULT '[]',
        criteria_json TEXT NOT NULL DEFAULT '[]',
        assumptions_json TEXT NOT NULL DEFAULT '[]',
        budget_usd REAL,
        allowed_scope TEXT NOT NULL DEFAULT 'workspace_only',
        amendment_scope TEXT NOT NULL DEFAULT 'once',
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY (contract_id, version)
      );
    `)
  }

  get(targetKind: ContractTargetKind, targetId: string): TaskContractRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM task_contracts WHERE target_kind = ? AND target_id = ?',
    ).get(targetKind, targetId) as ContractRow | undefined
    return row ? rowToContract(row) : undefined
  }

  getById(id: string): TaskContractRecord | undefined {
    const row = this.db.prepare('SELECT * FROM task_contracts WHERE id = ?').get(id) as ContractRow | undefined
    return row ? rowToContract(row) : undefined
  }

  list(filter: { targetKind?: ContractTargetKind; projectId?: string; limit?: number } = {}): TaskContractRecord[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter.targetKind) { clauses.push('target_kind = ?'); params.push(filter.targetKind) }
    if (filter.projectId) { clauses.push('project_id = ?'); params.push(filter.projectId) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
    const rows = this.db.prepare(
      `SELECT * FROM task_contracts ${where} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...params, limit) as unknown as ContractRow[]
    return rows.map(rowToContract)
  }

  getVersion(contractId: string, version: number): TaskContractVersionRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM task_contract_versions WHERE contract_id = ? AND version = ?',
    ).get(contractId, version) as ContractVersionRow | undefined
    return row ? rowToVersion(row) : undefined
  }

  listVersions(contractId: string): TaskContractVersionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_contract_versions WHERE contract_id = ? ORDER BY version ASC',
    ).all(contractId) as unknown as ContractVersionRow[]
    return rows.map(rowToVersion)
  }

  /** 创建或覆写约定（已存在时自动递增版本号并归档旧快照）。 */
  save(input: ContractSaveInput, now = new Date()): TaskContractRecord {
    const existing = this.get(input.targetKind, input.targetId)
    const goal = input.goal.trim().slice(0, 4000)
    if (!goal) throw new Error('任务约定的目标（goal）不能为空')
    const deliverables = normalizeStrings(input.deliverables)
    const criteria = normalizeCriteria(input.criteria)
    const assumptions = normalizeStrings(input.assumptions)
    const budgetUsd = input.budgetUsd !== undefined && input.budgetUsd !== null && Number.isFinite(input.budgetUsd)
      ? Math.max(0.01, Number(input.budgetUsd))
      : null
    const allowedScope = (input.allowedScope ?? 'workspace_only').trim().slice(0, 300) || 'workspace_only'
    const amendmentScope: AmendmentScope = input.amendmentScope ?? 'once'
    const amendmentReason = (input.amendmentReason ?? (existing ? '更新任务约定' : '初始约定')).trim().slice(0, 600)
    const iso = now.toISOString()

    if (!existing) {
      const id = makeId()
      this.db.prepare(`
        INSERT INTO task_contracts (
          id, target_kind, target_id, version, project_id, goal,
          deliverables_json, criteria_json, assumptions_json, budget_usd,
          allowed_scope, amendment_scope, amendment_reason, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.targetKind,
        input.targetId,
        input.projectId ?? null,
        goal,
        JSON.stringify(deliverables),
        JSON.stringify(criteria),
        JSON.stringify(assumptions),
        budgetUsd,
        allowedScope,
        amendmentScope,
        amendmentReason,
        iso,
        iso,
      )
      this.insertVersionSnapshot(id, 1, goal, deliverables, criteria, assumptions, budgetUsd, allowedScope, amendmentScope, amendmentReason, iso)
      return this.getById(id)!
    }

    const nextVer = existing.version + 1
    this.db.prepare(`
      UPDATE task_contracts
      SET version = ?, project_id = ?, goal = ?, deliverables_json = ?, criteria_json = ?,
          assumptions_json = ?, budget_usd = ?, allowed_scope = ?, amendment_scope = ?,
          amendment_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextVer,
      input.projectId !== undefined ? input.projectId : existing.projectId,
      goal,
      JSON.stringify(deliverables),
      JSON.stringify(criteria),
      JSON.stringify(assumptions),
      budgetUsd,
      allowedScope,
      amendmentScope,
      amendmentReason,
      iso,
      existing.id,
    )
    this.insertVersionSnapshot(existing.id, nextVer, goal, deliverables, criteria, assumptions, budgetUsd, allowedScope, amendmentScope, amendmentReason, iso)
    return this.getById(existing.id)!
  }

  /** 为简单任务自动补全一份轻量任务约定（已存在则直接返回现有约定）。 */
  ensureDefault(
    targetKind: ContractTargetKind,
    targetId: string,
    rawText: string,
    opts: {
      projectId?: string | null
      budgetUsd?: number | null
      deliverables?: string[]
      criteria?: (string | ContractCriterion)[]
      assumptions?: string[]
      allowedScope?: string
    } = {},
    now = new Date(),
  ): TaskContractRecord {
    const existing = this.get(targetKind, targetId)
    if (existing) return existing
    const cleaned = rawText.replace(/\s+/g, ' ').trim()
    const goal = cleaned.slice(0, 600) || `完成${targetKind}任务 ${targetId}`
    const criteria = opts.criteria && opts.criteria.length > 0
      ? opts.criteria
      : [{ id: 'c1', text: `按要求完成目标并附带可核查验证证据：${goal.slice(0, 140)}`, required: true }]
    const deliverables = opts.deliverables && opts.deliverables.length > 0
      ? opts.deliverables
      : ['任务执行成果与交付说明']
    const assumptions = opts.assumptions && opts.assumptions.length > 0
      ? opts.assumptions
      : ['默认遵循已有项目约定与用户长期偏好；遇重大歧义先确认。']
    return this.save({
      targetKind,
      targetId,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      goal,
      deliverables,
      criteria,
      assumptions,
      ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
      allowedScope: opts.allowedScope ?? (opts.projectId ? 'project_workspace' : 'workspace_only'),
      amendmentScope: 'once',
      amendmentReason: '系统自动补全默认任务约定',
    }, now)
  }

  /**
   * 中途纠正/修订任务约定：
   * - 保留全部旧版本快照（已完成产物继续绑定旧版本依据）；
   * - 递增至新版本并计算变更/受影响的验收条件，便于仅重做受影响部分。
   */
  amend(
    targetKind: ContractTargetKind,
    targetId: string,
    patch: ContractAmendPatch,
    opts: { scope: AmendmentScope; reason: string; projectId?: string | null },
    now = new Date(),
  ): {
    contract: TaskContractRecord
    previousVersion: number
    affectedCriteria: ContractCriterion[]
  } {
    const existing = this.get(targetKind, targetId)
    if (!existing) {
      const created = this.save({
        targetKind,
        targetId,
        projectId: patch.projectId ?? opts.projectId ?? null,
        goal: patch.goal?.trim() || `按纠正后的要求执行（${opts.reason.trim() || '新要求'}）`,
        ...(patch.deliverables ? { deliverables: patch.deliverables } : {}),
        criteria: patch.criteria ?? patch.addCriteria ?? [],
        ...(patch.assumptions ? { assumptions: patch.assumptions } : {}),
        ...(patch.budgetUsd !== undefined ? { budgetUsd: patch.budgetUsd } : {}),
        ...(patch.allowedScope ? { allowedScope: patch.allowedScope } : {}),
        amendmentScope: opts.scope,
        amendmentReason: opts.reason.trim() || '用户纠正要求',
      }, now)
      return { contract: created, previousVersion: 0, affectedCriteria: created.criteria }
    }

    const nextGoal = patch.goal !== undefined && patch.goal.trim() ? patch.goal.trim() : existing.goal
    const nextDeliverables = patch.deliverables !== undefined ? normalizeStrings(patch.deliverables) : existing.deliverables
    let nextCriteria: ContractCriterion[]
    if (patch.criteria !== undefined) {
      nextCriteria = normalizeCriteria(patch.criteria)
    } else if (patch.addCriteria && patch.addCriteria.length > 0) {
      nextCriteria = normalizeCriteria([...existing.criteria, ...patch.addCriteria])
    } else {
      nextCriteria = existing.criteria
    }
    const nextAssumptions = patch.assumptions !== undefined ? normalizeStrings(patch.assumptions) : existing.assumptions
    const nextBudget = patch.budgetUsd !== undefined ? patch.budgetUsd : existing.budgetUsd
    const nextScopeText = patch.allowedScope !== undefined ? patch.allowedScope : existing.allowedScope
    const nextProjectId = patch.projectId !== undefined
      ? patch.projectId
      : (opts.projectId !== undefined ? opts.projectId : existing.projectId)

    // 计算新增或内容发生变化的验收条件，供只重做受影响部分使用
    const prevById = new Map(existing.criteria.map(c => [c.id, c.text]))
    const affectedCriteria = nextCriteria.filter(c => prevById.get(c.id) !== c.text)

    const updated = this.save({
      targetKind,
      targetId,
      projectId: nextProjectId,
      goal: nextGoal,
      deliverables: nextDeliverables,
      criteria: nextCriteria,
      assumptions: nextAssumptions,
      budgetUsd: nextBudget,
      allowedScope: nextScopeText,
      amendmentScope: opts.scope,
      amendmentReason: opts.reason.trim() || '用户纠正要求',
    }, now)

    return {
      contract: updated,
      previousVersion: existing.version,
      affectedCriteria: affectedCriteria.length > 0 ? affectedCriteria : updated.criteria,
    }
  }

  /** 将调度任务或计划的当前约定快照克隆到具体执行工单，确保旧工单不受后续修订污染。 */
  cloneToTarget(
    source: TaskContractRecord,
    targetKind: ContractTargetKind,
    targetId: string,
    now = new Date(),
  ): TaskContractRecord {
    return this.save({
      targetKind,
      targetId,
      projectId: source.projectId,
      goal: source.goal,
      deliverables: source.deliverables,
      criteria: source.criteria,
      assumptions: source.assumptions,
      budgetUsd: source.budgetUsd,
      allowedScope: source.allowedScope,
      amendmentScope: source.amendmentScope,
      amendmentReason: `继承自 ${source.targetKind}:${source.targetId} v${source.version}`,
    }, now)
  }

  /** 渲染供 Worker 或总控直接阅读的结构化约定文本。 */
  formatForPrompt(contract: TaskContractRecord): string {
    const lines: string[] = [
      `## 统一任务约定（v${contract.version} · ${contract.targetKind}:${contract.targetId}）`,
      `- **目标**：${contract.goal}`,
    ]
    if (contract.deliverables.length > 0) {
      lines.push(`- **交付物**：${contract.deliverables.join('；')}`)
    }
    if (contract.criteria.length > 0) {
      lines.push('- **逐项验收条件**：')
      for (const c of contract.criteria) {
        lines.push(`  - [${c.id}${c.required ? '·必选' : '·可选'}] ${c.text}`)
      }
    }
    if (contract.assumptions.length > 0) {
      lines.push(`- **关键假设与口径**：${contract.assumptions.join('；')}`)
    }
    if (contract.budgetUsd !== null) {
      lines.push(`- **预算上限**：$${contract.budgetUsd.toFixed(2)}`)
    }
    lines.push(`- **授权范围**：${contract.allowedScope}`)
    if (contract.version > 1 && contract.amendmentReason) {
      lines.push(`- **最新修订说明（v${contract.version}）**：${contract.amendmentReason}`)
    }
    return lines.join('\n')
  }

  private insertVersionSnapshot(
    contractId: string,
    version: number,
    goal: string,
    deliverables: string[],
    criteria: ContractCriterion[],
    assumptions: string[],
    budgetUsd: number | null,
    allowedScope: string,
    amendmentScope: AmendmentScope,
    reason: string,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO task_contract_versions (
        contract_id, version, goal, deliverables_json, criteria_json,
        assumptions_json, budget_usd, allowed_scope, amendment_scope, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contractId,
      version,
      goal,
      JSON.stringify(deliverables),
      JSON.stringify(criteria),
      JSON.stringify(assumptions),
      budgetUsd,
      allowedScope,
      amendmentScope,
      reason,
      createdAt,
    )
  }
}
