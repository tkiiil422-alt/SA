/**
 * 平台事件回流与微信主动汇报桥接（Director Bridge）。
 *
 * 将后台异步事件（工单完工/失败、工人阻塞提问、预算熔断、密钥申请、目标验收阻塞、会商结论、小说弧结束）
 * 统一写入总控会话记忆，并根据 `director.notifyScope` 决定是否整理并主动推送到微信。
 * 微信离线推送失败时自动暂存到 `director_undelivered`，待下次对话自动补报，不漏状态。
 */
import type { AdminHost } from '../admin/host.ts'
import type { OptionsStore } from '../admin/options.ts'
import type { EventLog } from '../ledger/events.ts'
import type { DirectorService } from './service.ts'
import type { DirectorFollowup, DirectorSession, FollowupTriggerKind } from './store.ts'

export type PlatformNoticeEvent =
  | {
    kind: 'ticket.ended'
    ticketId: string
    title: string
    outcome: string
    summary: string
    costUsd?: number
    previews?: { title: string; url: string }[]
    links?: { kind: string; url: string }[]
    /** 标记该工单原本是否来自微信直通通道，避免与 outbox 重复推送。 */
    fromDirectWechat?: boolean
  }
  | {
    kind: 'ticket.attention'
    ticketId: string
    title: string
    state: 'blocked' | 'failed' | 'waiting' | 'progress'
    summary: string
    question?: string
  }
  | {
    kind: 'budget.blocked'
    ticketId: string
    title: string
    reason: string
  }
  | {
    kind: 'vault.request'
    ticketId: string
    ticketTitle: string
    requestId?: string
    name: string
    why: string
  }
  | {
    kind: 'council.ended'
    councilId: string
    topic: string
    status: string
    conclusion?: string
    ticketId?: string
  }

export interface DirectorBridgeDeps {
  director: DirectorService
  options: OptionsStore
  host: Pick<AdminHost, 'wechatStatus'>
  events: EventLog
  sendWechat: (input: { to?: string; title?: string; text: string }) => Promise<void>
  /** 飞书主动汇报：`to` 为用户 open_id。 */
  sendFeishu?: (input: { to: string; text: string }) => Promise<void>
  /** 飞书默认汇报对象（通常为飞书允许名单里的 open_id）。 */
  feishuRecipients?: () => string[]
  now?: () => Date
  onError?: (error: unknown) => void
}

type PushChannel = 'wechat' | 'feishu'
const PUSH_LABEL: Record<PushChannel, string> = { wechat: '微信', feishu: '飞书' }

const DEDUPE_TTL_MS = 10 * 60_000
/**
 * 兜底检测：即使模型派单时忘了显式填写 `onComplete`，只要最近几条对话里主人或总控明确承诺过
 * 「完成后自动部署 / 执行下一步 / 接着做...」，工单成功结束时依然自动唤醒总控推进。
 */
const AUTO_CONTINUE_RE = /(?:(?:完成|结束|跑完|做完|改完|构建完成|通过|完毕)后.{0,16}(?:部署|发布|重启|构建|测试|验证|派单|切换|发送|推送|同步|继续|执行|推进|下一步)|下一步.{0,12}(?:部署|发布|重启|构建|测试|验证|派单|切换|发送|推送|同步|执行)|自动(?:部署|发布|重启|继续|执行|推进|切换|发邮件|同步)|我会(?:立刻|马上|自动|直接|继续|接着).{0,16}(?:部署|发布|重启|验证|执行|推进|处理|派发|切换|同步))/
const OUTCOME_LABEL: Record<string, string> = {
  completed: '已完成',
  merged: '已合并',
  failed: '失败',
  dropped: '已放弃',
  stopped: '已停止',
}

export class DirectorBridge {
  private readonly doNow: () => Date
  private readonly dedupe = new Map<string, number>()

  constructor(private readonly deps: DirectorBridgeDeps) {
    this.doNow = deps.now ?? (() => new Date())
  }

  /** 接收平台事件：先检查并触发已登记/承诺的自动续接；普通通知则写会话记忆并按策略主动推送到对应通道。 */
  async notify(event: PlatformNoticeEvent): Promise<void> {
    const opts = this.deps.options.get()
    if (!opts.director.enabled) return
    const channels = this.activeChannels()

    // 手动停止的工单不刷屏打扰
    if (event.kind === 'ticket.ended' && event.outcome === 'stopped') return
    if (event.kind === 'ticket.ended' && event.fromDirectWechat) return

    const dedupeKey = this.keyOf(event)
    const nowMs = this.doNow().getTime()
    this.pruneDedupe(nowMs)
    if (this.dedupe.has(dedupeKey)) return
    this.dedupe.set(dedupeKey, nowMs + DEDUPE_TTL_MS)

    const store = this.deps.director.store
    const isFollowupEvent = event.kind === 'ticket.ended' || event.kind === 'council.ended'
    const followupTargetId = event.kind === 'council.ended'
      ? event.councilId
      : event.kind === 'ticket.ended' ? event.ticketId : undefined
    const claimedFollowups = isFollowupEvent && followupTargetId
      ? store.claimPendingFollowups(event.kind as FollowupTriggerKind, followupTargetId)
      : []
    const followupsBySession = new Map<string, DirectorFollowup[]>()
    for (const fw of claimedFollowups) {
      const list = followupsBySession.get(fw.sessionId) ?? []
      list.push(fw)
      followupsBySession.set(fw.sessionId, list)
    }

    const targets = this.resolveTargets(event, opts.director.notifyScope, channels, followupsBySession)
    if (targets.length === 0) return

    const message = await this.formatNotice(event, opts.director.summarizeReports)
    const ticketId = 'ticketId' in event ? event.ticketId : undefined
    const linkedSessionIds = new Set(ticketId ? store.linksForTicket(ticketId).map(l => l.sessionId) : [])
    const outcomeOk = event.kind === 'council.ended'
      ? event.status === 'done'
      : event.kind === 'ticket.ended'
        ? (event.outcome === 'completed' || event.outcome === 'merged')
        : false

    for (const target of targets) {
      if (ticketId) {
        store.updateSession(target.session.id, { focusTicketId: ticketId })
      }

      // 若该会话命中显式自动续接计划，或为总控派单会话且近期对话明确承诺过「完成后继续下一步」，则直接唤醒总控执行
      const explicitFollowups = followupsBySession.get(target.session.id) ?? []
      const inferredFromChat = isFollowupEvent
        && explicitFollowups.length === 0
        && outcomeOk
        && (event.kind === 'ticket.ended' ? linkedSessionIds.has(target.session.id) : true)
        && this.sessionHasPendingPromise(target.session.id)

      if (isFollowupEvent && followupTargetId && (explicitFollowups.length > 0 || inferredFromChat)) {
        const handled = await this.deps.director.triggerAutoFollowup({
          sessionId: target.session.id,
          eventKind: event.kind as FollowupTriggerKind,
          targetId: followupTargetId,
          outcomeOk,
          noticeText: message,
          followups: explicitFollowups,
          inferredFromChat,
          pushReply: target.push,
        })
        if (handled) continue
      }

      // 普通通知或自动续接失败兜底：写入会话记忆并按策略推送静态通知
      this.deps.director.recordEventInSession(target.session.id, message, {
        eventKind: event.kind,
        ...(ticketId ? { ticketId } : {}),
      })
      if (!target.push) continue
      if (target.session.channel !== 'wechat' && target.session.channel !== 'feishu') continue
      const channel = target.session.channel as PushChannel
      try {
        await this.send(channel, target.session.userId, message)
        try {
          this.deps.events.add({
            kind: 'director.proactive',
            level: 'info',
            ...(ticketId ? { ticketId } : {}),
            text: `总控主动向${PUSH_LABEL[channel]}汇报（${event.kind}）`,
            data: { userId: target.session.userId, kind: event.kind, channel },
          })
        } catch { /* best effort */ }
      } catch (error) {
        store.addUndelivered(target.session, message)
        this.deps.onError?.(error)
      }
    }
  }

  /** 检查该会话最近 6 条活跃对话是否包含明确的「任务完成后继续执行下一步」承诺。 */
  private sessionHasPendingPromise(sessionId: string): boolean {
    const recent = this.deps.director.store.activeMessages(sessionId, 16)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
    return recent.some(m => AUTO_CONTINUE_RE.test(m.content))
  }

  /** 当前开启了「总控助手」处理方式且具备发送能力的通道。 */
  private activeChannels(): PushChannel[] {
    const opts = this.deps.options.get()
    const out: PushChannel[] = []
    if (opts.wechat.enabled && opts.wechat.routingMode === 'director') out.push('wechat')
    if (opts.feishu.enabled && opts.feishu.routingMode === 'director' && this.deps.sendFeishu) out.push('feishu')
    return out
  }

  private async send(channel: PushChannel, userId: string, text: string): Promise<void> {
    if (channel === 'feishu') {
      if (!this.deps.sendFeishu) throw new Error('飞书发送未配置')
      await this.deps.sendFeishu({ to: userId, text })
      return
    }
    await this.deps.sendWechat({ to: userId, text })
  }

  private resolveTargets(
    event: PlatformNoticeEvent,
    scope: 'all' | 'wechat_only' | 'off',
    channels: readonly PushChannel[],
    followupsBySession: ReadonlyMap<string, DirectorFollowup[]>,
  ): { session: DirectorSession; push: boolean }[] {
    const store = this.deps.director.store
    const ticketId = 'ticketId' in event ? event.ticketId : undefined
    const allLinks = ticketId ? store.linksForTicket(ticketId) : []
    const linked = allLinks.filter(l => (channels as readonly string[]).includes(l.channel))

    const map = new Map<string, { session: DirectorSession; push: boolean }>()

    for (const link of linked) {
      const session = store.getSession(link.sessionId)
      if (session) map.set(session.id, { session, push: scope !== 'off' })
    }

    // 显式登记了自动续接的会话（含 web 控制台会话）必须纳入触发目标
    for (const sessionId of followupsBySession.keys()) {
      if (map.has(sessionId)) continue
      const session = store.getSession(sessionId)
      if (session) {
        const canPush = (channels as readonly string[]).includes(session.channel) && scope !== 'off'
        map.set(session.id, { session, push: canPush })
      }
    }

    // 控制台 web 会话派发的工单若在近期对话有自动续接承诺，也要纳入目标（不走 IM 推送，结果写入控制台会话）
    if (event.kind === 'ticket.ended') {
      for (const link of allLinks) {
        if (link.channel !== 'web' || map.has(link.sessionId)) continue
        const session = store.getSession(link.sessionId)
        if (session && this.sessionHasPendingPromise(session.id)) {
          map.set(session.id, { session, push: false })
        }
      }
    }

    // 若设为全平台汇报（all），补充各通道默认主人会话
    if (scope === 'all' && map.size === 0) {
      for (const channel of channels) {
        const users = channel === 'wechat' ? this.wechatRecipientUsers() : this.feishuRecipientUsers()
        for (const userId of users) {
          const session = store.getOrCreateSession(channel, userId)
          map.set(session.id, { session, push: true })
        }
      }
    }

    // 即使 scope === 'off'，若有已存在会话也写入记忆（不推送）以便用户主动询问时知情
    if (scope === 'off' && map.size === 0) {
      for (const channel of channels) {
        for (const session of store.listSessions(channel)) {
          map.set(session.id, { session, push: false })
        }
      }
    }

    return [...map.values()]
  }

  private feishuRecipientUsers(): string[] {
    const out = new Set<string>()
    for (const u of this.deps.feishuRecipients?.() ?? []) {
      if (u.trim()) out.add(u.trim())
    }
    if (out.size === 0) {
      for (const s of this.deps.director.store.listSessions('feishu')) {
        if (s.userId) out.add(s.userId)
      }
    }
    return [...out].slice(0, 5)
  }

  private wechatRecipientUsers(): string[] {
    const wc = this.deps.options.get().wechat
    const out = new Set<string>()
    for (const u of wc.allowedUsers) {
      if (u.trim()) out.add(u.trim())
    }
    const bound = this.deps.host.wechatStatus?.().ilink?.userId?.trim()
    if (bound) out.add(bound)
    if (out.size === 0) {
      for (const s of this.deps.director.store.listSessions('wechat')) {
        if (s.userId) out.add(s.userId)
      }
    }
    return [...out].slice(0, 5)
  }

  private async formatNotice(event: PlatformNoticeEvent, summarizeReports: boolean): Promise<string> {
    if (event.kind === 'ticket.ended') {
      const label = OUTCOME_LABEL[event.outcome] ?? event.outcome
      const icon = event.outcome === 'completed' || event.outcome === 'merged' ? '✅' : '❌'
      let body = event.summary.trim() || '（无详细摘要）'
      if (summarizeReports && body.length > 420) {
        const polished = await this.deps.director.summarizeForWechat(
          '你是 SuperAgent 总控助手，请把下面的工单完工报告提炼成 3~5 条适合手机端快速阅读的中文要点（总字数不超过 260 字，不用 Markdown 表格，保留关键结论、产出文件名和遗留问题）。',
          `任务：${event.title}\n状态：${label}\n报告原文：\n${body.slice(0, 4000)}`,
          `director-report-${event.ticketId}`,
        ).catch(() => undefined)
        if (polished) body = polished
        else body = `${body.slice(0, 700)}…`
      }
      const lines = [
        `${icon} 任务${label}：${event.title}`,
        `编号：${event.ticketId}${event.costUsd !== undefined && event.costUsd > 0 ? `｜花费 $${event.costUsd.toFixed(4)}` : ''}`,
        '',
        body,
      ]
      if (event.previews && event.previews.length > 0) {
        lines.push('', ...event.previews.slice(0, 3).map(p => `🔗 预览「${p.title}」：${p.url}`))
      }
      if (event.links && event.links.length > 0) {
        lines.push('', ...event.links.slice(0, 3).map(l => `🔗 ${l.kind.toUpperCase()}：${l.url}`))
      }
      lines.push('', '如需查看交付文件详情或继续追加修改，直接回复我即可。')
      return lines.join('\n')
    }

    if (event.kind === 'ticket.attention') {
      const icon = event.state === 'failed' ? '❌' : '🙋'
      const stageText = event.state === 'failed' ? '执行失败' : '暂停等你确认'
      const lines = [
        `${icon} 任务${stageText}：${event.title}`,
        `编号：${event.ticketId}`,
      ]
      if (event.question) lines.push('', `❓ 问题：${event.question}`)
      if (event.summary) lines.push('', `进展摘要：${event.summary.slice(0, 500)}`)
      lines.push('', '直接回复你的决定，我会转达给该任务继续推进（或让我停掉/重试）。')
      return lines.join('\n')
    }

    if (event.kind === 'budget.blocked') {
      return [
        `💸 任务因预算上限暂停：${event.title}`,
        `编号：${event.ticketId}`,
        `原因：${event.reason}`,
        '',
        '回复我「调高预算到 XX 美元并重试」即可由我引导处理。',
      ].join('\n')
    }

    if (event.kind === 'vault.request') {
      return [
        `🔑 任务申请使用密钥`,
        `工单：${event.ticketTitle}（${event.ticketId}）`,
        `密钥名：${event.name}`,
        `申请理由：${event.why || '未说明'}`,
        '',
        '回复「批准这个密钥申请」或「拒绝」，我会在二次确认后为你处理。',
      ].join('\n')
    }

    // council.ended
    const ok = event.status === 'done'
    return [
      `${ok ? '🏛️' : '⚠️'} 多角色会商${ok ? '已完成' : `已结束（${event.status}）`}`,
      `会商编号：${event.councilId}`,
      `议题：${event.topic.slice(0, 100)}`,
      ...(event.conclusion ? ['', event.conclusion.slice(0, 700)] : []),
      ...(event.ticketId ? ['', `已关联/派发工单：${event.ticketId}`] : ['', '如需按会商结论正式派单，直接回复我「按结论开工」。']),
    ].join('\n')
  }

  private keyOf(event: PlatformNoticeEvent): string {
    switch (event.kind) {
      case 'ticket.ended': return `ended:${event.ticketId}:${event.outcome}`
      case 'ticket.attention': return `attn:${event.ticketId}:${event.state}:${(event.question ?? event.summary).slice(0, 80)}`
      case 'budget.blocked': return `budget:${event.ticketId}:${event.reason.slice(0, 60)}`
      case 'vault.request': return `vault:${event.ticketId}:${event.name}:${event.requestId ?? ''}`
      case 'council.ended': return `council:${event.councilId}:${event.status}`
    }
  }

  private pruneDedupe(nowMs: number): void {
    for (const [k, exp] of this.dedupe) {
      if (exp <= nowMs) this.dedupe.delete(k)
    }
  }
}
