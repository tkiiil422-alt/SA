/**
 * 插件自动演进工作流（PluginEvolutionService）。
 *
 * 当现有技能确实无法完成一类重复任务时：
 * 1. 记录重复出现的能力缺口（`capability_gaps`）；
 * 2. 达到阈值（默认 >= 2 次）时自动生成插件改进提案（`plugin_proposals`），通过正常研发流程
 *    （独立 `worktree` 分支开发 → 契约测试与回归评测 → 小范围灰度启用）推进；
 * 3. **安全硬门禁**：凡涉及新增外部写权限（`externalWritePermissions`）或不可逆迁移（`irreversibleMigration`），
 *    强制进入 `pending_approval` 状态并要求真实用户审批后才能派发/合入，绝不越权自动生效！
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { PluginProposalRecord } from '../shared/api-types.ts'
import type { MissionService } from '../missions/service.ts'

export type { PluginProposalRecord }

interface ProposalRow {
  id: string
  gap_key: string
  plugin_name: string
  summary: string
  occurrences: number
  external_write_permissions_json: string
  irreversible_migration: number
  requires_user_approval: number
  status: string
  approved_by: string | null
  mission_id: string | null
  ticket_id: string | null
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

function rowToProposal(r: ProposalRow): PluginProposalRecord {
  return {
    id: r.id,
    gapKey: r.gap_key,
    pluginName: r.plugin_name,
    summary: r.summary,
    occurrences: r.occurrences,
    externalWritePermissions: parseStrings(r.external_write_permissions_json),
    irreversibleMigration: r.irreversible_migration === 1,
    requiresUserApproval: r.requires_user_approval === 1,
    status: r.status as PluginProposalRecord['status'],
    approvedBy: r.approved_by,
    missionId: r.mission_id,
    ticketId: r.ticket_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface PluginEvolutionDeps {
  db: DatabaseSync
  missions?: Pick<MissionService, 'create'>
  dispatchTicket?: (input: { text: string; projectId?: string; projectMode?: 'worktree' | 'copy' }) => Promise<{ ticketId?: string }>
  threshold?: number
  now?: () => Date
}

export class PluginEvolutionService {
  private readonly threshold: number
  private readonly doNow: () => Date

  constructor(private readonly deps: PluginEvolutionDeps) {
    this.threshold = Math.max(1, deps.threshold ?? 2)
    this.doNow = deps.now ?? (() => new Date())
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_gaps (
        gap_key TEXT PRIMARY KEY,
        plugin_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        samples_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_proposals (
        id TEXT PRIMARY KEY,
        gap_key TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        external_write_permissions_json TEXT NOT NULL DEFAULT '[]',
        irreversible_migration INTEGER NOT NULL DEFAULT 0,
        requires_user_approval INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        approved_by TEXT,
        mission_id TEXT,
        ticket_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_proposals_gap ON plugin_proposals(gap_key, updated_at DESC);
    `)
  }

  /**
   * 登记一次“现有技能无法完成”的任务缺口；
   * 若累计次数达到阈值，自动创建插件改进提案（有外部写权限或不可逆迁移时锁定待审批，否则可直接派发独立分支研发）。
   */
  async recordCapabilityGap(input: {
    gapKey: string
    pluginName: string
    summary: string
    sampleTask: string
    projectId?: string
    externalWritePermissions?: string[]
    irreversibleMigration?: boolean
  }): Promise<{ occurrences: number; proposal?: PluginProposalRecord }> {
    const gapKey = input.gapKey.trim().toLowerCase().slice(0, 80)
    if (!gapKey) throw new Error('gapKey 不能为空')
    const iso = this.doNow().toISOString()

    const cur = this.deps.db.prepare('SELECT occurrences, samples_json FROM capability_gaps WHERE gap_key = ?')
      .get(gapKey) as { occurrences: number; samples_json: string } | undefined

    const occurrences = (cur?.occurrences ?? 0) + 1
    const samples = [...parseStrings(cur?.samples_json ?? '[]'), input.sampleTask.trim().slice(0, 300)].slice(-10)

    this.deps.db.prepare(`
      INSERT INTO capability_gaps (gap_key, plugin_name, summary, occurrences, samples_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(gap_key) DO UPDATE SET
        plugin_name = excluded.plugin_name,
        summary = excluded.summary,
        occurrences = excluded.occurrences,
        samples_json = excluded.samples_json,
        updated_at = excluded.updated_at
    `).run(gapKey, input.pluginName.trim().slice(0, 80), input.summary.trim().slice(0, 600), occurrences, JSON.stringify(samples), iso)

    if (occurrences < this.threshold) {
      return { occurrences }
    }

    // 避免同一缺口重复刷屏建多个开放提案
    const existing = this.deps.db.prepare(
      `SELECT * FROM plugin_proposals WHERE gap_key = ? AND status IN ('pending_approval', 'approved', 'dispatched') ORDER BY created_at DESC LIMIT 1`,
    ).get(gapKey) as ProposalRow | undefined
    if (existing) {
      this.deps.db.prepare('UPDATE plugin_proposals SET occurrences = ?, updated_at = ? WHERE id = ?')
        .run(occurrences, iso, existing.id)
      return { occurrences, proposal: this.getProposal(existing.id)! }
    }

    const writePerms = [...new Set((input.externalWritePermissions ?? []).map(s => s.trim()).filter(Boolean))]
    const irreversible = Boolean(input.irreversibleMigration)
    const requiresUserApproval = writePerms.length > 0 || irreversible

    const id = `prop_${randomBytes(5).toString('hex')}`
    const initialStatus: PluginProposalRecord['status'] = requiresUserApproval ? 'pending_approval' : 'approved'

    this.deps.db.prepare(`
      INSERT INTO plugin_proposals (
        id, gap_key, plugin_name, summary, occurrences,
        external_write_permissions_json, irreversible_migration, requires_user_approval,
        status, approved_by, mission_id, ticket_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id,
      gapKey,
      input.pluginName.trim().slice(0, 80),
      input.summary.trim().slice(0, 600),
      occurrences,
      JSON.stringify(writePerms),
      irreversible ? 1 : 0,
      requiresUserApproval ? 1 : 0,
      initialStatus,
      iso,
      iso,
    )

    if (!requiresUserApproval) {
      const dispatched = await this.dispatchProposalPipeline(id, input.projectId)
      return { occurrences, proposal: dispatched }
    }
    return { occurrences, proposal: this.getProposal(id)! }
  }

  /** 用户批准涉及外部写权限或不可逆迁移的插件改进提案，并启动独立分支研发流水线。 */
  async approveProposal(proposalId: string, actorId: string, projectId?: string): Promise<PluginProposalRecord> {
    const actor = actorId.trim()
    if (!actor) throw new Error('批准插件提案必须提供真实用户身份 actorId')
    const prop = this.getProposal(proposalId)
    if (!prop) throw new Error(`找不到插件提案 ${proposalId}`)
    if (prop.status === 'dispatched' || prop.status === 'rolled_out') return prop
    this.deps.db.prepare(`
      UPDATE plugin_proposals SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ?
    `).run(actor, this.doNow().toISOString(), proposalId)
    return this.dispatchProposalPipeline(proposalId, projectId)
  }

  rejectProposal(proposalId: string): PluginProposalRecord {
    const prop = this.getProposal(proposalId)
    if (!prop) throw new Error(`找不到插件提案 ${proposalId}`)
    this.deps.db.prepare(`UPDATE plugin_proposals SET status = 'rejected', updated_at = ? WHERE id = ?`)
      .run(this.doNow().toISOString(), proposalId)
    return this.getProposal(proposalId)!
  }

  getProposal(id: string): PluginProposalRecord | undefined {
    const row = this.deps.db.prepare('SELECT * FROM plugin_proposals WHERE id = ?').get(id) as ProposalRow | undefined
    return row ? rowToProposal(row) : undefined
  }

  listProposals(limit = 30): PluginProposalRecord[] {
    const rows = this.deps.db.prepare('SELECT * FROM plugin_proposals ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ProposalRow[]
    return rows.map(rowToProposal)
  }

  private async dispatchProposalPipeline(proposalId: string, projectId?: string): Promise<PluginProposalRecord> {
    const prop = this.getProposal(proposalId)!
    const prompt = [
      `[插件改进提案 ${prop.id}] 为能力缺口「${prop.gapKey}」开发/升级插件「${prop.pluginName}」`,
      `问题描述（已重复出现 ${prop.occurrences} 次）：${prop.summary}`,
      ...(prop.externalWritePermissions.length > 0 ? [`已审批外部写权限：${prop.externalWritePermissions.join('、')}`] : []),
      ...(prop.irreversibleMigration ? ['已审批包含不可逆数据迁移（请先备份再执行）'] : []),
      '',
      '研发要求：',
      '1. 在独立 Git worktree 分支实现插件，支持独立启停（停用后路由/工具/后台任务同步退出）；',
      '2. 编写契约测试与回归评测，确认既有基准零退化；',
      '3. 先小范围灰度启用并输出交付回执。',
    ].join('\n')

    let missionId: string | null = null
    let ticketId: string | null = null

    if (this.deps.missions) {
      const m = await this.deps.missions.create({
        title: `插件演进：${prop.pluginName}`,
        goal: prop.summary,
        autoStart: true,
        nodes: [
          {
            key: 'implement',
            title: '独立分支实现与契约测试',
            kind: 'ticket',
            prompt,
            config: { ...(projectId ? { projectId } : {}), projectMode: 'worktree' },
          },
          {
            key: 'eval_rollout',
            title: '回归评测与小范围灰度启用',
            kind: 'approval',
            prompt: '请核对契约测试与回归评测报告，确认后灰度启用该插件。',
            dependsOn: ['implement'],
          },
        ],
      })
      missionId = m.id
    } else if (this.deps.dispatchTicket) {
      const t = await this.deps.dispatchTicket({
        text: prompt,
        ...(projectId ? { projectId } : {}),
        projectMode: 'worktree',
      })
      ticketId = t.ticketId ?? null
    }

    this.deps.db.prepare(`
      UPDATE plugin_proposals SET status = 'dispatched', mission_id = ?, ticket_id = ?, updated_at = ? WHERE id = ?
    `).run(missionId, ticketId, this.doNow().toISOString(), proposalId)
    return this.getProposal(proposalId)!
  }
}
