/**
 * 总控助手 AI 指挥中心（#/director）：
 * - 流式 SSE 思考与工具调用实时进度（`POST /api/director/chat/stream`）
 * - 需求上下文快捷装配栏（目标项目 / worktree 模式 / 拆解策略 / 强制证据验收）
 * - 实时 DAG 任务计划编排看板（启动 / 暂停 / 恢复 / 幂等版本审批 / 局部重试 / 取消）+ 活跃工位与高危审批
 */
import { useEffect, useRef, useState } from 'react'
import { API, get, post } from './api'
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
const SCOPE_LABEL: Record<string, string> = { all: '全平台重要动态', wechat_only: '仅微信派发任务', off: '关闭主动推送' }
const MISSION_STATUS: Record<MissionRecord['status'], string> = {
  draft: '草稿待启动',
  running: '执行中',
  paused: '已暂停',
  completed: '已交付',
  failed: '受阻失败',
  cancelled: '已取消',
}
const NODE_STATUS: Record<MissionNodeRecord['status'], string> = {
  pending: '等待依赖',
  dispatching: '派单中',
  running: '执行中',
  waiting_approval: '待人工批准',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
}

const QUICK_TEMPLATES: { label: string; prompt: string }[] = [
  { label: '多步 DAG 拆解', prompt: '请先分析需求并用 DAG 任务计划拆解：出方案 → 并行子任务（使用 worktree 隔离分支） → 汇总测试 → 等我批准。具体需求如下：\n' },
  { label: '网页改动+自检', prompt: '请修改指定项目的网页功能，要求提交表单后刷新页面数据仍然存在，并运行 browser_verify 完成断言与截图留证，最后提交审查与交付回执。具体修改：\n' },
  { label: '每周五销售周报', prompt: '请创建一个每周五执行的销售周报定时任务，建立任务约定：按付款日期归集、所有金额保留两位小数，并在交付回执中附上核对证据。' },
  { label: '全局体检', prompt: '请排查当前所有进行中任务、定时巡检状态、今日花费与异常告警，给我一份简明汇总。' },
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

  // 需求上下文快捷装配栏
  const [bindProjectId, setBindProjectId] = useState('')
  const [bindMode, setBindMode] = useState<ProjectWorkspaceMode>('worktree')
  const [strategy, setStrategy] = useState<'auto' | 'plan_first' | 'council_first'>('auto')
  const [requireVerify, setRequireVerify] = useState(true)
  const [showOps, setShowOps] = useState(true)

  const { busy, run } = useAction()
  const bottomRef = useRef<HTMLDivElement>(null)

  const items = sessionsPoll.d?.items ?? []
  const st = sessionsPoll.d?.status
  const globalPending = sessionsPoll.d?.pendingActions ?? []
  const missions = missionsPoll.d?.items ?? []
  const readyProjects = (projectsPoll.d?.items ?? []).filter(p => p.status === 'ready')

  useEffect(() => {
    if (!selectedId && items.length > 0) {
      const preferred = items.find(s => s.channel === 'web') ?? items.find(s => s.channel === 'wechat') ?? items[0]!
      setSelectedId(preferred.id)
    }
  }, [items, selectedId])

  const loadDetail = async (sid: string) => {
    if (!sid) { setDetail(null); return }
    try {
      const res = await get<any>(`api/director/sessions/${encodeURIComponent(sid)}`)
      setDetail(res)
      setDetailErr('')
    } catch (e: any) {
      setDetailErr(e?.message || '读取会话详情失败')
    }
  }

  useEffect(() => {
    if (!selectedId) return
    void loadDetail(selectedId)
    const t = setInterval(() => void loadDetail(selectedId), 4000)
    return () => clearInterval(t)
  }, [selectedId])

  const activeSession = detail?.session ?? items.find(s => s.id === selectedId)
  const messages = detail?.messages ?? []

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

  /** 通过 SSE 流式发送消息并实时渲染思考与工具调用进度，异常时优雅回退普通 POST。 */
  const sendMessage = async (overrideText?: string) => {
    const raw = (overrideText ?? input).trim()
    if (!raw || sending) return
    const text = overrideText ? raw : composeWithContext(raw)
    setSending(true)
    setStreamEvents([])
    if (!overrideText) setInput('')

    const targetChannel = activeSession?.channel ?? 'web'
    const targetUserId = activeSession?.userId ?? 'console'
    const imChannel = targetChannel === 'wechat' || targetChannel === 'feishu'
    const payload = {
      text,
      channel: targetChannel,
      userId: targetUserId,
      deliverToWechat: imChannel ? syncWechat : false,
    }

    try {
      let finalResult: any = null
      const resp = await fetch(API('api/director/chat/stream'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-sa-request': '1' },
        body: JSON.stringify(payload),
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
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 80)
    } catch (e: any) {
      toast(e?.message || '发送失败', true)
      if (!overrideText) setInput(raw)
    } finally {
      setSending(false)
      setStreamEvents([])
    }
  }

  const startWebChat = () => {
    const existing = items.find(s => s.channel === 'web' && s.userId === 'console')
    if (existing) { setSelectedId(existing.id); return }
    void sendMessage('/状态')
  }

  const resetCurrent = async () => {
    if (!selectedId) return
    if (!await confirmAction('清空当前会话的短期记忆？历史审计记录会保留，仅重新开始对话上下文。', { title: '开启新对话', okLabel: '确认清空' })) return
    await run(() => post(`api/director/sessions/${encodeURIComponent(selectedId)}/reset`, {}), '已开启新对话', () => {
      void loadDetail(selectedId)
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

  return <div className="dir">
    <header className="phead">
      <div>
        <h1>总控指挥中心</h1>
        <p className="phead__sub">理解复杂需求、拆解并行 DAG 计划、绑定任务约定与证据验收、实时观测总控工具推理与审批</p>
      </div>
      <div className="quick">
        <button type="button" className="ghost" onClick={() => setShowOps(v => !v)}>{showOps ? '收起右栏计划板' : '展开右栏计划板'}</button>
        <a className="btn" href="#/settings/director">总控设置</a>
        <a className="btn" href="#/memory">记忆技能</a>
        <a className="btn" href="#/schedules">定时巡检</a>
      </div>
    </header>

    {st && <div className="dir__stats">
      <div className="dir__stat"><span>状态</span><b>{st.enabled ? '已启用' : '已关闭'}</b></div>
      <div className="dir__stat"><span>总控模型</span><b className="mono">{st.model || '—'}</b></div>
      <div className="dir__stat"><span>主动汇报</span><b>{SCOPE_LABEL[st.notifyScope] || st.notifyScope}</b></div>
      <div className="dir__stat"><span>今日总控花费</span><b>{money(st.todayUsd || 0)}{st.dailyUsd > 0 ? ` / ${money(st.dailyUsd)}` : ''}</b></div>
      <div className="dir__stat"><span>活跃 DAG 计划</span><b>{missions.filter(m => m.status === 'running' || m.status === 'draft').length}</b></div>
      <div className="dir__stat"><span>待确认高危操作</span><b>{st.pendingActions ?? 0}</b></div>
    </div>}

    {globalPending.length > 0 && <section className="dir__pending" aria-label="待确认高危操作">
      <div className="sechead"><h2>待确认的高危操作</h2><span className="sechead__note">回复「/确认 短码」或直接点击审批</span></div>
      {globalPending.map(act => <div key={act.id} className="card dir__act">
        <div>
          <p><b>#{act.id} · {act.toolName}</b></p>
          <p>{act.summary}</p>
          <p className="meta">发起于 {ago(act.createdAt)} · 过期时间 {new Date(act.expiresAt).toLocaleTimeString()}</p>
        </div>
        <div className="quick">
          <button type="button" className="primary" disabled={busy} onClick={() => decideAction(act.id, 'approve')}>批准执行</button>
          <button type="button" className="danger" disabled={busy} onClick={() => decideAction(act.id, 'reject')}>拒绝</button>
        </div>
      </div>)}
    </section>}

    <div className="dir__layout" style={showOps ? { gridTemplateColumns: 'minmax(200px, 240px) minmax(0, 1fr) minmax(280px, 340px)' } : undefined}>
      <aside className="dir__side">
        <div className="dir__sidehead">
          <b>会话列表</b>
          <button type="button" className="ghost small" onClick={startWebChat}>＋ 网页对话</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {QUICK_TEMPLATES.map(tpl => <button
            key={tpl.label}
            type="button"
            className="ghost small"
            onClick={() => setInput(tpl.prompt)}
            title="填充常用指令模板"
          >
            {tpl.label}
          </button>)}
        </div>
        {items.length === 0 ? <Empty>还没有总控对话。点右上角「网页对话」直接交代任务。</Empty> : <div className="dir__sessions">
          {items.map(s => <button key={s.id} type="button" className={s.id === selectedId ? 'row dir__sess is-on' : 'row dir__sess'} onClick={() => setSelectedId(s.id)}>
            <div className="dir__sesstop">
              <span className="dir__tag">{CHANNEL_LABEL[s.channel] || s.channel}</span>
              <b>{s.title || s.userId}</b>
              {s.pendingActions > 0 && <span className="nb need">{s.pendingActions}</span>}
            </div>
            <span className="meta dir__preview">{s.lastMessage || '（空会话）'}</span>
            <span className="meta">{s.messageCount} 条 · {ago(s.updatedAt)}</span>
          </button>)}
        </div>}
      </aside>

      <section className="dir__chat">
        {activeSession ? <>
          <div className="dir__chathead">
            <div>
              <b>{activeSession.title || activeSession.userId}</b>
              <span className="meta">
                通道：{CHANNEL_LABEL[activeSession.channel] || activeSession.channel}
                {activeSession.focusTicketId && <> · 聚焦工单：<a href={`#/tickets/${encodeURIComponent(activeSession.focusTicketId)}`}>{activeSession.focusTicketId}</a></>}
              </span>
            </div>
            <div className="quick">
              {(activeSession.channel === 'wechat' || activeSession.channel === 'feishu') && <label className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={syncWechat} onChange={e => setSyncWechat(e.target.checked)} />
                同步推到{CHANNEL_LABEL[activeSession.channel]}
              </label>}
              <button type="button" className="ghost small" disabled={sending} onClick={() => void sendMessage('/状态')}>/状态</button>
              <button type="button" className="ghost small" disabled={busy || sending} onClick={resetCurrent}>新对话</button>
            </div>
          </div>

          {activeSession.summary && <details className="dir__summary">
            <summary>已压缩的早期记忆摘要</summary>
            <p>{activeSession.summary}</p>
          </details>}

          {pendingFollowups.length > 0 && <div className="dir__summary">
            <b>已登记的自动续接</b>
            {pendingFollowups.map(fw => <div key={fw.id} className="row" style={{ marginTop: 6 }}>
              <span>
                <span className="dir__tag">{fw.status === 'running' ? '正在续接' : '等待完工'}</span>{' '}
                <b className="mono">{fw.targetId}</b> → {fw.instruction}
              </span>
              {fw.status === 'pending' && <button type="button" className="ghost small danger" disabled={busy} onClick={() => cancelFollowup(fw.id)}>取消</button>}
            </div>)}
          </div>}

          {detailErr && <p className="warn">{detailErr}</p>}

          <div className="dir__feed">
            {messages.filter(m => m.role !== 'tool').map(m => {
              if (m.role === 'event') {
                return <div key={m.id} className={m.archived ? 'dir__event is-arch' : 'dir__event'}>
                  <span className="dir__tag">平台动态</span>
                  <div className="dir__eventbody"><Markdown text={m.content} /></div>
                  <span className="meta">{ago(m.createdAt)}</span>
                </div>
              }
              if (m.role === 'user') {
                return <div key={m.id} className={m.archived ? 'dir__msg is-user is-arch' : 'dir__msg is-user'}>
                  <div className="dir__bubble">{m.content}</div>
                  <span className="meta">{ago(m.createdAt)}</span>
                </div>
              }
              const calls = m.toolCalls ?? []
              return <div key={m.id} className={m.archived ? 'dir__msg is-ai is-arch' : 'dir__msg is-ai'}>
                {calls.length > 0 && <details className="dir__tools">
                  <summary>调用了 {calls.length} 个平台工具：{calls.map(c => c.name).join('、')}</summary>
                  <div className="dir__toollist">
                    {calls.map(c => {
                      const res = toolResultMap.get(c.id)
                      const ok = res?.meta?.ok !== false
                      return <div key={c.id} className="dir__toolitem">
                        <div className="dir__toolhead">
                          <b className="mono">{c.name}</b>
                          <span className="meta">{ok ? '成功' : '失败'}{typeof res?.meta?.ms === 'number' ? ` · ${res.meta.ms}ms` : ''}</span>
                        </div>
                        <pre className="mono">{JSON.stringify(c.arguments ?? {}, null, 2)}</pre>
                        {res && <pre className="mono dir__toolout">{res.content.slice(0, 1200)}{res.content.length > 1200 ? '\n…（已折叠）' : ''}</pre>}
                      </div>
                    })}
                  </div>
                </details>}
                {m.content && <div className="dir__bubble"><Markdown text={m.content} /></div>}
                <span className="meta">
                  {ago(m.createdAt)}
                  {typeof m.meta?.model === 'string' && ` · ${m.meta.model}`}
                  {typeof m.meta?.toolsCount === 'number' && m.meta.toolsCount > 0 && ` · 共查 ${m.meta.toolsCount} 次工具`}
                </span>
              </div>
            })}
            {sending && <div className="dir__msg is-ai">
              <div className="dir__bubble">
                <div className="meta"><b>总控正在实时推理与调度…</b></div>
                {streamEvents.length > 0 && <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  {streamEvents.map((ev, i) => <li key={i} className="meta" style={{ marginBottom: 2 }}>
                    {ev.type === 'start' && `已连接总控模型 ${ev.model || ''}`}
                    {ev.type === 'thinking' && `第 ${ev.step} 轮：${ev.message}`}
                    {ev.type === 'tool_start' && `⏳ 调用 ${ev.name}${ev.action ? `(${ev.action})` : ''}…`}
                    {ev.type === 'tool_done' && `${ev.ok ? '✅' : '⚠️'} ${ev.name}${ev.action ? `(${ev.action})` : ''} (${ev.ms}ms)：${ev.summary}`}
                  </li>)}
                </ul>}
              </div>
            </div>}
            <div ref={bottomRef} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 0 4px', alignItems: 'center' }}>
            <select value={bindProjectId} onChange={e => setBindProjectId(e.target.value)} title="绑定目标项目">
              <option value="">不限定项目</option>
              {readyProjects.map(p => <option key={p.id} value={p.id}>📁 {p.name}</option>)}
            </select>
            {bindProjectId && <select value={bindMode} onChange={e => setBindMode(e.target.value as ProjectWorkspaceMode)} title="代码隔离模式">
              <option value="worktree">worktree 隔离分支</option>
              <option value="copy">copy 独立副本</option>
              <option value="direct">direct 直接改原件</option>
            </select>}
            <select value={strategy} onChange={e => setStrategy(e.target.value as any)} title="派发策略">
              <option value="auto">自动理解并派发</option>
              <option value="plan_first">先出 DAG 方案确认再开工</option>
              <option value="council_first">先多角色会商</option>
            </select>
            <label className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={requireVerify} onChange={e => setRequireVerify(e.target.checked)} />
              要求证据验收
            </label>
          </div>

          <div className="dir__composer">
            <textarea
              rows={2}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && input.trim()) { e.preventDefault(); void sendMessage() } }}
              placeholder="把你的目标直接交代给总控：我会结合项目上下文和长期偏好拆解、派发、自检并交付…（Ctrl+Enter 发送）"
            />
            <button type="button" className="primary" disabled={sending || !input.trim()} onClick={() => void sendMessage()}>
              <Icon name="send" size={16} />{sending ? '执行中…' : '发送'}
            </button>
          </div>
        </> : <Empty>请选择左侧会话，或点「网页对话」直接向总控发消息。</Empty>}
      </section>

      {showOps && <aside className="dir__side" style={{ maxHeight: '78vh', overflowY: 'auto' }}>
        <div className="dir__sidehead">
          <b>DAG 任务计划（{missions.length}）</b>
          <button type="button" className="ghost small" onClick={missionsPoll.reload}>刷新</button>
        </div>
        {missions.length === 0
          ? <p className="meta">暂无多步骤 DAG 计划。遇到复杂需求时总控会自动拆成并行依赖图显示在这里。</p>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {missions.map(m => {
              const done = m.nodes.filter(n => n.status === 'completed' || n.status === 'skipped').length
              const pct = m.nodes.length > 0 ? Math.round((done / m.nodes.length) * 100) : 0
              return <div key={m.id} className="card" style={{ padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center' }}>
                  <b style={{ fontSize: 13 }}>{m.title}</b>
                  <span className="pill">v{m.planVersion} · {MISSION_STATUS[m.status]}</span>
                </div>
                <div className="meta" style={{ margin: '4px 0' }}>进度 {done}/{m.nodes.length}（{pct}%）</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                  {m.status === 'draft' && <button type="button" className="primary small" disabled={busy} onClick={() => missionOp(m, 'start')}>开工</button>}
                  {m.status === 'running' && <button type="button" className="ghost small" disabled={busy} onClick={() => missionOp(m, 'pause')}>暂停</button>}
                  {(m.status === 'paused' || m.status === 'failed') && <button type="button" className="primary small" disabled={busy} onClick={() => missionOp(m, 'resume')}>恢复</button>}
                  {(m.status === 'draft' || m.status === 'running' || m.status === 'paused') && <button type="button" className="ghost small danger" disabled={busy} onClick={() => missionOp(m, 'cancel')}>取消</button>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {m.nodes.map(n => <div key={n.id} style={{ padding: '5px 6px', borderRadius: 6, border: '1px solid var(--line, #e5e7eb)', fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                      <span><code>{n.key}</code> {n.title}</span>
                      <span className="meta">{NODE_STATUS[n.status]}</span>
                    </div>
                    {n.dependsOn.length > 0 && <div className="meta">依赖：{n.dependsOn.join(', ')}</div>}
                    {n.ticketId && <div className="meta"><a href={`#/tickets/${encodeURIComponent(n.ticketId)}`}>工单 {n.ticketId} →</a></div>}
                    {n.commitSha && <div className="meta">SHA: <code>{n.commitSha.slice(0, 8)}</code></div>}
                    {n.artifacts.length > 0 && <div className="meta">产物：{n.artifacts.slice(0, 2).join('、')}</div>}
                    {n.status === 'waiting_approval' && <button type="button" className="primary small" style={{ marginTop: 4 }} disabled={busy} onClick={() => approveMissionNode(m, n)}>批准继续 (v{m.planVersion})</button>}
                    {n.status === 'failed' && <button type="button" className="ghost small" style={{ marginTop: 4 }} disabled={busy} onClick={() => retryMissionNode(m, n)}>局部重试</button>}
                  </div>)}
                </div>
              </div>
            })}
          </div>}

        {openTickets.length > 0 && <div style={{ marginTop: 14 }}>
          <div className="dir__sidehead"><b>活跃工单（{openTickets.length}）</b></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {openTickets.slice(0, 6).map(t => <a key={t.id} className="row" href={`#/tickets/${encodeURIComponent(t.id)}`} style={{ fontSize: 12 }}>
              <b>{t.title}</b>
              <span className="meta">{t.needsPerson ? '等你回答' : (t.stageLabel || '运行中')}</span>
            </a>)}
          </div>
        </div>}
      </aside>}
    </div>
  </div>
}
