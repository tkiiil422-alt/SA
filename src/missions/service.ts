/**
 * DAG 任务计划编排、稳定执行 ID 崩溃恢复与幂等审批引擎（MissionService）。
 *
 * V2.2 关键保障：
 * 1. **稳定执行 ID（`executionId`）+ 崩溃对账**：派单前先行持久化 `status='dispatching'` 与 `executionId`，
 *    若进程在派单后、写回 `ticketId` 前崩溃退出，重启时 `recoverInterrupted()` 会先对账查找原工单并无缝续跑，绝不重复派单；
 * 2. **实体交接**：上游节点向汇总/下游节点显式传递实际产出文件路径（`artifacts`）与 Git 提交 SHA（`commitSha`）；
 * 3. **绑定人/节点/版本的幂等人工审批**：要求提供真实操作人 `actorId`，校验 `planVersion`，同一审批重复提交严格幂等不重复触发下游。
 */
import type { EventLog } from '../ledger/events.ts'
import type { GoalSpec } from '../goal/service.ts'
import type {
  MissionCreateInput,
  MissionNodeRecord,
  MissionRecord,
  MissionStatus,
  MissionStore,
} from './store.ts'
import type { ProjectWorkspaceMode } from '../shared/api-types.ts'

export interface TicketHandoffInfo {
  ticketId: string
  ended: boolean
  outcome?: string
  summary?: string
  artifacts?: string[]
  commitSha?: string
}

export interface MissionServiceDeps {
  store: MissionStore
  events: EventLog
  dispatchTicket: (input: {
    text: string
    executionId: string
    model?: string
    projectId?: string
    projectMode?: ProjectWorkspaceMode
    collab?: boolean
    goal?: GoalSpec
  }) => Promise<{ ticketId?: string; triggerId: string }>
  /** 崩溃恢复对账钩子：按稳定 `executionId` 查找可能已经创建但尚未写回 `mission_nodes.ticket_id` 的原工单。 */
  reconcileTicketByExecutionId?: (executionId: string) => Promise<TicketHandoffInfo | undefined> | TicketHandoffInfo | undefined
  /** 按已知 `ticketId` 查询其最新状态、交付物和提交 SHA（用于重启后补结算或节点交接）。 */
  getTicketHandoff?: (ticketId: string) => Promise<TicketHandoffInfo | undefined> | TicketHandoffInfo | undefined
  startCouncil?: (input: {
    text: string
    executionId: string
    projectId?: string
    rounds?: number
  }) => Promise<{ id: string }>
  getCouncilStatus?: (councilId: string) => { status: string; brief?: string; conclusion?: string } | undefined
  runDirectorNode?: (input: {
    sessionId?: string | null
    executionId: string
    prompt: string
  }) => Promise<{ reply: string; artifacts?: string[] }>
  onMissionSettled?: (mission: MissionRecord) => Promise<void> | void
  onApprovalNeeded?: (mission: MissionRecord, node: MissionNodeRecord) => Promise<void> | void
  resolveGoalInput?: (raw: Record<string, unknown>) => GoalSpec | undefined
  now?: () => Date
  onError?: (error: unknown) => void
}

export interface ApproveNodeOptions {
  /** 真实操作人身份（如 `owner` / `web:admin` / `feishu:ou_xxx`），必填。 */
  actorId: string
  /** 期望批准的计划版本；若与当前版本不符则拒绝，防止旧计划版本被误批准。 */
  planVersion?: number
  /** 幂等键（不传时默认按 `actorId:planVersion:nodeKey` 派生）；重复提交返回幂等成功不二次推进。 */
  idempotencyKey?: string
  note?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 构造稳定、可追溯的执行 ID（同一节点在同一重试次数下恒定）。 */
export function makeExecutionId(missionId: string, nodeKey: string, retries: number): string {
  return `exec_${missionId}_${nodeKey}_r${retries}`
}

export class MissionService {
  private readonly advancing = new Set<string>()
  private readonly doNow: () => Date
  private pollTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: MissionServiceDeps) {
    this.doNow = deps.now ?? (() => new Date())
  }

  start(): void {
    void this.recoverInterrupted().catch(err => this.deps.onError?.(err))
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollRunningCouncils().catch(err => this.deps.onError?.(err))
    }, 6_000)
    this.pollTimer.unref?.()
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  /**
   * 进程重启后的崩溃恢复与对账：
   * 1. 对于 `status='dispatching'`（已准备派单甚至已创建外部工单，但写回 `ticketId` 前进程退出）：
   *    先用 `executionId` 向工单库/外部状态核对；找回原工单则直接认领续跑（零重复派单），确认未创建才安全重排为 `pending`。
   * 2. 对于 `status='running'` 且已有 `ticketId` 的节点：检查工单是否已在停机期间结束，是则立即结算并推进下游！
   */
  async recoverInterrupted(): Promise<{ recovered: number; reconciledTickets: number; resumedMissions: string[] }> {
    const entries = this.deps.store.listDispatchingOrRunningNodes()
    const touchedMissions = new Set<string>()
    let recovered = 0
    let reconciledTickets = 0

    for (const { mission, node } of entries) {
      if (node.status === 'dispatching') {
        recovered += 1
        touchedMissions.add(mission.id)
        const execId = node.executionId ?? makeExecutionId(mission.id, node.key, node.retries)
        if (node.kind === 'ticket') {
          const found = this.deps.reconcileTicketByExecutionId
            ? await this.deps.reconcileTicketByExecutionId(execId)
            : undefined
          if (found) {
            reconciledTickets += 1
            if (found.ended) {
              const ok = found.outcome === 'completed' || found.outcome === 'merged'
              this.deps.store.updateNode(mission.id, node.key, {
                status: ok ? 'completed' : found.outcome === 'stopped' ? 'cancelled' : 'failed',
                ticketId: found.ticketId,
                ...(found.artifacts ? { artifacts: found.artifacts } : {}),
                ...(found.commitSha ? { commitSha: found.commitSha } : {}),
                outputSummary: found.summary || (ok ? '崩溃恢复：原工单已完工' : `崩溃恢复：原工单以 ${found.outcome} 结束`),
                error: ok ? null : (found.summary || `工单以 ${found.outcome} 结束`),
                finishedAt: this.doNow().toISOString(),
              }, this.doNow())
            } else {
              // 原工单仍在运行，直接回填 ticketId 恢复监控，不二次派单！
              this.deps.store.updateNode(mission.id, node.key, {
                status: 'running',
                ticketId: found.ticketId,
                error: null,
              }, this.doNow())
            }
            try {
              this.deps.events.add({
                kind: 'mission.recovered',
                level: 'info',
                ticketId: found.ticketId,
                text: `崩溃恢复已找回原工单 ${found.ticketId}（${execId}），避免重复派单`,
                data: { missionId: mission.id, nodeKey: node.key, executionId: execId, ended: found.ended },
              })
            } catch { /* ignore */ }
          } else {
            // 核对确认外部未落单，安全回滚到 pending 由 advance 重新派发
            this.deps.store.updateNode(mission.id, node.key, {
              status: 'pending',
              error: null,
            }, this.doNow())
          }
        } else {
          // 非 ticket 的 dispatching 节点安全退回 pending
          this.deps.store.updateNode(mission.id, node.key, { status: 'pending', error: null }, this.doNow())
        }
      } else if (node.status === 'running' && node.kind === 'ticket' && node.ticketId && this.deps.getTicketHandoff) {
        const info = await this.deps.getTicketHandoff(node.ticketId)
        if (info?.ended) {
          touchedMissions.add(mission.id)
          const ok = info.outcome === 'completed' || info.outcome === 'merged'
          this.deps.store.updateNode(mission.id, node.key, {
            status: ok ? 'completed' : info.outcome === 'stopped' ? 'cancelled' : 'failed',
            ...(info.artifacts ? { artifacts: info.artifacts } : {}),
            ...(info.commitSha ? { commitSha: info.commitSha } : {}),
            outputSummary: info.summary || (ok ? '重启补结算：工单已完成' : `工单以 ${info.outcome} 结束`),
            error: ok ? null : (info.summary || `工单以 ${info.outcome} 结束`),
            finishedAt: this.doNow().toISOString(),
          }, this.doNow())
        }
      }
    }

    // 也检查所有 running 状态但所有当前节点均已结束、还有 pending 下游待推进的计划
    for (const m of this.deps.store.list({ status: 'running', limit: 50 }).items) {
      if (m.nodes.some(n => n.status === 'pending')) touchedMissions.add(m.id)
    }

    const resumedMissions: string[] = []
    for (const mid of touchedMissions) {
      await this.advance(mid)
      resumedMissions.push(mid)
    }
    return { recovered, reconciledTickets, resumedMissions }
  }

  list(filter: { sessionId?: string; status?: MissionStatus; limit?: number } = {}): { items: MissionRecord[]; total: number } {
    return this.deps.store.list(filter)
  }

  get(id: string): MissionRecord | undefined {
    return this.deps.store.get(id)
  }

  async create(input: MissionCreateInput): Promise<MissionRecord> {
    const mission = this.deps.store.create(input, this.doNow())
    try {
      this.deps.events.add({
        kind: 'mission.created',
        level: 'info',
        text: `创建任务计划「${mission.title}」（v${mission.planVersion}，共 ${mission.nodes.length} 步，${mission.autoStart ? '自动开工' : '草稿待确认'}）`,
        data: { missionId: mission.id, planVersion: mission.planVersion, nodes: mission.nodes.length, autoStart: mission.autoStart },
      })
    } catch { /* ignore */ }
    if (mission.status === 'running') {
      await this.advance(mission.id)
      return this.deps.store.get(mission.id) ?? mission
    }
    return mission
  }

  async startMission(id: string): Promise<MissionRecord> {
    const m = this.deps.store.get(id)
    if (!m) throw new Error(`找不到任务计划 ${id}`)
    if (m.status === 'completed' || m.status === 'cancelled') throw new Error(`任务计划已结束（${m.status}），无法启动`)
    this.deps.store.setMissionStatus(id, 'running', undefined, this.doNow())
    await this.advance(id)
    return this.deps.store.get(id)!
  }

  pauseMission(id: string): MissionRecord {
    const m = this.deps.store.get(id)
    if (!m) throw new Error(`找不到任务计划 ${id}`)
    if (m.status !== 'running') throw new Error('只有运行中的计划可以暂停')
    return this.deps.store.setMissionStatus(id, 'paused', undefined, this.doNow())!
  }

  async resumeMission(id: string): Promise<MissionRecord> {
    const m = this.deps.store.get(id)
    if (!m) throw new Error(`找不到任务计划 ${id}`)
    if (m.status !== 'paused' && m.status !== 'failed') throw new Error('只有已暂停或失败的计划可以恢复')
    this.deps.store.setMissionStatus(id, 'running', undefined, this.doNow())
    await this.advance(id)
    return this.deps.store.get(id)!
  }

  cancelMission(id: string): MissionRecord {
    const m = this.deps.store.get(id)
    if (!m) throw new Error(`找不到任务计划 ${id}`)
    for (const node of m.nodes) {
      if (node.status === 'pending' || node.status === 'waiting_approval' || node.status === 'dispatching') {
        this.deps.store.updateNode(id, node.key, { status: 'cancelled', finishedAt: this.doNow().toISOString() }, this.doNow())
      }
    }
    return this.deps.store.setMissionStatus(id, 'cancelled', '已被用户取消', this.doNow())!
  }

  bumpPlanVersion(id: string, nextGoal?: string): MissionRecord {
    const updated = this.deps.store.bumpPlanVersion(id, nextGoal, this.doNow())
    if (!updated) throw new Error(`找不到任务计划 ${id}`)
    return updated
  }

  delete(id: string): boolean {
    return this.deps.store.delete(id)
  }

  /**
   * 批准处于 `waiting_approval` 的人工拍板节点：
   * - 必须绑定真实操作人 `actorId`、具体节点与计划版本 `planVersion`；
   * - 重复提交同一批准（相同幂等键或已批准节点）直接返回 `{ item, idempotent: true }`，绝不重复触发下游！
   */
  async approveNode(
    missionId: string,
    nodeKey: string,
    optsOrNote?: string | ApproveNodeOptions,
  ): Promise<{ item: MissionRecord; idempotent: boolean }> {
    const opts: ApproveNodeOptions = typeof optsOrNote === 'string'
      ? { actorId: 'console-user', note: optsOrNote }
      : (optsOrNote ?? { actorId: 'console-user' })

    const actorId = opts.actorId.trim()
    if (!actorId) throw new Error('人工审批必须绑定真实操作人身份（actorId）')

    const m = this.deps.store.get(missionId)
    if (!m) throw new Error(`找不到任务计划 ${missionId}`)
    const node = m.nodes.find(n => n.key === nodeKey)
    if (!node) throw new Error(`找不到节点 ${nodeKey}`)

    const expectedVersion = opts.planVersion ?? m.planVersion
    if (expectedVersion !== m.planVersion) {
      throw new Error(`审批版本不匹配：审批针对计划 v${expectedVersion}，但当前计划已更新至 v${m.planVersion}，请重新确认后再批准`)
    }

    const idemKey = (opts.idempotencyKey?.trim()) || `approve:${actorId}:v${expectedVersion}:${nodeKey}`

    // 若该节点已以当前版本与幂等键（或已审批完成）处理过，直接幂等返回，绝不重复触发！
    if (node.status === 'completed' && node.approvedPlanVersion === expectedVersion) {
      return { item: m, idempotent: true }
    }
    if (node.status !== 'waiting_approval') {
      throw new Error(`节点「${node.title}」当前状态（${node.status}）不是等待审批`)
    }

    const nowIso = this.doNow().toISOString()
    const rec = this.deps.store.recordApprovalIdempotent({
      missionId,
      nodeKey,
      planVersion: expectedVersion,
      idempotencyKey: idemKey,
      actorId,
      note: opts.note?.trim() ?? '',
      approvedAt: nowIso,
    })
    if (!rec.inserted) {
      return { item: this.deps.store.get(missionId)!, idempotent: true }
    }

    this.deps.store.updateNode(missionId, nodeKey, {
      status: 'completed',
      approvedBy: actorId,
      approvedPlanVersion: expectedVersion,
      approvalIdempotencyKey: idemKey,
      outputSummary: opts.note?.trim()
        ? `已由 ${actorId} 批准（计划 v${expectedVersion}）：${opts.note.trim()}`
        : `已由 ${actorId} 批准继续（计划 v${expectedVersion}）`,
      finishedAt: nowIso,
    }, this.doNow())
    try {
      this.deps.events.add({
        kind: 'mission.approved',
        level: 'info',
        text: `操作人 ${actorId} 批准了计划「${m.title}」(v${expectedVersion}) 的节点「${node.title}」`,
        data: { missionId, nodeKey, actorId, planVersion: expectedVersion, idempotencyKey: idemKey },
      })
    } catch { /* ignore */ }
    if (m.status === 'paused') this.deps.store.setMissionStatus(missionId, 'running', undefined, this.doNow())
    await this.advance(missionId)
    return { item: this.deps.store.get(missionId)!, idempotent: false }
  }

  /** 局部重试一个失败或已取消节点并恢复计划推进（生成新的重试次数 executionId）。 */
  async retryNode(missionId: string, nodeKey: string): Promise<MissionRecord> {
    const m = this.deps.store.get(missionId)
    if (!m) throw new Error(`找不到任务计划 ${missionId}`)
    const node = m.nodes.find(n => n.key === nodeKey)
    if (!node) throw new Error(`找不到节点 ${nodeKey}`)
    if (node.status !== 'failed' && node.status !== 'cancelled') throw new Error('只能重试失败或已取消的节点')
    this.deps.store.updateNode(missionId, nodeKey, {
      status: 'pending',
      error: null,
      executionId: null,
      ticketId: null,
      councilId: null,
      finishedAt: null,
      incrementRetries: true,
    }, this.doNow())
    this.deps.store.setMissionStatus(missionId, 'running', undefined, this.doNow())
    await this.advance(missionId)
    return this.deps.store.get(missionId)!
  }

  /** 跳过一个阻塞或失败节点，允许下游依赖继续推进。 */
  async skipNode(missionId: string, nodeKey: string, reason?: string): Promise<MissionRecord> {
    const m = this.deps.store.get(missionId)
    if (!m) throw new Error(`找不到任务计划 ${missionId}`)
    const node = m.nodes.find(n => n.key === nodeKey)
    if (!node) throw new Error(`找不到节点 ${nodeKey}`)
    if (node.status === 'completed' || node.status === 'running') throw new Error('已完成或运行中的节点不能跳过')
    this.deps.store.updateNode(missionId, nodeKey, {
      status: 'skipped',
      outputSummary: reason?.trim() ? `已跳过：${reason.trim()}` : '已被人工跳过',
      finishedAt: this.doNow().toISOString(),
    }, this.doNow())
    if (m.status === 'failed' || m.status === 'paused') this.deps.store.setMissionStatus(missionId, 'running', undefined, this.doNow())
    await this.advance(missionId)
    return this.deps.store.get(missionId)!
  }

  /** 工单结束回调：收集真实产物文件与提交 SHA 持久化到节点并推进下游。 */
  async onTicketEnded(
    ticketId: string,
    outcome: string,
    summary: string,
    handoff?: { artifacts?: string[]; commitSha?: string },
  ): Promise<void> {
    const hit = this.deps.store.findNodeByTicket(ticketId)
    if (!hit) return
    const { mission, node } = hit
    if (node.status !== 'running' && node.status !== 'dispatching') return

    let artifacts = handoff?.artifacts
    let commitSha = handoff?.commitSha
    if ((!artifacts || !commitSha) && this.deps.getTicketHandoff) {
      const fetched = await Promise.resolve(this.deps.getTicketHandoff(ticketId)).catch(() => undefined)
      if (!artifacts && fetched?.artifacts) artifacts = fetched.artifacts
      if (!commitSha && fetched?.commitSha) commitSha = fetched.commitSha
    }

    const ok = outcome === 'completed' || outcome === 'merged'
    const iso = this.doNow().toISOString()
    this.deps.store.updateNode(mission.id, node.key, {
      status: ok ? 'completed' : outcome === 'stopped' ? 'cancelled' : 'failed',
      ...(artifacts ? { artifacts } : {}),
      ...(commitSha ? { commitSha } : {}),
      outputSummary: summary || (ok ? '工单已完成' : `工单以 ${outcome} 结束`),
      error: ok ? null : (summary || `工单以 ${outcome} 结束`),
      finishedAt: iso,
    }, this.doNow())
    await this.advance(mission.id)
  }

  /** 会商结束回调：驱动会商节点结算并推进下游。 */
  async onCouncilEnded(councilId: string, status: string, conclusion: string): Promise<void> {
    const hit = this.deps.store.findNodeByCouncil(councilId)
    if (!hit) return
    const { mission, node } = hit
    if (node.status !== 'running') return
    const ok = status === 'done'
    this.deps.store.updateNode(mission.id, node.key, {
      status: ok ? 'completed' : 'failed',
      outputSummary: conclusion || (ok ? '会商已完成' : `会商以 ${status} 结束`),
      error: ok ? null : (conclusion || `会商以 ${status} 结束`),
      finishedAt: this.doNow().toISOString(),
    }, this.doNow())
    await this.advance(mission.id)
  }

  private async pollRunningCouncils(): Promise<void> {
    if (!this.deps.getCouncilStatus) return
    const running = this.deps.store.list({ status: 'running', limit: 30 }).items
    for (const mission of running) {
      for (const node of mission.nodes) {
        if (node.kind === 'council' && node.status === 'running' && node.councilId) {
          const st = this.deps.getCouncilStatus(node.councilId)
          if (st && (st.status === 'done' || st.status === 'failed' || st.status === 'cancelled')) {
            await this.onCouncilEnded(node.councilId, st.status, st.brief || st.conclusion || '')
          }
        }
      }
    }
  }

  /** 核心 DAG 推进器：找出所有前置已满足的 pending 节点并并发启动；检测计划整体终态。 */
  async advance(missionId: string): Promise<void> {
    if (this.advancing.has(missionId)) return
    this.advancing.add(missionId)
    try {
      for (let guard = 0; guard < 32; guard += 1) {
        const mission = this.deps.store.get(missionId)
        if (!mission || mission.status !== 'running') return

        const byKey = new Map(mission.nodes.map(n => [n.key, n]))
        const readyNodes: MissionNodeRecord[] = []

        for (const node of mission.nodes) {
          if (node.status !== 'pending') continue
          const allDepsDone = node.dependsOn.every(dk => {
            const dep = byKey.get(dk)
            return dep !== undefined && (dep.status === 'completed' || dep.status === 'skipped')
          })
          if (allDepsDone) readyNodes.push(node)
        }

        if (readyNodes.length === 0) {
          this.settleIfFinished(mission)
          return
        }

        await Promise.all(readyNodes.map(node => this.launchNode(mission, node, byKey)))

        const after = this.deps.store.get(missionId)
        if (!after || after.status !== 'running') return
        const byKeyAfter = new Map(after.nodes.map(n => [n.key, n]))
        const hasMoreReady = after.nodes.some(n =>
          n.status === 'pending' && n.dependsOn.every(dk => {
            const d = byKeyAfter.get(dk)
            return d !== undefined && (d.status === 'completed' || d.status === 'skipped')
          }),
        )
        if (!hasMoreReady) {
          this.settleIfFinished(after)
          return
        }
      }
    } finally {
      this.advancing.delete(missionId)
    }
  }

  /** 构造下游节点指令：显式传递前置节点的实际文件路径、产物引用和 Git 提交 SHA。 */
  private buildNodePrompt(
    mission: MissionRecord,
    node: MissionNodeRecord,
    byKey: Map<string, MissionNodeRecord>,
    executionId: string,
  ): string {
    const lines: string[] = [
      `[任务计划：${mission.title} (v${mission.planVersion}) · 节点 ${node.key}（${node.title}）]`,
      `[SA-EXEC-ID:${executionId}]`,
      `总目标：${mission.goal}`,
      '',
    ]
    if (node.dependsOn.length > 0) {
      lines.push('## 前置步骤实体交接（实际文件 / 产物引用 / 提交 SHA）')
      for (const dk of node.dependsOn) {
        const dep = byKey.get(dk)
        if (!dep) continue
        const ref = dep.ticketId ? `（工单 ${dep.ticketId}）` : dep.councilId ? `（会商 ${dep.councilId}）` : ''
        lines.push(`- **${dep.key} · ${dep.title}**${ref}：${dep.outputSummary || '已完成'}`)
        if (dep.commitSha) {
          lines.push(`  - 提交 SHA：\`${dep.commitSha}\``)
        }
        if (dep.artifacts.length > 0) {
          lines.push(`  - 交付产物：${dep.artifacts.map(a => `\`${a}\``).join('、')}`)
        }
      }
      lines.push('')
    }
    lines.push('## 本步骤具体任务与交付要求', node.prompt)
    return lines.join('\n')
  }

  private async launchNode(mission: MissionRecord, node: MissionNodeRecord, byKey: Map<string, MissionNodeRecord>): Promise<void> {
    const nowIso = this.doNow().toISOString()

    if (node.kind === 'approval') {
      const updated = this.deps.store.updateNode(mission.id, node.key, {
        status: 'waiting_approval',
        startedAt: nowIso,
      }, this.doNow())
      if (updated) {
        try { await this.deps.onApprovalNeeded?.(this.deps.store.get(mission.id) ?? mission, updated) } catch { /* ignore */ }
      }
      return
    }

    // 关键幂等步骤：先生成并持久化稳定 executionId 与 dispatching 状态，再调用外部派单！
    const executionId = node.executionId || makeExecutionId(mission.id, node.key, node.retries)
    this.deps.store.updateNode(mission.id, node.key, {
      status: 'dispatching',
      executionId,
      startedAt: nowIso,
      error: null,
    }, this.doNow())

    const prompt = this.buildNodePrompt(mission, node, byKey, executionId)
    const cfg = node.config

    try {
      if (node.kind === 'ticket') {
        // 派单前再对账一次，防止并发或半恢复态重复派单
        const existing = this.deps.reconcileTicketByExecutionId
          ? await this.deps.reconcileTicketByExecutionId(executionId)
          : undefined
        if (existing) {
          this.deps.store.updateNode(mission.id, node.key, {
            status: existing.ended ? ((existing.outcome === 'completed' || existing.outcome === 'merged') ? 'completed' : 'failed') : 'running',
            ticketId: existing.ticketId,
            ...(existing.artifacts ? { artifacts: existing.artifacts } : {}),
            ...(existing.commitSha ? { commitSha: existing.commitSha } : {}),
            ...(existing.ended ? { outputSummary: existing.summary || '已对账找回完成结果', finishedAt: this.doNow().toISOString() } : {}),
          }, this.doNow())
          return
        }

        const rawGoal = typeof cfg.goal === 'object' && cfg.goal !== null && !Array.isArray(cfg.goal)
          ? cfg.goal as Record<string, unknown>
          : undefined
        const goal = rawGoal ? this.deps.resolveGoalInput?.(rawGoal) : undefined
        const projectMode = cfg.projectMode === 'direct' || cfg.projectMode === 'worktree' || cfg.projectMode === 'copy'
          ? cfg.projectMode
          : undefined
        const created = await this.deps.dispatchTicket({
          text: prompt,
          executionId,
          ...(str(cfg.model) ? { model: str(cfg.model) } : {}),
          ...(str(cfg.projectId) ? { projectId: str(cfg.projectId) } : {}),
          ...(projectMode ? { projectMode } : {}),
          ...(typeof cfg.collab === 'boolean' ? { collab: cfg.collab } : {}),
          ...(goal ? { goal } : {}),
        })
        this.deps.store.updateNode(mission.id, node.key, {
          status: created.ticketId ? 'running' : 'failed',
          ticketId: created.ticketId ?? null,
          ...(created.ticketId ? {} : { error: '工单未被受理（可能因暂停接单或策略拦截）', finishedAt: this.doNow().toISOString() }),
        }, this.doNow())
        return
      }

      if (node.kind === 'council') {
        if (!this.deps.startCouncil) throw new Error('当前运行时未启用会商模块')
        const created = await this.deps.startCouncil({
          text: prompt,
          executionId,
          ...(str(cfg.projectId) ? { projectId: str(cfg.projectId) } : {}),
          ...(typeof cfg.rounds === 'number' ? { rounds: cfg.rounds } : {}),
        })
        this.deps.store.updateNode(mission.id, node.key, { status: 'running', councilId: created.id }, this.doNow())
        return
      }

      if (node.kind === 'director') {
        if (!this.deps.runDirectorNode) throw new Error('当前运行时未启用总控助手节点执行器')
        const res = await this.deps.runDirectorNode({ sessionId: mission.sessionId, executionId, prompt })
        this.deps.store.updateNode(mission.id, node.key, {
          status: 'completed',
          ...(res.artifacts ? { artifacts: res.artifacts } : {}),
          outputSummary: res.reply.slice(0, 2000) || '总控节点已完成',
          finishedAt: this.doNow().toISOString(),
        }, this.doNow())
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.deps.store.updateNode(mission.id, node.key, {
        status: 'failed',
        error: msg,
        outputSummary: `启动或执行失败：${msg.slice(0, 300)}`,
        finishedAt: this.doNow().toISOString(),
      }, this.doNow())
    }
  }

  private settleIfFinished(mission: MissionRecord): void {
    const active = mission.nodes.some(n => n.status === 'running' || n.status === 'dispatching' || n.status === 'waiting_approval')
    if (active) return

    const failed = mission.nodes.filter(n => n.status === 'failed')
    const completed = mission.nodes.filter(n => n.status === 'completed' || n.status === 'skipped')

    if (failed.length > 0) {
      const summary = `计划在 ${failed.map(n => `「${n.title}」`).join('、')} 处失败（已完成 ${completed.length}/${mission.nodes.length} 步），可修复后局部重试。`
      const settled = this.deps.store.setMissionStatus(mission.id, 'failed', summary, this.doNow())
      if (settled) {
        try {
          this.deps.events.add({ kind: 'mission.failed', level: 'warn', text: `任务计划「${mission.title}」失败`, data: { missionId: mission.id } })
        } catch { /* ignore */ }
        void Promise.resolve(this.deps.onMissionSettled?.(settled)).catch(err => this.deps.onError?.(err))
      }
      return
    }

    if (completed.length === mission.nodes.length) {
      const lines = mission.nodes.map(n => {
        const extra = [
          n.commitSha ? `commit:${n.commitSha.slice(0, 8)}` : '',
          n.artifacts.length > 0 ? `产物:${n.artifacts.join(',')}` : '',
        ].filter(Boolean).join(' · ')
        return `- ${n.title}${extra ? `（${extra}）` : ''}：${(n.outputSummary || '已完成').replace(/\s+/g, ' ').slice(0, 140)}`
      })
      const summary = `全部 ${mission.nodes.length} 个步骤已交付完成：\n${lines.join('\n')}`
      const settled = this.deps.store.setMissionStatus(mission.id, 'completed', summary, this.doNow())
      if (settled) {
        try {
          this.deps.events.add({ kind: 'mission.completed', level: 'info', text: `任务计划「${mission.title}」全部完成`, data: { missionId: mission.id } })
        } catch { /* ignore */ }
        void Promise.resolve(this.deps.onMissionSettled?.(settled)).catch(err => this.deps.onError?.(err))
      }
    }
  }
}
