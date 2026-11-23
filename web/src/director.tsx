/**
 * 总控助手主工作台（默认首页 #/director）：
 * - PC 端：左侧宽幅总控主对话画布（~62%）+ 右侧实时任务执行与进度面板（~38%，可折叠）
 * - 手机端：打开即总控对话 + 顶部可展开实时进度条（零臃肿 5 格底栏）
 * - 新开对话支持自由选择「网页对话」或「飞书对话」（自动关联/输入飞书 ID 并默认同步推送）
 * - 完整保留：SSE 流式推理与中途停止、会话历史与批量删除、消息批量删除、高危操作审批、自动续接、上下文约束与 DAG 计划审批
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { API, del, get, post } from './api'
import { usePoll, ago, money } from './hooks'
import { useLive, useTick } from './useLive'
import { Icon } from './icons'
import { Empty, Markdown, Sheet, confirmAction, toast, useAction } from './ui'
import { LiveProgressPanel } from './live-progress'
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

const STARTER_CARDS: { title: string; desc: string; tag: string; prompt: string; sendNow?: boolean }[] = [
  {
    title: '多步 DAG 拆解与并发开发',
    desc: '出方案 → 并行 worktree 子任务 → 汇总测试 → 人工批准',
    tag: 'DAG 编排',
    prompt: '请先分析需求并用 DAG 任务计划拆解：出方案 → 并行子任务（使用 worktree 隔离分支） → 汇总测试 → 等我批准。具体需求如下：\n',
  },
  {
    title: '网页改动 + 浏览器自检交付',
    desc: '修改功能并运行 browser_verify 留证截图与交付回执',
    tag: '研发工厂',
    prompt: '请修改指定项目的网页功能，要求提交表单后刷新页面数据仍然存在，并运行 browser_verify 完成断言与截图留证，最后提交审查与交付回执。具体修改：\n',
  },
  {
    title: '全平台健康与花费体检',
    desc: '一键排查活跃工单、定时巡检、主机负载与今日花费',
    tag: '秒查现状',
    prompt: '请排查当前所有进行中任务、定时巡检状态、今日花费与异常告警，给我一份简明汇总。',
    sendNow: true,
  },
  {
    title: '沉淀我的偏好与工作口径',
    desc: '告诉总控长期习惯，自动写入主人意图画像并持续遵循',
    tag: '越用越懂',
    prompt: '记住我的长期习惯：以后所有汇报先给核心结论再列明细，修改代码前必须先跑单测并附验证结果。',
  },
]

const QUICK_CHIPS: { label: string; cmd?: string; fill?: string }[] = [
  { label: '/状态', cmd: '/状态' },
  { label: '/计划', cmd: '/计划' },
  { label: '/帮助', cmd: '/帮助' },
  { label: 'DAG 拆解', fill: STARTER_CARDS[0]!.prompt },
]

export function Director() {
  const sessionsPoll = usePoll<{ status: any; items: SessionItem[]; pendingActions: PendingAct[] }>('api/director/sessions', 4000)
  const missionsPoll = usePoll<MissionListResponse>('api/missions?limit=12', 4000)
  const projectsPoll = usePoll<{ items: { id: string; name: string; status: string }[] }>('api/projects', 30000)
  const { board } = useLive()
  useTick()

  const [selectedId, setSelectedId] = useState<string>('')
  const [detail, setDetail] = useState<{ session: SessionItem; messages: DirMessage[]; pendingActions: PendingAct[]; followups?: PendingFollowup[] } | null>(null)
  const [detailErr, setDetailErr] = useState('')
  const [input, setInput] = useState('')
  const [syncChannel, setSyncChannel] = useState(true)
  const [sending, setSending] = useState(false)
  const [streamEvents, setStreamEvents] = useState<DirectorProgressEvent[]>([])

  // 面板与抽屉开关
  const [showProgress, setShowProgress] = useState(true)
  const [mobileProgressOpen, setMobileProgressOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatChannel, setNewChatChannel] = useState<'web' | 'feishu'>('web')
  const [newChatTitle, setNewChatTitle] = useState('')
  const [feishuTarget, setFeishuTarget] = useState('')
  const [feishuReset, setFeishuReset] = useState(false)

  // 上下文约束与更多操作
  const [ctxOpen, setCtxOpen] = useState(false)
  const [bindProjectId, setBindProjectId] = useState('')
  const [bindMode, setBindMode] = useState<ProjectWorkspaceMode>('worktree')
  const [strategy, setStrategy] = useState<'auto' | 'plan_first' | 'council_first'>('auto')
  const [requireVerify, setRequireVerify] = useState(true)
  const [chatMenuOpen, setChatMenuOpen] = useState(false)
  const [showJumpBottom, setShowJumpBottom] = useState(false)

  // 会话与消息批量管理
  const [manageSessions, setManageSessions] = useState(false)
  const [pickedSessions, setPickedSessions] = useState<string[]>([])
  const [removedSessionIds, setRemovedSessionIds] = useState<string[]>([])
  const [manageMsgs, setManageMsgs] = useState(false)
  const [pickedMsgIds, setPickedMsgIds] = useState<number[]>([])

  const { busy, run } = useAction()
  const feedRef = useRef<HTMLDivElement>(null)
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
  const feishuSessions = items.filter(s => s.channel === 'feishu')
  const st = sessionsPoll.d?.status
  const globalPending = sessionsPoll.d?.pendingActions ?? []
  const missions = missionsPoll.d?.items ?? []
  const readyProjects = (projectsPoll.d?.items ?? []).filter(p => p.status === 'ready')

  const openTickets = board?.open ?? []
  const needCount = openTickets.filter(t => t.needsPerson).length
  const runningSteps = board?.runningSteps ?? []
  const runningCount = runningSteps.length
  const slotsMax = board?.slots.max ?? 0
  const todayUsd = board?.usage.todayUsd ?? 0
  const waitingApprovals = missions.reduce((sum, m) => sum + m.nodes.filter(n => n.status === 'waiting_approval').length, 0)
  const progressAlertCount = needCount + waitingApprovals

  // 同步外部「新开对话」事件（来自左轨 + 按钮）
  useEffect(() => {
    const onNew = () => openNewChatModal()
    window.addEventListener('sa-director-new-chat', onNew)
    return () => window.removeEventListener('sa-director-new-chat', onNew)
  }, [feishuSessions.length])

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
      const preferred = items.find(s => s.channel === 'web') ?? items.find(s => s.channel === 'feishu') ?? items[0]!
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

  // 承接其他页转交的总控指令
  useEffect(() => {
    try {
      const handoff = sessionStorage.getItem('sa-director-handoff')
      if (handoff && handoff.trim()) {
        sessionStorage.removeItem('sa-director-handoff')
        setInput(handoff)
        setTimeout(() => textareaRef.current?.focus(), 60)
      }
    } catch { /* ignore */ }
  }, [])

  const activeSession = detail?.session ?? items.find(s => s.id === selectedId)
  const messages = detail?.messages ?? []
  const visibleMessages = messages.filter(m => m.role !== 'tool')
  const lastMsgId = visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1]!.id : 0
  const detailSessionId = detail?.session?.id ?? ''

  useEffect(() => {
    setChatMenuOpen(false)
    lastSessionScrolledRef.current = ''
    lastMsgIdRef.current = 0
    stickToBottomRef.current = true
    setShowJumpBottom(false)
  }, [selectedId])

  useLayoutEffect(() => {
    if (!detailSessionId && !sending) return
    const isInitial = lastSessionScrolledRef.current !== detailSessionId && visibleMessages.length > 0
    const hasNew = lastMsgId > lastMsgIdRef.current

    if (isInitial) {
      lastSessionScrolledRef.current = detailSessionId
      lastMsgIdRef.current = lastMsgId
      scrollToBottom('auto')
      const raf = requestAnimationFrame(() => scrollToBottom('auto'))
      return () => cancelAnimationFrame(raf)
    }

    if (hasNew || sending) {
      lastMsgIdRef.current = lastMsgId
      if (stickToBottomRef.current || sending) {
        const raf = requestAnimationFrame(() => scrollToBottom(sending ? 'auto' : 'smooth'))
        return () => cancelAnimationFrame(raf)
      }
    }
  }, [detailSessionId, visibleMessages.length, lastMsgId, sending, streamEvents.length])

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      if (stickToBottomRef.current) scrollToBottom('auto')
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const maxH = window.innerWidth < 900 ? 108 : 152
    ta.style.height = `${Math.min(maxH, Math.max(44, ta.scrollHeight))}px`
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

  const openNewChatModal = () => {
    setNewChatChannel('web')
    setNewChatTitle('')
    setFeishuTarget(feishuSessions[0]?.userId || '')
    setFeishuReset(false)
    setNewChatOpen(true)
  }

  const createNewConversation = async () => {
    if (newChatChannel === 'feishu' && !feishuTarget.trim()) {
      toast('请选择已有飞书会话，或输入飞书接收者 ID（open_id / chat_id）', true)
      return
    }
    await run(async () => {
      const body: Record<string, unknown> = {
        channel: newChatChannel,
        ...(newChatTitle.trim() ? { title: newChatTitle.trim() } : {}),
        ...(newChatChannel === 'feishu' ? { userId: feishuTarget.trim(), resetIfExists: feishuReset } : {}),
      }
      const res = await post<{ ok: boolean; session: SessionItem }>('api/director/sessions', body)
      if (res?.session?.id) {
        setSelectedId(res.session.id)
        if (newChatChannel === 'feishu') setSyncChannel(true)
        await loadDetail(res.session.id)
      }
      setNewChatOpen(false)
      setSessionsOpen(false)
      sessionsPoll.reload()
      setTimeout(() => textareaRef.current?.focus(), 60)
    }, newChatChannel === 'feishu' ? '已开启飞书总控对话（回复将自动同步飞书）' : '已开启全新网页对话')
  }

  const stopSending = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setSending(false)
    setStreamEvents([])
    toast('已中止当前推理')
  }

  const sendMessage = async (overrideText?: string) => {
    const raw = (overrideText ?? input).trim()
    if (!raw || sending) return
    const text = overrideText ? raw : composeWithContext(raw)
    setSending(true)
    setStreamEvents([])
    setChatMenuOpen(false)
    setMobileProgressOpen(false)
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
      deliverToWechat: imChannel ? syncChannel : false,
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

      if (imChannel && syncChannel && finalResult) {
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

  const pickSession = (id: string) => {
    setSelectedId(id)
    setSessionsOpen(false)
  }

  const fillInput = (text: string) => {
    setInput(text)
    setMobileProgressOpen(false)
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
    if (!await confirmAction('清空当前会话的短期记忆？历史审计记录会保留，仅重新开始对话上下文。', { title: '清空上下文', okLabel: '确认清空' })) return
    await run(() => post(`api/director/sessions/${encodeURIComponent(selectedId)}/reset`, {}), '已清空当前对话上下文', () => {
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
  const firstRunning = runningSteps[0]
  const firstRunningTitle = firstRunning ? (openTickets.find(t => t.id === firstRunning.id)?.title || '') : ''

  return <div className={showProgress ? 'studio-dir has-progress' : 'studio-dir'}>
    {/* 手机端顶部可展开「实时进度条」 */}
    <div className="dir-mstrip only-mobile">
      <button
        type="button"
        className="dir-mstrip__btn"
        aria-expanded={mobileProgressOpen}
        onClick={() => setMobileProgressOpen(v => !v)}
      >
        <span className="dir-mstrip__main">
          <i className={runningCount > 0 ? 'lp__dot is-run' : progressAlertCount > 0 ? 'lp__dot is-warn' : 'lp__dot'} />
          <span className="dir-mstrip__text">
            {runningCount > 0
              ? `${runningCount}/${slotsMax} 运行中${firstRunningTitle ? ` · ${firstRunningTitle}` : ''}`
              : progressAlertCount > 0
                ? `${progressAlertCount} 项待你拍板`
                : `${slotsMax || 3} 个工位待命`}
          </span>
        </span>
        <span className="dir-mstrip__right mono">
          <span>{money(todayUsd)}</span>
          <Icon name="chevronDown" size={14} />
        </span>
      </button>
      {runningCount > 0 && <span className="dir-mstrip__line" aria-hidden="true" />}
    </div>

    {/* 手机端展开的实时任务进度面板 */}
    {mobileProgressOpen && (
      <div className="dir-mprogress only-mobile">
        <LiveProgressPanel
          compact
          missions={missions}
          onReloadMissions={missionsPoll.reload}
          onMissionOp={missionOp}
          onApproveMissionNode={approveMissionNode}
          onRetryMissionNode={retryMissionNode}
          onIntervene={fillInput}
          busy={busy}
        />
      </div>
    )}

    {/* 左侧宽幅主舞台：总控对话画布 */}
    <section className="dir-stage" aria-label="总控助手对话">
      {/* 轻盈顶栏 */}
      <header className="dir-bar">
        <div className="dir-bar__left">
          <button
            type="button"
            className="dir-sessbtn"
            onClick={() => setSessionsOpen(true)}
            title="切换或管理历史对话"
          >
            <span className="dir-chan">{CHANNEL_LABEL[activeSession?.channel || 'web'] || '网页'}</span>
            <b>{activeSession ? (activeSession.title || activeSession.userId) : '新网页对话'}</b>
            <Icon name="chevronDown" size={14} />
          </button>
          {st && (
            <span className="dir-bar__meta only-desktop mono">
              {st.model || '未配置模型'}
              <span aria-hidden="true"> · </span>
              <span data-ok={st.enabled}>{st.enabled ? '在线' : '已关闭'}</span>
            </span>
          )}
        </div>

        <div className="dir-bar__right">
          {activeSession && (activeSession.channel === 'wechat' || activeSession.channel === 'feishu') && (
            <label className="dir-sync only-desktop">
              <input type="checkbox" checked={syncChannel} onChange={e => setSyncChannel(e.target.checked)} />
              <span>同步{CHANNEL_LABEL[activeSession.channel]}</span>
            </label>
          )}
          <button type="button" className="dir-newbtn" onClick={openNewChatModal}>
            <Icon name="new" size={14} />
            <span>新对话</span>
          </button>
          <button
            type="button"
            className={chatMenuOpen ? 'ghost small dir-iconbtn is-active' : 'ghost small dir-iconbtn'}
            aria-label="更多会话操作"
            aria-expanded={chatMenuOpen}
            onClick={() => setChatMenuOpen(v => !v)}
          >
            <Icon name="more" size={16} />
          </button>
          <button
            type="button"
            className={showProgress ? 'ghost small dir-iconbtn only-desktop is-active' : 'ghost small dir-iconbtn only-desktop'}
            title={showProgress ? '收起右侧任务进度' : '展开右侧任务进度'}
            aria-label={showProgress ? '收起右侧任务进度' : '展开右侧任务进度'}
            onClick={() => setShowProgress(v => !v)}
          >
            <Icon name="panelRight" size={16} />
            {progressAlertCount > 0 && !showProgress && <span className="dir-dotbadge">{progressAlertCount}</span>}
          </button>
        </div>
      </header>

      {/* 会话更多操作下拉条 */}
      {chatMenuOpen && (
        <div className="dir-menu" role="region" aria-label="会话操作">
          {activeSession && (activeSession.channel === 'wechat' || activeSession.channel === 'feishu') && (
            <label className="dir-sync only-mobile">
              <input type="checkbox" checked={syncChannel} onChange={e => setSyncChannel(e.target.checked)} />
              <span>同步{CHANNEL_LABEL[activeSession.channel]}</span>
            </label>
          )}
          <button type="button" className="ghost small" onClick={() => { setChatMenuOpen(false); setSessionsOpen(true) }}>
            历史会话 ({items.length})
          </button>
          {activeSession && visibleMessages.length > 0 && (
            <button
              type="button"
              className={manageMsgs ? 'ghost small is-active' : 'ghost small'}
              disabled={busy || sending}
              onClick={() => {
                setManageMsgs(v => { if (v) setPickedMsgIds([]); return !v })
                setChatMenuOpen(false)
              }}
            >
              {manageMsgs ? '退出删消息' : '批量删消息'}
            </button>
          )}
          {activeSession && (
            <button type="button" className="ghost small" disabled={busy || sending} onClick={() => { setChatMenuOpen(false); void resetCurrent() }}>
              清空上下文
            </button>
          )}
          {activeSession && (
            <button type="button" className="ghost small danger" disabled={busy || sending} onClick={() => { setChatMenuOpen(false); void deleteCurrentSession() }}>
              删除当前会话
            </button>
          )}
          <a className="ghost small" href="#/settings/director" onClick={() => setChatMenuOpen(false)}>总控设置</a>
        </div>
      )}

      {/* 高危二次确认横幅 */}
      {globalPending.length > 0 && (
        <div className="dir-pendingwrap" role="region" aria-label="待确认高危操作">
          {globalPending.map(act => (
            <div key={act.id} className="dir-actcard">
              <div className="dir-actmain">
                <div className="dir-acthead">
                  <span className="dir-actcode mono">#{act.id}</span>
                  <b>{act.toolName}</b>
                  <span className="meta">发起于 {ago(act.createdAt)}</span>
                </div>
                <p>{act.summary}</p>
              </div>
              <div className="dir-actbtns">
                <button type="button" className="primary small" disabled={busy} onClick={() => decideAction(act.id, 'approve')}>批准执行</button>
                <button type="button" className="danger small" disabled={busy} onClick={() => decideAction(act.id, 'reject')}>拒绝</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 批量删消息工具条 */}
      {manageMsgs && visibleMessages.length > 0 && (
        <div className="dir__bulkbar" role="region" aria-label="消息批量删除">
          <label className="dir__checkall">
            <input
              type="checkbox"
              checked={pickedMsgIds.length === visibleMessages.length && visibleMessages.length > 0}
              onChange={toggleAllMsgs}
            />
            <span>{pickedMsgIds.length === visibleMessages.length ? '取消全选' : '全选消息'} ({pickedMsgIds.length}/{visibleMessages.length})</span>
          </label>
          <div className="dir__bulkacts">
            <button type="button" className="danger small" disabled={busy || pickedMsgIds.length === 0} onClick={() => void deletePickedMsgs()}>
              删除所选 ({pickedMsgIds.length})
            </button>
            <button type="button" className="ghost small" onClick={() => { setManageMsgs(false); setPickedMsgIds([]) }}>取消</button>
          </div>
        </div>
      )}

      {/* 对话主滚动区 */}
      <div className="dir-feedwrap">
        <div className="dir-feed" ref={feedRef} onScroll={onFeedScroll}>
          <div className="dir-feed__inner">
            {activeSession?.summary && (
              <details className="dir-note">
                <summary>早期记忆摘要（已压缩）</summary>
                <p>{activeSession.summary}</p>
              </details>
            )}

            {pendingFollowups.length > 0 && (
              <div className="dir-note">
                <b>已登记自动续接（{pendingFollowups.length}）</b>
                {pendingFollowups.map(fw => (
                  <div key={fw.id} className="dir__fwrow">
                    <span>
                      <code className="mono">{fw.targetId.slice(0, 12)}</code> → {fw.instruction}
                    </span>
                    {fw.status === 'pending' && (
                      <button type="button" className="ghost small danger" disabled={busy} onClick={() => cancelFollowup(fw.id)}>取消</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {detailErr && <p className="warn dir__err">{detailErr}</p>}

            {visibleMessages.length === 0 && !sending && (
              <div className="dir-hero">
                <div className="dir-hero__head">
                  <h1>有什么可以帮你？</h1>
                  <p className="meta">直接交代目标、查询进度或沉淀偏好。我会结合实时工位、项目代码与你的长期习惯自动推进。</p>
                </div>
                <div className="dir-starters">
                  {STARTER_CARDS.map(card => (
                    <button
                      key={card.title}
                      type="button"
                      className="dir-starter"
                      onClick={() => card.sendNow ? void sendMessage(card.prompt) : fillInput(card.prompt)}
                    >
                      <div className="dir-starter__top">
                        <b>{card.title}</b>
                        <span className="meta">{card.tag}</span>
                      </div>
                      <span className="meta">{card.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {visibleMessages.map(m => {
              const picked = pickedMsgIds.includes(m.id)
              const wrapMsg = (node: ReactNode, alignRight = false) => {
                if (!manageMsgs) return node
                return <div
                  key={m.id}
                  className={['dir__msgpick', alignRight ? 'is-right' : '', picked ? 'is-picked' : ''].filter(Boolean).join(' ')}
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
                return wrapMsg(
                  <div key={m.id} className={m.archived ? 'dir-event is-arch' : 'dir-event'}>
                    <div className="dir-event__head">
                      <span>平台动态</span>
                      <span className="meta">{ago(m.createdAt)}</span>
                    </div>
                    <div className="dir-event__body"><Markdown text={m.content} /></div>
                  </div>,
                )
              }

              if (m.role === 'user') {
                return wrapMsg(
                  <div key={m.id} className={m.archived ? 'dir-turn is-user is-arch' : 'dir-turn is-user'}>
                    <div className="dir-userbubble">{m.content}</div>
                    <span className="meta dir-turn__time">{ago(m.createdAt)}</span>
                  </div>,
                  true,
                )
              }

              const calls = m.toolCalls ?? []
              return wrapMsg(
                <div key={m.id} className={m.archived ? 'dir-turn is-ai is-arch' : 'dir-turn is-ai'}>
                  {calls.length > 0 && (
                    <details className="dir-trace">
                      <summary>
                        <span className="dir-trace__dot" aria-hidden="true" />
                        <span>已调用 {calls.length} 项工具：{calls.map(c => {
                          const act = typeof c.arguments?.action === 'string' ? c.arguments.action : ''
                          return act ? `${c.name}(${act})` : c.name
                        }).join('、')}</span>
                      </summary>
                      <div className="dir-trace__list">
                        {calls.map(c => {
                          const res = toolResultMap.get(c.id)
                          const ok = res?.meta?.ok !== false
                          return <div key={c.id} className="dir-trace__item">
                            <div className="dir-trace__head">
                              <b className="mono">{c.name}{typeof c.arguments?.action === 'string' ? `.${c.arguments.action}` : ''}</b>
                              <span className="meta mono" data-tone={ok ? 'done' : 'bad'}>
                                {ok ? '成功' : '失败'}{typeof res?.meta?.ms === 'number' ? ` · ${res.meta.ms}ms` : ''}
                              </span>
                            </div>
                            <pre className="mono">{JSON.stringify(c.arguments ?? {}, null, 2)}</pre>
                            {res && <pre className="mono dir-trace__out">{res.content.slice(0, 1200)}{res.content.length > 1200 ? '\n…（已折叠）' : ''}</pre>}
                          </div>
                        })}
                      </div>
                    </details>
                  )}
                  {m.content && (
                    <div className="dir-prose">
                      <Markdown text={m.content} />
                    </div>
                  )}
                  <div className="dir-turn__foot">
                    <span className="meta">
                      {ago(m.createdAt)}
                      {typeof m.meta?.model === 'string' && ` · ${m.meta.model}`}
                      {typeof m.meta?.toolsCount === 'number' && m.meta.toolsCount > 0 && ` · ${m.meta.toolsCount} 次工具`}
                    </span>
                    {m.content && !manageMsgs && (
                      <button type="button" className="dir-copy" onClick={() => copyText(m.content)} title="复制回复">
                        <Icon name="copy" size={13} />复制
                      </button>
                    )}
                  </div>
                </div>,
              )
            })}

            {sending && (
              <div className="dir-turn is-ai">
                <div className="dir-stream">
                  <div className="dir-stream__head">
                    <span className="dir__pulse" aria-hidden="true" />
                    <b>总控正在推理与调度…</b>
                    <button type="button" className="ghost small danger" onClick={stopSending}>停止</button>
                  </div>
                  {streamEvents.length > 0 && (
                    <ul className="dir-stream__list mono">
                      {streamEvents.map((ev, i) => (
                        <li key={i}>
                          {ev.type === 'start' && `已连接模型 ${ev.model || ''}`}
                          {ev.type === 'thinking' && `第 ${ev.step} 轮 · ${ev.message}`}
                          {ev.type === 'tool_start' && `调用 ${ev.name}${ev.action ? `(${ev.action})` : ''}…`}
                          {ev.type === 'tool_done' && `${ev.ok ? '✓' : '✗'} ${ev.name}${ev.action ? `(${ev.action})` : ''} (${ev.ms}ms) ${ev.summary}`}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {showJumpBottom && (
          <button type="button" className="dir-jump" onClick={() => scrollToBottom('smooth')} aria-label="回到底部最新消息">
            ↓ 最新消息
          </button>
        )}
      </div>

      {/* 底部雕塑悬浮输入框 */}
      <div className="dir-dock">
        <div className="dir-dock__inner">
          {ctxOpen && (
            <div className="dir-ctxpanel">
              <label className="dir-ctxfield">
                <span>目标项目</span>
                <select value={bindProjectId} onChange={e => setBindProjectId(e.target.value)}>
                  <option value="">不限定项目</option>
                  {readyProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              {bindProjectId && (
                <label className="dir-ctxfield">
                  <span>代码模式</span>
                  <select value={bindMode} onChange={e => setBindMode(e.target.value as ProjectWorkspaceMode)}>
                    <option value="worktree">worktree 隔离分支</option>
                    <option value="copy">copy 独立副本</option>
                    <option value="direct">direct 直接改原件</option>
                  </select>
                </label>
              )}
              <label className="dir-ctxfield">
                <span>执行策略</span>
                <select value={strategy} onChange={e => setStrategy(e.target.value as any)}>
                  <option value="auto">自动理解并派发</option>
                  <option value="plan_first">先出 DAG 方案确认</option>
                  <option value="council_first">先多角色会商</option>
                </select>
              </label>
              <label className="dir-ctxcheck">
                <input type="checkbox" checked={requireVerify} onChange={e => setRequireVerify(e.target.checked)} />
                <span>要求客观证据验收</span>
              </label>
            </div>
          )}

          <div className="dir-box">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && input.trim()) {
                  if (window.innerWidth >= 960 || e.ctrlKey || e.metaKey) {
                    e.preventDefault()
                    void sendMessage()
                  }
                }
              }}
              placeholder={activeSession?.channel === 'feishu' ? '发消息给总控（将同步推送至飞书）…' : '向总控下达目标、拆解计划或干预任务…'}
            />
            <div className="dir-box__bar">
              <div className="dir-box__chips">
                <button
                  type="button"
                  className={ctxOpen || activeContextTags.length > 0 ? 'dir-chip is-on' : 'dir-chip'}
                  onClick={() => setCtxOpen(v => !v)}
                >
                  <Icon name="settings" size={13} />
                  <span>约束{activeContextTags.length > 0 ? ` (${activeContextTags.length})` : ''}</span>
                </button>
                {activeContextTags.map(tag => <span key={tag} className="dir-ctxtag">{tag}</span>)}
                {QUICK_CHIPS.map(ch => (
                  <button
                    key={ch.label}
                    type="button"
                    className="dir-chip"
                    disabled={sending}
                    onClick={() => ch.cmd ? void sendMessage(ch.cmd) : fillInput(ch.fill || '')}
                  >
                    {ch.label}
                  </button>
                ))}
              </div>
              {sending ? (
                <button type="button" className="dir-send is-stop" onClick={stopSending} aria-label="停止推理">
                  <Icon name="x" size={16} />
                </button>
              ) : (
                <button type="button" className="dir-send" disabled={!input.trim()} onClick={() => void sendMessage()} aria-label="发送消息">
                  <Icon name="arrowUp" size={17} stroke={2.1} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>

    {/* PC 端右侧实时任务执行与进度面板 */}
    {showProgress && (
      <aside className="dir-progress only-desktop" aria-label="任务执行与实时进度">
        <LiveProgressPanel
          missions={missions}
          onReloadMissions={missionsPoll.reload}
          onMissionOp={missionOp}
          onApproveMissionNode={approveMissionNode}
          onRetryMissionNode={retryMissionNode}
          onIntervene={fillInput}
          busy={busy}
        />
      </aside>
    )}

    {/* 历史会话抽屉 Sheet */}
    {sessionsOpen && (
      <Sheet title={`对话列表 (${items.length})`} onClose={() => { setSessionsOpen(false); setManageSessions(false); setPickedSessions([]) }}>
        <div className="dir-sheethead">
          <button type="button" className="primary small" onClick={() => { setSessionsOpen(false); openNewChatModal() }}>
            <Icon name="new" size={14} />新开对话（网页 / 飞书）
          </button>
          {items.length > 0 && (
            <button
              type="button"
              className={manageSessions ? 'ghost small is-active' : 'ghost small'}
              disabled={busy}
              onClick={() => {
                setManageSessions(v => { if (v) setPickedSessions([]); return !v })
              }}
            >
              {manageSessions ? '完成' : '批量删除'}
            </button>
          )}
        </div>
        {manageSessions && items.length > 0 && (
          <div className="dir__bulkbar">
            <label className="dir__checkall">
              <input type="checkbox" checked={pickedSessions.length === items.length && items.length > 0} onChange={toggleAllSessions} />
              <span>{pickedSessions.length === items.length ? '取消全选' : '全选'} ({pickedSessions.length}/{items.length})</span>
            </label>
            <button type="button" className="danger small" disabled={busy || pickedSessions.length === 0} onClick={() => void deletePickedSessions()}>
              删除 ({pickedSessions.length})
            </button>
          </div>
        )}
        {items.length === 0 ? (
          <Empty>还没有历史会话，点击上方「新开对话」即可开始。</Empty>
        ) : (
          <div className="dir-sesslist">
            {items.map(s => {
              const picked = pickedSessions.includes(s.id)
              const active = !manageSessions && s.id === selectedId
              return <button
                key={s.id}
                type="button"
                className={['dir-sessrow', active ? 'is-on' : '', manageSessions && picked ? 'is-picked' : ''].filter(Boolean).join(' ')}
                onClick={() => manageSessions ? toggleSessionPick(s.id) : pickSession(s.id)}
              >
                <div className="dir-sessrow__top">
                  {manageSessions && (
                    <input
                      type="checkbox"
                      className="dir__chk"
                      checked={picked}
                      onChange={() => toggleSessionPick(s.id)}
                      onClick={e => e.stopPropagation()}
                      aria-label={`选择会话 ${s.title || s.userId}`}
                    />
                  )}
                  <span className="dir-chan">{CHANNEL_LABEL[s.channel] || s.channel}</span>
                  <b>{s.title || s.userId}</b>
                  {s.pendingActions > 0 && <span className="nb need">{s.pendingActions}</span>}
                </div>
                <span className="meta dir-sessrow__preview">{s.lastMessage || '（空会话）'}</span>
                <span className="meta">{s.messageCount} 条消息 · {ago(s.updatedAt)}</span>
              </button>
            })}
          </div>
        )}
      </Sheet>
    )}

    {/* 新开对话通道选择弹窗（网页对话 / 飞书对话） */}
    {newChatOpen && (
      <Sheet title="新开总控对话" onClose={() => setNewChatOpen(false)}>
        <div className="dir-newmodal">
          <div className="dir-chanpick" role="radiogroup" aria-label="选择对话通道">
            <button
              type="button"
              role="radio"
              aria-checked={newChatChannel === 'web'}
              className={newChatChannel === 'web' ? 'dir-chancard is-on' : 'dir-chancard'}
              onClick={() => setNewChatChannel('web')}
            >
              <Icon name="globe" size={18} />
              <div className="dir-chancard__body">
                <div className="dir-chancard__top">
                  <b>网页对话</b>
                  <span className="dir-chancard__dot" aria-hidden="true">{newChatChannel === 'web' && <Icon name="check" size={11} stroke={2.8} />}</span>
                </div>
                <span className="meta">独立控制台上下文，适合深度交互与拆解复杂任务</span>
              </div>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={newChatChannel === 'feishu'}
              className={newChatChannel === 'feishu' ? 'dir-chancard is-on' : 'dir-chancard'}
              onClick={() => setNewChatChannel('feishu')}
            >
              <Icon name="feishu" size={18} />
              <div className="dir-chancard__body">
                <div className="dir-chancard__top">
                  <b>飞书对话</b>
                  <span className="dir-chancard__dot" aria-hidden="true">{newChatChannel === 'feishu' && <Icon name="check" size={11} stroke={2.8} />}</span>
                </div>
                <span className="meta">绑定飞书会话，总控回复与任务战报实时同步推送至飞书</span>
              </div>
            </button>
          </div>

          <label className="field">
            <span>对话标题（可选）</span>
            <input
              value={newChatTitle}
              onChange={e => setNewChatTitle(e.target.value)}
              placeholder={newChatChannel === 'feishu' ? '例如：飞书日常调度' : '例如：前端重设计与测试'}
            />
          </label>

          {newChatChannel === 'feishu' && (
            <>
              {feishuSessions.length > 0 && (
                <div className="field">
                  <span>选择已有飞书接收对象</span>
                  <div className="dir-fspicks">
                    {feishuSessions.map(fs => (
                      <button
                        key={fs.id}
                        type="button"
                        className={feishuTarget === fs.userId ? 'dir-chip is-on' : 'dir-chip'}
                        onClick={() => setFeishuTarget(fs.userId)}
                      >
                        {fs.title || fs.userId}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label className="field">
                <span>飞书接收 ID（open_id 或 chat_id）</span>
                <input
                  value={feishuTarget}
                  onChange={e => setFeishuTarget(e.target.value)}
                  placeholder="例如：ou_xxxxxxxx 或 oc_xxxxxxxx"
                />
                <small className="hint">如尚未在飞书发过消息，可先在飞书给机器人发一条「/状态」，系统会自动登记你的飞书 ID。</small>
              </label>
              <label className="check">
                <input type="checkbox" checked={feishuReset} onChange={e => setFeishuReset(e.target.checked)} />
                <span><b>清空该飞书会话短期上下文</b><small className="hint">若该飞书 ID 已有对话，开启后从全新话题开始</small></span>
              </label>
            </>
          )}

          <div className="actions dialog__actions">
            <button type="button" onClick={() => setNewChatOpen(false)}>取消</button>
            <button type="button" className="primary" disabled={busy} onClick={() => void createNewConversation()}>
              {busy ? '创建中…' : (newChatChannel === 'feishu' ? '开启飞书对话' : '开启网页对话')}
            </button>
          </div>
        </div>
      </Sheet>
    )}
  </div>
}
