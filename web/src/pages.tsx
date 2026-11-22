import { useEffect, useState } from 'react'
import { API, get, post, put, del, uploadProject } from './api'
import { usePoll, ago, money } from './hooks'
import { toast, useAction, Empty, Tabs, bytes, Sheet, Markdown, QrSvg, confirmAction, safeDecode } from './ui'
import { Icon } from './icons'
import { GoalFields, emptyGoal, goalPayload } from './goal'

export function Loading({ d, err }: { d: unknown; err: string }) {
  if (err && !d) return <p className="warn">读取失败：{err}</p>
  if (!d) return <p className="meta">加载中…</p>
  return null
}
/** Path segments after the page key, e.g. #/novels/b_1/3 → ['b_1','3']. */
const segs = () => location.hash.replace(/^#\//, '').split('?')[0]!.split('/').slice(1).map(safeDecode)
const query = () => new URLSearchParams(location.hash.split('?')[1] || '')

/* ---------- 发任务 ---------- */
export function NewTask() {
  const [text, setText] = useState(() => localStorage.getItem('sa-next-draft') || '')
  const [model, setModel] = useState('')
  const [projectId, setProjectId] = useState(() => query().get('project') || '')
  const [projectMode, setProjectMode] = useState<'worktree' | 'copy' | 'direct'>(() => {
    const m = query().get('mode')
    return m === 'direct' ? 'direct' : m === 'copy' ? 'copy' : 'worktree'
  })
  const [runnerId, setRunnerId] = useState('pi')
  const [scriptId, setScriptId] = useState('')
  const [scriptParamsText, setScriptParamsText] = useState('')
  const [secrets, setSecrets] = useState<Set<string>>(new Set())
  const [council, setCouncil] = useState(false)
  const [helpers, setHelpers] = useState(true)
  const [goal, setGoal] = useState(emptyGoal)
  const goalBody = goalPayload(goal)
  const models = usePoll<any>('api/models', 60000)
  const projects = usePoll<any>('api/projects', 60000)
  const runners = usePoll<any>('api/runners', 60000)
  const allSecrets = usePoll<any>('api/secrets', 60000)
  const cset = usePoll<any>('api/settings/council', 600000)
  const collabSet = usePoll<any>('api/settings/collab', 600000)
  const { busy, run } = useAction()
  useEffect(() => { localStorage.setItem('sa-next-draft', text) }, [text])
  useEffect(() => { if (cset.d?.defaultOn) setCouncil(true) }, [cset.d])
  useEffect(() => {
    if (runnerId === 'script' && !scriptId && runners.d?.scripts?.length) {
      setScriptId(runners.d.scripts[0].id)
    }
  }, [runnerId, scriptId, runners.d])
  const send = () => run(async () => {
    if (council) {
      const r = await post('api/councils', { mode: 'brief', text, autoStart: true, ...(projectId ? { projectId } : {}) })
      localStorage.removeItem('sa-next-draft')
      location.hash = r?.id ? `#/councils/${encodeURIComponent(r.id)}` : '#/councils'
      return
    }
    let parsedScriptParams: Record<string, unknown> | undefined
    if (runnerId === 'script' && scriptParamsText.trim()) {
      try {
        const obj = JSON.parse(scriptParamsText)
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
          toast('脚本参数必须是 JSON 对象，例如 {"mode":"paid"}', true)
          return
        }
        parsedScriptParams = obj as Record<string, unknown>
      } catch {
        toast('脚本参数 JSON 格式有误，请检查括号与引号', true)
        return
      }
    }
    const r = await post('api/tickets', {
      text,
      ...(model ? { model } : {}),
      ...(projectId ? { projectId, projectMode } : {}),
      ...(runnerId && runnerId !== 'pi' ? { runnerId } : {}),
      ...(runnerId === 'script' && scriptId ? { scriptId } : {}),
      ...(runnerId === 'script' && parsedScriptParams ? { scriptParams: parsedScriptParams } : {}),
      ...(secrets.size ? { secrets: [...secrets] } : {}),
      ...(collabSet.d?.enabled && !helpers ? { collab: false } : {}),
      ...(goalBody ? { goal: goalBody } : {}),
    })
    localStorage.removeItem('sa-next-draft')
    const id = r?.ticketId ?? r?.id
    location.hash = id ? `#/tickets/${encodeURIComponent(id)}` : '#/tickets'
  }, council ? '会商已开始' : '已发出')
  const ready = (projects.d?.items || []).filter((p: any) => p.status === 'ready')
  const runnerList: any[] = runners.d?.items || [{ id: 'pi', name: 'Pi 默认容器执行器', kind: 'agent', available: true }]
  const scriptList: any[] = runners.d?.scripts || []
  return <><h1>发任务</h1>
    <textarea className="big" rows={7} value={text} onChange={e => setText(e.target.value)} placeholder="想让它做什么？写清楚要什么结果。" autoFocus />
    <div className="grid2">
      <label className="field">执行模型
        <select value={model} onChange={e => setModel(e.target.value)} disabled={council || runnerId === 'script'}>
          <option value="">{models.d?.autoSelect === false ? `默认（${models.d?.default || ''}）` : '让它挑'}</option>
          {(models.d?.items || []).map((m: any) => <option key={m.ref} value={m.ref}>{m.label || m.ref}{m.providerName ? `（${m.providerName}）` : ''}</option>)}
        </select></label>
      <label className="field">项目
        <select value={projectId} onChange={e => setProjectId(e.target.value)}>
          <option value="">不带项目</option>
          {ready.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
    </div>
    {!council && <div className="grid2">
      <label className="field">执行器（本机）
        <select value={runnerId} onChange={e => setRunnerId(e.target.value)}>
          {runnerList.map((rn: any) => <option key={rn.id} value={rn.id} disabled={rn.available === false}>{rn.name}{rn.kind === 'script' ? '（0 Token）' : ''}{rn.available === false ? '（未安装）' : ''}</option>)}
        </select></label>
      {projectId
        ? <label className="field">项目工作模式
          <select value={projectMode} onChange={e => setProjectMode(e.target.value as 'worktree' | 'copy' | 'direct')}>
            <option value="worktree">Git 隔离分支（推荐：支持并行审查、返工与安全合并）</option>
            <option value="copy">独立副本（不改动项目原件）</option>
            <option value="direct">直接修改项目原件（自动快照，可回滚）</option>
          </select></label>
        : <div />}
    </div>}
    {!council && runnerId === 'script' && <div className="card" style={{ marginBottom: 12 }}>
      <label className="field">已登记的确定性脚本（0 Token，仅允许白名单脚本 ID）
        <select value={scriptId} onChange={e => setScriptId(e.target.value)}>
          {scriptList.map((sc: any) => <option key={sc.id} value={sc.id}>{sc.id} — {sc.description}</option>)}
        </select></label>
      <label className="field">结构化 JSON 参数（可选）
        <textarea rows={3} className="mono" value={scriptParamsText} onChange={e => setScriptParamsText(e.target.value)} placeholder='例如：{"inputFile":"project/sales.csv","dateField":"paid_at","decimals":2} 或 {"subDir":"."}' /></label>
    </div>}
    {!!allSecrets.d?.items?.length && !council && <details className="field"><summary>可用密钥（{secrets.size}）</summary>
      {allSecrets.d.items.map((s: any) => <label key={s.name} className="check"><input type="checkbox" checked={secrets.has(s.name)} onChange={() => setSecrets(p => { const n = new Set(p); n.has(s.name) ? n.delete(s.name) : n.add(s.name); return n })} /><span className="mono">{s.name}</span><span className="meta">{s.description}</span></label>)}
    </details>}
    {collabSet.d?.enabled && !council && runnerId === 'pi' && <label className="check"><input type="checkbox" checked={helpers} onChange={e => setHelpers(e.target.checked)} /> 允许它在执行中叫别的模型帮忙（侦察、审查、顾问等，见「设置 → 协作」）</label>}
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
        {p.status === 'ready' && <a className="btn" href={`#/new?project=${encodeURIComponent(p.id)}&mode=worktree`}>隔离分支发任务</a>}
        {p.status === 'ready' && <a className="btn" href={`#/new?project=${encodeURIComponent(p.id)}&mode=direct`}>直接改原件</a>}
        <button className="ghost danger" disabled={busy} onClick={() => { if (confirm(`删除项目「${p.name}」？`)) run(() => del(`api/projects/${encodeURIComponent(p.id)}`), '已删除', reload) }}>删除</button>
      </span>
      {p.status === 'ready' && <ProjectSnapshots id={p.id} name={p.name} />}
    </div>)}
    {d && !items.length && <Empty>还没有项目。上传一个压缩包，发任务时就能带上它。</Empty>}</>
}
/** 项目原件的快照历史：「直接修改原件」的任务前后、每次同步都会拍一张，可查看差异、回滚或删除旧快照。 */
function ProjectSnapshots({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<any[] | null>(null)
  const [diff, setDiff] = useState<{ sha: string; d: any } | null>(null)
  const { busy, run } = useAction()
  const fetchList = async () => setItems((await get(`api/projects/${encodeURIComponent(id)}/snapshots?limit=30`))?.items || [])
  const load = () => run(fetchList)
  const restore = async (s: any) => {
    const ok = await confirmAction(
      `把项目「${name}」的原件恢复到快照 ${s.sha.slice(0, 8)}？\n恢复前会自动再拍一张快照，可再撤回。`,
      { title: '恢复项目快照', okLabel: '恢复到此' },
    )
    if (!ok) return
    await run(async () => {
      await post(`api/projects/${encodeURIComponent(id)}/restore`, { snapshot: s.sha })
      setDiff(null)
      await fetchList()
    }, '已恢复')
  }
  const remove = async (s: any) => {
    const ok = await confirmAction(
      `永久删除项目「${name}」的历史快照 ${s.sha.slice(0, 8)}（${s.message}）？\n不会修改当前项目文件，但删除后无法再恢复到此版本。`,
      { title: '删除历史快照', danger: true, okLabel: '永久删除' },
    )
    if (!ok) return
    await run(async () => {
      const res = await del(`api/projects/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(s.sha)}`)
      setDiff(null)
      await fetchList()
      toast(res?.freedBytes > 0 ? `已删除快照（释放 ${bytes(res.freedBytes)}）` : '已删除快照')
    })
  }
  return <details className="field" open={open} onToggle={e => { const o = (e.target as HTMLDetailsElement).open; setOpen(o); if (o && items === null) void load() }}>
    <summary>快照历史 / 回滚</summary>
    {items === null ? <p className="meta">加载中…</p> : !items.length ? <p className="meta">还没有快照。用「直接改原件」发任务或同步代码后会自动生成。</p> : items.map((s: any, i: number) => <div key={s.sha} className="row">
      <span><b className="mono">{s.sha.slice(0, 8)}</b> {s.message}</span>
      <span className="meta">{ago(s.at)}</span>
      <span className="actions">
        <button className="ghost small" disabled={busy} onClick={() => run(async () => setDiff({ sha: s.sha, d: await get(`api/projects/${encodeURIComponent(id)}/snapshots/diff?from=${s.sha}`) }))}>与当前对比</button>
        {i > 0 && <button className="ghost small" disabled={busy} onClick={() => void restore(s)}>恢复到此</button>}
        <button className="ghost small danger" disabled={busy} onClick={() => void remove(s)}>删除</button>
      </span>
      {diff && diff.sha === s.sha && <pre className="meta">{diff.d?.stat}{'\n'}{(diff.d?.files || []).join('\n')}{diff.d?.total > (diff.d?.files || []).length ? `\n…共 ${diff.d.total} 个文件` : ''}</pre>}
    </div>)}
  </details>
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
    {(d?.topTickets || []).map((x: any, idx: number) => x.ticketId
      ? <a className="row" key={x.ticketId} href={`#/tickets/${encodeURIComponent(x.ticketId)}`}><b>{x.title || x.ticketId}</b><span className="meta">{money(x.usd)}</span></a>
      : <div className="row" key={`sys-${idx}`}><b>系统分析 / 会商调用</b><span className="meta">{money(x.usd)}</span></div>)}
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
    {(d?.items || []).map((x: any) => <details className="row" key={x.id}><summary><b>{x.kindLabel || (x.kind === 'accept' ? '受理' : x.kind === 'ignore' ? '忽略' : x.kind)}</b> {x.triggerText}<span className="meta"> · {ago(x.at)}</span></summary>
      <p className="meta">{x.threadKey} · {x.strength}{x.ticketId ? <> · <a href={`#/tickets/${encodeURIComponent(x.ticketId)}`}>打开任务</a></> : null}</p>
      <ul>{(x.reasonText || x.reasons || []).map((r: any, i: number) => <li key={i} className="meta">{typeof r === 'string' ? r : (r.label || r.code)}</li>)}</ul>
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
const STATE_WORD: Record<string, string> = { connected: '已连接', ready: '已就绪', disconnected: '未连接', disabled: '未启用', off: '未启用', error: '出错', connecting: '待扫码/连接中', idle: '空闲', running: '运行中', ok: '正常' }
const WC_MODE: Record<string, string> = { ilink: '个人微信扫码直连', wecom: '企业微信插件', mp: '公众号', webhook: 'Webhook/桥接' }

function WechatQrModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [localQr, setLocalQr] = useState<any>(null)
  const [verifyCode, setVerifyCode] = useState('')
  const qrPoll = usePoll<any>('api/settings/wechat/qr/status', 1500)
  const { busy, run } = useAction()
  const qr = qrPoll.d?.qr || localQr

  useEffect(() => {
    run(async () => {
      const r = await post('api/settings/wechat/qr/start', { force: false })
      if (r?.qr) setLocalQr(r.qr)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (qr?.status === 'confirmed') {
      toast('个人微信连接成功！')
      onDone()
    }
  }, [qr?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => run(async () => {
    const r = await post('api/settings/wechat/qr/start', { force: true })
    if (r?.qr) setLocalQr(r.qr)
    qrPoll.reload()
  }, '二维码已刷新')

  const submitCode = () => run(async () => {
    const r = await post('api/settings/wechat/qr/verify', { code: verifyCode.trim() })
    if (r?.qr) setLocalQr(r.qr)
    setVerifyCode('')
    qrPoll.reload()
  }, '已提交配对码')

  return <Sheet title="扫码连接个人微信（微信插件）" onClose={onClose}>
    <div style={{ textAlign: 'center', padding: '8px 0' }}>
      {qr?.qrSvgDataUrl ? <>
        <QrSvg dataUrl={qr.qrSvgDataUrl} size={230} alt="个人微信扫码二维码" />
        <p style={{ marginTop: 10, fontWeight: 600 }}>{qr.message || '请用手机微信扫一扫'}</p>
        {qr.qrcodeUrl && <p className="meta" style={{ wordBreak: 'break-all' }}>备用链接：<a href={qr.qrcodeUrl} target="_blank" rel="noopener">{qr.qrcodeUrl}</a></p>}
      </> : <p className="meta">{busy ? '正在生成官方微信二维码…' : (qr?.message || '准备二维码中…')}</p>}
      {qr?.status === 'need_verifycode' && <div className="quick" style={{ marginTop: 10 }}>
        <input className="mono" value={verifyCode} onChange={e => setVerifyCode(e.target.value)} placeholder="输入手机微信显示的数字" onKeyDown={e => { if (e.key === 'Enter' && verifyCode.trim()) submitCode() }} />
        <button type="button" className="primary" disabled={busy || !verifyCode.trim()} onClick={submitCode}>确认</button>
      </div>}
      <div className="actions" style={{ justifyContent: 'center', marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={refresh}>{busy ? '获取中…' : '刷新二维码'}</button>
      </div>
    </div>
  </Sheet>
}

export function Connections() {
  const feishu = usePoll<any>('api/settings/feishu/status', 20000)
  const email = usePoll<any>('api/settings/email/status', 20000)
  const wechat = usePoll<any>('api/settings/wechat/status', 20000)
  const gh = usePoll<any>('api/settings/github', 60000)
  const pv = usePoll<any>('api/settings/preview', 60000)
  const [sendBox, setSendBox] = useState<'' | 'email' | 'wechat'>('')
  const [qrOpen, setQrOpen] = useState(false)
  const [to, setTo] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const { busy, run } = useAction()
  const line = (v: any) => v.err ? '读取失败' : v.d ? (STATE_WORD[v.d.state] || v.d.state || '—') : '加载中…'
  const test = (k: string) => run(async () => { const r = await post(`api/settings/${k}/test`, {}); toast(r?.message || (r?.ok ? '连接正常' : '测试失败'), !r?.ok) })
  const sendNow = () => run(async () => {
    if (sendBox === 'email') {
      const list = to.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
      await post('api/email/send', { to: list, subject: title.trim() || 'SuperAgent 消息', text: body.trim() })
    } else {
      await post('api/wechat/send', { ...(to.trim() ? { to: to.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}), text: body.trim() })
    }
    setSendBox(''); setTitle(''); setBody('')
  }, sendBox === 'email' ? '邮件已发出' : '微信消息已发出')
  return <><h1>连接</h1>
    <div className="row" data-lv={wechat.d?.state === 'error' ? 'error' : ''}>
      <b>微信</b>
      <span className="meta">{line(wechat)}{wechat.d?.mode ? ` · ${WC_MODE[wechat.d.mode] || wechat.d.mode}` : ''}{typeof wechat.d?.received === 'number' ? ` · 收 ${wechat.d.received} / 发 ${wechat.d.sent}` : ''}</span>
      {wechat.d?.lastError && <span className="warn">{wechat.d.lastError}</span>}
      <span className="actions">
        <button className="primary" disabled={busy} onClick={() => setQrOpen(true)}>扫码连接</button>
        <button disabled={busy} onClick={() => test('wechat')}>测试</button>
        <button disabled={busy} onClick={() => setSendBox('wechat')}>发测试消息</button>
        <a className="btn" href="#/settings/wechat">设置</a>
      </span>
    </div>
    <div className="row" data-lv={email.d?.state === 'error' ? 'error' : ''}>
      <b>邮箱</b>
      <span className="meta">{line(email)}{typeof email.d?.processed === 'number' ? ` · 已处理 ${email.d.processed} 封` : ''}{email.d?.lastPollAt ? ` · 检查于 ${ago(email.d.lastPollAt)}` : ''}</span>
      {email.d?.lastError && <span className="warn">{email.d.lastError}</span>}
      <span className="actions">
        <button disabled={busy} onClick={() => test('email')}>测试</button>
        <button disabled={busy} onClick={() => setSendBox('email')}>发测试邮件</button>
        <a className="btn" href="#/settings/email">设置</a>
      </span>
    </div>
    <div className="row" data-lv={feishu.d?.state === 'error' ? 'error' : ''}>
      <b>飞书</b>
      <span className="meta">{line(feishu)}{feishu.d?.mode ? ` · ${feishu.d.mode}` : ''}</span>
      {feishu.d?.lastError && <span className="warn">{feishu.d.lastError}</span>}
      <span className="actions"><button disabled={busy} onClick={() => test('feishu')}>测试</button><button disabled={busy} onClick={() => run(() => post('api/settings/feishu/reconnect', {}), '已重连', feishu.reload)}>重连</button><a className="btn" href="#/settings/feishu">设置</a></span>
    </div>
    <div className="row"><b>GitHub</b><span className="meta">{gh.d ? (gh.d.enabled ? `已启用 · ${gh.d.repos?.length || 0} 个仓库 · ${gh.d.tokenSet ? '已配令牌' : '未配令牌'}` : '未启用') : '加载中…'}</span>
      <span className="actions"><button disabled={busy} onClick={() => test('github')}>测试</button><a className="btn" href="#/settings/github">设置</a></span></div>
    <div className="row"><b>网页预览</b><span className="meta">{pv.d ? (pv.d.enabled ? `端口 ${pv.d.portStart}–${pv.d.portEnd} · ${pv.d.publicBase || '无公网地址'}` : '未启用') : '加载中…'}</span>
      <span className="actions"><a className="btn" href="#/settings/preview">设置</a></span></div>
    <SshConnections />
    {qrOpen && <WechatQrModal onClose={() => setQrOpen(false)} onDone={() => { setQrOpen(false); wechat.reload() }} />}
    {sendBox && <Sheet title={sendBox === 'email' ? '发送测试邮件' : '发送微信消息'} onClose={() => setSendBox('')}>
      <label className="field"><span>{sendBox === 'email' ? '收件人邮箱' : '目标用户 ID / OpenID（留空则用默认接收人/群）'}</span>
        <input className="mono" value={to} onChange={e => setTo(e.target.value)} placeholder={sendBox === 'email' ? 'you@example.com' : '@all 或 UserID'} /></label>
      <label className="field"><span>{sendBox === 'email' ? '邮件主题' : '标题（可选）'}</span>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="SuperAgent 连通测试" /></label>
      <label className="field"><span>正文内容</span>
        <textarea className="big" rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="输入要发送的内容…" /></label>
      <button className="primary wide" disabled={busy || !body.trim() || (sendBox === 'email' && !to.trim())} onClick={sendNow}>{busy ? '发送中…' : '立即发送'}</button>
    </Sheet>}</>
}

/* ---------- SSH 连接：私钥进密钥库，只交给容器里的 ssh-agent ---------- */
const emptySsh = { name: '', host: '', port: '22', user: '', privateKey: '' }
function SshConnections() {
  const s = usePoll<any>('api/ssh', 60000)
  const { busy, run } = useAction()
  const [edit, setEdit] = useState<null | typeof emptySsh & { isNew: boolean }>(null)
  const save = () => edit && run(async () => {
    await post('api/ssh/connections', { name: edit.name.trim(), host: edit.host.trim(), port: Number(edit.port) || 22, user: edit.user.trim(), privateKey: edit.privateKey })
  }, '已保存，主机指纹已记下', () => { setEdit(null); s.reload() })
  const remove = (name: string) => { if (confirm(`删除 SSH 连接 ${name}？它的私钥也会从密钥库删掉。`)) run(() => del(`api/ssh/connections/${encodeURIComponent(name)}`), '已删除', s.reload) }
  const setAll = (v: boolean) => run(() => post('api/ssh/settings', { allTickets: v }), '已保存', s.reload)
  const d = s.d
  return <>
    <div className="headrow"><h2>SSH</h2><button className="primary" disabled={busy} onClick={() => setEdit({ ...emptySsh, isNew: true })}>新增</button></div>
    <p className="meta">登记后，任务里可以直接 <span className="mono">ssh 名字</span>，scp、rsync、git 也能用。私钥存进密钥库，启动时只交给容器里的 ssh-agent，AI 读不到私钥本身；主机指纹在登记时记下，对不上就拒绝连接。</p>
    {d && <label className="check"><input type="checkbox" checked={!!d.allTickets} disabled={busy} onChange={e => setAll(e.target.checked)} />
      <span><b>所有任务都能用</b><small className="hint">关掉后，只有在密钥页授权了 SSH_KEY_名字 的任务能用</small></span></label>}
    {(d?.connections || []).map((c: any) => <div className="row" key={c.name}>
      <b className="mono">{c.name}</b>
      <span className="meta">{c.user}@{c.host}{c.port !== 22 ? `:${c.port}` : ''} · {c.keySet ? '已存私钥' : <span className="warn">缺私钥</span>}</span>
      <span className="actions">
        <button disabled={busy} onClick={() => setEdit({ name: c.name, host: c.host, port: String(c.port), user: c.user, privateKey: '', isNew: false })}>修改</button>
        <button className="ghost danger" disabled={busy} onClick={() => remove(c.name)}>删除</button>
      </span></div>)}
    {d && !(d.connections || []).length && <Empty>还没有登记 SSH 连接。</Empty>}
    {edit && <Sheet title={edit.isNew ? '新增 SSH 连接' : `修改 ${edit.name}`} onClose={() => setEdit(null)}>
      <label className="field"><span>名字</span><small className="hint">小写字母、数字和横线，任务里用 ssh 名字 连接</small>
        <input className="mono" value={edit.name} disabled={!edit.isNew} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
      <label className="field"><span>地址</span><input className="mono" value={edit.host} onChange={e => setEdit({ ...edit, host: e.target.value })} /></label>
      <label className="field"><span>端口</span><input type="number" value={edit.port} onChange={e => setEdit({ ...edit, port: e.target.value })} /></label>
      <label className="field"><span>用户</span><input className="mono" value={edit.user} onChange={e => setEdit({ ...edit, user: e.target.value })} /></label>
      <label className="field"><span>私钥</span><small className="hint">{edit.isNew ? '粘贴整段私钥（BEGIN … PRIVATE KEY）；不能带口令' : '留空表示不改'}</small>
        <textarea className="big mono" rows={6} value={edit.privateKey} onChange={e => setEdit({ ...edit, privateKey: e.target.value })} /></label>
      <div className="actions"><button className="primary" disabled={busy || !edit.name || !edit.host || !edit.user} onClick={save}>保存（会连一次读主机指纹）</button></div>
    </Sheet>}
  </>
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
    {d?.brief && <><h2>任务书</h2>{brief === null ? <Markdown text={d.brief} /> : <textarea className="big" rows={10} value={brief} onChange={e => setBrief(e.target.value)} />}</>}
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
  ['工作', [
    ['director', '总控助手', '微信与控制台共用的平台总控 AI 指挥中心'],
    ['projects', '项目库', '上传、同步代码仓并支持 worktree 并发审查'],
    ['schedules', '定时巡检', 'Cron 定时派单、主动巡检与任务约定修订'],
    ['memory', '记忆与进化', '三层长期记忆、技能库、基准评测与本机执行器'],
    ['councils', '会商', '让几个 AI 角色先讨论出方案'],
  ]],
  ['安全', [
    ['defense', '防御工作台', '应用安全代码审查、配置基线核查、直接加固与自动快照'],
    ['pentest', '渗透工作台', '内部红队测试、源码快扫、OWASP 剧本与漏洞管理'],
  ]],
  ['写作', [['novels', '书库', '写好的小说'], ['fanqie', '番茄发布', '勾选章节同步到番茄']]],
  ['管理', [['usage', '花费', '今天、7 天、30 天'], ['secrets', '密钥', '加密保存，按任务授权'], ['connections', '连接', '微信、邮箱、飞书、GitHub、SSH、预览'], ['pi', 'Pi 版本', '检测、构建、切换执行者版本'], ['devenv', '开发环境', '预装工具链、额外系统包'], ['settings', '设置', '规则、模型、预算、账号']]],
  ['记录', [['system', '系统', '健康、清理、备份'], ['events', '事件', '机器做过的事'], ['decisions', '判断记录', '受理或忽略的理由']]],
]
export function More({ onLogout }: { onLogout: () => void }) {
  return <><h1>更多</h1>
    {MORE.map(([g, items]) => <section className="menu" key={g}><h2>{g}</h2>
      {items.map(([k, n, h]) => <a className="menu__item" key={k} href={`#/${k}`}><Icon name={k} size={20} /><span><b>{n}</b><span className="meta">{h}</span></span><Icon name="chev" size={16} /></a>)}
    </section>)}
    <section className="menu"><h2>其他</h2>
      <button className="menu__item danger" onClick={onLogout}><Icon name="logout" size={20} /><span><b>退出登录</b></span></button>
    </section></>
}

export { get }
