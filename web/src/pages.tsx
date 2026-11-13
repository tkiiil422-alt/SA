import { useEffect, useState } from 'react'
import { API, get, post, put, del, uploadProject } from './api'
import { usePoll, ago, money } from './hooks'
import { toast, useAction, Empty, Tabs, bytes, Sheet } from './ui'
import { Icon } from './icons'
import { GoalFields, emptyGoal, goalPayload } from './goal'

export function Loading({ d, err }: { d: unknown; err: string }) {
  if (err && !d) return <p className="warn">读取失败：{err}</p>
  if (!d) return <p className="meta">加载中…</p>
  return null
}
/** Path segments after the page key, e.g. #/novels/b_1/3 → ['b_1','3']. */
const segs = () => location.hash.replace(/^#\//, '').split('?')[0]!.split('/').slice(1).map(decodeURIComponent)
const query = () => new URLSearchParams(location.hash.split('?')[1] || '')

/* ---------- 发任务 ---------- */
export function NewTask() {
  const [text, setText] = useState(() => localStorage.getItem('sa-next-draft') || '')
  const [model, setModel] = useState('')
  const [projectId, setProjectId] = useState(() => query().get('project') || '')
  const [secrets, setSecrets] = useState<Set<string>>(new Set())
  const [council, setCouncil] = useState(false)
  const [helpers, setHelpers] = useState(true)
  const [goal, setGoal] = useState(emptyGoal)
  const goalBody = goalPayload(goal)
  const models = usePoll<any>('api/models', 60000)
  const projects = usePoll<any>('api/projects', 60000)
  const allSecrets = usePoll<any>('api/secrets', 60000)
  const cset = usePoll<any>('api/settings/council', 600000)
  const collabSet = usePoll<any>('api/settings/collab', 600000)
  const { busy, run } = useAction()
  useEffect(() => { localStorage.setItem('sa-next-draft', text) }, [text])
  useEffect(() => { if (cset.d?.defaultOn) setCouncil(true) }, [cset.d])
  const send = () => run(async () => {
    if (council) {
      const r = await post('api/councils', { mode: 'brief', text, autoStart: true, ...(projectId ? { projectId } : {}) })
      localStorage.removeItem('sa-next-draft')
      location.hash = r?.id ? `#/councils/${encodeURIComponent(r.id)}` : '#/councils'
      return
    }
    const r = await post('api/tickets', { text, ...(model ? { model } : {}), ...(projectId ? { projectId } : {}), ...(secrets.size ? { secrets: [...secrets] } : {}), ...(collabSet.d?.enabled && !helpers ? { collab: false } : {}), ...(goalBody ? { goal: goalBody } : {}) })
    localStorage.removeItem('sa-next-draft')
    const id = r?.ticketId ?? r?.id
    location.hash = id ? `#/tickets/${encodeURIComponent(id)}` : '#/tickets'
  }, council ? '会商已开始' : '已发出')
  const ready = (projects.d?.items || []).filter((p: any) => p.status === 'ready')
  return <><h1>发任务</h1>
    <textarea className="big" rows={7} value={text} onChange={e => setText(e.target.value)} placeholder="想让它做什么？写清楚要什么结果。" autoFocus />
    <div className="grid2">
      <label className="field">执行模型
        <select value={model} onChange={e => setModel(e.target.value)} disabled={council}>
          <option value="">{models.d?.autoSelect === false ? `默认（${models.d?.default || ''}）` : '让它挑'}</option>
          {(models.d?.items || []).map((m: any) => <option key={m.ref} value={m.ref}>{m.label || m.ref}{m.providerName ? `（${m.providerName}）` : ''}</option>)}
        </select></label>
      <label className="field">项目
        <select value={projectId} onChange={e => setProjectId(e.target.value)}>
          <option value="">不带项目</option>
          {ready.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
    </div>
    {!!allSecrets.d?.items?.length && !council && <details className="field"><summary>可用密钥（{secrets.size}）</summary>
      {allSecrets.d.items.map((s: any) => <label key={s.name} className="check"><input type="checkbox" checked={secrets.has(s.name)} onChange={() => setSecrets(p => { const n = new Set(p); n.has(s.name) ? n.delete(s.name) : n.add(s.name); return n })} /><span className="mono">{s.name}</span><span className="meta">{s.description}</span></label>)}
    </details>}
    {collabSet.d?.enabled && !council && <label className="check"><input type="checkbox" checked={helpers} onChange={e => setHelpers(e.target.checked)} /> 允许它在执行中叫别的模型帮忙（侦察、审查、顾问等，见「设置 → 协作」）</label>}
    {!council && <details className="field goalbox"><summary>设定目标：没达成就不停{goalBody ? '（已填写）' : ''}</summary>
      <GoalFields g={goal} set={patch => setGoal(x => ({ ...x, ...patch }))} /></details>}
    {cset.d?.enabled && <label className="check"><input type="checkbox" checked={council} onChange={e => setCouncil(e.target.checked)} /> 先让几个 AI 角色会商，出任务书后自动开工</label>}
    <p><button className="primary wide" disabled={busy || !text.trim()} onClick={send}>{busy ? '发送中…' : council ? '开始会商' : '发送'}</button></p>
    <RecentSent onPick={setText} /></>
}
function RecentSent({ onPick }: { onPick: (t: string) => void }) {
  const { d } = usePoll<any>('api/tickets?status=all&limit=5', 60000)
  if (!d?.items?.length) return null
  return <><h2>最近发过的</h2>{d.items.map((t: any) => <button key={t.id} className="row" onClick={() => onPick(t.title)}><b>{t.title}</b><span className="meta">{ago(t.createdAt)} · 点一下填入</span></button>)}</>
}

/* ---------- 项目 ---------- */
const PSTATUS: Record<string, string> = { uploading: '上传中', extracting: '解压中', ready: '可用', failed: '失败' }
export function Projects() {
  const { d, err, reload } = usePoll<any>('api/projects', 5000)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [prog, setProg] = useState<[number, number] | null>(null)
  const { busy, run } = useAction()
  const items: any[] = d?.items || []
  const upload = () => file && run(async () => {
    setProg([0, file.size])
    await uploadProject(file, name, (a, b) => setProg([a, b]))
    setFile(null); setName('')
  }, '上传完成，正在解压', () => { setProg(null); reload() }).then(ok => { if (!ok) setProg(null) })
  return <><h1>项目</h1>
    <div className="card">
      <h2>上传项目压缩包</h2>
      <input type="file" accept=".zip,.tar,.tgz,.tar.gz" onChange={e => setFile(e.target.files?.[0] || null)} />
      <label className="field">项目名（可选）<input value={name} onChange={e => setName(e.target.value)} placeholder={file?.name.replace(/\.(zip|tgz|tar\.gz|tar)$/i, '') || ''} /></label>
      {prog && <div className="bar"><span style={{ width: `${Math.round(prog[0] / Math.max(1, prog[1]) * 100)}%` }} /></div>}
      {prog && <p className="meta">{bytes(prog[0])} / {bytes(prog[1])}</p>}
      <button className="primary" disabled={busy || !file} onClick={upload}>{busy ? '上传中…' : '上传'}</button>
    </div>
    <Loading d={d} err={err} />
    {items.map(p => <div className="row" key={p.id}>
      <b>{p.name || p.id}</b>
      <span className="meta">{PSTATUS[p.status] || p.status} · {p.files ?? 0} 个文件 · {bytes(p.bytes)} · {ago(p.createdAt)}</span>
      {p.error && <span className="warn">{p.error}</span>}
      <span className="actions">
        {p.status === 'ready' && <a className="btn" href={`#/new?project=${encodeURIComponent(p.id)}`}>用它发任务</a>}
        <button className="ghost danger" disabled={busy} onClick={() => { if (confirm(`删除项目「${p.name}」？`)) run(() => del(`api/projects/${encodeURIComponent(p.id)}`), '已删除', reload) }}>删除</button>
      </span>
    </div>)}
    {d && !items.length && <Empty>还没有项目。上传一个压缩包，发任务时就能带上它。</Empty>}</>
}

/* ---------- 花费 ---------- */
const RANGES: [string, string][] = [['today', '今天'], ['7d', '7 天'], ['30d', '30 天']]
export function Usage() {
  const [range, setRange] = useState('today')
  const { d, err } = usePoll<any>(`api/usage?range=${range}`, 30000)
  const calls = usePoll<any>('api/usage/calls?limit=30', 30000)
  const t = d?.totals || {}
  const days: any[] = d?.byDay || []
  const max = Math.max(0.0001, ...days.map(x => x.usd || 0))
  return <><h1>花费</h1>
    <Tabs value={range} onChange={setRange} items={RANGES} />
    <Loading d={d} err={err} />
    {d && <div className="stats"><div><b>{money(t.usd)}</b><span>合计</span></div><div><b>{t.calls ?? 0}</b><span>调用</span></div><div><b>{Math.round((t.hitRate || 0) * 100)}%</b><span>缓存命中</span></div></div>}
    {days.length > 1 && <div className="chart">{days.map((x: any) => <div key={x.day || x.date} title={`${x.day || x.date} ${money(x.usd)}`}><span style={{ height: `${Math.max(2, (x.usd || 0) / max * 100)}%` }} /><small>{String(x.day || x.date || '').slice(5)}</small></div>)}</div>}
    {!!d?.byModel?.length && <h2>按模型</h2>}
    {(d?.byModel || []).map((m: any) => <div className="row" key={m.provider + m.model}><b>{m.model}</b><span className="meta">{m.provider} · {money(m.usd)} · {m.calls} 次 · 命中 {Math.round((m.hitRate || 0) * 100)}%</span></div>)}
    {!!d?.topTickets?.length && <h2>花得最多的任务</h2>}
    {(d?.topTickets || []).map((x: any) => <a className="row" key={x.ticketId} href={`#/tickets/${encodeURIComponent(x.ticketId)}`}><b>{x.title || x.ticketId}</b><span className="meta">{money(x.usd)}</span></a>)}
    <h2>最近调用</h2>
    {(calls.d?.items || []).map((c: any, i: number) => <div className="row" key={c.id ?? i} data-lv={c.status === 200 ? '' : 'warn'}><b>{c.model}</b><span className="meta">{c.status} · {money(c.costUsd ?? c.usd)} · {c.latencyMs ? `${(c.latencyMs / 1000).toFixed(1)}s · ` : ''}{ago(c.at)}</span></div>)}
    {calls.d && !(calls.d.items || []).length && <Empty>没有调用记录。</Empty>}</>
}

/* ---------- 事件 / 判断记录 ---------- */
export function Events() {
  const [level, setLevel] = useState('')
  const { d, err } = usePoll<any>(`api/events?limit=100${level ? `&level=${level}` : ''}`, 10000)
  return <><h1>事件</h1>
    <Tabs value={level} onChange={setLevel} items={[['', '全部'], ['warn', '警告'], ['error', '错误']]} />
    <Loading d={d} err={err} />
    {(d?.items || []).map((e: any, i: number) => <div className="row" key={e.id ?? i} data-lv={e.level}><span>{e.text}</span><span className="meta">{ago(e.at)} · {e.kind}{e.ticketId ? <> · <a href={`#/tickets/${encodeURIComponent(e.ticketId)}`}>任务</a></> : null}</span></div>)}
    {d && !(d.items || []).length && <Empty>没有事件。</Empty>}</>
}
export function Decisions() {
  const { d, err } = usePoll<any>('api/decisions?limit=50', 15000)
  return <><h1>判断记录</h1><Loading d={d} err={err} />
    {(d?.items || []).map((x: any) => <details className="row" key={x.id}><summary><b>{x.kind === 'accept' ? '受理' : x.kind === 'ignore' ? '忽略' : x.kind}</b> {x.triggerText}<span className="meta"> · {ago(x.at)}</span></summary>
      <p className="meta">{x.threadKey} · {x.strength}{x.ticketId ? <> · <a href={`#/tickets/${encodeURIComponent(x.ticketId)}`}>打开任务</a></> : null}</p>
      <ul>{(x.reasons || []).map((r: any, i: number) => <li key={i} className="meta">{r.label || r.code}</li>)}</ul>
    </details>)}
    {d && !(d.items || []).length && <Empty>还没有判断记录。</Empty>}</>
}

/* ---------- 系统 ---------- */
export function System() {
  const ov = usePoll<any>('api/overview', 10000)
  const sys = usePoll<any>('api/system', 30000)
  const backups = usePoll<any>('api/system/backups', 60000)
  const orphans = usePoll<any>('api/system/orphans', 60000)
  const { busy, run } = useAction()
  const [days, setDays] = useState(30)
  const [plan, setPlan] = useState<any>(null)
  const o = ov.d
  return <><h1>系统</h1><Loading d={o} err={ov.err} />
    {o && <div className="card">
      <p>版本 {o.version} · 已运行 {Math.round((o.uptimeSec || 0) / 60)} 分钟 · {o.paused ? <b className="warn">已暂停接单</b> : '正常接单'}</p>
      <p>槽位 {o.slots?.used}/{o.slots?.max}（给人留 {o.slots?.reservedForPerson}）· 进行中 {o.tickets?.open} · 等你 {o.tickets?.needsPerson}</p>
      <p>负载 {o.host?.load1?.toFixed?.(2)}（{o.host?.cpuCount} 核）· 内存 {Math.round(o.host?.memUsedPct || 0)}% · 磁盘剩余 {Math.round(o.host?.diskFreeGb || 0)} GB</p>
      <p>上游 {o.upstream?.provider}/{o.upstream?.model} · {o.upstream?.ok ? '正常' : <span className="warn">最近失败</span>}</p>
    </div>}
    <p className="actions">
      <button disabled={busy} onClick={() => { if (confirm(o?.paused ? '恢复接单？' : '暂停接单？新任务将不会被受理。')) run(() => post('api/pause', { paused: !o?.paused }), '已更新', ov.reload) }}>{o?.paused ? '恢复接单' : '暂停接单'}</button>
      <button disabled={busy} onClick={() => run(() => post('api/system/backups', {}), '已创建备份', backups.reload)}>立即备份</button>
    </p>
    <div className="card"><h2>清理旧工作区</h2>
      <label className="field">结束超过多少天<input type="number" min={0} max={3650} value={days} onChange={e => setDays(Number(e.target.value))} /></label>
      <p className="actions"><button disabled={busy} onClick={() => run(async () => setPlan(await post('api/system/cleanup', { olderThanDays: days, dryRun: true })))}>先预览</button>
        {plan && !plan.deleted?.length && plan.entries?.length > 0 && <button className="danger" disabled={busy} onClick={() => { if (confirm(`删除 ${plan.entries.length} 个工作区？`)) run(async () => setPlan(await post('api/system/cleanup', { olderThanDays: days, dryRun: false })), '已清理', ov.reload) }}>确认清理</button>}</p>
      {plan && <p className="meta">{plan.dryRun ? `将清理 ${plan.entries?.length || 0} 个，约 ${bytes(plan.entries?.reduce((s: number, e: any) => s + (e.bytes || 0), 0))}` : `已清理 ${plan.deleted?.length || 0} 个，释放 ${bytes(plan.freedBytes)}`}</p>}
      {plan?.dryRun && (plan.entries || []).slice(0, 20).map((e: any) => <p key={e.ticketId} className="meta">{e.title} · {e.ageDays} 天 · {bytes(e.bytes)}</p>)}
    </div>
    <div className="card"><h2>孤儿目录 <small>{orphans.d?.items?.length ?? 0} 个 · {bytes(orphans.d?.totalBytes)}</small></h2>
      <p className="meta">任务已删除但目录还在。</p>
      {!!orphans.d?.items?.length && <button className="danger" disabled={busy} onClick={() => { if (confirm(`清理 ${orphans.d.items.length} 个孤儿目录？`)) run(async () => { const r = await post('api/system/orphans/cleanup', { ids: [...new Set(orphans.d.items.map((x: any) => x.id))] }); toast(`已释放 ${bytes(r?.freedBytes)}`) }, undefined, orphans.reload) }}>全部清理</button>}
    </div>
    <div className="card"><h2>备份</h2><p className="meta mono">{backups.d?.dir}</p>
      {(backups.d?.items || []).slice(0, 10).map((b: any) => <p key={b.name} className="meta">{b.name} · {bytes(b.bytes)} · {ago(b.at)}</p>)}</div>
    {sys.d && <details><summary>详细信息</summary><pre>{JSON.stringify(sys.d, null, 2)}</pre></details>}</>
}

/* ---------- 连接 ---------- */
const STATE_WORD: Record<string, string> = { connected: '已连接', disconnected: '未连接', disabled: '未启用', off: '未启用', error: '出错', connecting: '连接中', idle: '空闲', running: '运行中', ok: '正常' }
export function Connections() {
  const feishu = usePoll<any>('api/settings/feishu/status', 20000)
  const email = usePoll<any>('api/settings/email/status', 20000)
  const gh = usePoll<any>('api/settings/github', 60000)
  const pv = usePoll<any>('api/settings/preview', 60000)
  const { busy, run } = useAction()
  const line = (v: any) => v.err ? '读取失败' : v.d ? (STATE_WORD[v.d.state] || v.d.state || '—') : '加载中…'
  const test = (k: string) => run(async () => { const r = await post(`api/settings/${k}/test`, {}); toast(r?.message || (r?.ok ? '连接正常' : '测试失败'), !r?.ok) })
  return <><h1>连接</h1>
    <div className="row"><b>飞书</b><span className="meta">{line(feishu)}{feishu.d?.mode ? ` · ${feishu.d.mode}` : ''}{feishu.d?.error ? ` · ${feishu.d.error}` : ''}</span>
      <span className="actions"><button disabled={busy} onClick={() => test('feishu')}>测试</button><button disabled={busy} onClick={() => run(() => post('api/settings/feishu/reconnect', {}), '已重连', feishu.reload)}>重连</button><a className="btn" href="#/settings/feishu">设置</a></span></div>
    <div className="row"><b>邮箱</b><span className="meta">{line(email)}{typeof email.d?.processed === 'number' ? ` · 已处理 ${email.d.processed} 封` : ''}{email.d?.error ? ` · ${email.d.error}` : ''}</span>
      <span className="actions"><button disabled={busy} onClick={() => test('email')}>测试</button><a className="btn" href="#/settings/email">设置</a></span></div>
    <div className="row"><b>GitHub</b><span className="meta">{gh.d ? (gh.d.enabled ? `已启用 · ${gh.d.repos?.length || 0} 个仓库 · ${gh.d.tokenSet ? '已配令牌' : '未配令牌'}` : '未启用') : '加载中…'}</span>
      <span className="actions"><button disabled={busy} onClick={() => test('github')}>测试</button><a className="btn" href="#/settings/github">设置</a></span></div>
    <div className="row"><b>网页预览</b><span className="meta">{pv.d ? (pv.d.enabled ? `端口 ${pv.d.portStart}–${pv.d.portEnd} · ${pv.d.publicBase || '无公网地址'}` : '未启用') : '加载中…'}</span>
      <span className="actions"><a className="btn" href="#/settings/preview">设置</a></span></div></>
}

/* ---------- 密钥 ---------- */
export function Secrets() {
  const { d, err, reload } = usePoll<any>('api/secrets', 20000)
  const reqs = usePoll<any>('api/secrets/requests', 15000)
  const [edit, setEdit] = useState<null | { name: string; value: string; description: string; isNew: boolean }>(null)
  const { busy, run } = useAction()
  const pending = (reqs.d?.items || []).filter((r: any) => r.status === 'pending')
  const save = () => edit && run(() => edit.isNew
    ? post('api/secrets', { name: edit.name.trim(), value: edit.value, ...(edit.description.trim() ? { description: edit.description.trim() } : {}) })
    : put(`api/secrets/${encodeURIComponent(edit.name)}`, { ...(edit.value ? { value: edit.value } : {}), description: edit.description.trim() }), '已保存', () => { setEdit(null); reload() })
  return <><div className="headrow"><h1>密钥</h1><button className="primary" onClick={() => setEdit({ name: '', value: '', description: '', isNew: true })}>新增</button></div>
    {!!pending.length && <div className="card"><h2>AI 申请使用 <small>{pending.length}</small></h2>
      {pending.map((r: any) => <div key={r.id} className="row"><b className="mono">{r.name}</b><span>{r.why}</span><span className="meta"><a href={`#/tickets/${encodeURIComponent(r.ticketId)}`}>{r.ticketTitle}</a> · {ago(r.at)}</span>
        <span className="actions"><button className="primary" disabled={busy} onClick={() => run(() => post(`api/secrets/requests/${encodeURIComponent(r.id)}`, { decision: 'grant' }), '已授权', reqs.reload)}>授权</button><button disabled={busy} onClick={() => run(() => post(`api/secrets/requests/${encodeURIComponent(r.id)}`, { decision: 'deny' }), '已拒绝', reqs.reload)}>拒绝</button></span></div>)}
    </div>}
    <Loading d={d} err={err} />
    {(d?.items || []).map((x: any) => <div className="row" key={x.name}><b className="mono">{x.name}</b><span className="meta">{x.description || '（无描述）'} · {x.origin === 'ai' ? 'AI 存的' : '手动'}{x.lastUsedAt ? ` · 最近使用 ${ago(x.lastUsedAt)}` : ''}</span>
      <span className="actions"><button onClick={() => setEdit({ name: x.name, value: '', description: x.description || '', isNew: false })}>修改</button>
        <button className="ghost danger" disabled={busy} onClick={() => { if (confirm(`删除密钥 ${x.name}？`)) run(() => del(`api/secrets/${encodeURIComponent(x.name)}`), '已删除', reload) }}>删除</button></span></div>)}
    {d && !(d.items || []).length && <Empty>还没有密钥。值加密保存，只有被授权的任务能拿到。</Empty>}
    {edit && <Sheet title={edit.isNew ? '新增密钥' : `修改 ${edit.name}`} onClose={() => setEdit(null)}>
      {edit.isNew && <label className="field">名称（大写字母、数字、下划线）<input className="mono" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value.toUpperCase() })} placeholder="API_TOKEN" /></label>}
      <label className="field">值{edit.isNew ? '' : '（留空=不改）'}<input type="password" autoComplete="new-password" value={edit.value} onChange={e => setEdit({ ...edit, value: e.target.value })} /></label>
      <label className="field">描述<input value={edit.description} onChange={e => setEdit({ ...edit, description: e.target.value })} /></label>
      <button className="primary wide" disabled={busy || (edit.isNew && (!edit.name || !edit.value))} onClick={save}>保存</button>
    </Sheet>}</>
}

/* ---------- 书库 ---------- */
export function Novels() {
  const [id, n] = segs()
  if (id && n) return <Chapter bookId={id} n={Number(n)} />
  if (id) return <Book id={id} />
  return <NovelList />
}
function NovelList() {
  const { d, err, status, reload } = usePoll<any>('api/novels', 20000)
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ idea: '', genre: 'xianxia', title: '' })
  const { busy, run } = useAction()
  if (status === 404) return <><h1>书库</h1><Empty>小说功能没有启用，可以在「设置 → 小说」里打开。</Empty></>
  return <><div className="headrow"><h1>书库</h1><button className="primary" onClick={() => setOpen(true)}>开新书</button></div>
    <Loading d={d} err={err} />
    {(d?.items || []).map((b: any) => <a className="row" key={b.id} href={`#/novels/${encodeURIComponent(b.id)}`}><b>{b.title || b.id}</b>
      <span className="meta">{b.genreLabel} · {b.phase} · 写到第 {b.lastChapter} 章 · {Math.round((b.chars || 0) / 1000)} 千字 · {money(b.costUsd)}{b.flagged ? ` · ${b.flagged} 章待查` : ''}</span>
      {b.error && <span className="warn">{b.error}</span>}</a>)}
    {d && !(d.items || []).length && <Empty>还没有书。</Empty>}
    {open && <Sheet title="开新书" onClose={() => setOpen(false)}>
      <label className="field">灵感<textarea className="big" rows={4} value={f.idea} onChange={e => setF({ ...f, idea: e.target.value })} /></label>
      <label className="field">题材<select value={f.genre} onChange={e => setF({ ...f, genre: e.target.value })}><option value="xianxia">仙侠</option><option value="xuanhuan">玄幻</option></select></label>
      <label className="field">书名（可选）<input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></label>
      <button className="primary wide" disabled={busy || !f.idea.trim()} onClick={() => run(() => post('api/novels', { idea: f.idea, genre: f.genre, ...(f.title.trim() ? { title: f.title.trim() } : {}) }), '已开始构思', () => { setOpen(false); reload() })}>开始</button>
    </Sheet>}</>
}
function Book({ id }: { id: string }) {
  const { d, err, reload } = usePoll<any>(`api/novels/${encodeURIComponent(id)}`, 15000)
  const [note, setNote] = useState('')
  const { busy, run } = useAction()
  const b = d?.book
  const chapters: any[] = d?.chapters || []
  // currentTicket falls back to the newest (possibly ended) ticket, so only the phase says whether an arc is being written.
  const writingNow = b?.phase === 'writing' || b?.phase === 'drafting'
  return <><a className="back" href="#/novels">← 书库</a><h1>{b?.title || '…'}</h1><Loading d={d} err={err} />
    {b && <p className="meta">{b.genreLabel} · {b.phase} · {chapters.length} 章 · {money(b.costUsd)}{b.currentTicket ? <> · <a href={`#/tickets/${encodeURIComponent(b.currentTicket)}`}>{writingNow ? '正在写' : '最近一次任务'}</a></> : null}</p>}
    {b?.nextArc && <div className="card"><h2>下一弧：{b.nextArc.title} <small>{b.nextArc.chapters} 章 · {b.nextArc.status}</small></h2>
      <input className="search" value={note} onChange={e => setNote(e.target.value)} placeholder="对这一弧有什么要求？（可留空）" />
      <button className="primary" disabled={busy || writingNow} onClick={() => run(() => post(`api/novels/${encodeURIComponent(id)}/arcs`, note.trim() ? { note: note.trim() } : {}), '已开始写下一弧', () => { setNote(''); reload() })}>写下一弧</button></div>}
    <p className="actions"><a className="btn" href={API(`api/novels/${encodeURIComponent(id)}/export`)}>导出 TXT</a>
      <button className="ghost danger" disabled={busy} onClick={() => { if (confirm('删除这本书？')) run(() => del(`api/novels/${encodeURIComponent(id)}`), '已删除', () => { location.hash = '#/novels' }) }}>删除</button></p>
    <h2>章节</h2>
    {chapters.map(c => <a className="row" key={c.n} href={`#/novels/${encodeURIComponent(id)}/${c.n}`} data-lv={c.status === 'flagged' ? 'warn' : ''}><b>第 {c.n} 章 {c.title}</b><span className="meta">{c.chars} 字{c.score != null ? ` · ${c.score} 分` : ''}{c.status === 'flagged' ? ' · 待查' : ''}</span></a>)}
    {d && !chapters.length && <Empty>还没有章节。</Empty>}</>
}
function Chapter({ bookId, n }: { bookId: string; n: number }) {
  const { d, err, reload } = usePoll<any>(`api/novels/${encodeURIComponent(bookId)}/chapters/${n}`, 600000)
  const [note, setNote] = useState('')
  const { busy, run } = useAction()
  const base = `api/novels/${encodeURIComponent(bookId)}/chapters/${n}`
  useEffect(() => { post(`${base}/read`, {}).catch(() => {}) }, [base])
  const last = d?.lastChapter || n
  const nav = (k: number) => `#/novels/${encodeURIComponent(bookId)}/${k}`
  return <div className="reader"><a className="back" href={`#/novels/${encodeURIComponent(bookId)}`}>← 目录</a>
    <h1>第 {n} 章 {d?.row?.title || ''}</h1><Loading d={d} err={err} />
    {d && <article>{String(d.text || '').split(/\n+/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>)}</article>}
    <p className="actions">{n > 1 && <a className="btn" href={nav(n - 1)}>上一章</a>}{n < last && <a className="btn" href={nav(n + 1)}>下一章</a>}</p>
    <details className="card"><summary>提修改意见</summary>
      <textarea className="big" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="哪里要怎么改？" />
      <p className="actions"><button className="primary" disabled={busy || !note.trim()} onClick={() => run(() => post(`${base}/edit`, { note }), '已提交修改', () => { setNote(''); reload() })}>按意见改</button>
        {d?.edit && <button disabled={busy} onClick={() => run(() => post(`${base}/undo`, {}), '已撤销', reload)}>撤销上次修改</button>}</p>
    </details></div>
}

/* ---------- 会商 ---------- */
const CSTATUS: Record<string, string> = { running: '进行中', done: '已完成', failed: '失败', cancelled: '已取消' }
export function Councils() {
  const [id] = segs()
  if (id) return <><a className="back" href="#/councils">← 会商</a><CouncilDetail id={id} full /></>
  return <CouncilList />
}
function CouncilList() {
  const { d, err, reload } = usePoll<any>('api/councils?limit=30', 10000)
  const [text, setText] = useState('')
  const { busy, run } = useAction()
  return <><h1>会商</h1>
    <div className="card"><textarea className="big" rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="想让几个 AI 角色一起讨论什么？会商结束会出一份任务书。" />
      <button className="primary" disabled={busy || !text.trim()} onClick={() => run(async () => { const r = await post('api/councils', { mode: 'brief', text }); setText(''); if (r?.id) location.hash = `#/councils/${encodeURIComponent(r.id)}` }, '会商已开始', reload)}>开始会商</button></div>
    <Loading d={d} err={err} />
    {(d?.items || []).map((c: any) => <a className="row" key={c.id} href={`#/councils/${encodeURIComponent(c.id)}`}><b>{c.topic.slice(0, 80)}</b><span className="meta">{c.mode === 'brief' ? '出任务书' : '出主意'} · {CSTATUS[c.status] || c.status} · {money(c.costUsd)} · {ago(c.createdAt)}</span></a>)}
    {d && !(d.items || []).length && <Empty>还没有会商。</Empty>}</>
}
export function CouncilDetail({ id, full = false }: { id: string; full?: boolean }) {
  const { d, err, reload } = usePoll<any>(`api/councils/${encodeURIComponent(id)}`, 3000)
  const [brief, setBrief] = useState<string | null>(null)
  const { busy, run } = useAction()
  const base = `api/councils/${encodeURIComponent(id)}`
  return <div className="card">
    {full && <h1>{d?.topic?.slice(0, 60) || '会商'}</h1>}
    <Loading d={d} err={err} />
    {d && <p className="meta">{CSTATUS[d.status] || d.status} · {d.phase} · {money(d.costUsd)}{d.ticketId ? <> · <a href={`#/tickets/${encodeURIComponent(d.ticketId)}`}>已开任务</a></> : null}</p>}
    {d?.error && <p className="warn">{d.error}</p>}
    {(d?.rounds || []).map((r: any) => <details key={r.n} open={r.n === (d.rounds.length)}><summary>第 {r.n} 轮</summary>
      {r.turns.map((t: any) => <div key={t.roleId} className="turn" data-st={t.status}><b>{t.name}</b>{t.status === 'running' ? <em> 发言中…</em> : t.status === 'failed' ? <em className="warn"> 失败</em> : null}<p>{t.text}</p></div>)}
    </details>)}
    {d?.brief && <><h2>任务书</h2>{brief === null ? <pre className="report">{d.brief}</pre> : <textarea className="big" rows={10} value={brief} onChange={e => setBrief(e.target.value)} />}</>}
    <p className="actions">
      {d?.status === 'running' && <button className="danger" disabled={busy} onClick={() => run(() => post(`${base}/cancel`, {}), '已取消', reload)}>取消会商</button>}
      {d?.mode === 'brief' && d?.status === 'done' && !d.ticketId && <>
        {brief === null && <button onClick={() => setBrief(d.brief || '')}>改任务书</button>}
        <button className="primary" disabled={busy} onClick={() => run(async () => { const r = await post(`${base}/commit`, brief !== null ? { brief } : {}); if (r?.ticketId) location.hash = `#/tickets/${encodeURIComponent(r.ticketId)}` }, '已按任务书开工', reload)}>按任务书开工</button></>}
    </p>
  </div>
}

export { Settings } from './settings'

/* ---------- 更多 ---------- */
const MORE: [string, [string, string, string][]][] = [
  ['工作', [['councils', '会商', '让几个 AI 角色先讨论']]],
  ['写作', [['novels', '书库', '写好的小说'], ['fanqie', '番茄发布', '勾选章节同步到番茄']]],
  ['管理', [['usage', '花费', '今天、7 天、30 天'], ['secrets', '密钥', '加密保存，按任务授权'], ['connections', '连接', '飞书、邮箱、GitHub、预览'], ['pi', 'Pi 版本', '检测、构建、切换执行者版本'], ['settings', '设置', '规则、模型、预算、账号']]],
  ['记录', [['system', '系统', '健康、清理、备份'], ['events', '事件', '机器做过的事'], ['decisions', '判断记录', '受理或忽略的理由']]],
]
export function More({ onLogout }: { onLogout: () => void }) {
  return <><h1>更多</h1>
    {MORE.map(([g, items]) => <section className="menu" key={g}><h2>{g}</h2>
      {items.map(([k, n, h]) => <a className="menu__item" key={k} href={`#/${k}`}><Icon name={k} size={20} /><span><b>{n}</b><span className="meta">{h}</span></span><Icon name="chev" size={16} /></a>)}
    </section>)}
    <section className="menu"><h2>其他</h2>
      <a className="menu__item" href="legacy/"><Icon name="server" size={20} /><span><b>旧版后台</b><span className="meta">需要时可以回去用</span></span><Icon name="chev" size={16} /></a>
      <button className="menu__item danger" onClick={onLogout}><Icon name="logout" size={20} /><span><b>退出登录</b></span></button>
    </section></>
}

export { get }
