import { createRoot } from 'react-dom/client'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { API, get, post, put, del } from './api'
import { usePoll, ago, money } from './hooks'
import { useSteps, type Step } from './useSteps'
import { LiveContext, useLive, useLiveSource, useTick, clock, secondsSince, type RunningStep } from './useLive'
import { ToastHost, toast, useAction, Sheet, Empty, Tabs, bytes, DialogHost, ErrorBoundary, Markdown, confirmAction, promptAction, safeDecode, useTheme, type ThemeMode } from './ui'
import * as P from './pages'
import { Icon, Logo } from './icons'
import { GoalCard, GoalSheet } from './goal'
import { ContractCard, DeliveryReceiptCard, TicketDiffReviewPanel } from './ticket-review'
import type { PluginDescriptor } from '../../src/shared/api-types.ts'
import './style.css'

const Fanqie = lazy(() => import('./fanqie').then(m => ({ default: m.Fanqie })))
const PiVersions = lazy(() => import('./pi').then(m => ({ default: m.PiVersions })))
const DevEnv = lazy(() => import('./devenv').then(m => ({ default: m.DevEnv })))
const Pentest = lazy(() => import('./pentest').then(m => ({ default: m.Pentest })))
const Defense = lazy(() => import('./defense').then(m => ({ default: m.Defense })))
const Director = lazy(() => import('./director').then(m => ({ default: m.Director })))
const MemoryPage = lazy(() => import('./memory').then(m => ({ default: m.MemoryPage })))
const SchedulerPage = lazy(() => import('./scheduler').then(m => ({ default: m.SchedulerPage })))

const useHash = () => {
  const [h, set] = useState(location.hash || '#/director')
  useEffect(() => {
    const f = () => set(location.hash || '#/director')
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])
  return h
}

const STATUS_WORD: Record<string, string> = { completed: '已完成', stopped: '已停止', failed: '失败', abandoned: '已放弃' }
const toneOf = (t: any) => t.needsPerson ? 'human' : t.status === 'ended' ? (t.outcome === 'failed' ? 'bad' : t.outcome === 'completed' ? 'done' : 'stop') : 'run'
/** Status bead: the same mark everywhere a ticket is listed. */
function Mark({ tone }: { tone: string }) {
  return <span className="smark" data-tone={tone} aria-hidden="true">
    {tone === 'done' ? <Icon name="check" size={13} stroke={2.6} /> : tone === 'bad' ? <Icon name="x" size={12} stroke={2.6} /> : tone === 'stop' ? <Icon name="pause" size={11} stroke={2.6} /> : tone === 'human' ? '?' : null}
  </span>
}
function Row({ t, step, pick }: { t: any; step?: string; pick?: { on: boolean; toggle: () => void } }) {
  const tone = toneOf(t)
  const word = t.needsPerson ? '等你' : t.status === 'ended' ? (STATUS_WORD[t.outcome] || '已结束') : (t.stageLabel || '进行中')
  const body = <>
    <Mark tone={tone} />
    <span className="tk__main">
      <b>{t.title}</b>
      {t.needsPerson && t.question ? <span className="q">{t.question}</span> : step ? <span className="step">{step}</span> : null}
    </span>
    <span className="tk__side"><span className="tk__word">{word}</span><span className="tk__ago">{ago(t.updatedAt)}{t.costUsd > 0 ? `，${money(t.costUsd)}` : ''}</span></span>
  </>
  if (pick) return <label className="row tk pickrow" data-tone={tone}><input type="checkbox" checked={pick.on} onChange={pick.toggle} aria-label={`选择 ${t.title}`} />{body}</label>
  return <a className="row tk" data-tone={tone} href={`#/tickets/${encodeURIComponent(t.id)}`}>{body}</a>
}

function QuickReply({ id, placeholder }: { id: string; placeholder: string }) {
  const [text, setText] = useState('')
  const { busy, run } = useAction()
  const send = () => run(() => post(`api/tickets/${encodeURIComponent(id)}/reply`, { text }), '已回复', () => setText(''))
  return <div className="quick">
    <input value={text} onChange={e => setText(e.target.value)} placeholder={placeholder} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) send() }} />
    <button disabled={busy || !text.trim()} onClick={send}><Icon name="send" size={16} />回复</button>
  </div>
}

/** A step that has not moved for this long gets flagged on its lane. */
const STALL_SEC = 300
const TOOL_WORD: Record<string, string> = { bash: '命令', read: '读文件', write: '写文件', edit: '改文件', subagent: '协作', say: '说', think: '想', turn: '节点', goal: '目标', web_search: '搜索', web_fetch: '读网页' }
const WEEK = '日一二三四五六'
const dateLine = () => { const d = new Date(); return `${d.getMonth() + 1} 月 ${d.getDate()} 日，星期${WEEK[d.getDay()]}` }
const agoSec = (s: number) => s < 60 ? `${Math.floor(s)} 秒前` : `${Math.floor(s / 60)} 分钟前`

function LiveBadge() {
  const { live, err, board } = useLive()
  const label = live ? '实时' : board ? '轮询中' : err ? '连不上' : '连接中'
  return <span className="livebadge" data-on={live} title={err || (live ? '状态一变就推送过来' : '推送断了，每 5 秒刷新一次')}><i />{label}</span>
}

function Lane({ n, t, step, skew, modelName }: { n: number; t: any; step?: RunningStep; skew: number; modelName: (model?: string) => string }) {
  const starting = !step || step.kind === 'none'
  const idle = secondsSince(step?.at, skew)
  const delegating = !starting && step!.tool === 'subagent' && step!.status === 'running'
  // A delegation reports progress without new steps, so its age alone does not mean it stalled.
  const stalled = !starting && !delegating && idle > STALL_SEC
  const tool = starting ? '' : (step!.tool || step!.kind)
  const note = starting ? '正在启动' : stalled ? `${Math.floor(idle / 60)} 分钟没动静` : step!.status === 'running' ? `这一步 ${clock(step!.at, skew)}` : agoSec(idle)
  const busy = delegating ? (step!.agents || []).filter(a => a.state === 'running') : []
  // Who is working: the main worker on its model, or the sub-agents it handed work to.
  const who = starting || step!.kind === 'turn' || step!.kind === 'goal' ? ''
    : step!.tool === 'subagent'
      ? busy.length > 1 ? `子代理 ×${busy.length} · ${busy.map(roleName).join('、')}`
        : busy.length === 1 ? `子代理 · ${roleName(busy[0]!)} · ${modelName(busy[0]!.model)}` : '子代理'
      : `主 AI${step!.model ? ` · ${modelName(step!.model)}` : ''}`
  return <a className="lane" data-st={starting ? 'start' : stalled ? 'stall' : 'run'} href={`#/tickets/${encodeURIComponent(t.id)}`}>
    <span className="lane__no">{n}</span>
    <span className="lane__main">
      <span className="lane__title">{t.goal && <span className="goalchip" data-st={t.goal.status} title="目标：已用轮数 / 上限">目标 {t.goal.rounds}/{t.goal.roundCap}</span>}{t.title}</span>
      <span className="lane__step">{starting ? <span className="sum">还没有记录到步骤</span>
        : <>{who && <span className="who" data-who={step!.tool === 'subagent' ? 'sub' : 'main'} title={who}>{who}</span>}
          {step!.tool !== 'subagent' && <span className="tool">{TOOL_WORD[tool] || tool}</span>}
          <span className={step!.tool === 'subagent' ? 'sum' : 'sum cmd'}>{step!.summary || '（无摘要）'}</span></>}</span>
    </span>
    <span className="lane__side">
      <span className="lane__clock" title="这张任务已经跑了多久">{clock(step?.since || t.updatedAt, skew)}</span>
      <span className="lane__sub">{note}{t.costUsd > 0 ? `，${money(t.costUsd)}` : ''}</span>
    </span>
    <span className="lane__rail" aria-hidden="true" />
  </a>
}

function QuickCommand() {
  const [text, setText] = useState('')
  const { busy, run } = useAction()
  const askDirector = () => {
    const q = text.trim()
    if (!q) { location.hash = '#/director'; return }
    try { sessionStorage.setItem('sa-director-handoff', q) } catch { /* ignore */ }
    setText('')
    location.hash = '#/director'
  }
  const dispatchNow = () => {
    const q = text.trim()
    if (!q) return
    run(async () => {
      const r = await post<any>('api/tickets', { text: q })
      setText('')
      if (r?.ticketId) location.hash = `#/tickets/${encodeURIComponent(r.ticketId)}`
    }, '任务已派发')
  }
  return <section className="cmdbar" aria-label="快捷指令">
    <div className="cmdbar__box">
      <Icon name="director" size={18} />
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) { e.preventDefault(); dispatchNow() }
          else if (e.key === 'Enter' && text.trim()) { e.preventDefault(); askDirector() }
        }}
        placeholder="向总控交代目标，或直接派发工单…"
      />
    </div>
    <div className="cmdbar__acts">
      <button type="button" className="primary" disabled={busy} onClick={askDirector}>
        <Icon name="director" size={15} />交给总控
      </button>
      <button type="button" disabled={busy || !text.trim()} onClick={dispatchNow}>
        <Icon name="new" size={15} />直接派单
      </button>
    </div>
  </section>
}

function Today() {
  const { board: b, err, skew } = useLive()
  const fq = usePoll<any>('api/fanqie/status', 30000)
  useTick()
  const modelName = useModelNames()
  const head = <header className="phead">
    <div>
      <h1>今日调度台</h1>
      <p className="phead__sub">{dateLine()}</p>
    </div>
    <div className="phead__right">
      <a className="btn small only-desktop" href="#/director"><Icon name="director" size={14} />进入总控工作台</a>
    </div>
  </header>
  if (!b) return <div className="today">{head}{err ? <p className="warn">连不上后台：{err}</p> : <p className="meta">加载中…</p>}</div>
  const steps = new Map<string, RunningStep>(b.runningSteps.map(s => [s.id, s]))
  const need = b.open.filter(t => t.needsPerson)
  const running = b.open.filter(t => !t.needsPerson && steps.has(t.id))
  const queued = b.open.filter(t => !t.needsPerson && !steps.has(t.id))
  const idleSlots = Math.max(0, b.slots.max - running.length)
  const budget = b.usage.dailyBudgetUsd || 0
  const pct = budget > 0 ? Math.min(1, b.usage.todayUsd / budget) : 0
  const link = (id: string) => `#/tickets/${encodeURIComponent(id)}`
  return <div className="today">
    {head}
    {b.paused && <a className="alert" data-lv="warn" href="#/system">接单已暂停，新任务不会被受理。</a>}
    {b.alerts.filter(a => a.text && !(b.paused && /暂停/.test(a.text))).map((a, i) => <a key={i} className="alert" data-lv={a.level} href={a.link || '#/today'}>{a.text}</a>)}
    {fq.d?.expired && <a className="alert" data-lv="warn" href="#/secrets">番茄登录已失效，请重新抓取 Cookie 并更新密钥 FANQIE_COOKIE</a>}

    <QuickCommand />

    <div className="kpi-strip today__kpis" aria-label="今日关键指标">
      <div className="kpi-cell">
        <span>活跃工位</span>
        <b>{running.length}<small className="kpi-den"> / {b.slots.max}</small></b>
        <small>{queued.length > 0 ? `${queued.length} 个排队中` : idleSlots > 0 ? `${idleSlots} 个空闲可用` : '工位已满载'}</small>
      </div>
      <div className={need.length > 0 ? 'kpi-cell is-warn' : 'kpi-cell'}>
        <span>待我拍板</span>
        <b>{need.length}</b>
        <small>{need.length > 0 ? '需要你回答或审批' : '全部顺畅推进'}</small>
      </div>
      <div className="kpi-cell">
        <span>今日花费</span>
        <b>{money(b.usage.todayUsd)}</b>
        <small>{budget > 0 ? `预算上限 ${money(budget)} (${Math.round(pct * 100)}%)` : `${b.usage.todayCalls ?? 0} 次模型调用`}</small>
      </div>
      <div className="kpi-cell">
        <span>今日交付</span>
        <b>{b.tickets.endedToday}</b>
        <small>模型：{b.upstream?.model || '未配置'}</small>
      </div>
    </div>

    <div className="today__grid">
      <div className="today__main">
        {need.length > 0 && <section className="need" aria-label="等你回答">
          <div className="sechead"><h2>等你回答</h2><span className="sechead__note">{need.length} 个任务停下来了</span></div>
          {need.map(t => <div key={t.id} className="needcard">
            <a className="needcard__title" href={link(t.id)}>{t.title}</a>
            <p className="needcard__q">{t.question || t.stageLabel || '它停下来等你'}</p>
            <QuickReply id={t.id} placeholder="直接回答它…" />
          </div>)}
        </section>}

        <section className="board" aria-label="工位">
          <div className="sechead"><h2>执行工位</h2><span className="sechead__note">{running.length ? `${running.length} / ${b.slots.max} 运行中` : `${b.slots.max} 个工位待命`}</span></div>
          <div className="lanes">
            {running.map((t, i) => <Lane key={t.id} n={i + 1} t={t} step={steps.get(t.id)} skew={skew} modelName={modelName} />)}
            {Array.from({ length: idleSlots }, (_, i) => <div key={'idle' + i} className="lane" data-st="idle">
              <span className="lane__no">{running.length + i + 1}</span>
              <span className="lane__main"><span className="lane__title">空闲工位</span>
                {i === 0 && <span className="lane__step"><span className="sum"><a href="#/new">发一个任务</a> 或使用上方快捷指令启动</span></span>}</span>
            </div>)}
          </div>
          {queued.length > 0 && <p className="queued">排队中 {queued.length} 个：{queued.slice(0, 3).map((t, i) => <a key={t.id} href={link(t.id)}>{i ? '、' : ''}{t.title}</a>)}{queued.length > 3 ? ' 等' : ''}</p>}
        </section>

        <section className="ended" aria-label="最近结束">
          <div className="sechead"><h2>最近交付</h2><a className="sechead__note" href="#/tickets">查看全部任务</a></div>
          {b.ended.length ? <ul className="endlist">{b.ended.map(t => <li key={t.id}>
            <a href={link(t.id)}><Mark tone={toneOf(t)} /><span className="t">{t.title}</span>
              <span className="w" data-tone={toneOf(t)}>{STATUS_WORD[t.outcome ?? ''] || '已结束'}</span><span className="a">{ago(t.updatedAt)}</span></a>
          </li>)}</ul> : <Empty>今天还没有结束的任务。</Empty>}
        </section>
      </div>

      <aside className="today__side" aria-label="今天概况">
        <div className="panel">
          <h3>预算与调用</h3>
          <p className="bignum">{money(b.usage.todayUsd)}</p>
          {budget > 0 ? <><div className="meter"><span style={{ width: `${Math.max(2, pct * 100)}%` }} data-lv={pct > 0.9 ? 'error' : pct > 0.7 ? 'warn' : ''} /></div>
            <p className="meta">日上限 {money(budget)} · 已用 {Math.round(pct * 100)}%</p></> : <p className="meta">未设置每日预算上限</p>}
          <dl className="mini">
            <dt>模型调用</dt><dd>{b.usage.todayCalls ?? 0}</dd>
            <dt>今日结束</dt><dd>{b.tickets.endedToday}</dd>
            <dt>等你回答</dt><dd>{b.tickets.needsPerson}</dd>
          </dl>
        </div>
        <div className="panel">
          <h3>系统脉搏</h3>
          <p className="statline"><i data-ok={!b.paused} /><span>{b.paused ? '已暂停接单' : '正常接单'}</span></p>
          <p className="statline"><i data-ok={b.upstream?.ok !== false} /><span>{b.upstream?.model || '未配置模型'}</span><span className="meta">{b.upstream?.ok === false ? '最近失败' : b.upstream?.provider}</span></p>
          <p className="statline"><i data-ok="true" /><span>工位 {b.slots.used} / {b.slots.max}</span>{b.slots.reservedForPerson ? <span className="meta">为人留 {b.slots.reservedForPerson}</span> : null}</p>
          <div className="panel__links">
            <a className="panel__link" href="#/memory">记忆与进化<Icon name="chev" size={14} /></a>
            <a className="panel__link" href="#/devenv">共享环境<Icon name="chev" size={14} /></a>
            <a className="panel__link" href="#/system">系统详情<Icon name="chev" size={14} /></a>
          </div>
        </div>
      </aside>
    </div>
  </div>
}

function Tickets() {
  const [f, setF] = useState('needs-person')
  const [q, setQ] = useState('')
  const [qq, setQq] = useState('')
  useEffect(() => { const t = setTimeout(() => setQq(q.trim()), 300); return () => clearTimeout(t) }, [q])
  const [limit, setLimit] = useState(50)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const { d, err, reload } = usePoll<any>(`api/tickets?status=${f}&limit=${limit}${qq ? `&q=${encodeURIComponent(qq)}` : ''}`)
  const { busy, run } = useAction()
  const items: any[] = d?.items || []
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const remove = async () => {
    if (!picked.size || !await confirmAction(`删除选中的 ${picked.size} 个任务？会删除记录和工作区文件，花费记录保留；进行中的任务会跳过。`, { title: '批量删除任务', danger: true, okLabel: '删除' })) return
    run(async () => {
      const r = await post('api/tickets/delete', { ids: [...picked], deleteWorkspace: true })
      const skipped = r?.skipped?.length || 0
      toast(`已删除 ${(r?.deleted?.length ?? picked.size - skipped)} 个${skipped ? `，跳过 ${skipped} 个` : ''}`)
    }, undefined, () => { setPicked(new Set()); setPicking(false); reload() })
  }
  return <><div className="headrow"><h1>任务</h1><button className="ghost" onClick={() => { setPicking(!picking); setPicked(new Set()) }}>{picking ? '取消' : '批量'}</button></div>
    <Tabs value={f} onChange={k => { setF(k); setLimit(50) }} items={[['needs-person', '需要我'], ['open', '进行中'], ['ended', '已结束'], ['all', '全部']]} />
    <input className="search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="搜索任务标题" />
    <P.Loading d={d} err={err} />
    {items.map(t => <Row key={t.id} t={t} pick={picking ? { on: picked.has(t.id), toggle: () => toggle(t.id) } : undefined} />)}
    {d && !items.length && <Empty>没有符合条件的任务。</Empty>}
    {d && d.total > items.length && <button className="more" onClick={() => setLimit(limit + 50)}>加载更多（还有 {d.total - items.length} 张）</button>}
    {picking && <div className="bulkbar"><span>已选 {picked.size}</span><button onClick={() => setPicked(new Set(items.map(t => t.id)))}>全选本页</button><button className="danger" disabled={busy || !picked.size} onClick={remove}>删除</button></div>}</>
}

const KIND_WORD: Record<string, string> = { say: '说', think: '想', turn: '节点', goal: '目标', web_search: '搜索', web_fetch: '读网页' }
const TOOL_LABEL: Record<string, string> = { subagent: '协作' }
const AGENT_WORD: Record<string, string> = { queued: '排队', running: '进行中', done: '完成', failed: '失败', stopped: '中断' }
type AgentView = { role: string; name?: string; model?: string; state: string }
const roleName = (a: AgentView): string => a.name || ROLE_NAME[a.role] || a.role
/** A finished delegation has no sub-agent still working: one left running was cut off. */
const agentState = (a: AgentView, stepStatus: string): string => stepStatus !== 'running' && a.state === 'running' ? 'stopped' : a.state
/** Model ids as the console names them: `sa-gw/claude-opus-5-5` or `claude-opus-5-5` → the configured label. */
function useModelNames(): (model?: string) => string {
  const { d } = usePoll<any>('api/models', 600000)
  return useMemo(() => {
    const names = new Map<string, string>()
    for (const m of d?.items || []) {
      const ref = String(m.ref || '')
      const id = ref.slice(ref.indexOf('/') + 1)
      const name = String(m.label || '').split(' · ')[0]!.trim() || id
      if (!ref || !name) continue
      names.set(ref, name)
      if (!names.has(id)) names.set(id, name)
    }
    return (model?: string) => {
      if (!model) return ''
      const ref = model.replace(/^sa-/, '')
      const id = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref
      return names.get(ref) || names.get(id) || id
    }
  }, [d])
}
const ROLE_NAME: Record<string, string> = { scout: '侦察', planner: '规划', reviewer: '审查', advisor: '顾问', helper: '帮手' }
const SHOW_STEPS = 10
type TicketPrompt = { text: string; at: string }
type TicketInputItem = { id: string; kind: string; at: string; text?: string; note?: string; human?: boolean }
type UserEntry = { id: string; at: string; tag: string; text: string }
type TimelineItem = { kind: 'step'; at: number; step: Step } | { kind: 'user'; at: number; entry: UserEntry }

function parseUserInput(inp: TicketInputItem): UserEntry | null {
  const raw = (inp.text || '').trim()
  if (!raw) return null
  if (inp.kind === 'trigger') return { id: inp.id, at: inp.at, tag: inp.human ? '追加要求' : '来源消息', text: raw }
  if (inp.kind === 'note') return { id: inp.id, at: inp.at, tag: '补充说明', text: raw }
  if (inp.kind !== 'text') return null
  let m = /^This ticket ended earlier \([^)]*\)\. A person reopened it[\s\S]*?\n\nInstruction:\s*([\s\S]+)$/.exec(raw)
  if (m) return { id: inp.id, at: inp.at, tag: '重新打开', text: m[1]!.trim() }
  m = /^A person switched the model for this ticket[\s\S]*?\n\nInstruction:\s*([\s\S]+)$/.exec(raw)
  if (m) return { id: inp.id, at: inp.at, tag: '换模型', text: m[1]!.trim() }
  m = /^Your last turn stopped \([^)]*\)\. A person sent a new instruction[\s\S]*?\n\nInstruction:\s*([\s\S]+)$/.exec(raw)
  if (m) return { id: inp.id, at: inp.at, tag: '继续指示', text: m[1]!.trim() }
  m = /^A person sent a new instruction on this ticket:\s*([\s\S]+)$/.exec(raw)
  if (m) return { id: inp.id, at: inp.at, tag: '追加要求', text: m[1]!.trim() }
  return null
}

function PromptBox({ prompt }: { prompt: TicketPrompt }) {
  const text = prompt.text.trim()
  if (!text) return null
  const long = text.length > 260 || text.split('\n').length > 5
  const preview = long ? `${text.slice(0, 240).trimEnd()}…` : text
  return <div className="prompt-box">
    <div className="prompt-box__head">
      <span className="who" data-who="user">我</span>
      <b>任务要求</b>
      <time>{new Date(prompt.at).toLocaleString()}</time>
    </div>
    {long
      ? <><div className="prompt-box__text">{preview}</div><details><summary>展开全文</summary><pre>{text}</pre></details></>
      : <div className="prompt-box__text">{text}</div>}
  </div>
}

function StepList({ id, mainModel, active, goalChecking, prompt, inputs }: {
  id: string; mainModel?: string; active?: boolean; goalChecking?: boolean; prompt?: TicketPrompt; inputs?: TicketInputItem[]
}) {
  const { steps, live } = useSteps(encodeURIComponent(id))
  const modelName = useModelNames()
  const [all, setAll] = useState(false)
  const userEntries = (inputs || []).map(parseUserInput).filter((x): x is UserEntry => x !== null)
  const timeline: TimelineItem[] = [
    ...steps.map(step => ({ kind: 'step' as const, at: Date.parse(step.at) || 0, step })),
    ...userEntries.map(entry => ({ kind: 'user' as const, at: Date.parse(entry.at) || 0, entry })),
  ].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'user' ? -1 : 1))
  const shown = all ? timeline.slice(-300) : timeline.slice(-SHOW_STEPS)
  const hidden = timeline.length - shown.length
  const mainName = modelName([...steps].reverse().find(s => s.model)?.model) || String(mainModel || '').split(' · ')[0]
  const delegating = [...steps].reverse().find(s => s.tool === 'subagent' && s.status === 'running')
  const busy = (delegating?.agents || []).filter(a => a.state === 'running')
  const last = steps[steps.length - 1]
  // "Now" only while the ticket is running a turn: a delegation in flight, or a last step that is not a turn boundary.
  const working = !!active && (delegating !== undefined || (last !== undefined && last.kind !== 'turn'))
  let prev = ''
  return <section className="card">
    <div className="headrow"><h2>执行过程 <small>{steps.length ? `共 ${steps.length} 步` : ''}</small></h2>
      <span className="meta"><span className={live ? 'dot on' : 'dot'} />{live ? '实时' : '轮询'}</span></div>
    {prompt && <PromptBox prompt={prompt} />}
    {goalChecking && <p className="nowrun" data-who="goal"><i aria-hidden="true" /><span>宿主在检查目标：跑验收命令、让判定模型核对。主 AI 在等结果。</span></p>}
    {working && !goalChecking && <p className="nowrun" data-who={delegating ? 'sub' : 'main'}><i aria-hidden="true" />
      {delegating
        ? busy.length > 0
          ? <span>子代理在干活：<b>{busy.map(a => `${roleName(a)}（${modelName(a.model) || '模型未知'}）`).join('、')}</b>。主 AI{mainName ? `（${mainName}）` : ''}在等它们交回结果。</span>
          : <span>主 AI 派出了子代理，正在排队启动。</span>
        : <span>主 AI 在干活{mainName ? <>，用的是 <b>{mainName}</b></> : null}。</span>}
    </p>}
    {!timeline.length && <Empty>还没有记录到步骤：可能在排队、准备文件，或者这是部署前的旧任务。</Empty>}
    {hidden > 0 && <button className="ghost small" onClick={() => setAll(true)}>显示更早的 {hidden} 条</button>}
    {!!shown.length && <ol className="steps">{shown.map(item => {
      if (item.kind === 'user') {
        const u = item.entry
        const long = u.text.length > 260 || u.text.split('\n').length > 5
        return <li key={`u-${u.id}`} data-st="user">
          <time>{new Date(u.at).toLocaleTimeString()}</time>
          <span className="who" data-who="user">我</span>
          <b>{u.tag}</b>
          <div className="user-msg">{long ? `${u.text.slice(0, 240).trimEnd()}…` : u.text}</div>
          {long && <details><summary>看全文</summary><pre>{u.text}</pre></details>}
        </li>
      }
      const s = item.step
      const sub = s.tool === 'subagent'
      const who = s.kind === 'turn' || s.kind === 'goal' ? '' : sub ? 'sub' : 'main'
      const m = who === 'main' ? modelName(s.model) : ''
      // The main worker's model is spelled out on its first step and whenever it changes.
      const tag = who === 'sub' ? '子代理' : who === 'main' ? (m && m !== prev ? `主 AI · ${m}` : '主 AI') : ''
      if (m) prev = m
      return <li key={s.id} data-st={s.status}>
        <time>{new Date(s.at).toLocaleTimeString()}</time>
        {tag && <span className="who" data-who={who} title={m ? `主 AI 用的模型：${m}` : undefined}>{tag}</span>}
        {!sub && <b>{(s.tool && TOOL_LABEL[s.tool]) || s.tool || KIND_WORD[s.kind] || s.kind}</b>} <span>{s.summary}</span>
        {s.status === 'running' ? <em> 进行中</em> : s.ms ? <em> {(s.ms / 1000).toFixed(1)}s</em> : null}
        {sub && !!s.agents?.length && <span className="agents">{s.agents.map((a, i) => {
          const st = agentState(a, s.status)
          return <span key={i} className="agent" data-st={st}>{roleName(a)}{a.model && <small>{modelName(a.model)}</small>}<i>{AGENT_WORD[st] || st}</i></span>
        })}</span>}
        {s.detail && s.detail !== s.summary && <details><summary>{s.kind === 'tool' ? '看输出' : '看全文'}</summary><pre>{s.detail}</pre></details>}
      </li>
    })}</ol>}
    {all && timeline.length > SHOW_STEPS && <button className="ghost small" onClick={() => setAll(false)}>只看最新 {SHOW_STEPS} 条</button>}
  </section>
}

function Files({ id }: { id: string }) {
  const [path, setPath] = useState('')
  const { d, err } = usePoll<any>(`api/tickets/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, 30000)
  const up = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const base = `api/tickets/${encodeURIComponent(id)}`
  return <div>
    <p className="crumbs"><button className="ghost small" onClick={() => setPath('')}>工作区</button>{path && <> / <span className="mono">{path}</span></>}</p>
    <P.Loading d={d} err={err} />
    {d && !d.exists && <Empty>工作区还没有文件。</Empty>}
    {d?.type === 'dir' && <ul className="files">
      {path && <li><button className="ghost" onClick={() => setPath(up)}>⬑ 上一级</button></li>}
      {(d.entries || []).map((e: any) => <li key={e.name}><button className="ghost" onClick={() => setPath(path ? `${path}/${e.name}` : e.name)}>{e.type === 'dir' ? '📁' : '📄'} {e.name}</button><span className="meta">{bytes(e.size)}</span></li>)}
    </ul>}
    {d?.type === 'file' && <div>
      <p className="actions"><button className="ghost" onClick={() => setPath(up)}>← 返回</button><a className="btn" href={API(`${base}/files?path=${encodeURIComponent(path)}&download=1`)}>下载</a><span className="meta">{bytes(d.size)} · {ago(d.modifiedAt)}</span></p>
      {/\.(png|jpe?g|gif|webp|svg)$/i.test(path) ? <img className="preview" alt={path} src={API(`${base}/files?path=${encodeURIComponent(path)}&raw=1`)} />
        : d.binary ? <Empty>二进制文件，请下载查看。</Empty> : <pre className="file">{d.text}{d.truncated ? '\n…（文件太长，只显示开头）' : ''}</pre>}
    </div>}
    <p className="actions"><a className="btn" href={API(`${base}/archive?path=output`)}>打包下载 output</a><a className="btn" href={API(`${base}/archive?path=project`)}>打包下载项目</a></p>
  </div>
}

function CouncilPanel({ ticketId, current }: { ticketId: string; current?: { id: string } }) {
  const list = usePoll<any>(`api/councils?ticketId=${encodeURIComponent(ticketId)}&limit=10`, 15000)
  const [open, setOpen] = useState<string | null>(current?.id || null)
  const { busy, run } = useAction()
  const [topic, setTopic] = useState('')
  const items: any[] = list.d?.items || []
  return <div>
    <div className="quick"><input value={topic} onChange={e => setTopic(e.target.value)} placeholder="想让几个 AI 角色讨论什么？（留空=讨论当前问题）" />
      <button disabled={busy} onClick={() => run(async () => { const r = await post('api/councils', { mode: 'decision', text: topic.trim() || '请就这张任务的当前问题给出建议', ticketId }); setOpen(r?.id || null); setTopic('') }, '会商已开始', list.reload)}>召集会商</button></div>
    {items.map(c => <button key={c.id} className="row" onClick={() => setOpen(open === c.id ? null : c.id)}><b>{c.topic.slice(0, 60)}</b><span className="meta">{c.status} · {money(c.costUsd)} · {ago(c.createdAt)}</span></button>)}
    {list.d && !items.length && <Empty>这张任务还没有会商。</Empty>}
    {open && <P.CouncilDetail id={open} />}
  </div>
}

function ModelSheet({ id, onClose, current }: { id: string; onClose: () => void; current?: string }) {
  const models = usePoll<any>('api/models', 60000)
  const [model, setModel] = useState(current || '')
  const [text, setText] = useState('请换用这个模型继续。')
  const { busy, run } = useAction()
  return <Sheet title="换模型" onClose={onClose}>
    <label className="field">模型<select value={model} onChange={e => setModel(e.target.value)}>{(models.d?.items || []).map((m: any) => <option key={m.ref} value={m.ref}>{m.label}（{m.providerName}）</option>)}</select></label>
    <label className="field">附一句话<input value={text} onChange={e => setText(e.target.value)} /></label>
    <button className="primary" disabled={busy || !model || !text.trim()} onClick={() => run(() => post(`api/tickets/${encodeURIComponent(id)}/reply`, { text, model }), '已换模型', onClose)}>确定</button>
  </Sheet>
}

function SecretsSheet({ id, granted, onClose }: { id: string; granted: string[]; onClose: () => void }) {
  const all = usePoll<any>('api/secrets', 60000)
  const [sel, setSel] = useState<Set<string>>(new Set(granted))
  const { busy, run } = useAction()
  return <Sheet title="这张任务能用的密钥" onClose={onClose}>
    {(all.d?.items || []).map((s: any) => <label key={s.name} className="check"><input type="checkbox" checked={sel.has(s.name)} onChange={() => setSel(p => { const n = new Set(p); n.has(s.name) ? n.delete(s.name) : n.add(s.name); return n })} /><span className="mono">{s.name}</span><span className="meta">{s.description}</span></label>)}
    {all.d && !(all.d.items || []).length && <Empty>还没有密钥，请先到「密钥」页添加。</Empty>}
    <button className="primary" disabled={busy} onClick={() => run(() => put(`api/tickets/${encodeURIComponent(id)}/secrets`, { names: [...sel] }), '已保存', onClose)}>保存</button>
  </Sheet>
}

function Detail({ id }: { id: string }) {
  const { d, err, reload } = usePoll<any>(`api/tickets/${encodeURIComponent(id)}`)
  const [text, setText] = useState('')
  const [tab, setTab] = useState('')
  const [sheet, setSheet] = useState<'' | 'model' | 'secrets' | 'more' | 'goal'>('')
  const { busy, run } = useAction()
  const base = `api/tickets/${encodeURIComponent(id)}`
  const ended = d?.status === 'ended'
  const cur = tab || (d && !ended && !d.attention ? 'steps' : 'result')
  const send = () => { if (text.trim()) run(() => post(`${base}/reply`, { text }), ended ? '已重新打开' : '已发送', () => { setText(''); reload() }) }
  const reports: any[] = d?.reports || []
  const last = reports[reports.length - 1]
  const [rawReport, setRawReport] = useState(false)
  const deleteTicket = async () => {
    if (!await confirmAction('删除这张任务？会删除任务记录和工作区文件，花费记录保留。', { title: '删除任务', danger: true, okLabel: '删除' })) return
    run(() => del(base, { deleteWorkspace: true, force: !ended }), '已删除', () => { location.hash = '#/tickets' })
  }
  const tone = !d ? 'run' : ended ? (d.outcome === 'failed' ? 'bad' : 'done') : d.attention ? 'human' : 'run'
  return <div className="detail"><a href="#/tickets" className="back"><Icon name="back" size={16} />全部任务</a>
    <h1>{d?.title || '…'}</h1>
    <P.Loading d={d} err={err} />
    {d && <div className="dmeta">
      <span className="pill" data-tone={tone}>{d.stageLabel}</span>
      {d.model?.label && <span><Icon name="model" size={15} />{d.model.label}</span>}
      {d.project?.name && <span title={d.project.mode === 'direct' ? '直接修改项目库原件' : '在项目副本上修改'}>📁 {d.project.name}{d.project.mode === 'direct' ? '（直接改原件）' : ''}{d.project.preparing ? ' · 正在准备文件' : ''}</span>}
      <span><Icon name="coin" size={15} />{money(d.usage?.totalUsd)}</span>
      <span><Icon name="clock" size={15} />更新于 {ago(d.updatedAt)}</span>
    </div>}
    {d?.attention?.question && <div className="ask"><b>等你回答</b><p>{d.attention.question}</p></div>}
    {d?.delivery && <p className="warn">结果没送达：{d.delivery.error}</p>}
    {d?.goal && <GoalCard id={id} goal={d.goal} ended={ended} onChange={reload} />}
    <Tabs value={cur} onChange={setTab} items={[['steps', '过程'], ['result', '结果与回执'], ['review', '代码审查'], ['files', '文件'], ['council', '会商'], ['info', '信息']]} />
    {cur === 'steps' && <StepList id={id} mainModel={d?.model?.label} active={!!d && d.status !== 'ended' && !d.attention} goalChecking={!!d?.goal?.checking} prompt={d?.prompt} inputs={d?.inputs} />}
    {cur === 'result' && <>
      {d?.receipt && <DeliveryReceiptCard ticketId={id} receipt={d.receipt} />}
      {d?.contract && <ContractCard ticketId={id} contract={d.contract} onUpdated={reload} />}
      {last ? <div className="card">
        <div className="headrow"><h2>最新报告 <small>{last.state} · {ago(last.at)}</small></h2>
          <button type="button" className="ghost small" onClick={() => setRawReport(v => !v)}>{rawReport ? '排版视图' : '原文'}</button></div>
        {rawReport ? <pre className="report">{last.summary}</pre> : <Markdown text={last.summary} />}
      </div> : <Empty>还没有报告。</Empty>}
      {reports.length > 1 && <details><summary>更早的报告（{reports.length - 1} 份）</summary>{reports.slice(0, -1).reverse().map((r: any) => <pre key={r.id + r.at}>{r.state} · {r.at}{'\n'}{r.summary}</pre>)}</details>}
      {!!d?.previews?.length && <><h2>预览</h2>{d.previews.map((p: any) => <div className="row" key={p.port}><a href={p.url} target="_blank" rel="noopener">{p.title || `端口 ${p.port}`}</a><span className="meta">{p.active ? '在线' : '已停止（显示留存文件）'} · <button className="ghost small" onClick={() => navigator.clipboard?.writeText(p.url).then(() => toast('已复制'), () => toast('复制失败', true))}>复制链接</button></span></div>)}</>}
      {!!d?.links?.length && <><h2>链接</h2>{d.links.filter((l: any) => /^https?:\/\//.test(l.url)).map((l: any) => <a className="row" key={l.url} href={l.url} target="_blank" rel="noopener">{l.title || l.url}</a>)}</>}
    </>}
    {cur === 'review' && <TicketDiffReviewPanel ticketId={id} onChanged={reload} />}
    {cur === 'files' && <Files id={id} />}
    {cur === 'council' && <CouncilPanel ticketId={id} current={d?.council} />}
    {cur === 'info' && d && <div className="card"><dl className="kvs">
      <dt>编号</dt><dd className="mono">{d.id}</dd>
      <dt>模型</dt><dd>{d.model?.label}（{d.model?.providerName}）</dd>
      <dt>花费</dt><dd>{money(d.usage?.totalUsd)} · {d.usage?.calls ?? 0} 次调用 · 命中 {Math.round((d.usage?.hitRate || 0) * 100)}%</dd>
      {d.byAgent?.some((a: any) => a.agent) && <><dt>按角色</dt><dd>{d.byAgent.map((a: any) => `${a.agent ? (ROLE_NAME[a.agent] || a.agent) : '主 AI'} ${money(a.usd)}（${a.calls} 次）`).join('，')}</dd></>}
      <dt>密钥</dt><dd>{(d.secrets || []).join('、') || '无'}</dd>
      <dt>授权</dt><dd>{d.mandate?.strength}，来自 {d.mandate?.actor?.id}</dd>
      <dt>目录</dt><dd className="mono">{d.workspace?.path}</dd>
      <dt>创建</dt><dd>{new Date(d.createdAt).toLocaleString()}</dd>
    </dl>
      <h2>事件</h2>{(d.events || []).slice(0, 30).map((e: any, i: number) => <p key={e.id ?? i} className="meta" data-lv={e.level}>{ago(e.at)} · {e.text}</p>)}
    </div>}
    <div className="compose">
      <button className="ghost" aria-label="更多操作" onClick={() => setSheet('more')}><Icon name="more" size={20} /></button>
      <textarea
        value={text}
        onChange={e => {
          setText(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`
        }}
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && text.trim()) { e.preventDefault(); send() } }}
        placeholder={ended ? '写一句话重新打开它…（Ctrl+Enter 发送）' : d?.attention ? '回答它的问题…（Ctrl+Enter 发送）' : '给它补一句…（Ctrl+Enter 发送）'}
        rows={1}
      />
      <button className="primary" onClick={send} disabled={busy || !text.trim()}>发送</button>
    </div>
    {sheet === 'more' && <Sheet title="操作" onClose={() => setSheet('')}>
      {d?.canRetry && !ended && <button className="row" disabled={busy} onClick={() => run(() => post(`${base}/retry`, {}), '已重新排队', () => { setSheet(''); reload() })}>重试</button>}
      {!ended && <button className="row" disabled={busy} onClick={async () => { const n = await promptAction('给它留一条备注（不打断当前这一轮）', { title: '留备注', placeholder: '输入备注内容…' }); if (n?.trim()) run(() => post(`${base}/note`, { text: n }), '已送到', () => setSheet('')) }}>留备注（不打断）</button>}
      {!ended && !(d?.goal && (d.goal.status === 'active' || d.goal.status === 'paused')) && <button className="row" onClick={() => setSheet('goal')}>设定目标（没达成就不停）</button>}
      <button className="row" onClick={() => setSheet('model')}>换模型</button>
      <button className="row" onClick={() => setSheet('secrets')}>管理可用密钥</button>
      {!ended && <button className="row danger" disabled={busy} onClick={async () => { const r = await promptAction('停止这张任务？可以写一句原因（可留空）', { title: '停止任务', placeholder: '原因（可选）', okLabel: '停止' }); if (r !== null) run(() => post(`${base}/stop`, r.trim() ? { reason: r.trim() } : {}), '已停止', () => { setSheet(''); reload() }) }}>停止任务</button>}
      <button className="row danger" disabled={busy} onClick={deleteTicket}>删除任务</button>
    </Sheet>}
    {sheet === 'goal' && <GoalSheet id={id} onClose={() => { setSheet(''); reload() }} />}
    {sheet === 'model' && <ModelSheet id={id} current={d?.model?.ref} onClose={() => { setSheet(''); reload() }} />}
    {sheet === 'secrets' && <SecretsSheet id={id} granted={d?.secrets || []} onClose={() => { setSheet(''); reload() }} />}
  </div>
}

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!pw || busy) return
    setBusy(true); setErr('')
    try { await post('api/login', { password: pw }); setPw(''); onDone() } catch (x: any) { setErr(x.message || '登录失败') } finally { setBusy(false) }
  }
  const plain = location.protocol === 'http:' && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost'
  return <main className="login"><form onSubmit={submit}>
    <div className="login__brand"><Logo size={46} /><div><h1>superagent</h1><p>AI 工位调度后台</p></div></div>
    <input type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} placeholder="管理口令" autoFocus />
    <button className="primary" disabled={busy || !pw}>{busy ? '登录中…' : '登录'}</button>
    {err && <p className="formerr">{err}</p>}
    {plain && <p className="login__note">当前是 HTTP 连接，口令会明文传输。</p>}
  </form></main>
}

const PAGES: Record<string, React.ComponentType> = {
  new: P.NewTask, director: Director, today: Today, projects: P.Projects, usage: P.Usage, events: P.Events, decisions: P.Decisions, system: P.System, pi: PiVersions, devenv: DevEnv,
  connections: P.Connections, secrets: P.Secrets, novels: P.Novels, settings: P.Settings, councils: P.Councils, fanqie: Fanqie, defense: Defense, pentest: Pentest,
  memory: MemoryPage, schedules: SchedulerPage,
}

const TOOL_GROUPS: [string, [string, string][]][] = [
  ['任务与调度', [['director', '总控助手'], ['tickets', '全部任务'], ['new', '直接发任务'], ['today', '今日总览'], ['projects', '项目库'], ['councils', '多角色会商'], ['schedules', '定时与巡检']]],
  ['记忆与统计', [['memory', '记忆与进化'], ['usage', '花费统计']]],
  ['环境与配置', [['devenv', '共享开发环境'], ['connections', '连接中心'], ['secrets', '密钥库'], ['pi', 'Pi 版本'], ['settings', '系统设置']]],
  ['安全与创作', [['defense', '防御工作台'], ['pentest', '渗透工作台'], ['novels', '书库'], ['fanqie', '番茄发布']]],
  ['系统记录', [['system', '系统与备份'], ['events', '事件流'], ['decisions', '判断记录']]],
]

const DOMAIN_TABS: { id: string; keys: string[]; tabs: [string, string][] }[] = [
  { id: 'tasks', keys: ['tickets', 'new', 'today', 'projects', 'councils', 'schedules'], tabs: [['tickets', '全部任务'], ['new', '发任务'], ['today', '今日总览'], ['projects', '项目库'], ['councils', '会商'], ['schedules', '定时巡检']] },
  { id: 'memory', keys: ['memory', 'usage'], tabs: [['memory', '记忆与进化'], ['usage', '花费统计']] },
  { id: 'env', keys: ['devenv', 'connections', 'secrets', 'pi', 'settings', 'system', 'events', 'decisions'], tabs: [['devenv', '共享环境'], ['connections', '连接中心'], ['secrets', '密钥库'], ['pi', 'Pi'], ['settings', '设置'], ['system', '系统']] },
  { id: 'sec', keys: ['defense', 'pentest'], tabs: [['defense', '防御工作台'], ['pentest', '渗透工作台']] },
  { id: 'write', keys: ['novels', 'fanqie'], tabs: [['novels', '书库'], ['fanqie', '番茄发布']] },
]

const THEME_OPTIONS: { id: ThemeMode; label: string; desc: string; swatch: string }[] = [
  { id: 'carbon', label: '暖炭绒黑', desc: '温润低反光 · 默认', swatch: '#1C1B1A' },
  { id: 'obsidian', label: '纯粹曜黑', desc: '深邃高对比 OLED', swatch: '#09090B' },
  { id: 'light', label: '瓷白工作室', desc: '清透柔和纸感', swatch: '#F5F5F7' },
]

const CMD_LINKS: { label: string; hint: string; href: string; keywords: string }[] = [
  { label: '总控助手', hint: '对话主舞台 + 实时任务执行与进度', href: '#/director', keywords: 'director ai assistant 总控 助手 飞书 微信 对话' },
  { label: '全部任务', hint: '查看、筛选、批量管理工单与详情', href: '#/tickets', keywords: 'tickets list 工单 任务' },
  { label: '发任务', hint: '新建一条 AI 执行任务', href: '#/new', keywords: 'new task ask 新建 派单' },
  { label: '今日总览', hint: '传统工位总览、待处理、今日花费', href: '#/today', keywords: 'today home 首页 今日' },
  { label: '记忆与进化', hint: '主人画像、三层长期记忆、技能 SOP 与自进化复盘', href: '#/memory', keywords: 'memory skill sop plugin evolution 记忆 技能 插件 复盘 进化' },
  { label: '花费统计', hint: '今日 / 7 天 / 30 天 模型调用成本', href: '#/usage', keywords: 'usage cost 花费 账单 统计' },
  { label: '共享开发环境', hint: '共享缓存目录、一键瘦身与容器镜像', href: '#/devenv', keywords: 'devenv cache docker 环境 缓存 开发' },
  { label: '系统设置', hint: '总控、模型、飞书、微信、邮箱与预算配置', href: '#/settings', keywords: 'settings config 设置 配置' },
  { label: '总控设置', hint: '总控模型、失败重试、主动汇报与高危审批', href: '#/settings/director', keywords: 'director settings retry 总控 设置 重试' },
  { label: '连接中心', hint: '飞书、微信、邮箱、GitHub、SSH', href: '#/connections', keywords: 'connections wechat email feishu 微信 邮箱 飞书' },
  { label: '项目库', hint: '上传和管理源码压缩包', href: '#/projects', keywords: 'projects repo 代码 项目' },
  { label: '定时与巡检', hint: 'Cron 定时派单、总控巡检、零 Token HTTP 监控', href: '#/schedules', keywords: 'schedule cron watch 定时 巡检 监控 调度' },
  { label: '多角色会商', hint: '多角色 AI 讨论与任务书', href: '#/councils', keywords: 'councils 讨论 会商' },
  { label: '密钥库', hint: '加密保存、按任务授权', href: '#/secrets', keywords: 'secrets vault 密钥' },
  { label: '模型与路由', hint: '服务商、默认模型、自动挑选', href: '#/settings/models', keywords: 'models provider 模型' },
  { label: '防御工作台', hint: '应用安全代码审查、配置基线核查与直接加固', href: '#/defense', keywords: 'defense hardening appsec code review security 防御 加固 安全' },
  { label: '渗透工作台', hint: '内部红队测试、源码快扫、OWASP 剧本与漏洞库', href: '#/pentest', keywords: 'pentest redteam security 漏洞 渗透 红队 扫描' },
  { label: '书库与写作', hint: '小说写作引擎', href: '#/novels', keywords: 'novels book 小说 书库' },
  { label: '番茄发布', hint: '番茄小说章节发布同步', href: '#/fanqie', keywords: 'fanqie 番茄 发布' },
  { label: 'Pi 版本', hint: '执行引擎版本与切换', href: '#/pi', keywords: 'pi version 版本' },
  { label: '系统与备份', hint: '健康检查、清理与立即备份', href: '#/system', keywords: 'system backup 系统 备份' },
  { label: '事件流', hint: '全局运行事件审计', href: '#/events', keywords: 'events 事件' },
  { label: '判断记录', hint: '策略与审批历史判断', href: '#/decisions', keywords: 'decisions 判断' },
]

function CommandPalette({
  open,
  onClose,
  themeMode,
  setTheme,
  onNewChat,
}: {
  open: boolean
  onClose: () => void
  themeMode: ThemeMode
  setTheme: (m: ThemeMode) => void
  onNewChat: () => void
}) {
  const [q, setQ] = useState('')
  useEffect(() => { if (!open) setQ('') }, [open])
  if (!open) return null
  const needle = q.trim().toLowerCase()
  const list = CMD_LINKS.filter(c => !needle || c.label.toLowerCase().includes(needle) || c.hint.toLowerCase().includes(needle) || c.keywords.toLowerCase().includes(needle))
  const pick = (href: string) => { onClose(); location.hash = href }
  return <Sheet title="快速跳转（⌘K / Ctrl+K）" onClose={onClose}>
    <input className="search" value={q} autoFocus placeholder="输入页面名、功能或关键词（如 总控、记忆、环境、飞书、防御）…"
      onChange={e => setQ(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && list[0]) pick(list[0].href) }} />
    <div className="cmd-themes" role="group" aria-label="界面主题">
      {THEME_OPTIONS.map(t => (
        <button
          key={t.id}
          type="button"
          className={themeMode === t.id ? 'cmd-theme is-on' : 'cmd-theme'}
          onClick={() => { setTheme(t.id); toast(`已切换至「${t.label}」`) }}
        >
          <i className="theme-dot" style={{ background: t.swatch }} />
          <span>{t.label}</span>
        </button>
      ))}
    </div>
    <div className="cmdlist">
      {!needle && (
        <button type="button" className="row" onClick={() => { onClose(); onNewChat() }}>
          <b>+ 新开总控对话（网页 / 飞书）</b>
          <span className="meta">选择网页独立会话或绑定飞书同步会话</span>
        </button>
      )}
      {list.map(c => <button key={c.href} type="button" className="row" onClick={() => pick(c.href)}><b>{c.label}</b><span className="meta">{c.hint}</span></button>)}
    </div>
  </Sheet>
}

function App() {
  const h = useHash()
  const [auth, setAuth] = useState<'unknown' | 'in' | 'out'>('unknown')
  const top = useRef<HTMLElement>(null)
  useEffect(() => {
    get('api/me').then(m => setAuth(m?.authenticated ? 'in' : 'out')).catch(() => setAuth('out'))
    const f = () => setAuth('out'); addEventListener('sa-401', f); return () => removeEventListener('sa-401', f)
  }, [])
  useEffect(() => { window.scrollTo?.(0, 0) }, [h])
  if (auth === 'unknown') return <main><p className="meta">加载中…</p></main>
  if (auth === 'out') return <><Login onDone={() => setAuth('in')} /><ToastHost /><DialogHost /></>
  const logout = () => { post('api/logout', {}).catch(() => {}).finally(() => setAuth('out')) }
  const m = /^#\/tickets\/([^/?]+)/.exec(h)
  const key = /^#\/([a-z0-9-]+)/.exec(h)?.[1] || 'director'
  return <Shell h={h} m={m} k={key} logout={logout} top={top} />
}

const NAV_PLUGIN_GUARD: Record<string, string> = {
  schedules: 'scheduler',
  memory: 'memory-skills',
}

function Shell({ h, m, k: key, logout, top }: { h: string; m: RegExpExecArray | null; k: string; logout: () => void; top: React.RefObject<HTMLElement> }) {
  const live = useLiveSource(true)
  const theme = useTheme()
  const pluginsPoll = usePoll<{ items: PluginDescriptor[] }>('api/plugins', 30000)
  useEffect(() => {
    const onChanged = () => pluginsPoll.reload()
    window.addEventListener('sa-plugins-changed', onChanged)
    return () => window.removeEventListener('sa-plugins-changed', onChanged)
  }, [pluginsPoll.reload])
  const disabledPlugins = useMemo(() => {
    const set = new Set<string>()
    for (const p of pluginsPoll.d?.items ?? []) {
      if (!p.enabled) set.add(p.id)
    }
    return set
  }, [pluginsPoll.d])

  const [cmdOpen, setCmdOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [themePopOpen, setThemePopOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen(v => !v)
      } else if (e.key === 'Escape') {
        setThemePopOpen(false)
        setDrawerOpen(false)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  // 路由变化时关闭抽屉与弹出层
  useEffect(() => {
    setDrawerOpen(false)
    setToolsOpen(false)
    setThemePopOpen(false)
  }, [h])

  const b = live.board
  const need = b?.tickets.needsPerson ?? 0
  const running = b?.tickets.running ?? 0
  const Page = PAGES[key]
  const isDirector = !m && key === 'director'
  const isTaskDomain = !!m || ['tickets', 'new', 'today', 'projects', 'councils', 'schedules'].includes(key)
  const isMemoryDomain = !m && ['memory', 'usage'].includes(key)
  const isEnvDomain = !m && ['devenv', 'settings', 'connections', 'secrets', 'pi', 'system', 'events', 'decisions'].includes(key)
  const isExtraDomain = !m && ['defense', 'pentest', 'novels', 'fanqie', 'more'].includes(key)

  const pageLabel = m
    ? '任务详情'
    : (TOOL_GROUPS.flatMap(([, items]) => items).find(([k]) => k === key)?.[1] || (key === 'more' ? '全部工具' : '总控助手'))
  const activeDomain = DOMAIN_TABS.find(d => (m && d.id === 'tasks') || d.keys.includes(key))
  const liveWord = live.live ? '实时' : b ? '轮询' : live.err ? '断开' : '连接中'

  const triggerNewChat = () => {
    setDrawerOpen(false)
    setToolsOpen(false)
    if (isDirector) {
      window.dispatchEvent(new CustomEvent('sa-director-new-chat'))
    } else {
      location.hash = '#/director'
      setTimeout(() => window.dispatchEvent(new CustomEvent('sa-director-new-chat')), 80)
    }
  }

  const pickTheme = (mode: ThemeMode) => {
    theme.setMode(mode)
    setThemePopOpen(false)
    const found = THEME_OPTIONS.find(x => x.id === mode)
    if (found) toast(`已切换至「${found.label}」`)
  }

  const cycleThemeWithToast = () => {
    const order: ThemeMode[] = ['carbon', 'obsidian', 'light']
    const next = order[(order.indexOf(theme.mode) + 1) % order.length]!
    pickTheme(next)
  }

  const shellClass = ['shell', isDirector ? 'is-director' : 'is-subpage'].join(' ')

  return <LiveContext.Provider value={live}>
    <div className={shellClass}>
      {/* 移动端极简顶栏（48px，无底部 5 格遮挡栏） */}
      <header className="mbar only-mobile">
        <button type="button" className="mbar__btn" aria-label="打开导航菜单" onClick={() => setDrawerOpen(true)}>
          <Icon name="menu" size={19} />
        </button>
        <a className="mbar__title" href={isDirector ? '#/director' : `#/${key}`}>
          <i className="mbar__dot" data-on={live.live} />
          <span>{pageLabel}</span>
        </a>
        <div className="mbar__tools">
          <button type="button" className="mbar__btn" aria-label="快速跳转" onClick={() => setCmdOpen(true)}>
            <Icon name="search" size={17} />
          </button>
          <button type="button" className="mbar__btn" aria-label={`切换主题（当前：${theme.label}）`} onClick={cycleThemeWithToast}>
            <Icon name={theme.dark ? 'moon' : 'sun'} size={17} />
          </button>
        </div>
      </header>

      {/* PC 端极简 56px 左侧图标轨道（苹果工业风） */}
      <aside className="srail only-desktop" aria-label="主导航">
        <div className="srail__top">
          <a className="srail__logo" href="#/director" title="SuperAgent 总控台">
            <Logo size={26} />
          </a>
          <button
            type="button"
            className="srail__btn srail__new"
            title="新开对话（网页 / 飞书）"
            aria-label="新开对话"
            onClick={triggerNewChat}
          >
            <Icon name="new" size={17} stroke={2} />
          </button>
        </div>

        <nav className="srail__nav" aria-label="核心域">
          <a
            href="#/director"
            className="srail__item"
            aria-current={isDirector ? 'page' : undefined}
            title="总控与进度"
            aria-label="总控与进度"
          >
            <Icon name="director" size={19} />
            {need > 0 && <span className="srail__badge is-warn">{need}</span>}
          </a>
          <a
            href="#/tickets"
            className="srail__item"
            aria-current={isTaskDomain ? 'page' : undefined}
            title="任务与项目"
            aria-label="任务与项目"
          >
            <Icon name="tickets" size={19} />
            {running > 0 && <span className="srail__badge is-run">{running}</span>}
          </a>
          <a
            href={disabledPlugins.has('memory-skills') ? '#/usage' : '#/memory'}
            className="srail__item"
            aria-current={isMemoryDomain ? 'page' : undefined}
            title="主人记忆与统计"
            aria-label="主人记忆与统计"
          >
            <Icon name="memory" size={19} />
          </a>
          <a
            href="#/devenv"
            className="srail__item"
            aria-current={isEnvDomain ? 'page' : undefined}
            title="环境与配置"
            aria-label="环境与配置"
          >
            <Icon name="settings" size={19} />
          </a>
          <button
            type="button"
            className={isExtraDomain || toolsOpen ? 'srail__item is-active' : 'srail__item'}
            title="全部功能与工具"
            aria-label="全部功能与工具"
            onClick={() => setToolsOpen(true)}
          >
            <Icon name="grid" size={18} />
          </button>
        </nav>

        <div className="srail__foot">
          <button
            type="button"
            className="srail__btn"
            title="快速跳转（⌘K / Ctrl+K）"
            aria-label="快速跳转"
            onClick={() => setCmdOpen(true)}
          >
            <Icon name="search" size={17} />
          </button>
          <div className="srail__themewrap">
            <button
              type="button"
              className={themePopOpen ? 'srail__btn is-active' : 'srail__btn'}
              title={`切换外观（当前：${theme.label}）`}
              aria-label={`切换外观（当前：${theme.label}）`}
              aria-expanded={themePopOpen}
              onClick={() => setThemePopOpen(v => !v)}
            >
              <Icon name={theme.dark ? 'moon' : 'sun'} size={17} />
            </button>
            {themePopOpen && (
              <div className="theme-pop" role="menu" aria-label="选择界面主题">
                <span className="theme-pop__label">界面外观</span>
                {THEME_OPTIONS.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={theme.mode === t.id}
                    className={theme.mode === t.id ? 'theme-pop__opt is-on' : 'theme-pop__opt'}
                    onClick={() => pickTheme(t.id)}
                  >
                    <i className="theme-dot" style={{ background: t.swatch }} />
                    <span>
                      <b>{t.label}</b>
                      <small>{t.desc}</small>
                    </span>
                    {theme.mode === t.id && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="srail__btn"
            title="退出登录"
            aria-label="退出登录"
            onClick={logout}
          >
            <Icon name="logout" size={17} />
          </button>
        </div>
      </aside>

      {/* 非总控子页面上下文顶栏（PC 端） */}
      {!isDirector && (
        <div className="subbar only-desktop" role="banner">
          <div className="subbar__left">
            <a className="subbar__back" href="#/director">
              <Icon name="back" size={15} />
              <span>总控</span>
            </a>
            <span className="subbar__sep" aria-hidden="true">/</span>
            {activeDomain ? (
              <nav className="subbar__tabs" aria-label="域内导航">
                {activeDomain.tabs
                  .filter(([k]) => !NAV_PLUGIN_GUARD[k] || !disabledPlugins.has(NAV_PLUGIN_GUARD[k]!))
                  .map(([k, label]) => (
                    <a key={k} href={`#/${k}`} aria-current={key === k || (m && k === 'tickets') ? 'page' : undefined}>
                      {label}
                    </a>
                  ))}
              </nav>
            ) : (
              <b className="subbar__title">{pageLabel}</b>
            )}
          </div>
          <div className="subbar__right">
            <span className="subbar__live" data-on={live.live}><i />{liveWord}</span>
            <button type="button" className="subbar__search" onClick={() => setCmdOpen(true)}>
              <Icon name="search" size={14} />
              <span>跳转…</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
        </div>
      )}

      {/* 主内容视口 */}
      <main ref={top} key={m ? 'd' + m[1] : isDirector ? 'director' : h}>
        <Suspense fallback={<p className="meta">加载中…</p>}>
          {m ? <Detail id={safeDecode(m[1]!)} /> : key === 'tickets' ? <Tickets /> : key === 'more' ? <P.More onLogout={logout} /> : Page ? <Page /> : <Director />}
        </Suspense>
      </main>

      {/* PC 端全部工具弹窗 */}
      {toolsOpen && (
        <Sheet title="全部功能与工作台" onClose={() => setToolsOpen(false)}>
          <div className="tools-groups">
            {TOOL_GROUPS.map(([groupName, items]) => {
              const visible = items.filter(([k]) => !NAV_PLUGIN_GUARD[k] || !disabledPlugins.has(NAV_PLUGIN_GUARD[k]!))
              if (visible.length === 0) return null
              return <div key={groupName} className="tools-group">
                <h4>{groupName}</h4>
                <div className="tools-grid">
                  {visible.map(([k, label]) => (
                    <a
                      key={k}
                      href={`#/${k}`}
                      className={key === k ? 'tools-item is-on' : 'tools-item'}
                      onClick={() => setToolsOpen(false)}
                    >
                      <Icon name={k} size={17} />
                      <span>{label}</span>
                    </a>
                  ))}
                </div>
              </div>
            })}
          </div>
        </Sheet>
      )}

      {/* 手机端轻盈侧滑导航抽屉 */}
      {drawerOpen && (
        <div className="sdrawer-mask" onClick={e => { if (e.target === e.currentTarget) setDrawerOpen(false) }}>
          <aside className="sdrawer" role="dialog" aria-label="导航菜单">
            <div className="sdrawer__head">
              <div className="sdrawer__brand">
                <Logo size={24} />
                <div>
                  <b>SuperAgent</b>
                  <span className="meta">{live.live ? '实时在线' : liveWord}</span>
                </div>
              </div>
              <button type="button" className="ghost small" aria-label="关闭菜单" onClick={() => setDrawerOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>

            <button type="button" className="primary wide sdrawer__new" onClick={triggerNewChat}>
              <Icon name="new" size={15} />新开对话（网页 / 飞书）
            </button>

            <div className="sdrawer__body">
              {TOOL_GROUPS.map(([groupName, items]) => {
                const visible = items.filter(([k]) => !NAV_PLUGIN_GUARD[k] || !disabledPlugins.has(NAV_PLUGIN_GUARD[k]!))
                if (visible.length === 0) return null
                return <div key={groupName} className="sdrawer__group">
                  <span className="sdrawer__glabel">{groupName}</span>
                  {visible.map(([k, label]) => (
                    <a
                      key={k}
                      href={`#/${k}`}
                      className={key === k ? 'sdrawer__link is-on' : 'sdrawer__link'}
                      onClick={() => setDrawerOpen(false)}
                    >
                      <Icon name={k} size={17} />
                      <span>{label}</span>
                      {k === 'tickets' && need > 0 && <span className="nb need">{need}</span>}
                      {k === 'today' && running > 0 && <span className="nb run">{running}</span>}
                    </a>
                  ))}
                </div>
              })}
            </div>

            <div className="sdrawer__foot">
              <span className="sdrawer__glabel">界面主题</span>
              <div className="sdrawer__themes">
                {THEME_OPTIONS.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    className={theme.mode === t.id ? 'cmd-theme is-on' : 'cmd-theme'}
                    onClick={() => pickTheme(t.id)}
                  >
                    <i className="theme-dot" style={{ background: t.swatch }} />
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="ghost danger sdrawer__logout" onClick={() => { setDrawerOpen(false); logout() }}>
                <Icon name="logout" size={16} />退出登录
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* 点击空白处收起主题浮层 */}
      {themePopOpen && <div className="pop-backdrop" onClick={() => setThemePopOpen(false)} aria-hidden="true" />}

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        themeMode={theme.mode}
        setTheme={pickTheme}
        onNewChat={triggerNewChat}
      />
      <ToastHost />
      <DialogHost />
    </div>
  </LiveContext.Provider>
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>)
