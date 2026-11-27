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
import {
  buildCouncilCompletedCard,
  buildMissionApprovalCard,
  buildNoticeCard,
  buildTicketAttentionCard,
  buildTicketCompletedCard,
  buildTicketDecisionCard,
  buildVaultRequestCard,
} from '../sources/feishu-cards.ts'
import {
  buildQqChoicePayload,
  buildQqCouncilCompletedPayload,
  buildQqMissionApprovalPayload,
  buildQqNovelEditPayload,
  buildQqTicketDecisionPayload,
  buildQqVaultRequestPayload,
  extractQqChoiceButtons,
  formatTextForQq,
  type QqKeyboard,
  type QqMarkdown,
  type QqRichMessagePayload,
} from '../sources/qq-cards.ts'

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
    kind: 'ticket.stalled'
    ticketId: string
    title: string
    idleMinutes: number
    stage: string
    lastStep?: string
  }
  | {
    kind: 'mission.waiting_approval'
    missionId: string
    missionTitle: string
    nodeKey: string
    nodeTitle: string
    planVersion: number
    prompt?: string
    artifacts?: string[]
  }
  | {
    kind: 'mission.failed'
    missionId: string
    missionTitle: string
    failedNodes: { key: string; title: string; error?: string }[]
    summary: string
  }
  | {
    kind: 'milestone.progress'
    ticketId: string
    title: string
    elapsedMinutes: number
    stage: string
    lastStep?: string
    round?: number
  }
  | {
    kind: 'host.alert'
    alertKey: string
    title: string
    summary: string
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
  | {
    kind: 'novel.edit_settled'
    editId: string
    bookId: string
    bookTitle: string
    chapter: number
    chapterTitle?: string
    status: 'done' | 'failed'
    source?: 'person' | 'director'
    note: string
    charsBefore?: number
    charsAfter?: number
    costUsd: number
    error?: string
  }

export interface DirectorBridgeDeps {
  director: DirectorService
  options: OptionsStore
  host: Pick<AdminHost, 'wechatStatus'>
  events: EventLog
  sendWechat: (input: { to?: string; title?: string; text: string }) => Promise<void>
  /** 飞书主动汇报：`to` 为用户 open_id。 */
  sendFeishu?: (input: { to: string; text: string }) => Promise<void>
  /** 飞书交互卡片主动推送（用于 DAG 审批、密钥授权与故障升级决策）。 */
  sendFeishuCard?: (input: { to: string; card: Record<string, unknown>; fallbackText?: string }) => Promise<{ messageId?: string }>
  /** 飞书默认汇报对象（通常为飞书允许名单里的 open_id）。 */
  feishuRecipients?: () => string[]
  /** QQ 官方机器人主动推送（支持原生可点击 Keyboard 按钮与纯文本自动排版降级）。 */
  sendQq?: (input: {
    to: string
    chatType?: 'c2c' | 'group'
    text: string
    keyboard?: QqKeyboard
    markdown?: QqMarkdown
  }) => Promise<void>
  /** QQ 默认汇报对象（用户 openId 或 `group:<group_openid>`）。 */
  qqRecipients?: () => string[]
  now?: () => Date
  onError?: (error: unknown) => void
}

type PushChannel = 'wechat' | 'feishu' | 'qq'
const PUSH_LABEL: Record<PushChannel, string> = { wechat: '微信', feishu: '飞书', qq: 'QQ' }

function parseQqTarget(userId: string): { to: string; chatType: 'c2c' | 'group' } {
  if (userId.startsWith('group:')) return { to: userId.slice(6), chatType: 'group' }
  return { to: userId, chatType: 'c2c' }
}

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

    // 手动停止的工单与总控巡检触发的常规修稿成功不刷屏打扰（失败仍汇报）
    if (event.kind === 'ticket.ended' && event.outcome === 'stopped') return
    if (event.kind === 'ticket.ended' && event.fromDirectWechat) return
    if (event.kind === 'novel.edit_settled' && event.source === 'director' && event.status === 'done') return

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

    // 1. 若该工单此前经历过总控主动自愈，如今成功结束，立即走「故障已解决并验证完成」闭环战报 + 避坑记忆反哺
    const healKeyForTicket = ticketId ? `ticket:${ticketId}` : undefined
    const priorHeal = healKeyForTicket ? store.getHealState(healKeyForTicket) : undefined
    const shouldReportHealResolved = event.kind === 'ticket.ended'
      && outcomeOk
      && Boolean(priorHeal && priorHeal.attempts > 0 && priorHeal.status !== 'resolved')

    // 2. 判断是否属于「需要总控主动诊断并解决」的异常事件
    const healIncident = this.toHealIncident(event)
    let autoHealAttempted = false
    let healExhaustedAttempts = 0

    for (const target of targets) {
      if (ticketId) {
        store.updateSession(target.session.id, { focusTicketId: ticketId })
      }

      // A. 自愈成功闭环汇报（仅主目标执行一次，防止多通道重复写记忆和调用模型）
      if (shouldReportHealResolved && !autoHealAttempted && healKeyForTicket && priorHeal && ticketId) {
        autoHealAttempted = true
        const handled = await this.deps.director.triggerHealResolvedReport({
          sessionId: target.session.id,
          targetKey: healKeyForTicket,
          ticketId,
          title: event.kind === 'ticket.ended' ? event.title : ticketId,
          priorReason: priorHeal.lastReason,
          priorAction: priorHeal.lastAction,
          noticeText: message,
          pushReply: target.push,
        })
        if (handled) continue
      }

      // B. 故障/卡死/阻塞主动自愈（仅主目标执行一次修复动作）
      if (healIncident && opts.director.autoHeal && !autoHealAttempted) {
        autoHealAttempted = true
        const healRes = await this.deps.director.triggerAutoHeal({
          sessionId: target.session.id,
          targetKey: healIncident.targetKey,
          incidentKind: healIncident.incidentKind,
          targetId: healIncident.targetId,
          title: healIncident.title,
          summary: healIncident.summary,
          ...(healIncident.question ? { question: healIncident.question } : {}),
          pushReply: target.push,
        })
        if (healRes.handled) continue
        if (healRes.exhausted) healExhaustedAttempts = healRes.attempts
      }

      // C. 正常完工后的显式/口头承诺自动续接
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

      // D. 常规通知或自愈超限升级：写入会话记忆并按通道能力推送（飞书优先交互按钮卡片）
      this.deps.director.recordEventInSession(target.session.id, message, {
        eventKind: event.kind,
        ...(ticketId ? { ticketId } : {}),
      })
      if (!target.push) continue
      if (target.session.channel !== 'wechat' && target.session.channel !== 'feishu' && target.session.channel !== 'qq') continue
      const channel = target.session.channel as PushChannel
      try {
        const card = channel === 'feishu' && opts.director.feishuInteractiveCards !== false
          ? this.buildInteractiveCardForEvent(event, message, healExhaustedAttempts)
          : undefined
        const qqPayload = channel === 'qq' && opts.qq?.interactiveButtons !== false
          ? this.buildQqPayloadForEvent(event, message, healExhaustedAttempts)
          : undefined
        if (card && this.deps.sendFeishuCard) {
          await this.deps.sendFeishuCard({ to: target.session.userId, card, fallbackText: message })
        } else if (qqPayload && this.deps.sendQq) {
          const qqTarget = parseQqTarget(target.session.userId)
          await this.deps.sendQq({
            to: qqTarget.to,
            chatType: qqTarget.chatType,
            ...qqPayload,
          })
        } else {
          await this.send(channel, target.session.userId, message)
        }
        try {
          this.deps.events.add({
            kind: 'director.proactive',
            level: 'info',
            ...(ticketId ? { ticketId } : {}),
            text: `总控主动向${PUSH_LABEL[channel]}汇报（${event.kind}）`,
            data: { userId: target.session.userId, kind: event.kind, channel, interactiveCard: Boolean(card || qqPayload?.keyboard) },
          })
        } catch { /* best effort */ }
      } catch (error) {
        store.addUndelivered(target.session, message)
        this.deps.onError?.(error)
      }
    }
  }

  /** 将需要总控主动诊断解决的异常事件转换为统一自愈入参。 */
  private toHealIncident(event: PlatformNoticeEvent): {
    targetKey: string
    incidentKind: 'ticket_failed' | 'ticket_attention' | 'ticket_stalled' | 'mission_failed'
    targetId: string
    title: string
    summary: string
    question?: string
  } | undefined {
    if (event.kind === 'ticket.ended' && (event.outcome === 'failed' || event.outcome === 'dropped')) {
      return {
        targetKey: `ticket:${event.ticketId}`,
        incidentKind: 'ticket_failed',
        targetId: event.ticketId,
        title: event.title,
        summary: event.summary || `工单以 ${event.outcome} 结束`,
      }
    }
    if (event.kind === 'ticket.attention' && (event.state === 'failed' || event.state === 'blocked')) {
      return {
        targetKey: `ticket:${event.ticketId}`,
        incidentKind: 'ticket_attention',
        targetId: event.ticketId,
        title: event.title,
        summary: event.summary || `工单进入 ${event.state} 状态`,
        ...(event.question ? { question: event.question } : {}),
      }
    }
    if (event.kind === 'ticket.stalled') {
      return {
        targetKey: `ticket:${event.ticketId}`,
        incidentKind: 'ticket_stalled',
        targetId: event.ticketId,
        title: event.title,
        summary: `已持续 ${event.idleMinutes} 分钟无新进展（阶段：${event.stage}${event.lastStep ? `，最后步骤：${event.lastStep}` : ''}）`,
      }
    }
    if (event.kind === 'mission.failed') {
      return {
        targetKey: `mission:${event.missionId}`,
        incidentKind: 'mission_failed',
        targetId: event.missionId,
        title: event.missionTitle,
        summary: `${event.summary}\n失败节点：${event.failedNodes.map(n => `${n.key}(${n.title}): ${n.error || '失败'}`).join('；')}`,
      }
    }
    return undefined
  }

  /** 为各类平台推送事件构造结构化飞书 JSON 2.0 卡片（交互按钮卡片 + 结构化战报/进度/告警卡片）。 */
  private buildInteractiveCardForEvent(
    event: PlatformNoticeEvent,
    fallbackBody: string,
    exhaustedAttempts: number,
  ): Record<string, unknown> | undefined {
    if (event.kind === 'mission.waiting_approval') {
      return buildMissionApprovalCard({
        missionId: event.missionId,
        missionTitle: event.missionTitle,
        nodeKey: event.nodeKey,
        nodeTitle: event.nodeTitle,
        planVersion: event.planVersion,
        ...(event.prompt ? { prompt: event.prompt } : {}),
        ...(event.artifacts ? { artifacts: event.artifacts } : {}),
      })
    }
    if (event.kind === 'vault.request' && event.requestId) {
      return buildVaultRequestCard({
        requestId: event.requestId,
        ticketId: event.ticketId,
        ticketTitle: event.ticketTitle,
        secretName: event.name,
        why: event.why,
      })
    }
    if (
      (event.kind === 'ticket.ended' && (event.outcome === 'failed' || event.outcome === 'dropped'))
      || (event.kind === 'ticket.attention' && (event.state === 'failed' || event.state === 'blocked'))
      || event.kind === 'ticket.stalled'
    ) {
      const reason = event.kind === 'ticket.stalled'
        ? `工单已停滞 ${event.idleMinutes} 分钟`
        : event.kind === 'ticket.ended' ? `执行${OUTCOME_LABEL[event.outcome] ?? event.outcome}` : '执行报错/阻塞'
      return buildTicketDecisionCard({
        ticketId: event.ticketId,
        title: event.title,
        reason,
        diagnosis: fallbackBody,
        ...(exhaustedAttempts > 0 ? { attempts: exhaustedAttempts } : {}),
      })
    }
    if (event.kind === 'ticket.ended') {
      return buildTicketCompletedCard({
        ticketId: event.ticketId,
        title: event.title,
        outcome: event.outcome,
        summary: event.summary || fallbackBody,
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        ...(event.previews ? { previews: event.previews } : {}),
      })
    }
    if (event.kind === 'ticket.attention') {
      return buildTicketAttentionCard({
        ticketId: event.ticketId,
        title: event.title,
        kind: event.state,
        question: event.question || event.summary,
      })
    }
    if (event.kind === 'council.ended') {
      const brief = event.conclusion || fallbackBody
      return buildCouncilCompletedCard({
        councilId: event.councilId,
        topic: event.topic,
        status: event.status,
        ...(brief ? { brief } : {}),
        canCommit: event.status === 'done' && !event.ticketId,
      })
    }
    if (event.kind === 'budget.blocked') {
      return buildNoticeCard({
        title: `预算上限暂停：${event.title}`,
        subtitle: `工单 ${event.ticketId}`,
        template: 'red',
        markdown: `**暂停原因**\n${event.reason}`,
        footnote: '回复「调高预算到 XX 美元并重试」即可快速恢复',
      })
    }
    if (event.kind === 'milestone.progress') {
      return buildNoticeCard({
        title: `阶段进度播报：${event.title}`,
        subtitle: `工单 ${event.ticketId}`,
        template: 'wathet',
        meta: [
          { label: '已运行', value: `${event.elapsedMinutes} 分钟` },
          { label: '当前阶段', value: event.stage },
        ],
        markdown: event.lastStep ? `**当前步骤**\n${event.lastStep}` : '任务持续推进中，完成后自动发送交付战报。',
      })
    }
    if (event.kind === 'novel.edit_settled') {
      const ok = event.status === 'done'
      const title = ok
        ? `《${event.bookTitle}》第 ${event.chapter} 章改稿完成`
        : `《${event.bookTitle}》第 ${event.chapter} 章改稿未通过`
      const lenLine = ok && event.charsBefore !== undefined && event.charsAfter !== undefined
        ? `\n**篇幅变化**：${event.charsBefore} 字 → ${event.charsAfter} 字`
        : ''
      const errLine = event.error ? `\n**失败原因**：${event.error}` : ''
      return buildNoticeCard({
        title,
        subtitle: event.chapterTitle || `第 ${event.chapter} 章`,
        template: ok ? 'green' : 'red',
        meta: [
          { label: '状态', value: ok ? '已完成（原稿已更新）' : '未通过（原稿未改动）' },
          ...(event.costUsd > 0 ? [{ label: '花费', value: `$${event.costUsd.toFixed(4)}` }] : []),
        ],
        markdown: `**修改意见**：${event.note.slice(0, 200)}${lenLine}${errLine}`,
        footnote: ok ? '如需撤销本次修改，可在小说阅读页点击「撤销上次修改」。' : '请调整修改意见后重新提交。',
      })
    }
    return undefined
  }

  /** 为 QQ 通道构造优化排版 + 可点击按钮交互消息（无按钮场景则按纯文本排版 + 智能选择按钮提取）。 */
  private buildQqPayloadForEvent(
    event: PlatformNoticeEvent,
    fallbackBody: string,
    exhaustedAttempts: number,
  ): QqRichMessagePayload {
    if (event.kind === 'mission.waiting_approval') {
      return buildQqMissionApprovalPayload({
        missionId: event.missionId,
        missionTitle: event.missionTitle,
        nodeKey: event.nodeKey,
        nodeTitle: event.nodeTitle,
        planVersion: event.planVersion,
        ...(event.prompt ? { prompt: event.prompt } : {}),
        ...(event.artifacts ? { artifacts: event.artifacts } : {}),
      })
    }
    if (event.kind === 'vault.request' && event.requestId) {
      return buildQqVaultRequestPayload({
        requestId: event.requestId,
        ticketId: event.ticketId,
        ticketTitle: event.ticketTitle,
        secretName: event.name,
        why: event.why,
      })
    }
    if (
      (event.kind === 'ticket.ended' && (event.outcome === 'failed' || event.outcome === 'dropped'))
      || (event.kind === 'ticket.attention' && (event.state === 'failed' || event.state === 'blocked'))
      || event.kind === 'ticket.stalled'
    ) {
      const reason = event.kind === 'ticket.stalled'
        ? `工单已停滞 ${event.idleMinutes} 分钟`
        : event.kind === 'ticket.ended' ? `执行${OUTCOME_LABEL[event.outcome] ?? event.outcome}` : '执行报错/阻塞'
      return buildQqTicketDecisionPayload({
        ticketId: event.ticketId,
        title: event.title,
        reason,
        diagnosis: fallbackBody,
        ...(exhaustedAttempts > 0 ? { attempts: exhaustedAttempts } : {}),
      })
    }
    if (event.kind === 'council.ended') {
      return buildQqCouncilCompletedPayload({
        councilId: event.councilId,
        topic: event.topic,
        status: event.status,
        brief: event.conclusion || fallbackBody,
        canCommit: event.status === 'done' && !event.ticketId,
      })
    }
    if (event.kind === 'novel.edit_settled') {
      return buildQqNovelEditPayload({
        bookId: event.bookId,
        bookTitle: event.bookTitle,
        n: event.chapter,
        ...(event.chapterTitle ? { chapterTitle: event.chapterTitle } : {}),
        status: event.status,
        note: event.note,
        ...(event.charsBefore !== undefined ? { charsBefore: event.charsBefore } : {}),
        ...(event.charsAfter !== undefined ? { charsAfter: event.charsAfter } : {}),
        costUsd: event.costUsd,
        ...(event.error ? { error: event.error } : {}),
      })
    }
    const choices = extractQqChoiceButtons(fallbackBody)
    if (choices.length >= 2) {
      return buildQqChoicePayload(fallbackBody, choices)
    }
    return { text: formatTextForQq(fallbackBody) }
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
    if (opts.qq?.enabled && opts.qq.routingMode === 'director' && this.deps.sendQq) out.push('qq')
    return out
  }

  private async send(channel: PushChannel, userId: string, text: string): Promise<void> {
    if (channel === 'feishu') {
      if (!this.deps.sendFeishu) throw new Error('飞书发送未配置')
      await this.deps.sendFeishu({ to: userId, text })
      return
    }
    if (channel === 'qq') {
      if (!this.deps.sendQq) throw new Error('QQ 发送未配置')
      const target = parseQqTarget(userId)
      await this.deps.sendQq({
        to: target.to,
        chatType: target.chatType,
        text: formatTextForQq(text),
      })
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

    // 控制台 web 会话派发的工单：遇到自动续接承诺、故障自愈或自愈完工汇报时，同样纳入目标（结果写入控制台会话）
    const isWebEligible = event.kind === 'ticket.ended'
      || event.kind === 'ticket.attention'
      || event.kind === 'ticket.stalled'
      || event.kind === 'milestone.progress'
    if (isWebEligible) {
      for (const link of allLinks) {
        if (link.channel !== 'web' || map.has(link.sessionId)) continue
        const session = store.getSession(link.sessionId)
        if (!session) continue
        const needForEnded = event.kind !== 'ticket.ended'
          || event.outcome === 'failed'
          || event.outcome === 'dropped'
          || Boolean(ticketId && store.getHealState(`ticket:${ticketId}`)?.attempts)
          || this.sessionHasPendingPromise(session.id)
        if (needForEnded) {
          map.set(session.id, { session, push: false })
        }
      }
    }

    // 若设为全平台汇报（all），补充各通道默认主人会话
    if (scope === 'all' && map.size === 0) {
      for (const channel of channels) {
        const users = channel === 'wechat'
          ? this.wechatRecipientUsers()
          : channel === 'feishu'
            ? this.feishuRecipientUsers()
            : this.qqRecipientUsers()
        for (const userId of users) {
          const session = store.getOrCreateSession(channel, userId)
          map.set(session.id, { session, push: true })
        }
      }
      // 即使未开启微信/飞书，若存在控制台会话，异常/审批事件仍写入并唤醒控制台总控
      if (map.size === 0) {
        const webSessions = store.listSessions('web')
        const primaryWeb = webSessions[0] ?? store.getOrCreateSession('web', 'console')
        map.set(primaryWeb.id, { session: primaryWeb, push: false })
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

  private qqRecipientUsers(): string[] {
    const out = new Set<string>()
    for (const u of this.deps.qqRecipients?.() ?? []) {
      if (u.trim()) out.add(u.trim())
    }
    for (const u of this.deps.options.get().qq?.allowedUsers ?? []) {
      if (u.trim()) out.add(u.trim())
    }
    if (out.size === 0) {
      for (const s of this.deps.director.store.listSessions('qq')) {
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

    if (event.kind === 'ticket.stalled') {
      return [
        `⏱️ 任务长时间无进展（疑似卡死）：${event.title}`,
        `编号：${event.ticketId}｜停滞 ${event.idleMinutes} 分钟｜阶段：${event.stage}`,
        ...(event.lastStep ? [`最后活动：${event.lastStep.slice(0, 200)}`] : []),
        '',
        '回复「重试」或「停掉它」，或在飞书直接点卡片按钮处理。',
      ].join('\n')
    }

    if (event.kind === 'mission.waiting_approval') {
      return [
        `🗺️ DAG 任务计划等待你的批准：${event.missionTitle}`,
        `计划编号：${event.missionId}（v${event.planVersion}）`,
        `卡点节点：${event.nodeTitle}（${event.nodeKey}）`,
        ...(event.prompt ? ['', event.prompt.slice(0, 400)] : []),
        ...(event.artifacts && event.artifacts.length > 0 ? ['', `前置产物：${event.artifacts.slice(0, 5).join('、')}`] : []),
        '',
        `回复「批准计划 ${event.missionId} 的 ${event.nodeKey} 节点」或直接点击卡片按钮继续。`,
      ].join('\n')
    }

    if (event.kind === 'mission.failed') {
      return [
        `❌ DAG 任务计划执行受阻：${event.missionTitle}`,
        `计划编号：${event.missionId}`,
        event.summary,
        ...event.failedNodes.slice(0, 4).map(n => `• ${n.key}（${n.title}）：${n.error || '失败'}`),
      ].join('\n')
    }

    if (event.kind === 'milestone.progress') {
      return [
        `⏳ 任务阶段进度播报：${event.title}`,
        `编号：${event.ticketId}｜已运行 ${event.elapsedMinutes} 分钟｜阶段：${event.stage}${event.round ? `（第 ${event.round} 轮）` : ''}`,
        ...(event.lastStep ? [`当前正在：${event.lastStep.slice(0, 180)}`] : []),
      ].join('\n')
    }

    if (event.kind === 'host.alert') {
      return [
        `⚠️ 主机健康巡检预警：${event.title}`,
        event.summary,
      ].join('\n')
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

    if (event.kind === 'council.ended') {
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

    // novel.edit_settled
    const ok = event.status === 'done'
    const lines = [
      ok
        ? `✅ 《${event.bookTitle}》第 ${event.chapter} 章${event.chapterTitle ? `「${event.chapterTitle}」` : ''}改稿完成`
        : `❌ 《${event.bookTitle}》第 ${event.chapter} 章改稿未通过（原稿未改动）`,
      `修改意见：${event.note.slice(0, 160)}`,
      ...(ok && event.charsBefore !== undefined && event.charsAfter !== undefined
        ? [`篇幅变化：${event.charsBefore} 字 → ${event.charsAfter} 字`]
        : []),
      ...(event.costUsd > 0 ? [`本次花费：$${event.costUsd.toFixed(4)}`] : []),
      ...(event.error ? [`失败原因：${event.error}`] : []),
    ]
    if (ok) lines.push('', '可在小说阅读页点击「撤销上次修改」恢复原稿。')
    return lines.join('\n')
  }

  private keyOf(event: PlatformNoticeEvent): string {
    switch (event.kind) {
      case 'ticket.ended': return `ended:${event.ticketId}:${event.outcome}`
      case 'ticket.attention': return `attn:${event.ticketId}:${event.state}:${(event.question ?? event.summary).slice(0, 80)}`
      case 'ticket.stalled': return `stalled:${event.ticketId}:${Math.floor(event.idleMinutes / 5)}`
      case 'mission.waiting_approval': return `mis_wait:${event.missionId}:${event.nodeKey}:v${event.planVersion}`
      case 'mission.failed': return `mis_fail:${event.missionId}:${event.failedNodes.map(n => n.key).join(',')}`
      case 'milestone.progress': return `milestone:${event.ticketId}:${Math.floor(event.elapsedMinutes / 5)}`
      case 'host.alert': return `host_alert:${event.alertKey}`
      case 'budget.blocked': return `budget:${event.ticketId}:${event.reason.slice(0, 60)}`
      case 'vault.request': return `vault:${event.ticketId}:${event.name}:${event.requestId ?? ''}`
      case 'council.ended': return `council:${event.councilId}:${event.status}`
      case 'novel.edit_settled': return `novel_edit:${event.editId}:${event.status}`
    }
  }

  private pruneDedupe(nowMs: number): void {
    for (const [k, exp] of this.dedupe) {
      if (exp <= nowMs) this.dedupe.delete(k)
    }
  }
}
