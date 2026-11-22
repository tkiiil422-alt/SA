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

export interface DirectorServiceDeps extends Omit<DirectorToolsDeps, 'store' | 'onAudit'> {
  store: DirectorStore
  sendWechat?: (input: { to?: string; title?: string; text: string }) => Promise<void>
  sendWechatTyping?: (to?: string, status?: 1 | 2) => Promise<void>
  /** 飞书私聊发送：`to` 为用户 open_id；`replyTo` 为要回复的原消息 ID（对话回复时使用）。 */
  sendFeishu?: (input: { to: string; text: string; replyTo?: string }) => Promise<void>
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
  /** 内部使用：由任务/会商完成事件自动唤醒总控推进后续步骤。 */
  autoTrigger?: { eventKind: FollowupTriggerKind; targetId: string; followupIds?: string[] }
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
const TURN_TIMEOUT_MS = 150_000
const STEP_TIMEOUT_MS = 60_000
const TYPING_PULSE_MS = 8_000

const CONFIRM_RE = /^\/?(?:确认|同意|批准|ok|yes)(?:\s+#?([A-Za-z0-9]{4}))?$/i
const CANCEL_RE = /^\/?(?:取消|拒绝|放弃|cancel|no)(?:\s+#?([A-Za-z0-9]{4}))?$/i
const STATUS_RE = /^\/(?:状态|status)$/i
const RESET_RE = /^\/(?:新对话|重置|清空|reset|new)$/i
const DIRECT_RE = /^\/(?:直通|直接派单|task)\s+([\s\S]+)$/i

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
    const immediate = STATUS_RE.test(text) || RESET_RE.test(text) || DIRECT_RE.test(text)
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

  /** 把一段文字发到指定通道的用户；飞书带 `replyTo` 时回复到原消息下。 */
  private async deliverTo(channel: InboundChannel, userId: string, text: string, replyTo?: string): Promise<void> {
    if (channel === 'wechat') {
      if (!this.deps.sendWechat) throw new Error('微信发送未配置')
      await this.deps.sendWechat({ to: userId, text })
      return
    }
    if (!this.deps.sendFeishu) throw new Error('飞书发送未配置')
    await this.deps.sendFeishu({ to: userId, text, ...(replyTo ? { replyTo } : {}) })
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
            await this.deliverTo(channel, userId, res.reply, channel === 'feishu' ? messageId : undefined)
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
          await this.deliverTo(channel, input.userId, res.reply)
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
    const systemPrompt = buildDirectorSystemPrompt({
      nowIso: this.doNow().toISOString(),
      channel: input.channel,
      session: freshSession,
      pendingActions: pendingBefore,
      pendingFollowups,
      extraPrompt: cfg.extraPrompt,
      ...(pluginSections && pluginSections.length > 0 ? { pluginSections } : {}),
    })

    const toolsUsed: DirectorToolAudit[] = []
    const maxRetries = Math.max(0, Math.min(20, cfg.maxRetries ?? 5))
    // 重试次数调高时，按每次额外重试增加 12 秒单步预算（上限 4 分钟），避免高重试配置被旧固定超时提前截断
    const stepTimeoutMs = Math.min(240_000, STEP_TIMEOUT_MS + Math.max(0, maxRetries - 3) * 12_000)
    const turnTimeoutMs = Math.max(TURN_TIMEOUT_MS, stepTimeoutMs + 90_000)
    const deadline = Date.now() + turnTimeoutMs
    const maxSteps = Math.max(1, Math.min(15, cfg.maxToolSteps))
    const sessionKey = `director-${input.channel}-${input.userId}`
    let finalReply = ''
    let modelFailed = false

    for (let step = 0; step <= maxSteps; step += 1) {
      const remainingMs = deadline - Date.now()
      if (remainingMs < 3_000) {
        finalReply = '本次排查调用耗时较长已达上限，以上已获取部分信息，你可以继续追问具体某一项。'
        break
      }

      const allowTools = step < maxSteps
      const result = await this.doCallTool(resolved.target, {
        model: resolved.model,
        system: systemPrompt,
        messages: conversation,
        tools: allowTools ? this.tools.definitions() : [],
        maxTokens: Math.min(4096, resolved.maxTokens),
      }, {
        timeoutMs: Math.min(stepTimeoutMs, remainingMs),
        sessionId: sessionKey,
        stream: true,
        cacheTtl: '5m',
        maxRetries,
      })

      this.recordUsage(resolved.provider, resolved.model, result.status ?? 0, result.usage, result.latencyMs)

      if (!result.ok) {
        modelFailed = true
        this.logEvent('director.model_failed', 'warn', `总控模型调用失败（${resolved.ref}）：${(result.error ?? '未知错误').slice(0, 120)}`, {
          sessionId: session.id,
          model: resolved.ref,
          step: step + 1,
          status: result.status ?? 0,
          latencyMs: result.latencyMs,
        })
        if (result.toolsUnsupported) {
          finalReply = `当前总控模型（${resolved.ref}）的上游接口不支持原生工具调用（Function Calling）。请在后台「设置 → 总控助手」切换一个支持工具调用的模型（如 Claude、Gemini 或 DeepSeek 官方/兼容接口）。`
        } else {
          finalReply = `调用总控模型（${resolved.ref}）失败：${result.error ?? '未知错误'}。你可以稍后重试，或发 /状态 查看实时面板。`
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
        meta: { model: resolved.ref, step: step + 1 },
      })
      conversation.push({ role: 'assistant', content: result.text.trim(), toolCalls: sanitizedCalls })

      for (let i = 0; i < assistantCalls.length; i += 1) {
        const tc = assistantCalls[i]!
        const safeArgs = sanitizedCalls[i]!.arguments
        const t0 = Date.now()
        const runRes = await this.tools.run(tc.name, tc.arguments, {
          session: this.store.getSession(session.id) ?? session,
          confirmHighRisk: cfg.confirmHighRisk,
        })
        const ms = Date.now() - t0
        toolsUsed.push({
          name: tc.name,
          args: safeArgs,
          ok: runRes.ok,
          ms,
          summary: safeSummary(runRes.output, 160),
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

    const safeReply = `${missedPrefix}${this.deps.redact(finalReply)}`
    this.store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: safeReply,
      meta: {
        model: resolved.ref,
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
      model: resolved.ref,
      ...(modelFailed ? { modelFailed: true } : {}),
    })
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
            await this.deliverTo(session.channel, session.userId, res.reply)
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
