/**
 * 总控助手 AI 指挥中心（#/director）：
 * - 桌面端三栏指挥台（会话栏 · 流式对话主区 · 实时 DAG 计划板）
 * - 手机端类原生全屏对话布局（顶部三段视图切换「对话 / 会话 / 计划板」、横向快捷芯片栏、可折叠上下文约束抽屉、吸底输入区）
 * - 流式 SSE 思考与工具调用实时进度（`POST /api/director/chat/stream`）+ 支持中途停止（AbortController）
 * - 实时 DAG 任务计划编排与幂等审批、高危操作二次确认与自动续接管理
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { API, del, get, post } from './api'
import { usePoll, ago, money } from './hooks'
import { useLive } from './useLive'
import { Icon } from './icons'
import { Empty, Markdown, confirmAction, toast, useAction } from './ui'
import type {
  DirectorProgressEvent,
  MissionListResponse,
  MissionNodeRecord,
  MissionRecord,
  ProjectWorkspaceMode,
} from '../../src/shared/api-types.ts'

interface ToolCallItem {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface DirMessage {
  id: number
  sessionId: string
  role: 'user' | 'assistant' | 'tool' | 'event'
  content: string
  toolCalls?: ToolCallItem[]
  toolCallId?: string
  toolName?: string
  meta?: Record<string, unknown>
  archived: boolean
  createdAt: string
}

interface PendingAct {
  id: string
  sessionId: string
  toolName: string
  args: Record<string, unknown>
  summary: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  resultText?: string
  expiresAt: string
  createdAt: string
}

interface SessionItem {
  id: string
  channel: 'wechat' | 'web' | 'feishu'
  userId: string
  title: string
  summary: string
  focusTicketId?: string
  messageCount: number
  pendingActions: number
  lastMessage?: string
  updatedAt: string
}

interface PendingFollowup {
  id: string
  sessionId: string
  triggerKind: string
  targetId: string
  instruction: string
  status: string
  createdAt: string
}

const CHANNEL_LABEL: Record<string, string> = { wechat: '微信', web: '网页', feishu: '飞书' }
const SCOPE_LABEL: Record<string, string> = { all: '全平台动态', wechat_only: '仅微信派单', off: '已静默' }
const MISSION_STATUS: Record<MissionRecord['status'], string> = {
  draft: '草稿',
  running: '执行中',
  paused: '已暂停',
  completed: '已交付',
  failed: '受阻',
  cancelled: '已取消',
}
const MISSION_TONE: Record<MissionRecord['status'], string> = {
  draft: 'human',
  running: 'run',
  paused: 'human',
  completed: 'done',
  failed: 'bad',
  cancelled: 'done',
}
const NODE_STATUS: Record<MissionNodeRecord['status'], string> = {
  pending: '等待依赖',
  dispatching: '派单中',
  running: '执行中',
  waiting_approval: '待审批',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
}
const NODE_TONE: Record<MissionNodeRecord['status'], string> = {
  pending: 'done',
  dispatching: 'run',
  running: 'run',
  waiting_approval: 'human',
  completed: 'done',
  failed: 'bad',
  skipped: 'done',
  cancelled: 'done',
}

const STARTER_CARDS: { title: string; desc: string; tag: string; prompt: string; sendNow?: boolean }[] = [
  {
    title: '多步 DAG 拆解与并发开发',
    desc: '出方案 → 并行 worktree 子任务 → 汇总测试 → 人工批准',
    tag: 'DAG 编排',
    prompt: '请先分析需求并用 DAG 任务计划拆解：出方案 → 并行子任务（使用 worktree 隔离分支） → 汇总测试 → 等我批准。具体需求如下：\n',
  },
  {
    title: '网页改动 + 浏览器自检交付',
    desc: '修改功能并运行 browser_verify 留证截图、生成交付回执',
    tag: '研发工厂',
    prompt: '请修改指定项目的网页功能，要求提交表单后刷新页面数据仍然存在，并运行 browser_verify 完成断言与截图留证，最后提交审查与交付回执。具体修改：\n',
  },
  {
    title: '周期销售周报（0 Token 核对）',
    desc: '建立可修订任务约定：按付款日期归集、金额保留两位小数',
    tag: '定时约定',
    prompt: '请创建一个每周五执行的销售周报定时任务，建立任务约定：按付款日期归集、所有金额保留两位小数，并在交付回执中附上核对证据。',
  },
  {
    title: '全平台健康与花费体检',
    desc: '一键查看活跃工单、主机负载、定时任务与今日花费',
    tag: '秒查现状',
    prompt: '请排查当前所有进行中任务、定时巡检状态、今日花费与异常告警，给我一份简明汇总。',
    sendNow: true,
  },
]

const QUICK_CHIPS: { label: string; cmd?: string; fill?: string }[] = [
  { label: '/状态', cmd: '/状态' },
  { label: '/计划', cmd: '/计划' },
  { label: '/帮助', cmd: '/帮助' },
  { label: 'DAG 拆解', fill: STARTER_CARDS[0]!.prompt },
  { label: '网页+自检', fill: STARTER_CARDS[1]!.prompt },
  { label: '周五周报', fill: STARTER_CARDS[2]!.prompt },
]

export function Director() {
  const sessionsPoll = usePoll<{ status: any; items: SessionItem[]; pendingActions: PendingAct[] }>('api/director/sessions', 4000)
  const missionsPoll = usePoll<MissionListResponse>('api/missions?limit=12', 4000)
  const projectsPoll = usePoll<{ items: { id: string; name: string; status: string }[] }>('api/projects', 30000)
  const { board } = useLive()

  const [selectedId, setSelectedId] = useState<string>('')
  const [detail, setDetail] = useState<{ session: SessionItem; messages: DirMessage[]; pendingActions: PendingAct[]; followups?: PendingFollowup[] } | null>(null)
  const [detailErr, setDetailErr] = useState('')
  const [input, setInput] = useState('')
  const [syncWechat, setSyncWechat] = useState(true)
  const [sending, setSending] = useState(false)
  const [streamEvents, setStreamEvents] = useState<DirectorProgressEvent[]>([])

  // 移动端三段切换视图（默认直接进入对话主区）
  const [mobilePane, setMobilePane] = useState<'chat' | 'sessions' | 'ops'>('chat')
  // 需求上下文约束抽屉（可折叠，保持输入区清爽）
  const [ctxOpen, setCtxOpen] = useState(false)
  const [bindProjectId, setBindProjectId] = useState('')
  const [bindMode, setBindMode] = useState<ProjectWorkspaceMode>('worktree')
  const [strategy, setStrategy] = useState<'auto' | 'plan_first' | 'council_first'>('auto')
  const [requireVerify, setRequireVerify] = useState(true)
  const [showOps, setShowOps] = useState(true)
  // 会话列表与单会话消息的批量管理状态
  const [manageSessions, setManageSessions] = useState(false)
  const [pickedSessions, setPickedSessions] = useState<string[]>([])
  const [removedSessionIds, setRemovedSessionIds] = useState<string[]>([])
  const [manageMsgs, setManageMsgs] = useState(false)
  const [pickedMsgIds, setPickedMsgIds] = useState<number[]>([])
  // 手机端沉浸聊天控制：快捷工具抽屉、会话更多操作菜单、回到底部悬浮提示
  const [toolsOpen, setToolsOpen] = useState(false)
  const [chatMenuOpen, setChatMenuOpen] = useState(false)
  const [showJumpBottom, setShowJumpBottom] = useState(false)

  const { busy, run } = useAction()
  const feedRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const stickToBottomRef = useRef(true)
  const lastSessionScrolledRef = useRef('')
  const lastMsgIdRef = useRef(0)

  const scrollToBottom = (behavior: 'auto' | 'smooth' = 'auto') => {
    const el = feedRef.current
    if (!el) return
    stickToBottomRef.current = true
    setShowJumpBottom(false)
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    // 距离超过 2 屏时直接瞬时定位，避免长对话 smooth 滚动慢吞吞或中途反复触发回底按钮
    if (behavior === 'smooth' && dist <= el.clientHeight * 2 && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }

  const onFeedScroll = () => {
    const el = feedRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = dist <= 88
    stickToBottomRef.current = nearBottom
    setShowJumpBottom(!nearBottom && el.scrollHeight > el.clientHeight + 120)
  }

  const rawItems = sessionsPoll.d?.items ?? []
  const items = removedSessionIds.length > 0
    ? rawItems.filter(s => !removedSessionIds.includes(s.id))
    : rawItems
  const st = sessionsPoll.d?.status
  const globalPending = sessionsPoll.d?.pendingActions ?? []
  const missions = missionsPoll.d?.items ?? []
  const readyProjects = (projectsPoll.d?.items ?? []).filter(p => p.status === 'ready')

  const waitingApprovals = missions.reduce(
    (sum, m) => sum + m.nodes.filter(n => n.status === 'waiting_approval').length,
    0,
  )
  const opsAttention = waitingApprovals + globalPending.length
  const activeMissionsCount = missions.filter(m => m.status === 'running' || m.status === 'draft').length

  // 当后端轮询数据已不再包含被删会话时，自动释放乐观隐藏集合
  useEffect(() => {
    if (removedSessionIds.length === 0) return
    const rawSet = new Set(rawItems.map(s => s.id))
    const stillPending = removedSessionIds.filter(id => rawSet.has(id))
    if (stillPending.length !== removedSessionIds.length) setRemovedSessionIds(stillPending)
  }, [rawItems, removedSessionIds])

  useEffect(() => {
    if (selectedId && items.length > 0 && !items.some(s => s.id === selectedId)) {
      const next = items.find(s => s.channel === 'web') ?? items[0]!
      setSelectedId(next.id)
      return
    }
    if (selectedId && sessionsPoll.d && items.length === 0) {
      setSelectedId('')
      setDetail(null)
      return
    }
    if (!selectedId && items.length > 0) {
      const preferred = items.find(s => s.channel === 'web') ?? items.find(s => s.channel === 'wechat') ?? items[0]!
      setSelectedId(preferred.id)
    }
  }, [items, selectedId, sessionsPoll.d])

  useEffect(() => {
    if (pickedSessions.length === 0) return
    const valid = new Set(items.map(s => s.id))
    const next = pickedSessions.filter(id => valid.has(id))
    if (next.length !== pickedSessions.length) setPickedSessions(next)
  }, [items, pickedSessions])

  useEffect(() => {
    setManageMsgs(false)
    setPickedMsgIds([])
  }, [selectedId])

  const loadDetail = async (sid: string) => {
    if (!sid) { setDetail(null); return }
    try {
      const res = await get<any>(`api/director/sessions/${encodeURIComponent(sid)}`)
      setDetail(res)
      setDetailErr('')
    } catch (e: any) {
      if (e?.status === 404) {
        setDetail(null)
        setDetailErr('')
        return
      }
      setDetailErr(e?.message || '读取会话详情失败')
    }
  }

  useEffect(() => {
    if (!selectedId) return
    void loadDetail(selectedId)
    const t = setInterval(() => void loadDetail(selectedId), 4000)
    return () => clearInterval(t)
  }, [selectedId])

  useEffect(() => () => { abortRef.current?.abort() }, [])

  const activeSession = detail?.session ?? items.find(s => s.id === selectedId)
  const messages = detail?.messages ?? []
  const visibleMessages = messages.filter(m => m.role !== 'tool')
  const lastMsgId = visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1]!.id : 0
  const detailSessionId = detail?.session?.id ?? ''

  // 切换会话时重置滚底标记与更多菜单
  useEffect(() => {
    setChatMenuOpen(false)
    lastSessionScrolledRef.current = ''
    lastMsgIdRef.current = 0
    stickToBottomRef.current = true
    setShowJumpBottom(false)
  }, [selectedId])

  // 打开总控页 / 首次加载历史消息 / 切回手机端「对话」分栏 / 收到新消息或流式进度时自动定位到最新内容
  useLayoutEffect(() => {
    if (mobilePane !== 'chat') return
    if (!detailSessionId && !sending) return
    const sessionKey = `${detailSessionId}:${mobilePane}`
    const isInitialForSession = lastSessionScrolledRef.current !== sessionKey && visibleMessages.length > 0
    const hasNewMessage = lastMsgId > lastMsgIdRef.current

    if (isInitialForSession) {
      lastSessionScrolledRef.current = sessionKey
      lastMsgIdRef.current = lastMsgId
      scrollToBottom('auto')
      const raf = requestAnimationFrame(() => scrollToBottom('auto'))
      return () => cancelAnimationFrame(raf)
    }

    if (hasNewMessage || sending) {
      lastMsgIdRef.current = lastMsgId
      if (stickToBottomRef.current || sending) {
        const raf = requestAnimationFrame(() => scrollToBottom(sending ? 'auto' : 'smooth'))
        return () => cancelAnimationFrame(raf)
      }
    }
  }, [detailSessionId, visibleMessages.length, lastMsgId, sending, streamEvents.length, mobilePane])

  // 手机端软键盘弹出导致可视高度变化时，若原本停留在最新位置则继续紧贴底部
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      if (mobilePane === 'chat' && stickToBottomRef.current) {
        scrollToBottom('auto')
      }
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [mobilePane])

  // 聊天输入框单行起跳、随内容自动增高（最多 ~4 行），把首屏高度留给聊天记录
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const maxH = window.innerWidth < 900 ? 104 : 140
    ta.style.height = `${Math.min(maxH, Math.max(40, ta.scrollHeight))}px`
  }, [input])

  const toolResultMap = new Map<string, DirMessage>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) toolResultMap.set(m.toolCallId, m)
  }

  const composeWithContext = (raw: string): string => {
    if (raw.startsWith('/')) return raw
    const hints: string[] = []
    if (bindProjectId) {
      const proj = readyProjects.find(p => p.id === bindProjectId)
      hints.push(`目标项目：${proj ? `${proj.name} (${proj.id})` : bindProjectId}，挂载模式：${bindMode}`)
    }
    if (strategy === 'plan_first') hints.push('执行策略：请先通过 mission_create(autoStart:false) 生成 DAG 方案供我确认，不要立即启动')
    if (strategy === 'council_first') hints.push('执行策略：请先发起多角色会商（council_start）敲定方案再实施')
    if (requireVerify && (bindProjectId || strategy !== 'auto')) {
      hints.push('验收要求：必须建立任务约定并附带客观验收证据（测试命令/浏览器自检/数据核对）后方可交付')
    }
    if (hints.length === 0) return raw
    return `[需求上下文约束]\n- ${hints.join('\n- ')}\n\n${raw}`
  }

  const activeContextTags: string[] = []
  if (bindProjectId) {
    const pName = readyProjects.find(p => p.id === bindProjectId)?.name || bindProjectId
    activeContextTags.push(`${pName} · ${bindMode}`)
  }
  if (strategy === 'plan_first') activeContextTags.push('先出 DAG 方案')
  if (strategy === 'council_first') activeContextTags.push('先多角色会商')

  const stopSending = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setSending(false)
    setStreamEvents([])
    toast('已中止当前推理')
  }

  /** 通过 SSE 流式发送消息并实时渲染思考与工具调用进度，异常时优雅回退普通 POST。 */
  const sendMessage = async (overrideText?: string) => {
    const raw = (overrideText ?? input).trim()
    if (!raw || sending) return
    const text = overrideText ? raw : composeWithContext(raw)
    setSending(true)
    setStreamEvents([])
    setMobilePane('chat')
    setToolsOpen(false)
    setChatMenuOpen(false)
    stickToBottomRef.current = true
    if (!overrideText) setInput('')
    requestAnimationFrame(() => scrollToBottom('auto'))

    const targetChannel = activeSession?.channel ?? 'web'
    const targetUserId = activeSession?.userId ?? 'console'
    const imChannel = targetChannel === 'wechat' || targetChannel === 'feishu'
    const payload = {
      text,
      channel: targetChannel,
      userId: targetUserId,
      deliverToWechat: imChannel ? syncWechat : false,
    }

    const ctl = new AbortController()
    abortRef.current = ctl

    try {
      let finalResult: any = null
      const resp = await fetch(API('api/director/chat/stream'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-sa-request': '1' },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      })

      if (resp.status === 401) {
        window.dispatchEvent(new Event('sa-401'))
        throw new Error('登录已失效，请重新登录。')
      }

      if (resp.ok && resp.body && (resp.headers.get('content-type') || '').includes('text/event-stream')) {
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const chunks = buf.split('\n\n')
          buf = chunks.pop() ?? ''
          for (const chunk of chunks) {
            const dataLine = chunk.split('\n').find(l => l.startsWith('data:'))
            if (!dataLine) continue
            try {
              const ev = JSON.parse(dataLine.slice(5).trim()) as DirectorProgressEvent
              if (ev.type === 'done') finalResult = ev.result
              else if (ev.type === 'error') throw new Error(ev.message)
              else setStreamEvents(prev => [...prev.slice(-14), ev])
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message && !parseErr.message.includes('JSON')) throw parseErr
            }
          }
        }
      } else {
        finalResult = await post('api/director/chat', payload)
      }

      if (imChannel && syncWechat && finalResult) {
        const label = CHANNEL_LABEL[targetChannel] || targetChannel
        if (finalResult.wechatDelivered === true) toast(`回复已同步推送到${label}`)
        else if (finalResult.wechatDelivered === false) toast(`回复已生成，但推送${label}失败：${finalResult.wechatError || '未知错误'}`, true)
      }
      if (finalResult?.sessionId) {
        setSelectedId(finalResult.sessionId)
        await loadDetail(finalResult.sessionId)
      }
      sessionsPoll.reload()
      missionsPoll.reload()
      requestAnimationFrame(() => scrollToBottom('smooth'))
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        toast(e?.message || '发送失败', true)
        if (!overrideText) setInput(raw)
      }
    } finally {
      if (abortRef.current === ctl) abortRef.current = null
      setSending(false)
      setStreamEvents([])
    }
  }

  const startWebChat = () => {
    const existing = items.find(s => s.channel === 'web' && s.userId === 'console')
    if (existing) {
      setSelectedId(existing.id)
      setMobilePane('chat')
      return
    }
    void sendMessage('/状态')
  }

  const pickSession = (id: string) => {
    setSelectedId(id)
    setMobilePane('chat')
  }

  const fillInput = (text: string) => {
    setInput(text)
    setMobilePane('chat')
    setTimeout(() => textareaRef.current?.focus(), 40)
  }

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast('已复制到剪贴板'),
      () => toast('当前环境无法自动复制', true),
    )
  }

  const resetCurrent = async () => {
    if (!selectedId) return
    if (!await confirmAction('清空当前会话的短期记忆？历史审计记录会保留，仅重新开始对话上下文。', { title: '开启新对话', okLabel: '确认清空' })) return
    await run(() => post(`api/director/sessions/${encodeURIComponent(selectedId)}/reset`, {}), '已开启新对话', () => {
      void loadDetail(selectedId)
      sessionsPoll.reload()
    })
  }

  const toggleSessionPick = (id: string) => {
    setPickedSessions(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const toggleAllSessions = () => {
    if (pickedSessions.length === items.length) setPickedSessions([])
    else setPickedSessions(items.map(s => s.id))
  }

  const deletePickedSessions = async () => {
    if (pickedSessions.length === 0) return
    const count = pickedSessions.length
    if (!await confirmAction(`永久删除已选中的 ${count} 个总控对话及其全部历史消息？此操作不可撤销。`, { title: '批量删除对话', okLabel: `删除 ${count} 个`, danger: true })) return
    const toDelete = [...pickedSessions]
    await run(async () => {
      const r = await post('api/director/sessions/batch-delete', { ids: toDelete })
      toast(`已删除 ${r?.deleted ?? count} 个对话会话`)
    }, undefined, () => {
      setRemovedSessionIds(prev => [...new Set([...prev, ...toDelete])])
      if (selectedId && toDelete.includes(selectedId)) {
        setSelectedId('')
        setDetail(null)
      }
      setPickedSessions([])
      setManageSessions(false)
      sessionsPoll.reload()
    })
  }

  const deleteCurrentSession = async () => {
    if (!selectedId) return
    const title = activeSession?.title || activeSession?.userId || selectedId
    if (!await confirmAction(`永久删除对话「${title}」及其全部消息记录？此操作不可撤销。`, { title: '删除对话', okLabel: '永久删除', danger: true })) return
    const targetId = selectedId
    await run(() => del(`api/director/sessions/${encodeURIComponent(targetId)}`), '已删除当前对话', () => {
      setRemovedSessionIds(prev => [...new Set([...prev, targetId])])
      setSelectedId('')
      setDetail(null)
      setPickedSessions(prev => prev.filter(x => x !== targetId))
      sessionsPoll.reload()
    })
  }

  const toggleMsgPick = (id: number) => {
    setPickedMsgIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const toggleAllMsgs = () => {
    if (pickedMsgIds.length === visibleMessages.length) setPickedMsgIds([])
    else setPickedMsgIds(visibleMessages.map(m => m.id))
  }

  const deletePickedMsgs = async () => {
    if (!selectedId || pickedMsgIds.length === 0) return
    const count = pickedMsgIds.length
    if (!await confirmAction(`永久删除已勾选的 ${count} 条消息记录？对应工具调用明细也会一并清理。`, { title: '批量删除消息', okLabel: `删除 ${count} 条`, danger: true })) return
    const targetSessionId = selectedId
    const ids = [...pickedMsgIds]
    await run(async () => {
      const r = await post(`api/director/sessions/${encodeURIComponent(targetSessionId)}/messages/batch-delete`, { messageIds: ids })
      toast(`已删除 ${r?.deleted ?? count} 条消息`)
    }, undefined, () => {
      setPickedMsgIds([])
      setManageMsgs(false)
      void loadDetail(targetSessionId)
      sessionsPoll.reload()
    })
  }

  const decideAction = (id: string, decision: 'approve' | 'reject') => run(async () => {
    const r = await post(`api/director/actions/${encodeURIComponent(id)}/decide`, { decision })
    toast(r?.message || (decision === 'approve' ? '已批准执行' : '已拒绝'), !r?.ok)
  }, undefined, () => {
    sessionsPoll.reload()
    if (selectedId) void loadDetail(selectedId)
  })

  const cancelFollowup = (id: string) => run(async () => {
    await post(`api/director/followups/${encodeURIComponent(id)}/cancel`, {})
    toast(`已取消自动续接 #${id}`)
  }, undefined, () => {
    sessionsPoll.reload()
    if (selectedId) void loadDetail(selectedId)
  })

  const missionOp = (m: MissionRecord, op: 'start' | 'pause' | 'resume' | 'cancel') =>
    run(() => post(`api/missions/${encodeURIComponent(m.id)}/${op}`, {}), '已更新任务计划状态', missionsPoll.reload)

  const approveMissionNode = (m: MissionRecord, node: MissionNodeRecord) =>
    run(() => post(`api/missions/${encodeURIComponent(m.id)}/nodes/${encodeURIComponent(node.key)}/approve`, {
      actorId: 'web:console',
      planVersion: m.planVersion,
      idempotencyKey: `web:${m.id}:${node.key}:v${m.planVersion}`,
      note: '控制台一键批准继续',
    }), `已批准节点「${node.title}」`, missionsPoll.reload)

  const retryMissionNode = (m: MissionRecord, node: MissionNodeRecord) =>
    run(() => post(`api/missions/${encodeURIComponent(m.id)}/nodes/${encodeURIComponent(node.key)}/retry`, {}), `已局部重试「${node.title}」`, missionsPoll.reload)

  const pendingFollowups = (detail?.followups ?? []).filter(f => f.status === 'pending' || f.status === 'running')
  const openTickets = board?.open ?? []

  return <div className="dir" data-mpane={mobilePane}>
    {/* 顶部指挥台页头 */}
    <header className="phead dir__head">
      <div className="dir__titlewrap">
        <div className="dir__titlerow">
          <h1>总控指挥中心</h1>
          {st && <span className="pill" data-tone={st.enabled ? 'run' : 'bad'}>
            {st.enabled ? '在线' : '已关闭'}
          </span>}
        </div>
        <p className="phead__sub only-desktop">自然语言理解需求、并行拆解 DAG 计划、自动绑定任务约定与证据验收</p>
      </div>
      <div className="dir__headactions">
        <button type="button" className="ghost small only-desktop" onClick={() => setShowOps(v => !v)}>
          <Icon name="sidebar" size={15} />
          {showOps ? '收起计划板' : '展开计划板'}
        </button>
        <a className="btn small" href="#/settings/director"><Icon name="settings" size={14} />设置</a>
        <a className="btn small only-desktop" href="#/memory"><Icon name="memory" size={14} />记忆进化</a>
        <a className="btn small only-desktop" href="#/schedules"><Icon name="schedules" size={14} />定时巡检</a>
      </div>
    </header>

    {/* 顶部运行指标条（PC 网格 / 手机横向滚动胶囊条） */}
    {st && <div className="dir__stats" aria-label="总控运行指标">
      <div className="dir__stat"><span>总控模型</span><b className="mono">{st.model || '—'}</b></div>
      <div className="dir__stat"><span>今日花费</span><b>{money(st.todayUsd || 0)}{st.dailyUsd > 0 ? <small className="meta"> / {money(st.dailyUsd)}</small> : null}</b></div>
      <div className="dir__stat"><span>活跃计划</span><b>{activeMissionsCount} 个</b></div>
      <div className="dir__stat"><span>进行中工单</span><b>{openTickets.length} 张</b></div>
      <div className="dir__stat"><span>主动汇报</span><b>{SCOPE_LABEL[st.notifyScope] || st.notifyScope}</b></div>
      <div className={opsAttention > 0 ? 'dir__stat is-alert' : 'dir__stat'}>
        <span>待审批事项</span>
        <b>{opsAttention > 0 ? `${opsAttention} 项待确认` : '全部畅通'}</b>
      </div>
    </div>}

    {/* 高危二次确认横幅（全局可见） */}
    {globalPending.length > 0 && <section className="dir__pending" aria-label="待确认高危操作">
      <div className="sechead">
        <h2>待确认的高危操作</h2>
        <span className="sechead__note">回复「/确认 短码」或点击按钮</span>
      </div>
      {globalPending.map(act => <div key={act.id} className="card dir__act">
        <div className="dir__actmain">
          <p className="dir__acttitle"><span className="pill" data-tone="human">#{act.id}</span> <b>{act.toolName}</b></p>
          <p>{act.summary}</p>
          <p className="meta">发起于 {ago(act.createdAt)} · 过期 {new Date(act.expiresAt).toLocaleTimeString()}</p>
        </div>
        <div className="dir__actbtns">
          <button type="button" className="primary" disabled={busy} onClick={() => decideAction(act.id, 'approve')}>批准执行</button>
          <button type="button" className="danger" disabled={busy} onClick={() => decideAction(act.id, 'reject')}>拒绝</button>
        </div>
      </div>)}
    </section>}

    {/* 手机端专属三段视图切换栏（PC 端自动隐藏） */}
    <div className="dir__mnav" role="tablist" aria-label="总控视图切换">
      <button type="button" role="tab" aria-selected={mobilePane === 'chat'} className={mobilePane === 'chat' ? 'is-on' : ''} onClick={() => setMobilePane('chat')}>
        对话{sending ? ' · 推理中' : ''}
      </button>
      <button type="button" role="tab" aria-selected={mobilePane === 'sessions'} className={mobilePane === 'sessions' ? 'is-on' : ''} onClick={() => setMobilePane('sessions')}>
        会话 ({items.length})
      </button>
      <button type="button" role="tab" aria-selected={mobilePane === 'ops'} className={mobilePane === 'ops' ? 'is-on' : ''} onClick={() => setMobilePane('ops')}>
        计划板 ({missions.length})
        {opsAttention > 0 && <span className="nb need">{opsAttention}</span>}
      </button>
    </div>

    {/* 主三栏工作区（纯 CSS Grid 响应式，绝不写内联 gridTemplateColumns） */}
    <div className={showOps ? 'dir__layout has-ops' : 'dir__layout'}>
      {/* 左栏：会话列表（支持多选批量删除） */}
      <aside className="dir__side dir__pane-sessions">
        <div className="dir__sidehead">
          <b>会话列表</b>
          <div className="dir__sideacts">
            {items.length > 0 && (
              <button
                type="button"
                className={manageSessions ? 'ghost small is-active' : 'ghost small'}
                disabled={busy}
                onClick={() => {
                  setManageSessions(v => {
                    if (v) setPickedSessions([])
                    return !v
                  })
                }}
              >
                {manageSessions ? '完成' : '批量删除'}
              </button>
            )}
            {!manageSessions && <button type="button" className="ghost small" onClick={startWebChat}>＋ 新建</button>}
          </div>
        </div>
        {manageSessions && items.length > 0 && <div className="dir__bulkbar" role="region" aria-label="会话批量操作">
          <label className="dir__checkall">
            <input
              type="checkbox"
              checked={pickedSessions.length === items.length && items.length > 0}
              onChange={toggleAllSessions}
            />
            <span>{pickedSessions.length === items.length ? '取消全选' : '全选'} ({pickedSessions.length}/{items.length})</span>
          </label>
          <button
            type="button"
            className="danger small"
            disabled={busy || pickedSessions.length === 0}
            onClick={() => void deletePickedSessions()}
          >
            删除 ({pickedSessions.length})
          </button>
        </div>}
        {items.length === 0
          ? <Empty>还没有总控对话。直接在对话区输入目标即可开始。</Empty>
          : <div className="dir__sessions">
            {items.map(s => {
              const picked = pickedSessions.includes(s.id)
              const cls = [
                'dir__sess',
                !manageSessions && s.id === selectedId ? 'is-on' : '',
                manageSessions && picked ? 'is-picked' : '',
              ].filter(Boolean).join(' ')
              return <button
                key={s.id}
                type="button"
                className={cls}
                onClick={() => manageSessions ? toggleSessionPick(s.id) : pickSession(s.id)}
              >
                <div className="dir__sesstop">
                  {manageSessions && <input
                    type="checkbox"
                    className="dir__chk"
                    checked={picked}
                    onChange={() => toggleSessionPick(s.id)}
                    onClick={e => e.stopPropagation()}
                    aria-label={`选择会话 ${s.title || s.userId}`}
                  />}
                  <span className="dir__tag">{CHANNEL_LABEL[s.channel] || s.channel}</span>
                  <b>{s.title || s.userId}</b>
                  {s.pendingActions > 0 && <span className="nb need">{s.pendingActions}</span>}
                </div>
                <span className="meta dir__preview">{s.lastMessage || '（新会话）'}</span>
                <span className="meta">{s.messageCount} 条 · {ago(s.updatedAt)}</span>
              </button>
            })}
          </div>}
      </aside>

      {/* 中栏：核心流式对话区 */}
      <section className="dir__chat dir__pane-chat">
        <div className="dir__chathead">
          <div className="dir__chatinfo">
            <div className="dir__chattitle">
              {st && <i className={st.enabled ? 'dir__dot is-on' : 'dir__dot'} aria-hidden="true" />}
              <b>{activeSession ? (activeSession.title || activeSession.userId) : '新网页对话'}</b>
            </div>
            <span className="meta only-desktop">
              {activeSession ? `通道：${CHANNEL_LABEL[activeSession.channel] || activeSession.channel}` : '直接交代目标，总控自动建立会话'}
              {activeSession?.focusTicketId && <> · 聚焦：<a href={`#/tickets/${encodeURIComponent(activeSession.focusTicketId)}`}>{activeSession.focusTicketId.slice(0, 10)}</a></>}
            </span>
          </div>
          {/* 桌面端平铺操作按钮 */}
          <div className="dir__chattools only-desktop">
            {activeSession && (activeSession.channel === 'wechat' || activeSession.channel === 'feishu') && (
              <label className="dir__synclabel">
                <input type="checkbox" checked={syncWechat} onChange={e => setSyncWechat(e.target.checked)} />
                同步{CHANNEL_LABEL[activeSession.channel]}
              </label>
            )}
            <button type="button" className="ghost small" disabled={sending} onClick={() => void sendMessage('/状态')}>/状态</button>
            {activeSession && visibleMessages.length > 0 && (
              <button
                type="button"
                className={manageMsgs ? 'ghost small is-active' : 'ghost small'}
                disabled={busy || sending}
                onClick={() => {
                  setManageMsgs(v => {
                    if (v) setPickedMsgIds([])
                    return !v
                  })
                }}
              >
                {manageMsgs ? '退出清理' : '删消息'}
              </button>
            )}
            {activeSession && <button type="button" className="ghost small" disabled={busy || sending} onClick={resetCurrent}>新对话</button>}
            {activeSession && <button type="button" className="ghost small danger" disabled={busy || sending} onClick={() => void deleteCurrentSession()}>删除会话</button>}
          </div>
          {/* 手机端极简单行操作（把垂直空间留给对话消息） */}
          <div className="dir__chattools only-mobile">
            {activeSession && (
              <button type="button" className="ghost small" disabled={busy || sending} onClick={resetCurrent}>新对话</button>
            )}
            <button
              type="button"
              className={chatMenuOpen ? 'ghost small is-active dir__morebtn' : 'ghost small dir__morebtn'}
              aria-label="更多会话操作"
              aria-expanded={chatMenuOpen}
              onClick={() => setChatMenuOpen(v => !v)}
            >
              ⋯
            </button>
          </div>
        </div>

        {/* 手机端展开的会话操作条 */}
        {chatMenuOpen && <div className="dir__mactions only-mobile">
          {activeSession && (activeSession.channel === 'wechat' || activeSession.channel === 'feishu') && (
            <label className="dir__synclabel">
              <input type="checkbox" checked={syncWechat} onChange={e => setSyncWechat(e.target.checked)} />
              同步{CHANNEL_LABEL[activeSession.channel]}
            </label>
          )}
          {activeSession && visibleMessages.length > 0 && (
            <button
              type="button"
              className={manageMsgs ? 'ghost small is-active' : 'ghost small'}
              disabled={busy || sending}
              onClick={() => {
                setManageMsgs(v => {
                  if (v) setPickedMsgIds([])
                  return !v
                })
                setChatMenuOpen(false)
              }}
            >
              {manageMsgs ? '退出删消息' : '批量删消息'}
            </button>
          )}
          {activeSession && (
            <button
              type="button"
              className="ghost small danger"
              disabled={busy || sending}
              onClick={() => { setChatMenuOpen(false); void deleteCurrentSession() }}
            >
              删除会话
            </button>
          )}
          <a className="btn small" href="#/settings/director" onClick={() => setChatMenuOpen(false)}>总控设置</a>
        </div>}

        {manageMsgs && visibleMessages.length > 0 && <div className="dir__bulkbar" role="region" aria-label="消息批量删除">
          <label className="dir__checkall">
            <input
              type="checkbox"
              checked={pickedMsgIds.length === visibleMessages.length && visibleMessages.length > 0}
              onChange={toggleAllMsgs}
            />
            <span>{pickedMsgIds.length === visibleMessages.length ? '取消全选' : '全选消息'} ({pickedMsgIds.length}/{visibleMessages.length})</span>
          </label>
          <div className="dir__bulkacts">
            <button
              type="button"
              className="danger small"
              disabled={busy || pickedMsgIds.length === 0}
              onClick={() => void deletePickedMsgs()}
            >
              删除所选 ({pickedMsgIds.length})
            </button>
            <button type="button" className="ghost small" onClick={() => { setManageMsgs(false); setPickedMsgIds([]) }}>取消</button>
          </div>
        </div>}

        {activeSession?.summary && <details className="dir__summary">
          <summary>早期记忆摘要（已压缩）</summary>
          <p>{activeSession.summary}</p>
        </details>}

        {pendingFollowups.length > 0 && <div className="dir__summary">
          <b>已登记的自动续接（{pendingFollowups.length}）</b>
          {pendingFollowups.map(fw => <div key={fw.id} className="dir__fwrow">
            <span>
              <span className="dir__tag">{fw.status === 'running' ? '续接中' : '等完工'}</span>{' '}
              <code className="mono">{fw.targetId.slice(0, 12)}</code> → {fw.instruction}
            </span>
            {fw.status === 'pending' && <button type="button" className="ghost small danger" disabled={busy} onClick={() => cancelFollowup(fw.id)}>取消</button>}
          </div>)}
        </div>}

        {detailErr && <p className="warn" style={{ margin: '4px 0' }}>{detailErr}</p>}

        {/* 消息流（默认贴底展示最新内容，上翻查看历史时浮现回底胶囊） */}
        <div className="dir__feedwrap">
        <div className="dir__feed" ref={feedRef} onScroll={onFeedScroll}>
          {visibleMessages.length === 0 && !sending && <div className="dir__welcome">
            <div className="dir__welcome-head">
              <div className="dir__avatar is-lg"><Icon name="director" size={22} /></div>
              <div>
                <h3>把任务目标直接交给我</h3>
                <p className="meta">我会结合实时平台态势、项目源码和你的长期偏好自动规划、派单、自检并交付。</p>
              </div>
            </div>
            <div className="dir__starters">
              {STARTER_CARDS.map(card => <button
                key={card.title}
                type="button"
                className="dir__starter"
                onClick={() => card.sendNow ? void sendMessage(card.prompt) : fillInput(card.prompt)}
              >
                <div className="dir__starter-top">
                  <b>{card.title}</b>
                  <span className="dir__tag">{card.tag}</span>
                </div>
                <span className="meta">{card.desc}</span>
              </button>)}
            </div>
          </div>}

          {visibleMessages.map(m => {
            const picked = pickedMsgIds.includes(m.id)
            const wrapMsg = (node: ReactNode, alignRight = false) => {
              if (!manageMsgs) return node
              return <div
                key={m.id}
                className={[
                  'dir__msgpick',
                  alignRight ? 'is-right' : '',
                  picked ? 'is-picked' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => toggleMsgPick(m.id)}
              >
                <input
                  type="checkbox"
                  className="dir__chk"
                  checked={picked}
                  onChange={() => toggleMsgPick(m.id)}
                  onClick={e => e.stopPropagation()}
                  aria-label={`选择消息 #${m.id}`}
                />
                {node}
              </div>
            }

            if (m.role === 'event') {
              return wrapMsg(<div key={m.id} className={m.archived ? 'dir__event is-arch' : 'dir__event'}>
                <div className="dir__eventhead">
                  <span className="dir__tag">平台动态</span>
                  <span className="meta">{ago(m.createdAt)}</span>
                </div>
                <div className="dir__eventbody"><Markdown text={m.content} /></div>
              </div>)
            }
            if (m.role === 'user') {
              return wrapMsg(<div key={m.id} className={m.archived ? 'dir__msg is-user is-arch' : 'dir__msg is-user'}>
                <div className="dir__bubble">{m.content}</div>
                <span className="meta">{ago(m.createdAt)}</span>
              </div>, true)
            }
            const calls = m.toolCalls ?? []
            return wrapMsg(<div key={m.id} className={m.archived ? 'dir__msg is-ai is-arch' : 'dir__msg is-ai'}>
              {calls.length > 0 && <details className="dir__tools">
                <summary>
                  <span className="dir__tools-dot" aria-hidden="true" />
                  <span>调用 {calls.length} 项工具：{calls.map(c => {
                    const act = typeof c.arguments?.action === 'string' ? c.arguments.action : ''
                    return act ? `${c.name}(${act})` : c.name
                  }).join('、')}</span>
                </summary>
                <div className="dir__toollist">
                  {calls.map(c => {
                    const res = toolResultMap.get(c.id)
                    const ok = res?.meta?.ok !== false
                    return <div key={c.id} className="dir__toolitem">
                      <div className="dir__toolhead">
                        <b className="mono">{c.name}{typeof c.arguments?.action === 'string' ? `.${c.arguments.action}` : ''}</b>
                        <span className="pill" data-tone={ok ? 'done' : 'bad'}>
                          {ok ? '成功' : '失败'}{typeof res?.meta?.ms === 'number' ? ` · ${res.meta.ms}ms` : ''}
                        </span>
                      </div>
                      <pre className="mono">{JSON.stringify(c.arguments ?? {}, null, 2)}</pre>
                      {res && <pre className="mono dir__toolout">{res.content.slice(0, 1200)}{res.content.length > 1200 ? '\n…（已折叠）' : ''}</pre>}
                    </div>
                  })}
                </div>
              </details>}
              {m.content && <div className="dir__bubble">
                <Markdown text={m.content} />
              </div>}
              <div className="dir__msgfoot">
                <span className="meta">
                  {ago(m.createdAt)}
                  {typeof m.meta?.model === 'string' && ` · ${m.meta.model}`}
                  {typeof m.meta?.toolsCount === 'number' && m.meta.toolsCount > 0 && ` · ${m.meta.toolsCount} 次工具`}
                </span>
                {m.content && !manageMsgs && <button type="button" className="dir__copybtn" onClick={() => copyText(m.content)} title="复制回复">
                  <Icon name="copy" size={13} />复制
                </button>}
              </div>
            </div>)
          })}

          {sending && <div className="dir__msg is-ai">
            <div className="dir__bubble dir__streamcard">
              <div className="dir__streamhead">
                <span className="dir__pulse" aria-hidden="true" />
                <b>总控正在实时推理与调度…</b>
                <button type="button" className="ghost small danger" onClick={stopSending}>停止</button>
              </div>
              {streamEvents.length > 0 && <ul className="dir__streamlist">
                {streamEvents.map((ev, i) => <li key={i}>
                  {ev.type === 'start' && `已连接总控模型 ${ev.model || ''}`}
                  {ev.type === 'thinking' && `第 ${ev.step} 轮：${ev.message}`}
                  {ev.type === 'tool_start' && `调用 ${ev.name}${ev.action ? `(${ev.action})` : ''}…`}
                  {ev.type === 'tool_done' && `${ev.ok ? '✓' : '✗'} ${ev.name}${ev.action ? `(${ev.action})` : ''} (${ev.ms}ms)：${ev.summary}`}
                </li>)}
              </ul>}
            </div>
          </div>}
          <div ref={bottomRef} />
        </div>
        {showJumpBottom && (
          <button type="button" className="dir__jump" onClick={() => scrollToBottom('smooth')} aria-label="回到底部最新消息">
            ↓ 回到最新
          </button>
        )}
        </div>

        {/* 底部输入控制区（桌面常驻快捷芯片；手机默认单行极简输入，点 ＋ 展开快捷指令与约束） */}
        <div className="dir__dock">
          <div className={toolsOpen || activeContextTags.length > 0 ? 'dir__chipbar is-open' : 'dir__chipbar'}>
            <button
              type="button"
              className={ctxOpen || activeContextTags.length > 0 ? 'dir__chip is-active' : 'dir__chip'}
              onClick={() => setCtxOpen(v => !v)}
            >
              <Icon name="settings" size={13} />
              约束{activeContextTags.length > 0 ? ` (${activeContextTags.length})` : ''}
            </button>
            {activeContextTags.map(tag => <span key={tag} className="dir__ctxtag">{tag}</span>)}
            {QUICK_CHIPS.map(ch => <button
              key={ch.label}
              type="button"
              className="dir__chip"
              disabled={sending}
              onClick={() => {
                if (ch.cmd) {
                  void sendMessage(ch.cmd)
                } else {
                  setToolsOpen(false)
                  fillInput(ch.fill || '')
                }
              }}
            >
              {ch.label}
            </button>)}
          </div>

          {ctxOpen && <div className="dir__ctxpanel">
            <label className="dir__ctxfield">
              <span>目标项目</span>
              <select value={bindProjectId} onChange={e => setBindProjectId(e.target.value)}>
                <option value="">不限定项目</option>
                {readyProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {bindProjectId && <label className="dir__ctxfield">
              <span>代码模式</span>
              <select value={bindMode} onChange={e => setBindMode(e.target.value as ProjectWorkspaceMode)}>
                <option value="worktree">worktree 隔离分支（推荐）</option>
                <option value="copy">copy 独立副本</option>
                <option value="direct">direct 直接改原件</option>
              </select>
            </label>}
            <label className="dir__ctxfield">
              <span>执行策略</span>
              <select value={strategy} onChange={e => setStrategy(e.target.value as any)}>
                <option value="auto">自动理解并派发</option>
                <option value="plan_first">先出 DAG 方案确认再开工</option>
                <option value="council_first">先多角色会商</option>
              </select>
            </label>
            <label className="dir__ctxcheck">
              <input type="checkbox" checked={requireVerify} onChange={e => setRequireVerify(e.target.checked)} />
              <span>要求客观证据验收</span>
            </label>
          </div>}

          <div className="dir__composer">
            <button
              type="button"
              className={toolsOpen || ctxOpen || activeContextTags.length > 0 ? 'dir__plusbtn is-active only-mobile' : 'dir__plusbtn only-mobile'}
              aria-label={toolsOpen ? '收起快捷工具' : '展开快捷指令与约束'}
              aria-expanded={toolsOpen}
              onClick={() => {
                setToolsOpen(v => {
                  if (v) setCtxOpen(false)
                  return !v
                })
              }}
            >
              {toolsOpen ? '×' : '＋'}
              {activeContextTags.length > 0 && <span className="dir__plusdot" aria-hidden="true" />}
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && input.trim()) { e.preventDefault(); void sendMessage() } }}
              placeholder="发消息给总控助手…"
            />
            {sending
              ? <button type="button" className="dir__sendbtn is-stop" onClick={stopSending} aria-label="停止推理">
                <Icon name="x" size={18} />
                <span>停止</span>
              </button>
              : <button type="button" className="primary dir__sendbtn" disabled={!input.trim()} onClick={() => void sendMessage()} aria-label="发送消息">
                <Icon name="send" size={17} />
                <span>发送</span>
              </button>}
          </div>
        </div>
      </section>

      {/* 右栏：实时 DAG 任务计划板 + 活跃工单 */}
      <aside className="dir__side dir__ops dir__pane-ops">
        {/* 手机端把运行状态概览收进计划板顶部，不挤占聊天对话区高度 */}
        {st && <div className="dir__mstatus only-mobile">
          <div className="dir__mstatus-row">
            <span className="pill" data-tone={st.enabled ? 'run' : 'bad'}>{st.enabled ? '总控在线' : '已关闭'}</span>
            <span className="mono meta">{st.model || '—'}</span>
            <a className="btn small" href="#/settings/director">设置</a>
          </div>
          <div className="dir__mstatus-meta">
            <span>今日 {money(st.todayUsd || 0)}{st.dailyUsd > 0 ? ` / ${money(st.dailyUsd)}` : ''}</span>
            <span>工单 {openTickets.length}</span>
            <span>计划 {activeMissionsCount}</span>
          </div>
        </div>}
        <div className="dir__sidehead">
          <b>DAG 任务计划（{missions.length}）</b>
          <button type="button" className="ghost small" onClick={missionsPoll.reload}>刷新</button>
        </div>
        {missions.length === 0
          ? <Empty>暂无多步骤 DAG 计划。复杂需求发给总控后，会自动拆解为可审批的并行依赖图显示在这里。</Empty>
          : <div className="dir__missions">
            {missions.map(m => {
              const done = m.nodes.filter(n => n.status === 'completed' || n.status === 'skipped').length
              const pct = m.nodes.length > 0 ? Math.round((done / m.nodes.length) * 100) : 0
              return <div key={m.id} className="dir__mcard">
                <div className="dir__mhead">
                  <b>{m.title}</b>
                  <span className="pill" data-tone={MISSION_TONE[m.status]}>v{m.planVersion} · {MISSION_STATUS[m.status]}</span>
                </div>
                <div className="dir__mprog">
                  <div className="dir__mbar"><span style={{ width: `${pct}%` }} /></div>
                  <span className="meta">{done}/{m.nodes.length} ({pct}%)</span>
                </div>
                <div className="dir__mops">
                  {m.status === 'draft' && <button type="button" className="primary small" disabled={busy} onClick={() => missionOp(m, 'start')}>开工</button>}
                  {m.status === 'running' && <button type="button" className="ghost small" disabled={busy} onClick={() => missionOp(m, 'pause')}>暂停</button>}
                  {(m.status === 'paused' || m.status === 'failed') && <button type="button" className="primary small" disabled={busy} onClick={() => missionOp(m, 'resume')}>恢复</button>}
                  {(m.status === 'draft' || m.status === 'running' || m.status === 'paused') && <button type="button" className="ghost small danger" disabled={busy} onClick={() => missionOp(m, 'cancel')}>取消</button>}
                </div>
                <div className="dir__nodes">
                  {m.nodes.map(n => <div key={n.id} className={n.status === 'waiting_approval' ? 'dir__node is-wait' : 'dir__node'}>
                    <div className="dir__nodehead">
                      <span><code className="mono">{n.key}</code> {n.title}</span>
                      <span className="pill" data-tone={NODE_TONE[n.status]}>{NODE_STATUS[n.status]}</span>
                    </div>
                    {n.dependsOn.length > 0 && <div className="meta">依赖：{n.dependsOn.join(', ')}</div>}
                    {n.ticketId && <div className="meta"><a href={`#/tickets/${encodeURIComponent(n.ticketId)}`}>工单 {n.ticketId.slice(0, 10)} →</a></div>}
                    {n.commitSha && <div className="meta">提交：<code className="mono">{n.commitSha.slice(0, 8)}</code></div>}
                    {n.artifacts.length > 0 && <div className="meta">产物：{n.artifacts.slice(0, 2).join('、')}</div>}
                    {n.status === 'waiting_approval' && (
                      <button type="button" className="primary small wide" style={{ marginTop: 6 }} disabled={busy} onClick={() => approveMissionNode(m, n)}>
                        批准继续 (v{m.planVersion})
                      </button>
                    )}
                    {n.status === 'failed' && (
                      <button type="button" className="ghost small" style={{ marginTop: 4 }} disabled={busy} onClick={() => retryMissionNode(m, n)}>
                        局部重试
                      </button>
                    )}
                  </div>)}
                </div>
              </div>
            })}
          </div>}

        {openTickets.length > 0 && <div className="dir__activetks">
          <div className="dir__sidehead">
            <b>活跃工单（{openTickets.length}）</b>
            <a className="ghost small" href="#/tickets">全部 →</a>
          </div>
          <div className="dir__tklist">
            {openTickets.slice(0, 6).map(t => <a key={t.id} className="dir__tkitem" href={`#/tickets/${encodeURIComponent(t.id)}`}>
              <b>{t.title}</b>
              <span className="pill" data-tone={t.needsPerson ? 'human' : 'run'}>{t.needsPerson ? '等你回答' : (t.stageLabel || '运行中')}</span>
            </a>)}
          </div>
        </div>}
      </aside>
    </div>
  </div>
}
