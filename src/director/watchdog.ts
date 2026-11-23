/**
 * 总控助手后台盯盘看门狗（Director Watchdog）。
 *
 * 设计原则：
 * - 纯内存 / SQLite 低开销巡检（默认每 60 秒一轮），平时 **0 Token 消耗**，非常适合小主机长期运行；
 * - 仅在真正检测到「工单静默卡死」「DAG 节点待审批或失败」「长耗时任务阶段里程碑」「主机磁盘不足」时，
 *   通过 `DirectorBridge.notify()` 精准触发主动自愈、飞书一键审批卡片或简洁进度播报。
 */
import type { ActivityLog } from '../executor/activity.ts'
import type { AdminHost } from '../admin/host.ts'
import type { OptionsStore } from '../admin/options.ts'
import type { EventLog } from '../ledger/events.ts'
import type { PluginRegistry } from '../plugins/registry.ts'
import type { DirectorBridge } from './bridge.ts'

export interface DirectorWatchdogDeps {
  bridge: DirectorBridge
  host: Pick<AdminHost, 'overview' | 'listTickets'>
  options: OptionsStore
  events: EventLog
  activity?: Pick<ActivityLog, 'list'>
  plugins?: PluginRegistry
  /** 巡检周期（毫秒），默认 60_000；测试中可手动调用 `tick()` 而不依赖真实定时器。 */
  intervalMs?: number
  now?: () => Date
  onError?: (error: unknown) => void
}

interface MissionNodeBrief {
  key: string
  title: string
  status: string
  prompt?: string
  artifacts?: string[]
  error?: string
}

interface MissionBrief {
  id: string
  title: string
  status: string
  planVersion: number
  summary?: string
  nodes: MissionNodeBrief[]
}

const DEFAULT_INTERVAL_MS = 60_000
const STALL_COOLDOWN_MS = 10 * 60_000
const DISK_ALERT_COOLDOWN_MS = 6 * 60 * 60_000
const MAX_MILESTONES_PER_TICKET = 2

export class DirectorWatchdog {
  private readonly doNow: () => Date
  private readonly intervalMs: number
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private readonly stallNotifiedAt = new Map<string, number>()
  private readonly milestoneSent = new Map<string, { count: number; lastAt: number }>()
  private readonly missionApprovalSent = new Set<string>()
  private readonly missionFailedNotified = new Set<string>()
  private diskAlertUntil = 0

  constructor(private readonly deps: DirectorWatchdogDeps) {
    this.doNow = deps.now ?? (() => new Date())
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** 执行单轮低开销巡检（可被单元测试直接调用）。 */
  async tick(): Promise<void> {
    if (this.ticking) return
    const cfg = this.deps.options.get().director
    if (!cfg.enabled) return
    this.ticking = true
    try {
      const nowMs = this.doNow().getTime()
      await this.checkOpenTickets(nowMs, cfg.stallMinutes ?? 8, cfg.milestoneMinutes ?? 5)
      await this.checkMissions()
      await this.checkHostHealth(nowMs)
      this.pruneCaches(nowMs)
    } catch (error) {
      this.deps.onError?.(error)
    } finally {
      this.ticking = false
    }
  }

  private async checkOpenTickets(nowMs: number, stallMinutes: number, milestoneMinutes: number): Promise<void> {
    const open = this.deps.host.listTickets({ status: 'open', limit: 30, offset: 0 }).items
    const openIds = new Set(open.map(t => t.id))

    for (const id of [...this.stallNotifiedAt.keys()]) {
      if (!openIds.has(id)) this.stallNotifiedAt.delete(id)
    }
    for (const id of [...this.milestoneSent.keys()]) {
      if (!openIds.has(id)) this.milestoneSent.delete(id)
    }

    const stallMs = Math.max(2, stallMinutes) * 60_000
    const milestoneMs = milestoneMinutes > 0 ? milestoneMinutes * 60_000 : 0

    for (const tk of open) {
      // 等待人工回复或排队未开工的工单不算「卡死」
      if (tk.needsPerson) continue
      const stageName = tk.stage.stage === 'working' && tk.stage.action === 'queued' ? 'queued' : tk.stage.stage
      if (stageName === 'queued' || stageName === 'idle' || stageName === 'ended') continue

      const act = this.deps.activity?.list(tk.id)
      const lastStepItem = act?.items.at(-1)
      const lastActivityIso = act?.updatedAt || tk.updatedAt || tk.createdAt
      const lastActivityMs = new Date(lastActivityIso).getTime()
      const createdMs = new Date(tk.createdAt).getTime()
      if (!Number.isFinite(lastActivityMs) || !Number.isFinite(createdMs)) continue

      const idleMs = Math.max(0, nowMs - lastActivityMs)
      const elapsedMs = Math.max(0, nowMs - createdMs)
      const lastStepText = lastStepItem
        ? `${lastStepItem.tool ? `[${lastStepItem.tool}] ` : ''}${lastStepItem.summary || ''}`.trim()
        : undefined

      // 1. 静默卡死判定 -> 唤醒总控主动诊断并解决
      if (idleMs >= stallMs) {
        const lastAlert = this.stallNotifiedAt.get(tk.id) ?? 0
        if (nowMs - lastAlert >= STALL_COOLDOWN_MS) {
          this.stallNotifiedAt.set(tk.id, nowMs)
          await this.deps.bridge.notify({
            kind: 'ticket.stalled',
            ticketId: tk.id,
            title: tk.title,
            idleMinutes: Math.max(1, Math.round(idleMs / 60_000)),
            stage: stageName,
            ...(lastStepText ? { lastStep: lastStepText } : {}),
          })
        }
        continue
      }

      // 2. 健康运行中的长耗时任务里程碑播报（每单最多 2 次，防刷屏）
      if (milestoneMs > 0 && elapsedMs >= milestoneMs) {
        const rec = this.milestoneSent.get(tk.id)
        const count = rec?.count ?? 0
        const sinceLast = rec ? nowMs - rec.lastAt : elapsedMs
        if (count < MAX_MILESTONES_PER_TICKET && sinceLast >= milestoneMs) {
          this.milestoneSent.set(tk.id, { count: count + 1, lastAt: nowMs })
          await this.deps.bridge.notify({
            kind: 'milestone.progress',
            ticketId: tk.id,
            title: tk.title,
            elapsedMinutes: Math.max(1, Math.round(elapsedMs / 60_000)),
            stage: stageName,
            ...(lastStepText ? { lastStep: lastStepText } : {}),
          })
        }
      }
    }
  }

  private async checkMissions(): Promise<void> {
    if (!this.deps.plugins) return
    const res = await this.deps.plugins.dispatchDirectorQuery(
      'missions_list',
      { limit: 15 },
      { sessionId: 'watchdog', channel: 'web', userId: 'watchdog' },
    ).catch(() => undefined)
    if (!res || !res.matched) return
    const items = ((res.result as { items?: MissionBrief[] })?.items) ?? []
    for (const m of items) {
      // 1. 待人工审批节点 -> 自动发飞书一键审批卡片
      for (const n of m.nodes) {
        if (n.status !== 'waiting_approval') continue
        const key = `${m.id}:${n.key}:v${m.planVersion}`
        if (this.missionApprovalSent.has(key)) continue
        this.missionApprovalSent.add(key)
        await this.deps.bridge.notify({
          kind: 'mission.waiting_approval',
          missionId: m.id,
          missionTitle: m.title,
          nodeKey: n.key,
          nodeTitle: n.title,
          planVersion: m.planVersion,
          ...(n.prompt ? { prompt: n.prompt } : {}),
          ...(n.artifacts && n.artifacts.length > 0 ? { artifacts: n.artifacts } : {}),
        })
      }

      // 2. 失败的 DAG 计划 -> 唤醒总控主动排查并局部重试
      if (m.status === 'failed') {
        const failedNodes = m.nodes.filter(n => n.status === 'failed').map(n => ({
          key: n.key,
          title: n.title,
          ...(n.error ? { error: n.error } : {}),
        }))
        if (failedNodes.length === 0) continue
        const failKey = `${m.id}:v${m.planVersion}:${failedNodes.map(n => n.key).join(',')}`
        if (this.missionFailedNotified.has(failKey)) continue
        this.missionFailedNotified.add(failKey)
        await this.deps.bridge.notify({
          kind: 'mission.failed',
          missionId: m.id,
          missionTitle: m.title,
          failedNodes,
          summary: m.summary || `节点 ${failedNodes.map(n => n.title).join('、')} 执行失败`,
        })
      }
    }
  }

  private async checkHostHealth(nowMs: number): Promise<void> {
    if (nowMs < this.diskAlertUntil) return
    try {
      const ov = this.deps.host.overview()
      if (typeof ov.host?.diskFreeGb === 'number' && ov.host.diskFreeGb > 0 && ov.host.diskFreeGb < 2) {
        this.diskAlertUntil = nowMs + DISK_ALERT_COOLDOWN_MS
        await this.deps.bridge.notify({
          kind: 'host.alert',
          alertKey: 'disk_low',
          title: '主机磁盘剩余空间不足 2GB',
          summary: `当前主机磁盘剩余仅 ${ov.host.diskFreeGb.toFixed(2)} GB，可能影响容器启动或任务产出。你可以让我执行清理旧镜像/孤儿工作区。`,
        })
      }
    } catch { /* best effort */ }
  }

  private pruneCaches(nowMs: number): void {
    if (this.missionApprovalSent.size > 300) this.missionApprovalSent.clear()
    if (this.missionFailedNotified.size > 300) this.missionFailedNotified.clear()
    for (const [k, at] of this.stallNotifiedAt) {
      if (nowMs - at > 24 * 60 * 60_000) this.stallNotifiedAt.delete(k)
    }
  }
}
