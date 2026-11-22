import { useEffect, useRef, useState } from 'react'
import { get, post } from './api'
import { usePoll, ago, money } from './hooks'
import { Icon } from './icons'
import { Empty, Markdown, confirmAction, toast, useAction } from './ui'

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

export function Director() {
  const sessionsPoll = usePoll<{ status: any; items: SessionItem[]; pendingActions: PendingAct[] }>('api/director/sessions', 4000)
  const [selectedId, setSelectedId] = useState<string>('')
  const [detail, setDetail] = useState<{ session: SessionItem; messages: DirMessage[]; pendingActions: PendingAct[]; followups?: PendingFollowup[] } | null>(null)
  const [detailErr, setDetailErr] = useState('')
  const [input, setInput] = useState('')
  const [syncWechat, setSyncWechat] = useState(true)
  const [sending, setSending] = useState(false)
  const { busy, run } = useAction()
  const bottomRef = useRef<HTMLDivElement>(null)

  const items = sessionsPoll.d?.items ?? []
  const st = sessionsPoll.d?.status
  const globalPending = sessionsPoll.d?.pendingActions ?? []

  useEffect(() => {
    if (!selectedId && items.length > 0) {
      const wx = items.find(s => s.channel === 'wechat') ?? items[0]!
      setSelectedId(wx.id)
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

  const sendMessage = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    if (!text || sending) return
    setSending(true)
    if (!overrideText) setInput('')
    try {
      const targetChannel = activeSession?.channel ?? 'web'
      const targetUserId = activeSession?.userId ?? 'console'
      const imChannel = targetChannel === 'wechat' || targetChannel === 'feishu'
      const res = await post('api/director/chat', {
        text,
        channel: targetChannel,
        userId: targetUserId,
        deliverToWechat: imChannel ? syncWechat : false,
      })
      if (imChannel && syncWechat) {
        const label = CHANNEL_LABEL[targetChannel] || targetChannel
        if (res?.wechatDelivered === true) toast(`回复已同步推送到${label}`)
        else if (res?.wechatDelivered === false) toast(`回复已生成，但推送${label}失败：${res?.wechatError || '未知错误'}`, true)
      }
      if (res?.sessionId) {
        setSelectedId(res.sessionId)
        await loadDetail(res.sessionId)
      }
      sessionsPoll.reload()
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 80)
    } catch (e: any) {
      toast(e?.message || '发送失败', true)
      if (!overrideText) setInput(text)
    } finally {
      setSending(false)
    }
  }

  const startWebChat = () => {
    const existing = items.find(s => s.channel === 'web' && s.userId === 'console')
    if (existing) {
      setSelectedId(existing.id)
      return
    }
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

  const pendingFollowups = (detail?.followups ?? []).filter(f => f.status === 'pending' || f.status === 'running')

  return <div className="dir">
    <header className="phead">
      <div>
        <h1>总控助手</h1>
        <p className="phead__sub">微信、飞书与控制台共用的平台总控 AI：掌管宿主机运维与控制台全部能力（主机巡检/日志/命令、Pi 与开发环境、系统设置、工单/项目/防御工作台全链路）</p>
      </div>
      <div className="quick">
        <a className="btn" href="#/settings/director">总控设置</a>
        <a className="btn" href="#/settings/feishu">飞书连接</a>
        <a className="btn" href="#/settings/wechat">微信连接</a>
      </div>
    </header>

    {st && <div className="dir__stats">
      <div className="dir__stat"><span>状态</span><b>{st.enabled ? '已启用' : '已关闭'}</b></div>
      <div className="dir__stat"><span>总控模型</span><b className="mono">{st.model || '—'}</b></div>
      <div className="dir__stat"><span>主动汇报</span><b>{SCOPE_LABEL[st.notifyScope] || st.notifyScope}</b></div>
      <div className="dir__stat"><span>今日总控花费</span><b>{money(st.todayUsd || 0)}{st.dailyUsd > 0 ? ` / ${money(st.dailyUsd)}` : ''}</b></div>
      <div className="dir__stat"><span>待确认高危操作</span><b>{st.pendingActions ?? 0}</b></div>
      <div className="dir__stat"><span>待自动续接</span><b>{st.pendingFollowups ?? 0}</b></div>
    </div>}

    {globalPending.length > 0 && <section className="dir__pending" aria-label="待确认高危操作">
      <div className="sechead"><h2>待确认的高危操作</h2><span className="sechead__note">微信回复「/确认 短码」或在此直接审批</span></div>
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

    <div className="dir__layout">
      <aside className="dir__side">
        <div className="dir__sidehead">
          <b>会话列表</b>
          <button type="button" className="ghost small" onClick={startWebChat}>＋ 网页对话</button>
        </div>
        {items.length === 0 ? <Empty>还没有总控对话。在微信给机器人发一条消息，或点右上角「网页对话」开始。</Empty> : <div className="dir__sessions">
          {items.map(s => <button key={s.id} type="button" className={s.id === selectedId ? 'row dir__sess is-on' : 'row dir__sess'} onClick={() => setSelectedId(s.id)}>
            <div className="dir__sesstop">
              <span className="dir__tag">{CHANNEL_LABEL[s.channel] || s.channel}</span>
              <b>{s.title || s.userId}</b>
              {s.pendingActions > 0 && <span className="nb need">{s.pendingActions}</span>}
            </div>
            <span className="meta dir__preview">{s.lastMessage || '（空会话）'}</span>
            <span className="meta">{s.messageCount} 条记录 · {ago(s.updatedAt)}</span>
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
            <b>已登记的自动续接（目标完成后自动唤醒执行）</b>
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
            {sending && <div className="dir__msg is-ai"><div className="dir__bubble meta">总控正在查阅平台数据并思考…</div></div>}
            <div ref={bottomRef} />
          </div>

          <div className="dir__composer">
            <textarea
              rows={2}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && input.trim()) { e.preventDefault(); void sendMessage() } }}
              placeholder="直接和总控助手对话：查任务进度、查花费、读报告、聊需求并派单…（Ctrl+Enter 发送）"
            />
            <button type="button" className="primary" disabled={sending || !input.trim()} onClick={() => void sendMessage()}>
              <Icon name="send" size={16} />{sending ? '思考中…' : '发送'}
            </button>
          </div>
        </> : <Empty>请选择左侧会话，或点「网页对话」直接向总控发消息。</Empty>}
      </section>
    </div>
  </div>
}
