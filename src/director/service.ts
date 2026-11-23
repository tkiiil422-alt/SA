/**
 * 总控助手（Director）核心服务：
 * - 多轮对话与原生 Tool Calling 主循环
 * - 微信端短窗防抖聚合、按用户串行队列、typing 心跳保活
 * - 零成本快捷口令（/状态、/新对话、/确认、/取消、/直通）
 * - 高危操作代码级二次确认执行器
 * - 自动滑动窗口 + 异步滚动摘要压缩
 */
import type { AdminHost } from '../admin/host.ts'
import { findModel, formatRef, type DirectorOptions, type ModelRef, type OptionsStore } from '../admin/options.ts'
import { callModel, type ModelTarget } from '../assessor/model-call.ts'
import { costOf } from '../gateway/pricing.ts'
import type { Usage } from '../gateway/usage.ts'
import type { EventLog } from '../ledger/events.ts'
import type { Ledger } from '../ledger/ledger.ts'
import { callToolModel, type AgentMessage, type ToolCall } from './llm.ts'
import { buildDirectorSystemPrompt } from './prompt.ts'
import { redactPendingAction, redactToolCallArgs } from './settings-patch.ts'
import { DirectorStore, type DirectorChannel, type DirectorFollowup, type DirectorMessage, type DirectorSession, type FollowupTriggerKind, type PendingAction, type SessionListItem } from './store.ts'
import { DirectorToolExecutor, type DirectorToolsDeps } from './tools.ts'
import type { DirectorProgressEvent } from '../shared/api-types.ts'
import {
  buildPendingActionCard,
  buildSettledCard,
  type FeishuCardActionEvent,
  type FeishuCardCallbackResponse,
} from '../sources/feishu-cards.ts'

export interface DirectorServiceDeps extends Omit<DirectorToolsDeps, 'store' | 'onAudit'> {
  store: DirectorStore
  sendWechat?: (input: { to?: string; title?: string; text: string }) => Promise<void>
  sendWechatTyping?: (to?: string, status?: 1 | 2) => Promise<void>
  /** 飞书私聊发送：`to` 为用户 open_id；`replyTo` 为要回复的原消息 ID（对话回复时使用）。 */
  sendFeishu?: (input: { to: string; text: string; replyTo?: string }) => Promise<void>
  /** 飞书交互式按钮卡片发送（支持确认/拒绝/审批/重试一键点击）。 */
  sendFeishuCard?: (input: {
    to: string
    replyTo?: string
    card: Record<string, unknown>
    fallbackText?: string
  }) => Promise<{ messageId?: string }>
  /** 飞书交互卡片原位更新（异步执行完成后将「处理中」更新为最终结果）。 */
  updateFeishuCard?: (messageId: string, card: Record<string, unknown>) => Promise<void>
  /** 飞书卡片按钮点击鉴权：检查点击人是否在飞书允许操作员白名单中。 */
  feishuAllowCheck?: (openId: string) => boolean
  /** 审批密钥申请（供飞书卡片按钮直接调用）。 */
  decideSecretRequest?: (requestId: string, decision: 'approve' | 'reject') => Promise<{ ok: boolean; message: string }>
  /** 批准 DAG 人工审批节点（供飞书卡片按钮直接调用）。 */
  approveMissionNode?: (missionId: string, nodeKey: string, opts: {
    actorId: string
    planVersion: number
    idempotencyKey: string
    note?: string
  }) => Promise<{ ok: boolean; message: string }>
  /** 取消 DAG 计划（供飞书卡片按钮直接调用）。 */
  cancelMission?: (missionId: string) => Promise<{ ok: boolean; message: string }>
  /** 当用户在微信使用 `/直通 <内容>` 时，回调走原有直接建单链路（可选）。 */
  directWechatFallback?: (input: { from: string; chatId: string; messageId: string; text: string }) => void
  callTool?: typeof callToolModel
  callPlain?: typeof callModel
  now?: () => Date
  onError?: (error: unknown) => void
}

export interface DirectorChatInput {
  channel: DirectorChannel
  userId: string
  text: string
  /** 仅用于 `/直通` 时的微信上下文透传。 */
  wechatMeta?: { chatId: string; messageId: string }
  /** 从控制台向微信/飞书会话发消息时，是否同步把总控回复推送到该通道。 */
  deliverToWechat?: boolean
  /** 内部使用：由任务/会商完成、故障自愈或闭环汇报事件自动唤醒总控。 */
  autoTrigger?: { eventKind: FollowupTriggerKind | 'auto_heal' | 'heal_resolved' | 'turn_resume'; targetId: string; followupIds?: string[]; resumeDepth?: number }
  /** 实时流式思考与工具调用进度回调（供 SSE `/api/director/chat/stream` 消费）。 */
  onProgress?: (ev: DirectorProgressEvent) => void
  /** 客户端断开或点击停止时触发中止。 */
  signal?: AbortSignal
}

export interface DirectorToolAudit {
  name: string
  args: Record<string, unknown>
  ok: boolean
  ms: number
  summary: string
  pendingActionId?: string
}

export interface DirectorChatResult {
  sessionId: string
  reply: string
  toolsUsed: DirectorToolAudit[]
  pendingActions: PendingAction[]
  model?: string
  shortcut?: string
  modelFailed?: boolean
  /** 本轮因超时或模型故障中断，已自动排队续跑。 */
  resumeScheduled?: boolean
  wechatDelivered?: boolean
  wechatError?: string
}

export interface DirectorSessionDetail {
  session: DirectorSession
  messages: DirectorMessage[]
  pendingActions: PendingAction[]
  followups: DirectorFollowup[]
}

export interface DirectorStatus {
  enabled: boolean
  model: string
  notifyScope: DirectorOptions['notifyScope']
  confirmHighRisk: boolean
  sessions: number
  pendingActions: number
  pendingFollowups: number
  todayUsd: number
  dailyUsd: number
}

const MAX_TOOL_OUTPUT_IN_HISTORY = 2400
const ACTIVE_WINDOW_MESSAGES = 36
const COMPACT_TRIGGER_MESSAGES = 44
const COMPACT_KEEP_TAIL = 16
const TURN_TIMEOUT_MS = 240_000
/** 单次用户请求因超时/模型故障中断后最多自动续跑次数。 */
const MAX_TURN_RESUMES = 3
const STEP_TIMEOUT_MS = 60_000
const TYPING_PULSE_MS = 8_000

const CONFIRM_RE = /^\/?(?:确认|同意|批准|ok|yes)(?:\s+#?([A-Za-z0-9]{4}))?$/i
const CANCEL_RE = /^\/?(?:取消|拒绝|放弃|cancel|no)(?:\s+#?([A-Za-z0-9]{4}))?$/i
const STATUS_RE = /^\/(?:状态|status)$/i
const PLANS_RE = /^\/(?:计划|dag|missions?)$/i
const HELP_RE = /^\/(?:帮助|help|\?)$/i
const RESET_RE = /^\/(?:新对话|重置|清空|reset|new)$/i
const DIRECT_RE = /^\/(?:直通|直接派单|task)\s+([\s\S]+)$/i

const READ_ONLY_HOST_ACTIONS = new Set([
  'host_inspect', 'host_logs', 'host_files', 'host_read_file',
  'podman_ps', 'podman_images', 'podman_logs', 'service_status',
])

function isReadOnlyToolCall(tc: ToolCall): boolean {
  if (tc.name === 'platform_query') return true
  if (tc.name === 'host_ops') {
    const act = typeof tc.arguments.action === 'string' ? tc.arguments.action.trim() : ''
    return READ_ONLY_HOST_ACTIONS.has(act)
  }
  return false
}

function safeSummary(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

/**
 * 将数据库中的活跃消息整理成合法、可缓存的 AgentMessage 列表：
 * - `event` 消息转成带标签的 `user` 提示；
 * - 确保第一条必须是 `user`，绝不以孤立的 `tool` 或 `assistant` 开头；
 * - 确保每条带 `toolCalls` 的 `assistant` 后都有配对的 `tool` 结果，否则丢弃不完整片段避免上游 400。
 */
export function buildConversationWindow(messages: readonly DirectorMessage[], maxItems = ACTIVE_WINDOW_MESSAGES): AgentMessage[] {
  const tail = messages.length > maxItems ? messages.slice(-maxItems) : [...messages]
  // 跳过开头的非 user/event 消息，确保首条不是悬空的 tool 或 assistant
  let start = 0
  while (start < tail.length && tail[start]!.role !== 'user' && tail[start]!.role !== 'event') {
    start += 1
  }
  const sliced = tail.slice(start)
  const out: AgentMessage[] = []

  for (let i = 0; i < sliced.length; i += 1) {
    const msg = sliced[i]!
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content })
    } else if (msg.role === 'event') {
      out.push({ role: 'user', content: `[平台后台事件通知]\n${msg.content}` })
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // 收集紧随其后的匹配 tool 结果
        const expected = new Set(msg.toolCalls.map(tc => tc.id))
        const results: AgentMessage[] = []
        let j = i + 1
        while (j < sliced.length && sliced[j]!.role === 'tool') {
          const t = sliced[j]!
          if (t.toolCallId && expected.has(t.toolCallId)) {
            results.push({
              role: 'tool',
              toolCallId: t.toolCallId,
              name: t.toolName || 'tool',
              content: t.content.length > MAX_TOOL_OUTPUT_IN_HISTORY
                ? `${t.content.slice(0, MAX_TOOL_OUTPUT_IN_HISTORY)}…（历史工具输出已省略）`
                : t.content,
            })
            expected.delete(t.toolCallId)
          }
          j += 1
        }
        if (expected.size === 0) {
          out.push({ role: 'assistant', content: msg.content, toolCalls: msg.toolCalls })
          out.push(...results)
        } else if (msg.content.trim()) {
          out.push({ role: 'assistant', content: msg.content })
        }
        i = j - 1
      } else {
        out.push({ role: 'assistant', content: msg.content })
      }
    }
    // 悬空的 tool 消息自然跳过
  }
  return out
}

interface PendingInboundBatch {
  channel: InboundChannel
  userId: string
  chatId: string
  lastMessageId: string
  texts: string[]
  timer?: ReturnType<typeof setTimeout>
}

/** 可以收发对话的即时通讯通道。 */
type InboundChannel = 'wechat' | 'feishu'
const CHANNEL_LABEL: Record<InboundChannel, string> = { wechat: '微信', feishu: '飞书' }

export class DirectorService {
  readonly store: DirectorStore
  readonly tools: DirectorToolExecutor
  private readonly doCallTool: typeof callToolModel
  private readonly doCallPlain: typeof callModel
  private readonly doNow: () => Date
  private readonly debounceMap = new Map<string, PendingInboundBatch>()
  private readonly userQueues = new Map<string, Promise<void>>()
  private readonly compacting = new Set<string>()
  private readonly cardActionLocks = new Set<string>()
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(private readonly deps: DirectorServiceDeps) {
    this.store = deps.store
    this.doCallTool = deps.callTool ?? callToolModel
    this.doCallPlain = deps.callPlain ?? callModel
    this.doNow = deps.now ?? (() => new Date())
    this.tools = new DirectorToolExecutor({
      ...deps,
      store: deps.store,
      onAudit: event => this.logEvent(event.kind, event.level, event.text, event.data),
    })
  }

  close(): void {
    this.closed = true
    for (const batch of this.debounceMap.values()) {
      if (batch.timer) clearTimeout(batch.timer)
    }
    this.debounceMap.clear()
    for (const t of this.resumeTimers.values()) clearTimeout(t)
    this.resumeTimers.clear()
  }

  /**
   * 微信入站入口：支持短窗防抖聚合 + 按用户严格串行排队 + 思考期 typing 心跳。
   * 返回 Promise 以便测试或调用方等待整批完成（正常线上可 fire-and-forget）。
   */
  handleWechatInbound(input: { from: string; chatId: string; messageId: string; text: string }): void {
    this.handleInbound('wechat', input)
  }

  /** 飞书私聊入站入口：与微信共用防抖聚合与串行队列，回复以卡片形式回到原消息下。 */
  handleFeishuInbound(input: { from: string; chatId: string; messageId: string; text: string }): void {
    this.handleInbound('feishu', input)
  }

  private handleInbound(channel: InboundChannel, input: { from: string; chatId: string; messageId: string; text: string }): void {
    if (this.closed) return
    const text = input.text.trim()
    if (!text) return
    const cfg = this.deps.options.get().director
    const key = `${channel}:${input.from}`

    // 快捷口令不等待防抖，立刻响应
    const immediate = STATUS_RE.test(text) || PLANS_RE.test(text) || HELP_RE.test(text) || RESET_RE.test(text) || DIRECT_RE.test(text)
      || CONFIRM_RE.test(text) || CANCEL_RE.test(text) || cfg.debounceMs <= 0

    if (immediate) {
      const existing = this.debounceMap.get(key)
      if (existing) {
        if (existing.timer) clearTimeout(existing.timer)
        this.debounceMap.delete(key)
        this.enqueueTurn(channel, input.from, input.chatId, input.messageId, [...existing.texts, text].join('\n'))
      } else {
        this.enqueueTurn(channel, input.from, input.chatId, input.messageId, text)
      }
      return
    }

    let batch = this.debounceMap.get(key)
    if (!batch) {
      batch = { channel, userId: input.from, chatId: input.chatId, lastMessageId: input.messageId, texts: [] }
      this.debounceMap.set(key, batch)
    }
    batch.texts.push(text)
    batch.chatId = input.chatId
    batch.lastMessageId = input.messageId
    if (batch.timer) clearTimeout(batch.timer)
    batch.timer = setTimeout(() => {
      const ready = this.debounceMap.get(key)
      this.debounceMap.delete(key)
      if (!ready || this.closed) return
      this.enqueueTurn(ready.channel, ready.userId, ready.chatId, ready.lastMessageId, ready.texts.join('\n'))
    }, cfg.debounceMs)
    batch.timer.unref?.()
  }

  /** 等待所有排队中的微信轮次处理完毕（主要用于单元测试）。 */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.userQueues.values()])
  }

  /** 该通道是否配置了发送能力。 */
  private canDeliver(channel: string): channel is InboundChannel {
    return (channel === 'wechat' && Boolean(this.deps.sendWechat)) || (channel === 'feishu' && Boolean(this.deps.sendFeishu))
  }

  /** 把一段文字（或在飞书端对新产生的高危待确认操作升级为可点击按钮卡片）发到指定通道的用户。 */
  private async deliverTo(
    channel: InboundChannel,
    userId: string,
    text: string,
    replyTo?: string,
    newPendingActions: readonly PendingAction[] = [],
  ): Promise<void> {
    if (channel === 'wechat') {
      if (!this.deps.sendWechat) throw new Error('微信发送未配置')
      await this.deps.sendWechat({ to: userId, text })
      return
    }
    const cfg = this.deps.options.get().director
    if (cfg.feishuInteractiveCards !== false && this.deps.sendFeishuCard && newPendingActions.length > 0) {
      const first = newPendingActions[0]!
      await this.deps.sendFeishuCard({
        to: userId,
        ...(replyTo ? { replyTo } : {}),
        card: buildPendingActionCard({
          actionId: first.id,
          toolName: first.toolName,
          summary: first.summary,
          expiresAt: first.expiresAt,
          replyBody: text,
        }),
        fallbackText: text,
      })
      for (const extra of newPendingActions.slice(1, 4)) {
        await this.deps.sendFeishuCard({
          to: userId,
          card: buildPendingActionCard({
            actionId: extra.id,
            toolName: extra.toolName,
            summary: extra.summary,
            expiresAt: extra.expiresAt,
          }),
          fallbackText: `待确认高危操作 #${extra.id}（${extra.toolName}）：${extra.summary}。回复「/确认 ${extra.id}」执行。`,
        })
      }
      return
    }
    if (!this.deps.sendFeishu) throw new Error('飞书发送未配置')
    await this.deps.sendFeishu({ to: userId, text, ...(replyTo ? { replyTo } : {}) })
  }

  /** 从本轮工具审计中提取新生成的待确认高危操作列表，用于在飞书附带一键点击确认卡片。 */
  private createdActionsOf(res: DirectorChatResult): PendingAction[] {
    const ids = new Set(res.toolsUsed.map(t => t.pendingActionId).filter((v): v is string => Boolean(v)))
    if (ids.size === 0) return []
    return res.pendingActions.filter(a => ids.has(a.id) && a.status === 'pending')
  }

  private enqueueTurn(channel: InboundChannel, userId: string, chatId: string, messageId: string, combinedText: string): void {
    const queueKey = `${channel}:${userId}`
    const prev = this.userQueues.get(queueKey) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(async () => {
      if (this.closed) return
      const typing = channel === 'wechat' ? this.deps.sendWechatTyping : undefined
      let pulse: ReturnType<typeof setInterval> | undefined
      if (typing) {
        void typing(userId).catch(() => undefined)
        pulse = setInterval(() => {
          void typing(userId).catch(() => undefined)
        }, TYPING_PULSE_MS)
        pulse.unref?.()
      }
      const label = CHANNEL_LABEL[channel]
      try {
        const res = await this.chat({
          channel,
          userId,
          text: combinedText,
          ...(channel === 'wechat' ? { wechatMeta: { chatId, messageId } } : {}),
        })
        if (res.reply && this.canDeliver(channel)) {
          try {
            await this.deliverTo(channel, userId, res.reply, channel === 'feishu' ? messageId : undefined, this.createdActionsOf(res))
          } catch (sendErr) {
            const msg = this.deps.redact(sendErr instanceof Error ? sendErr.message : String(sendErr))
            this.logEvent(`director.${channel}_send_failed`, 'warn', `总控回复${label}发送失败：${msg.slice(0, 80)}`, { userId, sessionId: res.sessionId })
            const sess = this.store.getSession(res.sessionId)
            if (sess) this.store.addUndelivered(sess, res.reply)
            this.deps.onError?.(sendErr)
          }
        }
      } catch (error) {
        this.deps.onError?.(error)
        const errMsg = this.deps.redact(error instanceof Error ? error.message : String(error))
        if (this.canDeliver(channel)) {
          await this.deliverTo(channel, userId, `总控助手处理消息时遇到异常：${errMsg.slice(0, 200)}`, channel === 'feishu' ? messageId : undefined)
            .catch(() => undefined)
        }
      } finally {
        if (pulse) clearInterval(pulse)
        if (typing) {
          void typing(userId, 2).catch(() => undefined)
        }
      }
    })
    this.userQueues.set(queueKey, next)
    void next.finally(() => {
      if (this.userQueues.get(queueKey) === next) this.userQueues.delete(queueKey)
    })
  }

  /** 同步执行一轮总控对话（微信、飞书、Web 后台与单测共用）。 */
  async chat(input: DirectorChatInput): Promise<DirectorChatResult> {
    const text = input.text.trim()
    const session = this.store.getOrCreateSession(input.channel, input.userId)
    const cfg = this.deps.options.get().director

    // 用户发来新消息时取消该会话尚未执行的自动续跑，避免与新指令冲突
    if (!input.autoTrigger) {
      const pendingResume = this.resumeTimers.get(session.id)
      if (pendingResume) { clearTimeout(pendingResume); this.resumeTimers.delete(session.id) }
    }

    // 拉取此前推送失败的离线积压通知，附在回复顶部确保不漏重要动态
    const missed = this.store.takeUndelivered(session.id)
    const missedPrefix = missed.length > 0
      ? `【离线期间补报 ${missed.length} 条】\n${missed.map(m => `• ${m.text}`).join('\n')}\n\n---\n\n`
      : ''

    const finish = async (rawRes: DirectorChatResult): Promise<DirectorChatResult> => {
      const res: DirectorChatResult = {
        ...rawRes,
        pendingActions: rawRes.pendingActions.map(redactPendingAction),
      }
      if (input.deliverToWechat === true && res.reply && this.canDeliver(input.channel)) {
        const channel = input.channel
        try {
          await this.deliverTo(channel, input.userId, res.reply, undefined, this.createdActionsOf(res))
          return { ...res, wechatDelivered: true }
        } catch (err) {
          const msg = this.deps.redact(err instanceof Error ? err.message : String(err))
          this.logEvent(`director.${channel}_send_failed`, 'warn', `总控同步推送${CHANNEL_LABEL[channel]}失败：${msg.slice(0, 80)}`, { userId: input.userId, sessionId: res.sessionId })
          return { ...res, wechatDelivered: false, wechatError: msg }
        }
      }
      return res
    }

    if (!text) {
      return finish({
        sessionId: session.id,
        reply: `${missedPrefix}收到空消息，请问需要查询平台状态还是派发任务？`,
        toolsUsed: [],
        pendingActions: this.store.listPendingActions(session.id, true),
      })
    }

    // 1. 零成本快捷口令处理（系统自动续接唤醒跳过快捷口令解析）
    if (!input.autoTrigger && STATUS_RE.test(text)) {
      const reply = `${missedPrefix}${this.formatQuickStatus(session.id)}`
      this.store.addMessage({ sessionId: session.id, role: 'user', content: text })
      this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply, meta: { shortcut: 'status' } })
      return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'status' })
    }

    if (!input.autoTrigger && PLANS_RE.test(text)) {
      const reply = `${missedPrefix}${await this.formatQuickPlans()}`
      this.store.addMessage({ sessionId: session.id, role: 'user', content: text })
      this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply, meta: { shortcut: 'plans' } })
      return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'plans' })
    }

    if (!input.autoTrigger && HELP_RE.test(text)) {
      const reply = `${missedPrefix}${this.formatQuickHelp()}`
      this.store.addMessage({ sessionId: session.id, role: 'user', content: text })
      this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply, meta: { shortcut: 'help' } })
      return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'help' })
    }

    if (!input.autoTrigger && RESET_RE.test(text)) {
      this.store.resetSession(session.id, true)
      const reply = `${missedPrefix}已清空当前短期对话上下文，我们可以重新开始。历史记录仍保留在控制台审计中。`
      this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply, meta: { shortcut: 'reset' } })
      return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'reset' })
    }

    const directMatch = !input.autoTrigger ? DIRECT_RE.exec(text) : null
    if (directMatch) {
      const taskText = directMatch[1]!.trim()
      this.store.addMessage({ sessionId: session.id, role: 'user', content: text, meta: { shortcut: 'direct' } })
      if (input.channel === 'wechat' && input.wechatMeta && this.deps.directWechatFallback) {
        this.deps.directWechatFallback({
          from: input.userId,
          chatId: input.wechatMeta.chatId,
          messageId: input.wechatMeta.messageId,
          text: taskText,
        })
        const reply = `${missedPrefix}已按直通模式提交任务，进入平台受理队列。`
        this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply, meta: { shortcut: 'direct' } })
        return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'direct' })
      }
      const created = await this.deps.host.createTicket(taskText)
      if (created.ticketId) this.store.linkTicket(created.ticketId, session)
      const reply = `${missedPrefix}${created.ticketId ? `已直接创建并派发工单 ${created.ticketId}。` : '已提交直通任务。'}`
      this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply, meta: { shortcut: 'direct', ticketId: created.ticketId } })
      return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'direct' })
    }

    // 2. 高危操作二次确认快捷处理（仅当该会话存在待确认动作且非自动唤醒时命中）
    const confirmMatch = !input.autoTrigger ? CONFIRM_RE.exec(text) : null
    if (confirmMatch) {
      const code = confirmMatch[1]?.toUpperCase()
      const target = code ? this.store.getPendingAction(code) : this.store.latestPendingAction(session.id)
      if (target && target.sessionId === session.id && target.status === 'pending') {
        this.store.addMessage({ sessionId: session.id, role: 'user', content: text })
        const decided = await this.decidePendingAction(target.id, 'approve')
        const reply = `${missedPrefix}${decided.message}`
        this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply, meta: { shortcut: 'confirm', actionId: target.id } })
        return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'confirm' })
      }
      if (code) {
        const reply = `${missedPrefix}未找到可确认的待办操作 #${code}（可能已执行、已取消或已过期）。`
        return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'confirm' })
      }
    }

    const cancelMatch = !input.autoTrigger ? CANCEL_RE.exec(text) : null
    if (cancelMatch) {
      const code = cancelMatch[1]?.toUpperCase()
      const target = code ? this.store.getPendingAction(code) : this.store.latestPendingAction(session.id)
      if (target && target.sessionId === session.id && target.status === 'pending') {
        this.store.addMessage({ sessionId: session.id, role: 'user', content: text })
        const decided = await this.decidePendingAction(target.id, 'reject')
        const reply = `${missedPrefix}${decided.message}`
        this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply, meta: { shortcut: 'cancel', actionId: target.id } })
        return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true), shortcut: 'cancel' })
      }
    }

    // 3. 预算闸门检查
    const budgetCheck = this.checkBudget()
    if (!budgetCheck.ok) {
      const reply = `${missedPrefix}${budgetCheck.reason}（仍可使用 /状态 查看实时面板，或到后台调高预算上限）。`
      this.store.addMessage({ sessionId: session.id, role: 'user', content: text })
      this.store.addMessage({ sessionId: session.id, role: 'assistant', content: reply })
      return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true) })
    }

    // 4. 解析模型配置
    const resolved = this.resolveModel()
    if (!resolved) {
      const reply = `${missedPrefix}总控助手当前没有可用的模型，请先在后台「设置 → 模型 / 总控助手」启用至少一个模型服务商。`
      return finish({ sessionId: session.id, reply, toolsUsed: [], pendingActions: this.store.listPendingActions(session.id, true) })
    }

    // 5. 写入本轮触发消息并组装历史上下文
    if (input.autoTrigger) {
      this.store.addMessage({
        sessionId: session.id,
        role: 'event',
        content: text,
        meta: {
          autoTrigger: true,
          eventKind: input.autoTrigger.eventKind,
          targetId: input.autoTrigger.targetId,
          ...(input.autoTrigger.followupIds?.length ? { followupIds: input.autoTrigger.followupIds } : {}),
        },
      })
      this.logEvent('director.followup_triggered', 'info', `总控自动唤醒续接（${input.autoTrigger.targetId}）`, {
        sessionId: session.id,
        channel: input.channel,
        eventKind: input.autoTrigger.eventKind,
        targetId: input.autoTrigger.targetId,
      })
    } else {
      this.store.addMessage({ sessionId: session.id, role: 'user', content: text })
      this.logEvent('director.message', 'info', `总控收到消息（${input.channel}）`, { sessionId: session.id, channel: input.channel })
    }

    const active = this.store.activeMessages(session.id, ACTIVE_WINDOW_MESSAGES + 12)
    const conversation = buildConversationWindow(active, ACTIVE_WINDOW_MESSAGES)
    const pendingBefore = this.store.listPendingActions(session.id, true)
    const pendingFollowups = this.store.listFollowups(session.id, true)
    const freshSession = this.store.getSession(session.id) ?? session
    const pluginSections = this.deps.plugins?.collectDirectorPromptSections({
      channel: input.channel,
      userId: input.userId,
      userMessage: text,
      focusTicketId: freshSession.focusTicketId,
    })
    const liveSnapshot = await this.buildLiveSnapshot()
    const systemPrompt = buildDirectorSystemPrompt({
      nowIso: this.doNow().toISOString(),
      channel: input.channel,
      session: freshSession,
      pendingActions: pendingBefore,
      pendingFollowups,
      extraPrompt: cfg.extraPrompt,
      ...(liveSnapshot ? { liveSnapshot } : {}),
      ...(pluginSections && pluginSections.length > 0 ? { pluginSections } : {}),
    })

    const toolsUsed: DirectorToolAudit[] = []
    const maxRetries = Math.max(0, Math.min(20, cfg.maxRetries ?? 5))
    // 重试次数调高时，按每次额外重试增加 12 秒单步预算（上限 4 分钟），避免高重试配置被旧固定超时提前截断
    const stepTimeoutMs = Math.min(240_000, STEP_TIMEOUT_MS + Math.max(0, maxRetries - 3) * 12_000)
    const turnTimeoutMs = Math.max(TURN_TIMEOUT_MS, stepTimeoutMs + 150_000)
    let deadline = Date.now() + turnTimeoutMs
    const maxSteps = Math.max(1, Math.min(15, cfg.maxToolSteps))
    const sessionKey = `director-${input.channel}-${input.userId}`
    let activeModel = resolved
    let fallbackUsed = false
    let finalReply = ''
    let modelFailed = false
    /** 本轮提前中断原因：超时 / 模型失败，用于决定是否自动续跑。 */
    let interruptedBy: 'deadline' | 'model_failed' | undefined
    let lastModelError = ''
    let toolsUnsupportedHit = false

    for (let step = 0; step <= maxSteps; step += 1) {
      if (input.signal?.aborted) {
        finalReply = '已按你的操作中止本轮推理。'
        break
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs < 3_000) {
        interruptedBy = 'deadline'
        finalReply = '本次排查调用耗时较长已达上限，以上已获取部分信息。'
        break
      }

      const allowTools = step < maxSteps
      if (step === 0) {
        input.onProgress?.({ type: 'start', sessionId: session.id, model: activeModel.ref })
      }
      input.onProgress?.({
        type: 'thinking',
        step: step + 1,
        message: step === 0 ? '正在结合实时态势、项目背景与长期偏好理解需求…' : `第 ${step + 1} 轮综合工具结果继续研判…`,
      })
      let result = await this.doCallTool(activeModel.target, {
        model: activeModel.model,
        system: systemPrompt,
        messages: conversation,
        tools: allowTools ? this.tools.definitions() : [],
        maxTokens: Math.min(4096, activeModel.maxTokens),
      }, {
        timeoutMs: Math.min(stepTimeoutMs, remainingMs),
        sessionId: sessionKey,
        stream: true,
        cacheTtl: '5m',
        maxRetries,
      })

      this.recordUsage(activeModel.provider, activeModel.model, result.status ?? 0, result.usage, result.latencyMs)

      // 故障自动备选模型降级：主模型上游报错/超时且非工具不兼容时，自动切换另一已启用模型重试本步
      if (!result.ok && !result.toolsUnsupported && !fallbackUsed && !input.signal?.aborted) {
        const alt = this.resolveFallbackModel(activeModel.ref)
        if (alt) {
          fallbackUsed = true
          const prevRef = activeModel.ref
          activeModel = alt
          this.logEvent('director.model_fallback', 'warn', `总控主模型 ${prevRef} 调用异常，自动切换备选模型 ${alt.ref}`, {
            sessionId: session.id,
            from: prevRef,
            to: alt.ref,
            error: (result.error ?? '').slice(0, 120),
          })
          input.onProgress?.({
            type: 'thinking',
            step: step + 1,
            message: `主模型 ${prevRef} 响应异常，已自动切换至备选模型 ${alt.ref} 继续处理…`,
          })
          // 备选模型拥有独立的完整重试额度与单步时间预算（不再被主模型重试耗尽的时间挤占，也不再硬限 2 次）
          deadline = Math.max(deadline, Date.now() + stepTimeoutMs + 30_000)
          result = await this.doCallTool(activeModel.target, {
            model: activeModel.model,
            system: systemPrompt,
            messages: conversation,
            tools: allowTools ? this.tools.definitions() : [],
            maxTokens: Math.min(4096, activeModel.maxTokens),
          }, {
            timeoutMs: stepTimeoutMs,
            sessionId: `${sessionKey}-fb`,
            stream: true,
            cacheTtl: '5m',
            maxRetries,
          })
          this.recordUsage(activeModel.provider, activeModel.model, result.status ?? 0, result.usage, result.latencyMs)
        }
      }

      if (!result.ok) {
        modelFailed = true
        lastModelError = result.error ?? ''
        toolsUnsupportedHit = Boolean(result.toolsUnsupported)
        this.logEvent('director.model_failed', 'warn', `总控模型调用失败（${activeModel.ref}）：${(result.error ?? '未知错误').slice(0, 120)}`, {
          sessionId: session.id,
          model: activeModel.ref,
          step: step + 1,
          status: result.status ?? 0,
          latencyMs: result.latencyMs,
        })
        if (result.toolsUnsupported) {
          finalReply = `当前总控模型（${activeModel.ref}）的上游接口不支持原生工具调用（Function Calling）。请在后台「设置 → 总控助手」切换一个支持工具调用的模型（如 Claude、Gemini 或 DeepSeek 官方/兼容接口）。`
        } else {
          interruptedBy = 'model_failed'
          finalReply = `调用总控模型（${activeModel.ref}）失败：${result.error ?? '未知错误'}。`
        }
        break
      }

      // 若模型未发起工具调用，结束循环并输出最终回复
      if (result.toolCalls.length === 0) {
        finalReply = result.text.trim()
        if (!finalReply) finalReply = '已完成检查，但模型未返回文字说明，请补充告诉我你最关注哪部分。'
        break
      }

      // 执行模型请求的工具调用，并持久化脱敏后的中间轨迹用于审计与连续记忆
      const assistantCalls: ToolCall[] = result.toolCalls
      const sanitizedCalls: ToolCall[] = assistantCalls.map(tc => ({
        ...tc,
        arguments: redactToolCallArgs(tc.name, tc.arguments),
      }))
      this.store.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: result.text.trim(),
        toolCalls: sanitizedCalls,
        meta: { model: activeModel.ref, step: step + 1 },
      })
      conversation.push({ role: 'assistant', content: result.text.trim(), toolCalls: sanitizedCalls })

      // 多个纯只读工具调用并发加速执行；包含任何写/派单/高危动作则严格串行执行保证顺序与一致性
      const allReadOnly = assistantCalls.length > 1 && assistantCalls.every(isReadOnlyToolCall)
      const execOne = async (idx: number) => {
        const tc = assistantCalls[idx]!
        const safeArgs = sanitizedCalls[idx]!.arguments
        const actName = typeof safeArgs.action === 'string' ? safeArgs.action : undefined
        input.onProgress?.({
          type: 'tool_start',
          step: step + 1,
          name: tc.name,
          ...(actName ? { action: actName } : {}),
          summary: `执行 ${tc.name}${actName ? `(${actName})` : ''}`,
        })
        const t0 = Date.now()
        const runRes = await this.tools.run(tc.name, tc.arguments, {
          session: this.store.getSession(session.id) ?? session,
          confirmHighRisk: cfg.confirmHighRisk,
        })
        const ms = Date.now() - t0
        const sum = safeSummary(runRes.output, 160)
        input.onProgress?.({
          type: 'tool_done',
          step: step + 1,
          name: tc.name,
          ...(actName ? { action: actName } : {}),
          ok: runRes.ok,
          ms,
          summary: sum,
          ...(runRes.pendingActionId ? { pendingActionId: runRes.pendingActionId } : {}),
        })
        return { tc, safeArgs, runRes, ms, sum }
      }

      const outcomes = allReadOnly
        ? await Promise.all(assistantCalls.map((_, idx) => execOne(idx)))
        : await (async () => {
            const list: Awaited<ReturnType<typeof execOne>>[] = []
            for (let i = 0; i < assistantCalls.length; i += 1) {
              list.push(await execOne(i))
            }
            return list
          })()

      for (const { tc, safeArgs, runRes, ms, sum } of outcomes) {
        toolsUsed.push({
          name: tc.name,
          args: safeArgs,
          ok: runRes.ok,
          ms,
          summary: sum,
          ...(runRes.pendingActionId ? { pendingActionId: runRes.pendingActionId } : {}),
        })
        this.store.addMessage({
          sessionId: session.id,
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          content: runRes.output,
          meta: { ok: runRes.ok, ms, ...(runRes.pendingActionId ? { pendingActionId: runRes.pendingActionId } : {}) },
        })
        conversation.push({
          role: 'tool',
          toolCallId: tc.id,
          name: tc.name,
          content: runRes.output,
          isError: !runRes.ok,
        })
      }
    }

    // 本轮因超时或模型上游故障中断时，自动排队续跑（用户无需重发），避免「派发的任务没有后续」
    const resumeDepth = input.autoTrigger?.resumeDepth ?? 0
    const resumable = interruptedBy !== undefined
      && !toolsUnsupportedHit
      && !input.signal?.aborted
      && cfg.enabled
      && !this.closed
      && (!input.autoTrigger || input.autoTrigger.eventKind === 'turn_resume')
    let resumeScheduled = false
    if (resumable && interruptedBy) {
      if (resumeDepth < MAX_TURN_RESUMES) {
        const nextDepth = resumeDepth + 1
        const delayMs = interruptedBy === 'model_failed' ? Math.min(120_000, 30_000 * nextDepth) : 2_000
        this.scheduleTurnResume({
          sessionId: session.id,
          reason: interruptedBy,
          depth: nextDepth,
          delayMs,
          errorText: lastModelError,
          doneTools: toolsUsed.map(t => `${t.name}${typeof t.args.action === 'string' ? `(${t.args.action})` : ''}:${t.ok ? 'ok' : 'err'}`),
        })
        resumeScheduled = true
        finalReply += interruptedBy === 'model_failed'
          ? `已安排 ${Math.round(delayMs / 1000)} 秒后自动重试（第 ${nextDepth}/${MAX_TURN_RESUMES} 次），无需你重发，成功后会直接汇报。`
          : `我已自动在后台续跑剩余步骤（第 ${nextDepth}/${MAX_TURN_RESUMES} 次），完成后会直接向你汇报，无需重发。`
      } else {
        finalReply += interruptedBy === 'model_failed'
          ? `已自动重试 ${MAX_TURN_RESUMES} 轮仍未恢复。你可以稍后重试，或发 /状态 查看实时面板。`
          : '已多轮自动续跑仍未收敛，请告诉我优先要完成的那一项，我会聚焦推进。'
      }
    }

    const safeReply = `${missedPrefix}${this.deps.redact(finalReply)}`
    this.store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: safeReply,
      meta: {
        model: activeModel.ref,
        toolsCount: toolsUsed.length,
        tools: toolsUsed.map(t => ({ name: t.name, ok: t.ok, ms: t.ms })),
      },
    })

    // 异步检查是否需要滚动压缩早期上下文
    this.maybeCompactAsync(session.id)

    return finish({
      sessionId: session.id,
      reply: safeReply,
      toolsUsed,
      pendingActions: this.store.listPendingActions(session.id, true),
      model: activeModel.ref,
      ...(modelFailed ? { modelFailed: true } : {}),
      ...(resumeScheduled ? { resumeScheduled: true } : {}),
    })
  }

  /** 排队一次延迟续跑：同一会话仅保留最新一个待执行续跑，用户发新消息时自动取消。 */
  private scheduleTurnResume(input: {
    sessionId: string
    reason: 'deadline' | 'model_failed'
    depth: number
    delayMs: number
    errorText: string
    doneTools: string[]
  }): void {
    const prev = this.resumeTimers.get(input.sessionId)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      this.resumeTimers.delete(input.sessionId)
      void this.runTurnResume(input)
    }, input.delayMs)
    timer.unref?.()
    this.resumeTimers.set(input.sessionId, timer)
    this.logEvent('director.turn_resume_scheduled', 'info', `总控本轮中断（${input.reason === 'deadline' ? '耗时上限' : '模型故障'}），${Math.round(input.delayMs / 1000)} 秒后自动续跑（第 ${input.depth} 次）`, {
      sessionId: input.sessionId,
      reason: input.reason,
      depth: input.depth,
    })
  }

  private async runTurnResume(input: {
    sessionId: string
    reason: 'deadline' | 'model_failed'
    depth: number
    errorText: string
    doneTools: string[]
  }): Promise<void> {
    if (this.closed) return
    const session = this.store.getSession(input.sessionId)
    if (!session) return
    const text = [
      `[系统自动续跑 · 第 ${input.depth}/${MAX_TURN_RESUMES} 次] 上一轮处理因${input.reason === 'deadline' ? '单轮耗时达到上限' : `模型上游连接故障（${input.errorText.slice(0, 80) || '连接中断'}）`}被中断。`,
      '请回看上方对话中主人最近的原始需求和已有的工具结果，继续完成尚未做完的部分。',
      '注意：已经成功执行的步骤（尤其是已派发的工单、已创建的计划）不要重复执行，先用只读查询确认现状再往下推进。',
      `上一轮已执行的工具：${input.doneTools.length > 0 ? input.doneTools.slice(-10).join('、') : '（无）'}`,
      '做完后用简短中文汇报：完成了什么、工单/计划编号与交付物位置、是否需要主人拍板。',
    ].join('\n')
    const queueKey = `${session.channel}:${session.userId}`
    const prev = this.userQueues.get(queueKey) ?? Promise.resolve()
    const task = prev.catch(() => undefined).then(async () => {
      if (this.closed) return
      try {
        const res = await this.chat({
          channel: session.channel,
          userId: session.userId,
          text,
          autoTrigger: { eventKind: 'turn_resume', targetId: session.id, resumeDepth: input.depth },
        })
        // 仍会继续自动重试且尚无任何成果时保持静默，避免刷屏；有结果或已彻底放弃则推送给主人
        if (res.resumeScheduled && res.modelFailed) return
        if (res.reply && this.canDeliver(session.channel)) {
          await this.deliverTo(session.channel, session.userId, res.reply, undefined, this.createdActionsOf(res)).catch(err => {
            this.store.addUndelivered(session, res.reply)
            this.deps.onError?.(err)
          })
        }
      } catch (error) {
        this.deps.onError?.(error)
      }
    })
    this.userQueues.set(queueKey, task)
    void task.finally(() => {
      if (this.userQueues.get(queueKey) === task) this.userQueues.delete(queueKey)
    })
    await task
  }

  /** 批准或拒绝一条待确认的高危操作（供微信口令与后台按钮共用）。 */
  async decidePendingAction(actionId: string, decision: 'approve' | 'reject'): Promise<{ ok: boolean; action?: PendingAction; message: string }> {
    const action = this.store.getPendingAction(actionId)
    if (!action) return { ok: false, message: `找不到待确认操作 #${actionId}。` }
    const safeAction = redactPendingAction(action)
    if (action.status !== 'pending') {
      const label = action.status === 'expired' ? '已过期' : action.status === 'approved' ? '已批准执行过' : '已取消'
      return { ok: false, action: safeAction, message: `操作 #${action.id} ${label}，无需重复操作。` }
    }
    const session = this.store.getSession(action.sessionId)
    if (!session) return { ok: false, action: safeAction, message: '所属会话不存在。' }

    if (decision === 'reject') {
      this.store.setActionStatus(action.id, 'rejected', '用户已取消', safeAction.args)
      this.logEvent('director.confirm_rejected', 'info', `已取消高危操作 #${action.id}`, { actionId: action.id, toolName: action.toolName })
      const updated = this.store.getPendingAction(action.id)
      return { ok: true, ...(updated ? { action: redactPendingAction(updated) } : {}), message: `已取消操作 #${action.id}（${action.summary}）。` }
    }

    const executed = await this.tools.run(action.toolName, action.args, {
      session,
      confirmHighRisk: false,
      bypassConfirm: true,
    })
    this.store.setActionStatus(action.id, 'approved', executed.output.slice(0, 1000), safeAction.args)
    this.logEvent('director.confirm_approved', 'info', `已批准并执行高危操作 #${action.id}`, {
      actionId: action.id,
      toolName: action.toolName,
      ok: executed.ok,
    })
    const updated = this.store.getPendingAction(action.id)
    const redactedUpdated = updated ? redactPendingAction(updated) : undefined
    if (!executed.ok) {
      return { ok: false, ...(redactedUpdated ? { action: redactedUpdated } : {}), message: `已确认执行 #${action.id}，但执行失败：${safeSummary(executed.output, 220)}` }
    }
    return { ok: true, ...(redactedUpdated ? { action: redactedUpdated } : {}), message: `✅ 已执行 #${action.id}：${action.summary}` }
  }

  /** 将后台事件注入指定会话上下文，供后续对话连贯理解。 */
  recordEventInSession(sessionId: string, text: string, meta?: Record<string, unknown>): void {
    this.store.addMessage({ sessionId, role: 'event', content: this.deps.redact(text), ...(meta ? { meta } : {}) })
  }

  /**
   * 由任务/会商完成事件自动唤醒总控继续推进后续步骤（串行排入同用户队列，避免与手动对话并发冲突）。
   * 返回 `true` 表示自动续接已完整执行（含将回复推送至对应通道）；返回 `false` 时由调用方回退发送静态完工通知。
   */
  async triggerAutoFollowup(input: {
    sessionId: string
    eventKind: FollowupTriggerKind
    targetId: string
    outcomeOk: boolean
    noticeText: string
    followups: readonly DirectorFollowup[]
    inferredFromChat?: boolean
    pushReply: boolean
  }): Promise<boolean> {
    if (this.closed) return false
    const session = this.store.getSession(input.sessionId)
    if (!session) return false
    const cfg = this.deps.options.get().director
    if (!cfg.enabled || !this.checkBudget().ok || !this.resolveModel()) {
      for (const fw of input.followups) {
        this.store.finishFollowup(fw.id, 'failed', '总控未启用、预算不足或无可用模型')
      }
      return false
    }

    const lines: string[] = [
      `[系统自动续接唤醒] ${input.eventKind === 'council.ended' ? '会商' : '工单'} ${input.targetId} 已结束，现将控制权自动交回总控推进后续步骤：`,
      '',
      input.noticeText,
      '',
    ]
    if (input.followups.length > 0) {
      lines.push('### 已登记的后续执行计划：')
      for (const fw of input.followups) {
        const policy = !input.outcomeOk && fw.onFailure === 'report'
          ? '（注意：前置任务未成功，按策略仅分析失败原因与补救方案并汇报，不要盲目继续部署）'
          : '（请立刻调用工具执行下一步；若涉及 L3 高危操作如宿主机部署/重启/切换镜像，请直接发起该操作生成确认短码供主人回复确认）'
        lines.push(`- #${fw.id}：${fw.instruction}${policy}`)
      }
    } else if (input.inferredFromChat) {
      lines.push(
        '### 自动续接检查：',
        '结合上方对话上下文，你或主人此前提到该任务完成后要进行下一步操作（如部署、重启、验收、发下一张单或推送报告）。',
        '1. 如果确实存在承诺过的后续步骤，请立刻调用相应工具推进（涉及 L3 高危操作时直接发起以生成确认短码）；',
        '2. 如果前置任务失败或实际上无需额外操作，请简明汇总本次完工结果即可；',
        '3. 最终把「任务完工结果 + 下一步已执行情况（或确认短码）」合并成一条清晰的中文回复汇报给主人。',
      )
    }

    const queueKey = `${session.channel}:${session.userId}`
    const prev = this.userQueues.get(queueKey) ?? Promise.resolve()
    let succeeded = false
    const task = prev.catch(() => undefined).then(async () => {
      if (this.closed) return
      try {
        const res = await this.chat({
          channel: session.channel,
          userId: session.userId,
          text: lines.join('\n'),
          autoTrigger: {
            eventKind: input.eventKind,
            targetId: input.targetId,
            followupIds: input.followups.map(f => f.id),
          },
        })
        if (res.modelFailed) {
          for (const fw of input.followups) {
            this.store.finishFollowup(fw.id, 'failed', res.reply.slice(0, 400))
          }
          succeeded = false
          return
        }
        for (const fw of input.followups) {
          this.store.finishFollowup(fw.id, 'done', res.reply.slice(0, 600))
        }
        if (input.pushReply && res.reply && this.canDeliver(session.channel)) {
          try {
            await this.deliverTo(session.channel, session.userId, res.reply, undefined, this.createdActionsOf(res))
          } catch (sendErr) {
            const msg = this.deps.redact(sendErr instanceof Error ? sendErr.message : String(sendErr))
            this.logEvent(`director.${session.channel}_send_failed`, 'warn', `总控自动续接回复推送失败：${msg.slice(0, 80)}`, {
              userId: session.userId,
              sessionId: session.id,
              targetId: input.targetId,
            })
            this.store.addUndelivered(session, res.reply)
            this.deps.onError?.(sendErr)
          }
        }
        succeeded = true
      } catch (error) {
        this.deps.onError?.(error)
        const errMsg = this.deps.redact(error instanceof Error ? error.message : String(error))
        for (const fw of input.followups) {
          this.store.finishFollowup(fw.id, 'failed', errMsg.slice(0, 400))
        }
        succeeded = false
      }
    })
    this.userQueues.set(queueKey, task)
    void task.finally(() => {
      if (this.userQueues.get(queueKey) === task) this.userQueues.delete(queueKey)
    })
    await task
    return succeeded
  }

  /**
   * 处理飞书交互式按钮卡片回传（长连接 WS 与 HTTP Webhook 共用）。
   * 3 秒内即时返回 `{ toast, card }` 锁定卡片防连点，耗时操作在后台异步执行并原位刷新卡片与汇报。
   */
  async handleFeishuCardAction(event: FeishuCardActionEvent): Promise<FeishuCardCallbackResponse> {
    if (this.deps.feishuAllowCheck && !this.deps.feishuAllowCheck(event.operatorOpenId)) {
      return { toast: { type: 'error', content: '你不在飞书授权操作员名单中，无权执行此操作' } }
    }
    const val = event.actionValue
    const lockKey = val.kind === 'director_action'
      ? `act:${val.actionId}`
      : val.kind === 'mission_approval'
        ? `mis:${val.missionId}:${val.nodeKey}:v${val.planVersion}`
        : val.kind === 'vault_request'
          ? `sec:${val.requestId}`
          : `tk:${val.ticketId}:${val.op}`
    if (this.cardActionLocks.has(lockKey)) {
      return { toast: { type: 'info', content: '操作正在处理中，请勿重复点击' } }
    }

    if (val.kind === 'director_action') {
      const action = this.store.getPendingAction(val.actionId)
      if (!action) {
        return { toast: { type: 'warning', content: `找不到待确认操作 #${val.actionId}` } }
      }
      if (action.status !== 'pending') {
        const stWord = action.status === 'approved' ? '已批准执行' : action.status === 'rejected' ? '已拒绝' : '已过期'
        return {
          toast: { type: 'warning', content: `操作 #${action.id} ${stWord}` },
          card: {
            type: 'raw',
            data: buildSettledCard({
              title: `高危指令 #${action.id}（${stWord}）`,
              template: action.status === 'approved' ? 'green' : 'grey',
              markdown: `**工具**：\`${action.toolName}\`\n**摘要**：${action.summary}`,
              statusLine: `状态：${stWord}`,
            }),
          },
        }
      }

      if (val.decision === 'reject') {
        const res = await this.decidePendingAction(action.id, 'reject')
        return {
          toast: { type: res.ok ? 'info' : 'error', content: res.message.slice(0, 80) },
          card: {
            type: 'raw',
            data: buildSettledCard({
              title: `已拒绝高危指令 #${action.id}`,
              template: 'grey',
              markdown: `**工具**：\`${action.toolName}\`\n**摘要**：${action.summary}`,
              statusLine: '🚫 已由你在飞书点击拒绝',
            }),
          },
        }
      }

      // 批准执行可能耗时超过飞书 3 秒回调窗口：立即锁定卡片并返回 Toast，后台异步执行完毕后原位更新卡片并汇报
      this.cardActionLocks.add(lockKey)
      const session = this.store.getSession(action.sessionId)
      const bgTask = (async () => {
        try {
          const decided = await this.decidePendingAction(action.id, 'approve')
          const finalCard = buildSettledCard({
            title: decided.ok ? `已执行高危指令 #${action.id}` : `执行失败 #${action.id}`,
            template: decided.ok ? 'green' : 'red',
            markdown: `**工具**：\`${action.toolName}\`\n**摘要**：${action.summary}\n\n**结果**：${decided.message.slice(0, 1200)}`,
            statusLine: decided.ok ? '✅ 已在后台执行完成' : '❌ 执行失败，总控将自动排查原因',
          })
          if (event.openMessageId && this.deps.updateFeishuCard) {
            await this.deps.updateFeishuCard(event.openMessageId, finalCard)
          }
          if (session) {
            this.recordEventInSession(session.id, `[飞书点击批准 #${action.id}] ${decided.message}`, { actionId: action.id, ok: decided.ok })
          }
          // 高危指令执行失败时，若开启主动自愈，自动唤醒总控诊断并提供补救方案
          const cfg = this.deps.options.get().director
          if (!decided.ok && cfg.autoHeal && session) {
            const heal = await this.triggerAutoHeal({
              sessionId: session.id,
              targetKey: `action:${action.id}`,
              incidentKind: 'command_failed',
              targetId: action.id,
              title: `${action.toolName} (${action.summary.slice(0, 40)})`,
              summary: decided.message,
              pushReply: true,
            })
            if (heal.handled) return
          }
          if (this.deps.sendFeishu) {
            await this.deps.sendFeishu({
              to: event.operatorOpenId,
              ...(event.openMessageId ? { replyTo: event.openMessageId } : {}),
              text: decided.message,
            }).catch(() => undefined)
          }
        } catch (err) {
          this.deps.onError?.(err)
        } finally {
          this.cardActionLocks.delete(lockKey)
        }
      })()
      void bgTask
      return {
        toast: { type: 'info', content: `已批准 #${action.id}，正在后台执行…` },
        card: {
          type: 'raw',
          data: buildSettledCard({
            title: `正在执行 #${action.id}`,
            template: 'blue',
            markdown: `**工具**：\`${action.toolName}\`\n**摘要**：${action.summary}`,
            statusLine: '⏳ 已由你在飞书批准，正在后台执行中，完成后会自动更新结果…',
          }),
        },
      }
    }

    if (val.kind === 'mission_approval') {
      this.cardActionLocks.add(lockKey)
      try {
        const res = val.decision === 'approve'
          ? (this.deps.approveMissionNode
              ? await this.deps.approveMissionNode(val.missionId, val.nodeKey, {
                  actorId: `feishu:${event.operatorOpenId}`,
                  planVersion: val.planVersion,
                  idempotencyKey: `feishu:${val.missionId}:${val.nodeKey}:v${val.planVersion}`,
                  note: '飞书卡片一键批准继续',
                })
              : { ok: false, message: '未启用 DAG 计划插件' })
          : (this.deps.cancelMission
              ? await this.deps.cancelMission(val.missionId)
              : { ok: false, message: '未启用 DAG 计划插件' })
        const label = val.decision === 'approve' ? '已批准继续' : '已取消计划'
        return {
          toast: { type: res.ok ? 'success' : 'error', content: res.message.slice(0, 80) },
          card: {
            type: 'raw',
            data: buildSettledCard({
              title: `${val.title || val.missionId}（${res.ok ? label : '处理失败'}）`,
              template: res.ok ? (val.decision === 'approve' ? 'green' : 'grey') : 'red',
              markdown: `**计划**：\`${val.missionId}\` · v${val.planVersion}\n**节点**：\`${val.nodeKey}\`\n\n${res.message}`,
              statusLine: res.ok ? `✅ ${label}` : '❌ 操作未成功',
            }),
          },
        }
      } finally {
        this.cardActionLocks.delete(lockKey)
      }
    }

    if (val.kind === 'vault_request') {
      this.cardActionLocks.add(lockKey)
      try {
        const res = this.deps.decideSecretRequest
          ? await this.deps.decideSecretRequest(val.requestId, val.decision)
          : { ok: false, message: '当前运行时未接入密钥审批回调' }
        const label = val.decision === 'approve' ? '已批准密钥授权' : '已拒绝密钥申请'
        return {
          toast: { type: res.ok ? 'success' : 'error', content: res.message.slice(0, 80) },
          card: {
            type: 'raw',
            data: buildSettledCard({
              title: `密钥申请：${val.secretName || val.requestId}`,
              template: res.ok ? (val.decision === 'approve' ? 'green' : 'grey') : 'red',
              markdown: `**工单**：\`${val.ticketId}\`\n**密钥**：\`${val.secretName}\`\n\n${res.message}`,
              statusLine: res.ok ? `✅ ${label}` : '❌ 审批失败',
            }),
          },
        }
      } finally {
        this.cardActionLocks.delete(lockKey)
      }
    }

    // kind === 'ticket_op'
    this.cardActionLocks.add(lockKey)
    try {
      let ok = true
      let msg = ''
      try {
        if (val.op === 'retry') {
          await this.deps.host.retryTicket(val.ticketId)
          msg = `已重新启动工单 ${val.ticketId}，总控会继续跟踪直至解决并汇报。`
        } else {
          await this.deps.host.stopTicket(val.ticketId, '主人在飞书卡片点击停止')
          msg = `已停止工单 ${val.ticketId}。`
        }
      } catch (err) {
        ok = false
        msg = this.deps.redact(err instanceof Error ? err.message : String(err))
      }
      return {
        toast: { type: ok ? 'success' : 'error', content: msg.slice(0, 80) },
        card: {
          type: 'raw',
          data: buildSettledCard({
            title: `${val.title || val.ticketId}（${ok ? (val.op === 'retry' ? '已重试' : '已停止') : '操作失败'}）`,
            template: ok ? (val.op === 'retry' ? 'blue' : 'grey') : 'red',
            markdown: `**工单**：\`${val.ticketId}\`\n\n${msg}`,
            statusLine: ok ? '✅ 已按你的飞书指令处理' : '❌ 执行失败',
          }),
        },
      }
    } finally {
      this.cardActionLocks.delete(lockKey)
    }
  }

  /**
   * 主动排障与自愈闭环入口：当工单失败、卡死、阻塞、DAG 节点失败或高危指令执行失败时自动唤醒总控大脑。
   * 遵守 `autoHeal` 开关、`maxAutoHealRounds` 防死循环上限与总控每日预算。
   */
  async triggerAutoHeal(input: {
    sessionId: string
    targetKey: string
    incidentKind: 'ticket_failed' | 'ticket_attention' | 'ticket_stalled' | 'mission_failed' | 'command_failed'
    targetId: string
    title: string
    summary: string
    question?: string
    pushReply: boolean
  }): Promise<{ handled: boolean; exhausted?: boolean; attempts: number; reply?: string }> {
    if (this.closed) return { handled: false, attempts: 0 }
    const session = this.store.getSession(input.sessionId)
    if (!session) return { handled: false, attempts: 0 }
    const cfg = this.deps.options.get().director
    const existing = this.store.getHealState(input.targetKey)
    const maxRounds = cfg.maxAutoHealRounds ?? 2
    if (!cfg.enabled || !cfg.autoHeal || maxRounds <= 0) {
      return { handled: false, attempts: existing?.attempts ?? 0 }
    }
    if ((existing?.attempts ?? 0) >= maxRounds) {
      this.store.markHealEscalated(input.targetKey, input.summary)
      return { handled: false, exhausted: true, attempts: existing!.attempts }
    }
    if (!this.checkBudget().ok || !this.resolveModel()) {
      return { handled: false, attempts: existing?.attempts ?? 0 }
    }

    const state = this.store.recordHealAttempt(input.targetKey, input.summary)
    this.logEvent('director.auto_heal_start', 'info', `总控启动主动排障自愈（第 ${state.attempts}/${maxRounds} 轮）：${input.title.slice(0, 60)}`, {
      targetKey: input.targetKey,
      incidentKind: input.incidentKind,
      targetId: input.targetId,
      attempt: state.attempts,
    })

    const kindDesc: Record<typeof input.incidentKind, string> = {
      ticket_failed: '工单执行失败',
      ticket_attention: '工单报错或阻塞停住',
      ticket_stalled: '工单长时间无进展疑似卡死',
      mission_failed: 'DAG 任务计划节点失败',
      command_failed: '宿主机/高危命令执行失败',
    }
    const promptLines = [
      `[系统主动排障自愈唤醒 · 第 ${state.attempts}/${maxRounds} 轮]`,
      `异常类型：${kindDesc[input.incidentKind]}`,
      `目标编号：${input.targetId}`,
      `目标标题：${input.title}`,
      ...(input.question ? [`现场提问/阻塞点：${input.question}`] : []),
      `异常摘要：${input.summary.slice(0, 900)}`,
      '',
      '### 请严格按以下四步自主排查并解决：',
      '1. **查清现场**：优先调用 `platform_query(ticket_diagnose)`（工单类）或 `host_ops(host_logs/podman_logs)` / `platform_query(missions_list)` 拿到真实报错堆栈与最后活动步骤，不要盲目猜测。',
      '2. **能自主解决就直接出手**：',
      '   - 若是疑似卡死：先看活动流确认是否仍在合法耗时构建；若确认挂死，立即 `ticket_manage(ticket_stop)` 并换更稳妥方式或补充非交互参数后重派/重试；',
      '   - 若是环境/依赖/参数/语法/偶发网络/推理受阻错误：直接修复环境、回复澄清指导、重试工单（`ticket_manage(ticket_retry)` / `ticket_reply`）或切换更合适模型/执行器重新派发，并用 `followup_set` 盯紧结果；',
      '   - 若是 DAG 失败节点：修复前置问题后调用 `subsystem_action(mission_retry_node)` 局部重试；',
      '   - 若修复需要执行宿主机命令或修改配置（L3 高危动作），直接调用对应工具生成确认卡片给主人一键点击批准。',
      '3. **真正无法自主解决**（缺少外部密钥、产品取舍或已尝试无解）：停止盲试，用 3~5 行讲清已查出的真实根因和给主人的 1~2 个可执行选项。',
      '4. **简洁汇报现状**：用简短中文说明「排查出的问题 + 我刚采取的解决动作 + 下一步跟踪计划（解决验证完成后再正式交付）」。',
    ]

    const queueKey = `${session.channel}:${session.userId}`
    const prev = this.userQueues.get(queueKey) ?? Promise.resolve()
    let outcome: { handled: boolean; attempts: number; reply?: string } = { handled: false, attempts: state.attempts }
    const task = prev.catch(() => undefined).then(async () => {
      if (this.closed) return
      try {
        const res = await this.chat({
          channel: session.channel,
          userId: session.userId,
          text: promptLines.join('\n'),
          autoTrigger: { eventKind: 'auto_heal', targetId: input.targetId },
        })
        if (res.modelFailed) {
          outcome = { handled: false, attempts: state.attempts }
          return
        }
        const actionsSummary = res.toolsUsed.map(t => `${t.name}(${t.ok ? 'ok' : 'err'})`).join(', ')
        this.store.updateHealAction(input.targetKey, actionsSummary ? `${actionsSummary} | ${res.reply.slice(0, 320)}` : res.reply.slice(0, 420))
        const newPending = this.createdActionsOf(res)
        if (input.pushReply && res.reply && this.canDeliver(session.channel)) {
          try {
            await this.deliverTo(session.channel, session.userId, res.reply, undefined, newPending)
          } catch (sendErr) {
            this.store.addUndelivered(session, res.reply)
            this.deps.onError?.(sendErr)
          }
        }
        outcome = { handled: true, attempts: state.attempts, reply: res.reply }
      } catch (err) {
        this.deps.onError?.(err)
        outcome = { handled: false, attempts: state.attempts }
      }
    })
    this.userQueues.set(queueKey, task)
    void task.finally(() => {
      if (this.userQueues.get(queueKey) === task) this.userQueues.delete(queueKey)
    })
    await task
    return outcome
  }

  /**
   * 故障自愈成功后触发的闭环战报 + 避坑经验自动沉淀到长期记忆（P2）。
   */
  async triggerHealResolvedReport(input: {
    sessionId: string
    targetKey: string
    ticketId: string
    title: string
    priorReason: string
    priorAction: string
    noticeText: string
    pushReply: boolean
  }): Promise<boolean> {
    if (this.closed) return false
    const session = this.store.getSession(input.sessionId)
    if (!session) return false
    this.store.markHealResolved(input.targetKey, `已解决并验收通过：${input.title}`)

    const cfg = this.deps.options.get().director
    const canCallModel = cfg.enabled && this.checkBudget().ok && Boolean(this.resolveModel())
    let handled = false

    if (canCallModel) {
      const prompt = [
        `[自愈闭环完成汇报] 此前出现异常并经你主动排查处理的工单 ${input.ticketId}（「${input.title}」）现已成功完成！`,
        `此前异常原因：${input.priorReason || '执行异常'}`,
        `此前自愈动作：${input.priorAction || '自动排查修复'}`,
        '',
        input.noticeText,
        '',
        '### 请完成两件事：',
        '1. 先调用 `platform_query(ticket_receipt)` 核实交付物与验收证据；',
        '2. 若本次排障形成了有长期价值的避坑经验，调用 `subsystem_action(memory_save)` 记下一条 `kind:"pitfall"` 的经验记忆；',
        '3. 最后向主人发一份干练的**自愈闭环战报**（3 段式：① 此前遇到什么问题 → ② 我是如何排查解决的 → ③ 最终验证依据与交付物）。',
      ].join('\n')

      const queueKey = `${session.channel}:${session.userId}`
      const prev = this.userQueues.get(queueKey) ?? Promise.resolve()
      const task = prev.catch(() => undefined).then(async () => {
        if (this.closed) return
        try {
          const res = await this.chat({
            channel: session.channel,
            userId: session.userId,
            text: prompt,
            autoTrigger: { eventKind: 'heal_resolved', targetId: input.ticketId },
          })
          if (res.modelFailed) return
          // 兜底经验反哺：如果总控本轮没有显式调用 memory_save，自动写入一条带工单来源的避坑记忆
          const savedMemory = res.toolsUsed.some(t => t.name === 'subsystem_action' && t.args?.action === 'memory_save' && t.ok)
          if (!savedMemory && this.deps.plugins && input.priorReason) {
            await this.deps.plugins.dispatchDirectorAction(
              'memory_save',
              {
                scope: 'user',
                kind: 'pitfall',
                title: `自愈经验：${input.title.slice(0, 48)}`,
                content: `异常现象：${input.priorReason.slice(0, 220)}；解决过程：${(input.priorAction || res.reply).slice(0, 320)}（来源工单 ${input.ticketId}）`,
                tags: ['auto_heal'],
              },
              { sessionId: session.id, channel: session.channel, userId: session.userId },
            ).catch(() => undefined)
          }
          if (input.pushReply && res.reply && this.canDeliver(session.channel)) {
            await this.deliverTo(session.channel, session.userId, res.reply, undefined, this.createdActionsOf(res)).catch(err => {
              this.store.addUndelivered(session, res.reply)
              this.deps.onError?.(err)
            })
          }
          handled = true
        } catch (err) {
          this.deps.onError?.(err)
        }
      })
      this.userQueues.set(queueKey, task)
      void task.finally(() => {
        if (this.userQueues.get(queueKey) === task) this.userQueues.delete(queueKey)
      })
      await task
    }
    return handled
  }

  // --- 控制台查询与状态 ---

  listSessions(channel?: DirectorChannel): SessionListItem[] {
    return this.store.listSessions(channel)
  }

  getSessionDetail(sessionId: string): DirectorSessionDetail | undefined {
    const session = this.store.getSession(sessionId)
    if (!session) return undefined
    return {
      session,
      messages: this.store.recentMessages(sessionId, 160),
      pendingActions: this.store.listPendingActions(sessionId, false).map(redactPendingAction),
      followups: this.store.listFollowups(sessionId, false),
    }
  }

  resetSession(sessionId: string): boolean {
    if (!this.store.getSession(sessionId)) return false
    this.store.resetSession(sessionId, true)
    return true
  }

  deleteSession(sessionId: string): boolean {
    const res = this.deleteSessions([sessionId])
    return res.deleted > 0
  }

  deleteSessions(sessionIds: readonly string[]): { deleted: number; ids: string[] } {
    const ids = this.store.deleteSessions(sessionIds)
    if (ids.length > 0) {
      this.logEvent('director.sessions_deleted', 'info', `已删除 ${ids.length} 个总控对话会话`, { ids })
    }
    return { deleted: ids.length, ids }
  }

  deleteMessages(sessionId: string, messageIds: readonly number[]): { ok: boolean; deleted: number } {
    if (!this.store.getSession(sessionId)) return { ok: false, deleted: 0 }
    const deleted = this.store.deleteMessages(sessionId, messageIds)
    if (deleted > 0) {
      this.logEvent('director.messages_deleted', 'info', `已从会话 ${sessionId} 删除 ${deleted} 条对话记录`, { sessionId, deleted })
    }
    return { ok: true, deleted }
  }

  listPendingActions(sessionId?: string, onlyPending = false): PendingAction[] {
    return this.store.listPendingActions(sessionId, onlyPending).map(redactPendingAction)
  }

  status(): DirectorStatus {
    const opts = this.deps.options.get()
    const resolved = this.resolveModel()
    return {
      enabled: opts.director.enabled,
      model: resolved?.ref ?? formatRef(opts.models.routing.worker),
      notifyScope: opts.director.notifyScope,
      confirmHighRisk: opts.director.confirmHighRisk,
      sessions: this.store.listSessions().length,
      pendingActions: this.store.listPendingActions(undefined, true).length,
      pendingFollowups: this.store.listFollowups(undefined, true).length,
      todayUsd: this.directorTodayUsd(),
      dailyUsd: opts.director.dailyUsd,
    }
  }

  /** 轻量调用当前总控模型总结一段文本（供主动汇报桥接复用）。 */
  async summarizeForWechat(system: string, user: string, sessionId = 'director-summary'): Promise<string | undefined> {
    if (!this.checkBudget().ok) return undefined
    const resolved = this.resolveModel()
    if (!resolved) return undefined
    const maxRetries = Math.max(0, Math.min(20, this.deps.options.get().director.maxRetries ?? 5))
    const timeoutMs = Math.min(90_000, 20_000 + maxRetries * 5_000)
    const res = await this.doCallPlain(resolved.target, {
      model: resolved.model,
      system,
      user,
      maxTokens: 600,
    }, { timeoutMs, sessionId, maxRetries })
    this.recordUsage(resolved.provider, resolved.model, res.status ?? 0, res.usage, res.latencyMs)
    return res.ok && res.text.trim() ? this.deps.redact(res.text.trim()) : undefined
  }

  // --- 内部辅助 ---

  private formatQuickStatus(sessionId: string): string {
    const ov = this.deps.host.overview()
    const today = this.deps.ledger.dayTotals()
    const budget = this.deps.options.get().budget
    const pendingReqs = this.deps.host.secretRequests().filter(r => r.status === 'pending').length
    const pendingActs = this.store.listPendingActions(sessionId, true)
    const lines = [
      `📊 SuperAgent 平台实时状态`,
      `• 接单状态：${ov.paused ? '⏸ 已暂停' : '✅ 正常接单'}｜工位 ${ov.slots.used}/${ov.slots.max}`,
      `• 工单概况：运行中 ${ov.tickets.running}｜等你回答 ${ov.tickets.needsPerson}｜开放共 ${ov.tickets.open}｜今日结束 ${ov.tickets.endedToday}`,
      `• 今日花费：$${today.usd.toFixed(4)}${budget.enabled && budget.dailyUsd > 0 ? ` / $${budget.dailyUsd}` : ''}（${today.calls} 次调用）`,
      `• 主机资源：负载 ${ov.host.load1.toFixed(2)}/${ov.host.cpuCount}C｜内存 ${ov.host.memUsedPct}%｜磁盘剩余 ${ov.host.diskFreeGb.toFixed(1)} GB`,
    ]
    if (ov.runningSteps && ov.runningSteps.length > 0) {
      lines.push('', '🔧 正在执行：')
      for (const s of ov.runningSteps.slice(0, 4)) {
        lines.push(`• ${s.id}：${safeSummary(s.summary || s.tool || s.kind, 60)}`)
      }
    }
    if (ov.attentionTickets.length > 0) {
      lines.push('', '⚠️ 等待你处理：')
      for (const t of ov.attentionTickets.slice(0, 5)) {
        lines.push(`• [${t.kind}] ${t.title} (${t.id})`)
      }
    }
    if (pendingReqs > 0) lines.push('', `🔑 有 ${pendingReqs} 条待审批密钥请求`)
    if (pendingActs.length > 0) {
      lines.push('', `🛡️ 待确认高危操作：${pendingActs.map(a => `#${a.id}`).join('、')}（回复 /确认 执行）`)
    }
    return lines.join('\n')
  }

  private async formatQuickPlans(): Promise<string> {
    try {
      const res = await this.deps.plugins?.dispatchDirectorQuery(
        'missions_list',
        { limit: 8 },
        { sessionId: 'quick-plans', channel: 'web', userId: 'quick' },
      )
      if (!res || !res.matched) return '🗺️ 当前未启用 DAG 任务计划插件。'
      const items = ((res.result as { items?: { id: string; title: string; status: string; planVersion: number; nodes: { key: string; title: string; status: string }[] }[] })?.items) ?? []
      if (items.length === 0) return '🗺️ 当前暂无多步骤 DAG 任务计划。直接把复杂需求发给我，我会自动拆解并排期执行。'
      const lines = ['🗺️ DAG 任务计划速览（最近 8 条）']
      for (const m of items.slice(0, 8)) {
        const done = m.nodes.filter(n => n.status === 'completed' || n.status === 'skipped').length
        const waiting = m.nodes.filter(n => n.status === 'waiting_approval')
        lines.push(`• [${m.status}] ${m.title}（${m.id} · v${m.planVersion} · ${done}/${m.nodes.length}）`)
        for (const w of waiting) lines.push(`  ⏳ 待人工批准：${w.title} (${w.key})`)
      }
      return lines.join('\n')
    } catch {
      return '🗺️ 读取任务计划失败，请稍后再试。'
    }
  }

  private formatQuickHelp(): string {
    return [
      '🧭 总控助手快捷口令（0 Token 秒回）',
      '• `/状态` — 查看工位、进行中任务、今日花费与主机资源',
      '• `/计划` — 查看多步骤 DAG 任务计划与待人工批准卡点',
      '• `/新对话` — 清空短期上下文重新开始（保留审计日志）',
      '• `/确认 [短码]` / `/取消 [短码]` — 批准或放弃待确认高危操作',
      '• `/直通 <任务内容>` — 跳过总控直接建单派发',
      '',
      '💡 日常直接用自然语言交代即可：',
      '• 代码改造（自动推荐 `worktree` 隔离分支审 Diff 合并）',
      '• 复杂多步任务（自动拆解并行 DAG 并设人工审批）',
      '• 周期定时与口径修订（自动同步任务约定与长期记忆）',
      '• 确定性数据核对（自动派发 0 Token 注册脚本）',
    ].join('\n')
  }

  /** 低开销采集实时平台态势快照注入系统提示词，避免首轮盲查显著提速。 */
  private async buildLiveSnapshot(): Promise<string> {
    const lines: string[] = []
    try {
      const ov = this.deps.host.overview()
      lines.push(`- 槽位：${ov.slots.used}/${ov.slots.max}｜接单：${ov.paused ? '已暂停' : '正常'}｜开放工单 ${ov.tickets.open}（运行中 ${ov.tickets.running}，等你回答 ${ov.tickets.needsPerson}）`)
      if (ov.attentionTickets.length > 0) {
        lines.push(`- 待处理工单：${ov.attentionTickets.slice(0, 5).map(t => `${t.id}(${t.kind}: ${t.title.slice(0, 28)})`).join('；')}`)
      }
    } catch { /* mock host */ }

    try {
      const open = this.deps.host.listTickets({ status: 'open', limit: 6, offset: 0 })
      if (open.items.length > 0) {
        lines.push(`- 当前开放工单：${open.items.map(t => `${t.id}「${t.title.slice(0, 28)}」[${t.stage}]`).join('；')}`)
      }
    } catch { /* mock host */ }

    try {
      const projs = this.deps.projects?.list?.().filter(p => p.status === 'ready').slice(0, 10) ?? []
      if (projs.length > 0) {
        lines.push(`- 就绪项目库：${projs.map(p => `${p.name}(${p.id})`).join('、')}`)
      }
    } catch { /* ignore */ }

    try {
      const mRes = await this.deps.plugins?.dispatchDirectorQuery(
        'missions_list',
        { limit: 5 },
        { sessionId: 'snapshot', channel: 'web', userId: 'snapshot' },
      )
      if (mRes?.matched) {
        const items = ((mRes.result as { items?: { id: string; title: string; status: string; planVersion: number; nodes: { key: string; status: string }[] }[] })?.items ?? [])
          .filter(m => m.status === 'running' || m.status === 'draft' || m.status === 'paused')
        if (items.length > 0) {
          lines.push(`- 活跃 DAG 计划：${items.map(m => {
            const wait = m.nodes.filter(n => n.status === 'waiting_approval').map(n => n.key)
            return `${m.id}「${m.title.slice(0, 24)}」[v${m.planVersion}/${m.status}${wait.length ? ` 待批:${wait.join(',')}` : ''}]`
          }).join('；')}`)
        }
      }
    } catch { /* ignore */ }

    return lines.join('\n')
  }

  private resolveModel(): { provider: string; model: string; ref: string; maxTokens: number; target: ModelTarget } | undefined {
    const opts = this.deps.options.get()
    const preferred: ModelRef = opts.director.model ?? opts.models.routing.worker
    const found = findModel(opts.models, preferred, { enabledOnly: true })
      ?? findModel(opts.models, opts.models.routing.worker, { enabledOnly: true })
    if (!found) return undefined
    const { provider, model } = found
    return {
      provider: provider.id,
      model: model.id,
      ref: formatRef({ provider: provider.id, model: model.id }),
      maxTokens: model.maxTokens,
      target: {
        api: provider.api,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(provider.sessionHeader ? { sessionHeader: provider.sessionHeader } : {}),
      },
    }
  }

  /** 主总控模型上游故障时，自动挑选一个不同的已启用模型兜底重试。 */
  private resolveFallbackModel(excludeRef: string): { provider: string; model: string; ref: string; maxTokens: number; target: ModelTarget } | undefined {
    const opts = this.deps.options.get()
    const workerRef = formatRef(opts.models.routing.worker)
    if (workerRef !== excludeRef) {
      const w = findModel(opts.models, opts.models.routing.worker, { enabledOnly: true })
      if (w) {
        return {
          provider: w.provider.id,
          model: w.model.id,
          ref: workerRef,
          maxTokens: w.model.maxTokens,
          target: {
            api: w.provider.api,
            baseUrl: w.provider.baseUrl,
            apiKey: w.provider.apiKey,
            ...(w.provider.sessionHeader ? { sessionHeader: w.provider.sessionHeader } : {}),
          },
        }
      }
    }
    for (const provider of opts.models.providers) {
      if (!provider.enabled) continue
      for (const model of provider.models) {
        const ref = formatRef({ provider: provider.id, model: model.id })
        if (ref === excludeRef) continue
        return {
          provider: provider.id,
          model: model.id,
          ref,
          maxTokens: model.maxTokens,
          target: {
            api: provider.api,
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            ...(provider.sessionHeader ? { sessionHeader: provider.sessionHeader } : {}),
          },
        }
      }
    }
    return undefined
  }

  private directorTodayUsd(): number {
    const todayPrefix = this.doNow().toISOString().slice(0, 10)
    const calls = this.deps.ledger.calls({ ticketId: '', limit: 500 })
    let sum = 0
    for (const c of calls) {
      if (c.agent === 'director' && c.at.startsWith(todayPrefix)) sum += c.costUsd
    }
    return Number(sum.toFixed(6))
  }

  private checkBudget(): { ok: true } | { ok: false; reason: string } {
    const opts = this.deps.options.get()
    if (opts.budget.enabled && opts.budget.dailyUsd > 0) {
      const globalToday = this.deps.ledger.dayUsd()
      if (globalToday >= opts.budget.dailyUsd) {
        return { ok: false, reason: `今日全局花费已达 $${globalToday.toFixed(4)}（上限 $${opts.budget.dailyUsd}），总控模型已暂停调用` }
      }
    }
    if (opts.director.dailyUsd > 0) {
      const dirToday = this.directorTodayUsd()
      if (dirToday >= opts.director.dailyUsd) {
        return { ok: false, reason: `总控助手今日花费已达 $${dirToday.toFixed(4)}（上限 $${opts.director.dailyUsd}）` }
      }
    }
    return { ok: true }
  }

  private recordUsage(providerId: string, modelId: string, status: number, usage: Usage | undefined, latencyMs: number): void {
    try {
      const found = findModel(this.deps.options.get().models, { provider: providerId, model: modelId })
      const cost = usage && found?.model.price ? costOf(found.model.price, usage) : 0
      this.deps.ledger.record({
        at: this.doNow().toISOString(),
        ticketId: '',
        agent: 'director',
        provider: providerId,
        model: modelId,
        status,
        promptHit: usage?.prompt_cache_hit_tokens ?? 0,
        promptMiss: usage?.prompt_cache_miss_tokens ?? 0,
        completion: usage?.completion_tokens ?? 0,
        costUsd: cost,
        latencyMs,
      })
    } catch (error) {
      this.deps.onError?.(error)
    }
  }

  private maybeCompactAsync(sessionId: string): void {
    if (this.compacting.has(sessionId) || this.closed) return
    const active = this.store.activeMessages(sessionId, COMPACT_TRIGGER_MESSAGES + 10)
    if (active.length < COMPACT_TRIGGER_MESSAGES) return
    this.compacting.add(sessionId)
    void (async () => {
      try {
        const cutIndex = active.length - COMPACT_KEEP_TAIL
        if (cutIndex <= 4) return
        const toArchive = active.slice(0, cutIndex)
        const lastArchiveId = toArchive[toArchive.length - 1]!.id
        const curSession = this.store.getSession(sessionId)
        if (!curSession) return
        const resolved = this.resolveModel()
        if (!resolved || !this.checkBudget().ok) return

        const transcript = toArchive
          .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'event')
          .map(m => `${m.role === 'user' ? '用户' : m.role === 'event' ? '事件' : '助手'}：${m.content.slice(0, 400)}`)
          .join('\n')
        const prompt = [
          curSession.summary ? `已有历史摘要：\n${curSession.summary}\n` : '',
          `新增需归档对话：\n${transcript}`,
        ].join('\n')

        const maxRetries = Math.max(0, Math.min(20, this.deps.options.get().director.maxRetries ?? 5))
        const timeoutMs = Math.min(90_000, 20_000 + maxRetries * 5_000)
        const res = await this.doCallPlain(resolved.target, {
          model: resolved.model,
          system: '你是对话记忆压缩员。请把已有摘要和新增对话合并为不超过 500 字的精炼中文要点：保留关键工单 ID、项目名、用户偏好、未完事项和关键结论，去掉寒暄和重复内容。',
          user: prompt,
          maxTokens: 600,
        }, { timeoutMs, sessionId: `director-compact-${sessionId}`, maxRetries })
        this.recordUsage(resolved.provider, resolved.model, res.status ?? 0, res.usage, res.latencyMs)
        if (res.ok && res.text.trim()) {
          this.store.updateSession(sessionId, { summary: this.deps.redact(res.text.trim()).slice(0, 1500) })
          this.store.archiveMessages(sessionId, lastArchiveId)
        }
      } catch (error) {
        this.deps.onError?.(error)
      } finally {
        this.compacting.delete(sessionId)
      }
    })()
  }

  private logEvent(kind: string, level: 'info' | 'warn', text: string, data?: Record<string, unknown>): void {
    try {
      this.deps.events.add({ kind, level, text, ...(data ? { data } : {}) })
    } catch { /* best effort */ }
  }
}
