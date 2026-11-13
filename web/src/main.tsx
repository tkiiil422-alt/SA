import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { API, get, post, put, del } from './api'
import { usePoll, ago, money } from './hooks'
import { useSteps } from './useSteps'
import { LiveContext, useLive, useLiveSource, useTick, clock, secondsSince, type RunningStep } from './useLive'
import { ToastHost, toast, useAction, Sheet, Empty, Tabs, bytes } from './ui'
import * as P from './pages'
import { Fanqie } from './fanqie'
import { PiVersions } from './pi'
import { Icon, Logo } from './icons'
import { GoalCard, GoalSheet } from './goal'
import './style.css'

const useHash = () => {
  const [h, set] = useState(location.hash || '#/today')
  useEffect(() => {
    const f = () => set(location.hash || '#/today')
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
const TOOL_WORD: Record<string, string> = { bash: '命令', read: '读文件', write: '写文件', edit: '改文件', subagent: '协作', say: '说', think: '想', turn: '节点', goal: '目标' }
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

function Today() {
  const { board: b, err, skew } = useLive()
  const fq = usePoll<any>('api/fanqie/status', 30000)
  useTick()
  const modelName = useModelNames()
  const head = <header className="phead"><div><h1>今日</h1><p className="phead__sub">{dateLine()}</p></div><LiveBadge /></header>
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
          <div className="sechead"><h2>工位</h2><span className="sechead__note">{running.length ? `${running.length} / ${b.slots.max} 在干活` : `${b.slots.max} 个都空着`}</span></div>
          <div className="lanes">
            {running.map((t, i) => <Lane key={t.id} n={i + 1} t={t} step={steps.get(t.id)} skew={skew} modelName={modelName} />)}
            {Array.from({ length: idleSlots }, (_, i) => <div key={'idle' + i} className="lane" data-st="idle">
              <span className="lane__no">{running.length + i + 1}</span>
              <span className="lane__main"><span className="lane__title">空闲</span>
                {i === 0 && <span className="lane__step"><span className="sum"><a href="#/new">发一个任务</a>，它会在这里开工</span></span>}</span>
            </div>)}
          </div>
          {queued.length > 0 && <p className="queued">排队中 {queued.length} 个：{queued.slice(0, 3).map((t, i) => <a key={t.id} href={link(t.id)}>{i ? '、' : ''}{t.title}</a>)}{queued.length > 3 ? ' 等' : ''}</p>}
        </section>

        <section className="ended" aria-label="最近结束">
          <div className="sechead"><h2>最近结束</h2><a className="sechead__note" href="#/tickets">全部任务</a></div>
          {b.ended.length ? <ul className="endlist">{b.ended.map(t => <li key={t.id}>
            <a href={link(t.id)}><Mark tone={toneOf(t)} /><span className="t">{t.title}</span>
              <span className="w" data-tone={toneOf(t)}>{STATUS_WORD[t.outcome] || '已结束'}</span><span className="a">{ago(t.updatedAt)}</span></a>
          </li>)}</ul> : <Empty>今天还没有结束的任务。</Empty>}
        </section>
      </div>

      <aside className="today__side" aria-label="今天概况">
        <div className="panel">
          <h3>今天花费</h3>
          <p className="bignum">{money(b.usage.todayUsd)}</p>
          {budget > 0 ? <><div className="meter"><span style={{ width: `${Math.max(2, pct * 100)}%` }} data-lv={pct > 0.9 ? 'error' : pct > 0.7 ? 'warn' : ''} /></div>
            <p className="meta">每天上限 {money(budget)}，用了 {Math.round(pct * 100)}%</p></> : <p className="meta">没有设每天上限</p>}
          <dl className="mini">
            <dt>模型调用</dt><dd>{b.usage.todayCalls ?? 0}</dd>
            <dt>结束的任务</dt><dd>{b.tickets.endedToday}</dd>
            <dt>等你回答</dt><dd>{b.tickets.needsPerson}</dd>
          </dl>
        </div>
        <div className="panel">
          <h3>运行</h3>
          <p className="statline"><i data-ok={!b.paused} /><span>{b.paused ? '已暂停接单' : '正常接单'}</span></p>
          <p className="statline"><i data-ok={b.upstream?.ok !== false} /><span>{b.upstream?.model || '没有配置模型'}</span><span className="meta">{b.upstream?.ok === false ? '最近失败' : b.upstream?.provider}</span></p>
          <p className="statline"><i data-ok="true" /><span>工位 {b.slots.used} / {b.slots.max}</span>{b.slots.reservedForPerson ? <span className="meta">给人留 {b.slots.reservedForPerson}</span> : null}</p>
          <a className="panel__link" href="#/system">系统详情<Icon name="chev" size={14} /></a>
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
  const remove = () => {
    if (!picked.size || !confirm(`删除选中的 ${picked.size} 个任务？会删除记录和工作区文件，花费记录保留；进行中的任务会跳过。`)) return
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

const KIND_WORD: Record<string, string> = { say: '说', think: '想', turn: '节点', goal: '目标' }
const TOOL_LABEL: Record<string, string> = { subagent: '协作' }
const AGENT_WORD: Record<string, string> = { queued: '排队', running: '进行中', done: '完成', failed: '失败', stopped: '中断' }
type AgentView = { role: string; name?: string; model?: string; state: string }
const roleName = (a: AgentView): string => a.name || ROLE_NAME[a.role] || a.role
/** A finished delegation has no sub-agent still working: one left running was cut off. */
const agentState = (a: AgentView, stepStatus: string): string => stepStatus !== 'running' && a.state === 'running' ? 'stopped' : a.state
/** Model ids as the console names them: `sa-gw/claude-opus-5-5` or `claude-opus-5-5` → the configured label. */
function useModelNames(): (model?: string) => string {
  const { d } = usePoll<any>('api/models', 600000)
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
}
const ROLE_NAME: Record<string, string> = { scout: '侦察', planner: '规划', reviewer: '审查', advisor: '顾问', helper: '帮手' }
const SHOW_STEPS = 10
function StepList({ id, mainModel, active, goalChecking }: { id: string; mainModel?: string; active?: boolean; goalChecking?: boolean }) {
  const { steps, live } = useSteps(encodeURIComponent(id))
  const modelName = useModelNames()
  const [all, setAll] = useState(false)
  const shown = all ? steps.slice(-300) : steps.slice(-SHOW_STEPS)
  const hidden = steps.length - shown.length
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
    {goalChecking && <p className="nowrun" data-who="goal"><i aria-hidden="true" /><span>宿主在检查目标：跑验收命令、让判定模型核对。主 AI 在等结果。</span></p>}
    {working && !goalChecking && <p className="nowrun" data-who={delegating ? 'sub' : 'main'}><i aria-hidden="true" />
      {delegating
        ? busy.length > 0
          ? <span>子代理在干活：<b>{busy.map(a => `${roleName(a)}（${modelName(a.model) || '模型未知'}）`).join('、')}</b>。主 AI{mainName ? `（${mainName}）` : ''}在等它们交回结果。</span>
          : <span>主 AI 派出了子代理，正在排队启动。</span>
        : <span>主 AI 在干活{mainName ? <>，用的是 <b>{mainName}</b></> : null}。</span>}
    </p>}
    {!steps.length && <Empty>还没有记录到步骤：可能在排队、准备文件，或者这是部署前的旧任务。</Empty>}
    {hidden > 0 && <button className="ghost small" onClick={() => setAll(true)}>显示更早的 {hidden} 步</button>}
    <ol className="steps">{shown.map(s => {
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
    })}</ol>
    {all && steps.length > SHOW_STEPS && <button className="ghost small" onClick={() => setAll(false)}>只看最新 {SHOW_STEPS} 步</button>}
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
  const deleteTicket = () => {
    if (!confirm('删除这张任务？会删除任务记录和工作区文件，花费记录保留。')) return
    run(() => del(base, { deleteWorkspace: true, force: !ended }), '已删除', () => { location.hash = '#/tickets' })
  }
  const tone = !d ? 'run' : ended ? (d.outcome === 'failed' ? 'bad' : 'done') : d.attention ? 'human' : 'run'
  return <div className="detail"><a href="#/tickets" className="back"><Icon name="back" size={16} />全部任务</a>
    <h1>{d?.title || '…'}</h1>
    <P.Loading d={d} err={err} />
    {d && <div className="dmeta">
      <span className="pill" data-tone={tone}>{d.stageLabel}</span>
      {d.model?.label && <span><Icon name="model" size={15} />{d.model.label}</span>}
      <span><Icon name="coin" size={15} />{money(d.usage?.totalUsd)}</span>
      <span><Icon name="clock" size={15} />更新于 {ago(d.updatedAt)}</span>
    </div>}
    {d?.attention?.question && <div className="ask"><b>等你回答</b><p>{d.attention.question}</p></div>}
    {d?.delivery && <p className="warn">结果没送达：{d.delivery.error}</p>}
    {d?.goal && <GoalCard id={id} goal={d.goal} ended={ended} onChange={reload} />}
    <Tabs value={cur} onChange={setTab} items={[['steps', '过程'], ['result', '结果'], ['files', '文件'], ['council', '会商'], ['info', '信息']]} />
    {cur === 'steps' && <StepList id={id} mainModel={d?.model?.label} active={!!d && d.status !== 'ended' && !d.attention} goalChecking={!!d?.goal?.checking} />}
    {cur === 'result' && <>
      {last ? <div className="card"><h2>最新报告 <small>{last.state} · {ago(last.at)}</small></h2><pre className="report">{last.summary}</pre></div> : <Empty>还没有报告。</Empty>}
      {reports.length > 1 && <details><summary>更早的报告（{reports.length - 1} 份）</summary>{reports.slice(0, -1).reverse().map((r: any) => <pre key={r.id + r.at}>{r.state} · {r.at}{'\n'}{r.summary}</pre>)}</details>}
      {!!d?.previews?.length && <><h2>预览</h2>{d.previews.map((p: any) => <div className="row" key={p.port}><a href={p.url} target="_blank" rel="noopener">{p.title || `端口 ${p.port}`}</a><span className="meta">{p.active ? '在线' : '已停止（显示留存文件）'} · <button className="ghost small" onClick={() => navigator.clipboard?.writeText(p.url).then(() => toast('已复制'), () => toast('复制失败', true))}>复制链接</button></span></div>)}</>}
      {!!d?.links?.length && <><h2>链接</h2>{d.links.filter((l: any) => /^https?:\/\//.test(l.url)).map((l: any) => <a className="row" key={l.url} href={l.url} target="_blank" rel="noopener">{l.title || l.url}</a>)}</>}
    </>}
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
      <textarea value={text} onChange={e => setText(e.target.value)} placeholder={ended ? '写一句话重新打开它…' : d?.attention ? '回答它的问题…' : '给它补一句…'} rows={1} />
      <button className="primary" onClick={send} disabled={busy || !text.trim()}>发送</button>
    </div>
    {sheet === 'more' && <Sheet title="操作" onClose={() => setSheet('')}>
      {d?.canRetry && !ended && <button className="row" disabled={busy} onClick={() => run(() => post(`${base}/retry`, {}), '已重新排队', () => { setSheet(''); reload() })}>重试</button>}
      {!ended && <button className="row" disabled={busy} onClick={() => { const n = prompt('给它留一条备注（不打断当前这一轮）'); if (n?.trim()) run(() => post(`${base}/note`, { text: n }), '已送到', () => setSheet('')) }}>留备注（不打断）</button>}
      {!ended && !(d?.goal && (d.goal.status === 'active' || d.goal.status === 'paused')) && <button className="row" onClick={() => setSheet('goal')}>设定目标（没达成就不停）</button>}
      <button className="row" onClick={() => setSheet('model')}>换模型</button>
      <button className="row" onClick={() => setSheet('secrets')}>管理可用密钥</button>
      {!ended && <button className="row danger" disabled={busy} onClick={() => { const r = prompt('停止这张任务？可以写一句原因（可留空）', ''); if (r !== null) run(() => post(`${base}/stop`, r.trim() ? { reason: r.trim() } : {}), '已停止', () => { setSheet(''); reload() }) }}>停止任务</button>}
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

const PAGES: Record<string, () => JSX.Element> = {
  new: P.NewTask, projects: P.Projects, usage: P.Usage, events: P.Events, decisions: P.Decisions, system: P.System, pi: PiVersions,
  connections: P.Connections, secrets: P.Secrets, novels: P.Novels, settings: P.Settings, councils: P.Councils, fanqie: Fanqie,
}
const SIDE_GROUPS: [string, [string, string][]][] = [
  ['工作', [['today', '今日'], ['tickets', '任务'], ['projects', '项目'], ['councils', '会商']]],
  ['写作', [['novels', '书库'], ['fanqie', '番茄发布']]],
  ['管理', [['usage', '花费'], ['secrets', '密钥'], ['connections', '连接'], ['pi', 'Pi 版本'], ['settings', '设置']]],
  ['记录', [['system', '系统'], ['events', '事件'], ['decisions', '判断记录']]],
]

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
  if (auth === 'out') return <><Login onDone={() => setAuth('in')} /><ToastHost /></>
  const logout = () => { post('api/logout', {}).catch(() => {}).finally(() => setAuth('out')) }
  const m = /^#\/tickets\/([^/?]+)/.exec(h)
  const key = /^#\/([a-z]+)/.exec(h)?.[1] || 'today'
  return <Shell h={h} m={m} k={key} logout={logout} top={top} />
}

function Shell({ h, m, k: key, logout, top }: { h: string; m: RegExpExecArray | null; k: string; logout: () => void; top: React.RefObject<HTMLElement> }) {
  const live = useLiveSource(true)
  const b = live.board
  const need = b?.tickets.needsPerson ?? 0
  const running = b?.tickets.running ?? 0
  const Page = PAGES[key]
  const cur = (k: string) => (m ? k === 'tickets' : key === k)
  const inMore = !m && !['today', 'tickets', 'new', 'projects'].includes(key)
  const badge = (k: string) => k === 'today' && running > 0 ? <span className="nb run">{running}</span>
    : k === 'tickets' && need > 0 ? <span className="nb need">{need}</span> : null
  const liveWord = live.live ? '实时连接' : b ? '轮询中' : live.err ? '连不上后台' : '连接中'
  return <LiveContext.Provider value={live}>
    <header className="mbar">
      <a className="mbar__brand" href="#/today"><Logo size={26} /><span>superagent</span></a>
      <span className="mbar__live" data-on={live.live}><i />{liveWord}</span>
    </header>
    <main ref={top} key={m ? 'd' + m[1] : h}>{m ? <Detail id={decodeURIComponent(m[1]!)} /> : key === 'tickets' ? <Tickets /> : key === 'more' ? <P.More onLogout={logout} /> : Page ? <Page /> : <Today />}</main>
    <nav className="tabs" aria-label="主导航">
      {TABS.map(([k, n]) => <a key={k} href={`#/${k}`} aria-current={k === 'more' ? inMore : cur(k)}><span className="tabs__ic"><Icon name={k} size={22} />{badge(k)}</span>{n}</a>)}
    </nav>
    <nav className="side" aria-label="侧栏">
      <a className="brand" href="#/today"><Logo size={32} /><span className="brand__name">superagent<small>AI 工位调度</small></span></a>
      <a className="newtask" href="#/new"><Icon name="new" size={18} stroke={2.2} />发任务</a>
      {SIDE_GROUPS.map(([g, items]) => <div className="navgroup" key={g}><span className="navgroup__h">{g}</span>
        {items.map(([k, n]) => <a key={k} href={`#/${k}`} aria-current={cur(k)}><Icon name={k} />{n}{badge(k)}</a>)}</div>)}
      <div className="side__foot">
        <span className="side__live" data-on={live.live}><i />{liveWord}</span>
        <button onClick={logout}><Icon name="logout" size={16} />退出登录</button>
      </div>
    </nav>
    <ToastHost /></LiveContext.Provider>
}

const TABS: [string, string][] = [['today', '今日'], ['tickets', '任务'], ['new', '发任务'], ['projects', '项目'], ['more', '更多']]

createRoot(document.getElementById('root')!).render(<App />)
