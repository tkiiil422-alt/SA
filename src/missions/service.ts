/**
 * DAG 任务计划编排与自动推进引擎（MissionService）。
 *
 * 核心能力：
 * 1. 自动识别无依赖或前置全部完成的节点，并发派发给沙箱工单 / 多角色会商 / 总控运维；
 * 2. 将前置节点的产出摘要与工单编号自动注入下游节点指令，形成连贯的上下文链；
 * 3. 支持人工审批卡点（`approval`）、暂停/恢复、单节点失败重试/跳过；
 * 4. 当全部节点收尾时自动生成总交付总结并通知总控会话与用户。
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

export interface MissionServiceDeps {
  store: MissionStore
  events: EventLog
  dispatchTicket: (input: {
    text: string
    model?: string
    projectId?: string
    projectMode?: ProjectWorkspaceMode
    collab?: boolean
    goal?: GoalSpec
  }) => Promise<{ ticketId?: string; triggerId: string }>
  startCouncil?: (input: {
    text: string
    projectId?: string
    rounds?: number
  }) => Promise<{ id: string }>
  getCouncilStatus?: (councilId: string) => { status: string; brief?: string; conclusion?: string } | undefined
  runDirectorNode?: (input: {
    sessionId?: string | null
    prompt: string
  }) => Promise<{ reply: string }>
  onMissionSettled?: (mission: MissionRecord) => Promise<void> | void
  onApprovalNeeded?: (mission: MissionRecord, node: MissionNodeRecord) => Promise<void> | void
  resolveGoalInput?: (raw: Record<string, unknown>) => GoalSpec | undefined
  now?: () => Date
  onError?: (error: unknown) => void
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export class MissionService {
  private readonly advancing = new Set<string>()
  private readonly doNow: () => Date
  private pollTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: MissionServiceDeps) {
    this.doNow = deps.now ?? (() => new Date())
  }

  start(): void {
    if (this.pollTimer) return
    // 每 6 秒兜底巡检正在等待会商完成的运行中计划节点
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
        text: `创建任务计划「${mission.title}」（共 ${mission.nodes.length} 步，${mission.autoStart ? '自动开工' : '草稿待确认'}）`,
        data: { missionId: mission.id, nodes: mission.nodes.length, autoStart: mission.autoStart },
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
      if (node.status === 'pending' || node.status === 'waiting_approval') {
        this.deps.store.updateNode(id, node.key, { status: 'cancelled', finishedAt: this.doNow().toISOString() }, this.doNow())
      }
    }
    return this.deps.store.setMissionStatus(id, 'cancelled', '已被用户取消', this.doNow())!
  }

  delete(id: string): boolean {
    return this.deps.store.delete(id)
  }

  /** 批准处于 `waiting_approval` 的人工拍板节点并自动推进后续节点。 */
  async approveNode(missionId: string, nodeKey: string, note?: string): Promise<MissionRecord> {
    const m = this.deps.store.get(missionId)
    if (!m) throw new Error(`找不到任务计划 ${missionId}`)
    const node = m.nodes.find(n => n.key === nodeKey)
    if (!node) throw new Error(`找不到节点 ${nodeKey}`)
    if (node.status !== 'waiting_approval') throw new Error(`节点「${node.title}」当前状态不是等待审批`)
    this.deps.store.updateNode(missionId, nodeKey, {
      status: 'completed',
      outputSummary: note?.trim() ? `人工已批准：${note.trim()}` : '人工已批准继续',
      finishedAt: this.doNow().toISOString(),
    }, this.doNow())
    if (m.status === 'paused') this.deps.store.setMissionStatus(missionId, 'running', undefined, this.doNow())
    await this.advance(missionId)
    return this.deps.store.get(missionId)!
  }

  /** 局部重试一个失败节点并恢复计划推进。 */
  async retryNode(missionId: string, nodeKey: string): Promise<MissionRecord> {
    const m = this.deps.store.get(missionId)
    if (!m) throw new Error(`找不到任务计划 ${missionId}`)
    const node = m.nodes.find(n => n.key === nodeKey)
    if (!node) throw new Error(`找不到节点 ${nodeKey}`)
    if (node.status !== 'failed' && node.status !== 'cancelled') throw new Error('只能重试失败或已取消的节点')
    this.deps.store.updateNode(missionId, nodeKey, {
      status: 'pending',
      error: null,
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

  /** 工单结束回调：驱动所属 DAG 节点结算并推进下游。 */
  async onTicketEnded(ticketId: string, outcome: string, summary: string): Promise<void> {
    const hit = this.deps.store.findNodeByTicket(ticketId)
    if (!hit) return
    const { mission, node } = hit
    if (node.status !== 'running') return
    const ok = outcome === 'completed' || outcome === 'merged'
    const iso = this.doNow().toISOString()
    this.deps.store.updateNode(mission.id, node.key, {
      status: ok ? 'completed' : outcome === 'stopped' ? 'cancelled' : 'failed',
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
      // 循环推进，直到没有可立即同步结算的节点（例如 director 节点同步完成立刻解锁下游）
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

        // 并发拉起所有本轮就绪节点
        await Promise.all(readyNodes.map(node => this.launchNode(mission, node, byKey)))

        // 检查是否还有同步执行完导致下游新就绪的节点
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

  private buildNodePrompt(mission: MissionRecord, node: MissionNodeRecord, byKey: Map<string, MissionNodeRecord>): string {
    const lines: string[] = [
      `[任务计划：${mission.title} · 节点 ${node.key}（${node.title}）]`,
      `总目标：${mission.goal}`,
      '',
    ]
    if (node.dependsOn.length > 0) {
      lines.push('## 前置步骤已完成产出（供本步骤直接衔接）')
      for (const dk of node.dependsOn) {
        const dep = byKey.get(dk)
        if (!dep) continue
        const ref = dep.ticketId ? `（工单 ${dep.ticketId}）` : dep.councilId ? `（会商 ${dep.councilId}）` : ''
        lines.push(`- **${dep.key} · ${dep.title}**${ref}：${dep.outputSummary || '已完成'}`)
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

    this.deps.store.updateNode(mission.id, node.key, { status: 'running', startedAt: nowIso, error: null }, this.doNow())
    const prompt = this.buildNodePrompt(mission, node, byKey)
    const cfg = node.config

    try {
      if (node.kind === 'ticket') {
        const rawGoal = typeof cfg.goal === 'object' && cfg.goal !== null && !Array.isArray(cfg.goal)
          ? cfg.goal as Record<string, unknown>
          : undefined
        const goal = rawGoal ? this.deps.resolveGoalInput?.(rawGoal) : undefined
        const projectMode = cfg.projectMode === 'direct' || cfg.projectMode === 'worktree' || cfg.projectMode === 'copy'
          ? cfg.projectMode
          : undefined
        const created = await this.deps.dispatchTicket({
          text: prompt,
          ...(str(cfg.model) ? { model: str(cfg.model) } : {}),
          ...(str(cfg.projectId) ? { projectId: str(cfg.projectId) } : {}),
          ...(projectMode ? { projectMode } : {}),
          ...(typeof cfg.collab === 'boolean' ? { collab: cfg.collab } : {}),
          ...(goal ? { goal } : {}),
        })
        this.deps.store.updateNode(mission.id, node.key, {
          ticketId: created.ticketId ?? null,
          ...(created.ticketId ? {} : { status: 'failed', error: '工单未被受理（可能因暂停接单或策略拦截）', finishedAt: this.doNow().toISOString() }),
        }, this.doNow())
        return
      }

      if (node.kind === 'council') {
        if (!this.deps.startCouncil) throw new Error('当前运行时未启用会商模块')
        const created = await this.deps.startCouncil({
          text: prompt,
          ...(str(cfg.projectId) ? { projectId: str(cfg.projectId) } : {}),
          ...(typeof cfg.rounds === 'number' ? { rounds: cfg.rounds } : {}),
        })
        this.deps.store.updateNode(mission.id, node.key, { councilId: created.id }, this.doNow())
        return
      }

      if (node.kind === 'director') {
        if (!this.deps.runDirectorNode) throw new Error('当前运行时未启用总控助手节点执行器')
        const res = await this.deps.runDirectorNode({ sessionId: mission.sessionId, prompt })
        this.deps.store.updateNode(mission.id, node.key, {
          status: 'completed',
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
    const active = mission.nodes.some(n => n.status === 'running' || n.status === 'waiting_approval')
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
      const lines = mission.nodes.map(n => `- ${n.title}：${(n.outputSummary || '已完成').replace(/\s+/g, ' ').slice(0, 140)}`)
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
