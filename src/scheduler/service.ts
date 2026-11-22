/**
 * 主动调度引擎核心服务（SchedulerService）。
 *
 * 支持三种动作：
 * 1. `dispatch_ticket`：定时派发工单到沙箱执行（可绑定项目/模型/验收目标）。
 * 2. `director_prompt`：定时唤醒总控助手（Director）执行巡检、汇总与汇报。
 * 3. `http_watch`：零空耗 Token 轻量 HTTP 巡检（状态码/关键词/SHA-256 变更探测），仅在变更或异常时触发告警或唤醒后续动作。
 */
import { createHash } from 'node:crypto'
import type { EventLog } from '../ledger/events.ts'
import type { GoalSpec } from '../goal/service.ts'
import type {
  ScheduleCreateInput,
  ScheduleRecord,
  ScheduleRunRecord,
  SchedulerStore,
  ScheduleUpdateInput,
} from './store.ts'

export interface SchedulerServiceDeps {
  store: SchedulerStore
  events: EventLog
  isPaused: () => boolean
  dispatchTicket: (input: {
    text: string
    model?: string
    projectId?: string
    projectMode?: 'copy' | 'direct'
    collab?: boolean
    goal?: GoalSpec
  }) => Promise<{ ticketId?: string; triggerId: string }>
  runDirectorPrompt?: (input: {
    prompt: string
    channel: 'web' | 'wechat' | 'feishu'
    userId: string
    deliverToWechat: boolean
  }) => Promise<{ reply: string; sessionId: string }>
  notifyAlert?: (input: { title: string; text: string }) => Promise<void>
  fetchImpl?: typeof fetch
  now?: () => Date
  tickIntervalMs?: number
  onError?: (error: unknown) => void
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export class SchedulerService {
  private readonly running = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly doNow: () => Date
  private readonly doFetch: typeof fetch

  constructor(private readonly deps: SchedulerServiceDeps) {
    this.doNow = deps.now ?? (() => new Date())
    this.doFetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  start(): void {
    this.deps.store.recoverInterrupted(this.doNow())
    if (this.timer) return
    const interval = Math.max(1000, this.deps.tickIntervalMs ?? 10_000)
    this.timer = setInterval(() => {
      void this.tick().catch(err => this.deps.onError?.(err))
    }, interval)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  list(): ScheduleRecord[] {
    return this.deps.store.list()
  }

  get(id: string): ScheduleRecord | undefined {
    return this.deps.store.get(id)
  }

  create(input: ScheduleCreateInput): ScheduleRecord {
    this.validateActionConfig(input.actionKind, input.actionConfig)
    return this.deps.store.create(input, this.doNow())
  }

  update(id: string, patch: ScheduleUpdateInput): ScheduleRecord | undefined {
    const cur = this.deps.store.get(id)
    if (!cur) return undefined
    const kind = patch.actionKind ?? cur.actionKind
    const cfg = patch.actionConfig ?? cur.actionConfig
    this.validateActionConfig(kind, cfg)
    return this.deps.store.update(id, patch, this.doNow())
  }

  delete(id: string): boolean {
    return this.deps.store.delete(id)
  }

  listRuns(scheduleId: string, limit = 30): ScheduleRunRecord[] {
    return this.deps.store.listRuns(scheduleId, limit)
  }

  /** 扫描并执行所有已到期的调度任务（供后台定时器和单元测试直接调用）。 */
  async tick(): Promise<ScheduleRunRecord[]> {
    const due = this.deps.store.listDue(this.doNow())
    const results: ScheduleRunRecord[] = []
    for (const schedule of due) {
      if (this.running.has(schedule.id)) continue
      const run = await this.execute(schedule, false)
      if (run) results.push(run)
    }
    return results
  }

  /** 手动立即触发一次（忽略暂停标志与下次触发时间，仍受防并发重入保护）。 */
  async runNow(id: string): Promise<ScheduleRunRecord> {
    const schedule = this.deps.store.get(id)
    if (!schedule) throw new Error(`找不到定时任务 ${id}`)
    if (this.running.has(id)) throw new Error('该定时任务正在执行中，请稍后再试')
    const run = await this.execute(schedule, true)
    if (!run) throw new Error('执行失败')
    return run
  }

  private validateActionConfig(kind: ScheduleRecord['actionKind'], cfg: Record<string, unknown>): void {
    if (kind === 'dispatch_ticket') {
      if (!str(cfg.prompt)) throw new Error('派单动作（dispatch_ticket）必须填写 prompt')
    } else if (kind === 'director_prompt') {
      if (!str(cfg.prompt)) throw new Error('总控巡检动作（director_prompt）必须填写 prompt')
    } else if (kind === 'http_watch') {
      const urlText = str(cfg.url)
      if (!/^https?:\/\/\S+$/i.test(urlText)) throw new Error('HTTP 巡检动作（http_watch）必须填写合法的 http/https 地址')
    }
  }

  private async execute(schedule: ScheduleRecord, manual: boolean): Promise<ScheduleRunRecord | undefined> {
    this.running.add(schedule.id)
    const startedAt = this.doNow()
    const run = this.deps.store.startRun(schedule, startedAt)

    try {
      if (!manual && schedule.respectPause && this.deps.isPaused()) {
        return this.deps.store.finishRun(
          run.id,
          schedule.id,
          { status: 'skipped', summary: '系统处于暂停接单状态，跳过本次计划执行' },
          startedAt.getTime(),
          this.doNow(),
        )
      }

      if (schedule.actionKind === 'dispatch_ticket') {
        const cfg = schedule.actionConfig
        const prompt = str(cfg.prompt)
        const res = await this.deps.dispatchTicket({
          text: `[定时任务：${schedule.name}]\n${prompt}`,
          ...(str(cfg.model) ? { model: str(cfg.model) } : {}),
          ...(str(cfg.projectId) ? { projectId: str(cfg.projectId) } : {}),
          ...(cfg.projectMode === 'copy' || cfg.projectMode === 'direct' ? { projectMode: cfg.projectMode } : {}),
          ...(typeof cfg.collab === 'boolean' ? { collab: cfg.collab } : {}),
        })
        const summary = res.ticketId ? `已自动派发工单 ${res.ticketId}` : `已提交触发器 ${res.triggerId}`
        try {
          this.deps.events.add({
            kind: 'scheduler.ran',
            level: 'info',
            ...(res.ticketId ? { ticketId: res.ticketId } : {}),
            text: `定时任务「${schedule.name}」${summary}`,
            data: { scheduleId: schedule.id, runId: run.id, ticketId: res.ticketId },
          })
        } catch { /* ignore */ }
        return this.deps.store.finishRun(
          run.id,
          schedule.id,
          { status: 'ok', summary, ...(res.ticketId ? { ticketId: res.ticketId } : {}) },
          startedAt.getTime(),
          this.doNow(),
        )
      }

      if (schedule.actionKind === 'director_prompt') {
        if (!this.deps.runDirectorPrompt) {
          throw new Error('当前运行时未启用总控助手（Director）')
        }
        const cfg = schedule.actionConfig
        const channel = cfg.channel === 'wechat' || cfg.channel === 'feishu' || cfg.channel === 'web' ? cfg.channel : 'web'
        const userId = str(cfg.userId) || 'console'
        const deliverToWechat = cfg.deliverToWechat !== false
        const res = await this.deps.runDirectorPrompt({
          prompt: `[定时巡检：${schedule.name}]\n${str(cfg.prompt)}`,
          channel,
          userId,
          deliverToWechat,
        })
        const summary = res.reply.replace(/\s+/g, ' ').slice(0, 260) || '总控已完成本次巡检'
        try {
          this.deps.events.add({
            kind: 'scheduler.ran',
            level: 'info',
            text: `定时总控巡检「${schedule.name}」完成`,
            data: { scheduleId: schedule.id, runId: run.id, sessionId: res.sessionId },
          })
        } catch { /* ignore */ }
        return this.deps.store.finishRun(
          run.id,
          schedule.id,
          { status: 'ok', summary },
          startedAt.getTime(),
          this.doNow(),
        )
      }

      // http_watch：零空耗 Token 轻量探测，仅在状态异常或内容变更时唤醒通知/后续动作
      const outcome = await this.runHttpWatch(schedule)
      return this.deps.store.finishRun(run.id, schedule.id, outcome, startedAt.getTime(), this.doNow())
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      try {
        this.deps.events.add({
          kind: 'scheduler.failed',
          level: 'warn',
          text: `定时任务「${schedule.name}」执行失败：${msg.slice(0, 120)}`,
          data: { scheduleId: schedule.id, runId: run.id, error: msg },
        })
      } catch { /* ignore */ }
      return this.deps.store.finishRun(
        run.id,
        schedule.id,
        { status: 'error', summary: `执行失败：${msg.slice(0, 200)}`, error: msg },
        startedAt.getTime(),
        this.doNow(),
      )
    } finally {
      this.running.delete(schedule.id)
    }
  }

  private async runHttpWatch(schedule: ScheduleRecord): Promise<{
    status: 'ok' | 'changed' | 'error'
    summary: string
    ticketId?: string
    error?: string
  }> {
    const cfg = schedule.actionConfig
    const url = str(cfg.url)
    const method = cfg.method === 'HEAD' ? 'HEAD' : 'GET'
    const expectStatus = Number.isInteger(cfg.expectStatus) ? Number(cfg.expectStatus) : 200
    const timeoutMs = Math.max(2000, Math.min(60_000, Number(cfg.timeoutMs) || 15_000))
    const mustContain = str(cfg.mustContain)
    const detectChange = cfg.detectChange !== false
    const onChangePrompt = str(cfg.onChangePrompt)

    const prev = this.deps.store.getWatchState(schedule.id)
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    let statusCode = 0
    let body = ''
    let etag: string | null = null
    try {
      const resp = await this.doFetch(url, {
        method,
        signal: ctl.signal,
        headers: {
          'user-agent': 'SuperAgent-Scheduler/2.0',
          ...(prev?.lastEtag ? { 'if-none-match': prev.lastEtag } : {}),
        },
      })
      statusCode = resp.status
      etag = resp.headers.get('etag')
      if (statusCode === 304) {
        return { status: 'ok', summary: `HTTP 304 未变化（${url}）` }
      }
      if (method !== 'HEAD') {
        body = (await resp.text()).slice(0, 128 * 1024)
      }
    } finally {
      clearTimeout(timer)
    }

    const hash = createHash('sha256').update(body).digest('hex')
    const nowIso = this.doNow().toISOString()
    const statusMismatch = statusCode !== expectStatus
    const keywordMissing = Boolean(mustContain && !body.includes(mustContain))
    const contentChanged = Boolean(detectChange && prev?.lastHash && prev.lastHash !== hash)

    this.deps.store.saveWatchState({
      scheduleId: schedule.id,
      lastStatusCode: statusCode,
      lastHash: hash,
      lastEtag: etag,
      lastBodySnippet: body.replace(/\s+/g, ' ').slice(0, 400),
      updatedAt: nowIso,
    })

    const reasons: string[] = []
    if (statusMismatch) reasons.push(`状态码异常（实际 ${statusCode}，期望 ${expectStatus}）`)
    if (keywordMissing) reasons.push(`未命中关键字「${mustContain}」`)
    if (contentChanged) reasons.push(`内容指纹发生变化（${prev!.lastHash!.slice(0, 8)} → ${hash.slice(0, 8)}）`)

    if (reasons.length === 0) {
      return {
        status: 'ok',
        summary: prev ? `探测正常（HTTP ${statusCode}，无变化）` : `首次基准建立成功（HTTP ${statusCode}，指纹 ${hash.slice(0, 8)}）`,
      }
    }

    const detail = `监控目标 ${url} 触发告警：${reasons.join('；')}`
    try {
      this.deps.events.add({
        kind: 'scheduler.watch_changed',
        level: statusMismatch || keywordMissing ? 'warn' : 'info',
        text: `巡检「${schedule.name}」${reasons[0]}`,
        data: { scheduleId: schedule.id, url, statusCode, reasons },
      })
    } catch { /* ignore */ }

    let ticketId: string | undefined
    if (onChangePrompt) {
      if (cfg.onChangeMode === 'director' && this.deps.runDirectorPrompt) {
        await this.deps.runDirectorPrompt({
          prompt: `[HTTP 监控触发：${schedule.name}]\n${detail}\n\n后续处理指令：${onChangePrompt}`,
          channel: cfg.channel === 'wechat' || cfg.channel === 'feishu' ? cfg.channel : 'web',
          userId: str(cfg.userId) || 'console',
          deliverToWechat: true,
        })
      } else {
        const res = await this.deps.dispatchTicket({
          text: `[HTTP 监控触发：${schedule.name}]\n${detail}\n\n处理要求：${onChangePrompt}`,
          ...(str(cfg.projectId) ? { projectId: str(cfg.projectId) } : {}),
          ...(str(cfg.model) ? { model: str(cfg.model) } : {}),
        })
        ticketId = res.ticketId
      }
    } else if (this.deps.notifyAlert) {
      await this.deps.notifyAlert({ title: `巡检告警：${schedule.name}`, text: detail })
    }

    return {
      status: 'changed',
      summary: `${detail}${ticketId ? `（已自动开单 ${ticketId}）` : ''}`,
      ...(ticketId ? { ticketId } : {}),
    }
  }
}
