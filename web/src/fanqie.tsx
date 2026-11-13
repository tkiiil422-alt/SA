import { useState } from 'react'
import { get, post, put } from './api'
import { usePoll, ago } from './hooks'
import { useAction, Empty, toast } from './ui'

const segs = () => location.hash.replace(/^#\//, '').split('?')[0]!.split('/').slice(1).map(decodeURIComponent)
const STATE: Record<string, string> = { none: '未同步', draft: '已存草稿', published: '已发布', scheduled: '定时中', changed: '正文有更新', failed: '失败' }

export function Fanqie() {
  const [bookId] = segs()
  if (!bookId) return <Pick />
  return <Manage bookId={bookId} />
}

function Pick() {
  const { d, err, status } = usePoll<any>('api/novels', 30000)
  if (status === 404) return <><h1>番茄发布</h1><Empty>小说功能没有开启，请先在「设置 → 小说」里打开。</Empty></>
  return <><h1>番茄发布</h1>
    {err && !d && <p className="warn">读取失败：{err}</p>}
    {(d?.items || []).map((b: any) => <a key={b.id} className="row" href={`#/fanqie/${encodeURIComponent(b.id)}`}><b>{b.title}</b><span className="meta">{b.lastChapter} 章</span></a>)}
    {d && !(d.items || []).length && <Empty>还没有书。</Empty>}</>
}

function Manage({ bookId }: { bookId: string }) {
  const st = usePoll<any>('api/fanqie/status', 3000)
  const list = usePoll<any>(`api/fanqie/novels/${encodeURIComponent(bookId)}`, 4000)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [mode, setMode] = useState<'draft' | 'publish' | 'timer'>('draft')
  const [when, setWhen] = useState('')
  const [useAi, setUseAi] = useState(true)
  const [fq, setFq] = useState('')
  const { busy, run } = useAction()
  const chapters: any[] = list.d?.chapters || []
  const job = st.d?.job
  const toggle = (n: number) => setSel(p => { const x = new Set(p); x.has(n) ? x.delete(n) : x.add(n); return x })
  const pickWhere = (f: (c: any) => boolean) => setSel(new Set(chapters.filter(f).map(c => c.n)))
  const start = () => {
    if (mode === 'publish' && !confirm(`直接发布 ${sel.size} 章？发布后不能在这里撤回。`)) return
    const timerTime = mode === 'timer' ? Math.floor(new Date(when).getTime() / 1000) : undefined
    run(() => post('api/fanqie/sync', { bookId, chapters: [...sel].sort((a, b) => a - b), mode, useAi, ...(timerTime ? { timerTime } : {}) }), '已开始同步', () => { setSel(new Set()); list.reload(); st.reload() })
  }
  return <><a className="back" href="#/fanqie">← 番茄发布</a><h1>番茄发布</h1>
    <div className="card">
      {!st.d?.hasCookie && <p className="warn">还没有填写登录信息：到「密钥」页新增 FANQIE_COOKIE（浏览器抓到的整串 Cookie）。</p>}
      {st.d?.expired && <p className="warn">番茄登录已失效，请重新抓取 Cookie，到「密钥」页修改 FANQIE_COOKIE。</p>}
      {st.d?.hasCookie && !st.d?.expired && <p className="meta">登录正常{st.d?.lastCheck?.name ? ` · ${st.d.lastCheck.name}` : ''}{st.d?.lastCheck ? ` · ${ago(st.d.lastCheck.at)}检查` : ''}（每 30 分钟自动保活）</p>}
      <button disabled={busy} onClick={() => run(async () => { const r = await post('api/fanqie/check', {}); toast(r.ok ? `登录有效：${r.name}` : r.error || '登录无效', !r.ok) }, undefined, st.reload)}>立即检查登录</button>
    </div>
    {list.d && !list.d.fqBookId && <div className="card"><h2>绑定番茄作品</h2>
      <FqBooks onPick={setFq} />
      <label className="field"><span>番茄作品 ID</span><input className="mono" inputMode="numeric" value={fq} onChange={e => setFq(e.target.value.trim())} placeholder="19 位数字" /></label>
      <button className="primary" disabled={busy || !fq} onClick={() => run(() => put(`api/fanqie/novels/${encodeURIComponent(bookId)}/bind`, { fqBookId: fq }), '已绑定', list.reload)}>绑定</button></div>}
    {job && <div className="card"><p>{job.running ? `同步中：第 ${job.current ?? '-'} 章，${job.done + job.failed}/${job.total}` : `上次同步：成功 ${job.done}，失败 ${job.failed}`}{job.error ? ` · ${job.error}` : ''}</p>
      <div className="bar"><span style={{ width: `${Math.round((job.done + job.failed) / Math.max(1, job.total) * 100)}%` }} /></div></div>}
    {list.d?.fqBookId && <>
      <div className="card"><h2>发布方式</h2>
        {([['draft', '存草稿（推荐，到番茄后台确认后再发）'], ['publish', '直接发布'], ['timer', '定时发布']] as const).map(([k, n]) => <label key={k} className="check"><input type="radio" name="mode" checked={mode === k} onChange={() => setMode(k)} /><span>{n}</span></label>)}
        {mode === 'timer' && <label className="field"><span>发布时间（至少晚于现在 30 分钟）</span><input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></label>}
        {mode !== 'draft' && <label className="check"><input type="checkbox" checked={useAi} onChange={e => setUseAi(e.target.checked)} /><span>声明本章使用了 AI 辅助创作（建议勾选）</span></label>}
      </div>
      <div className="actions"><button onClick={() => pickWhere(c => !c.flagged && c.state !== 'published' && c.state !== 'scheduled')}>选所有未发布且无待查</button><button onClick={() => pickWhere(c => c.state === 'changed')}>选有更新的</button><button onClick={() => setSel(new Set())}>清空</button></div>
      {chapters.map(c => <label key={c.n} className="row pickrow" data-lv={c.flagged ? 'warn' : ''}>
        <input type="checkbox" disabled={c.state === 'published' || c.state === 'scheduled'} checked={sel.has(c.n)} onChange={() => toggle(c.n)} />
        <span><b>第 {c.n} 章 {c.title}</b><span className="meta">{STATE[c.state] || c.state}{c.flagged ? ' · 审稿待查' : ''}{c.error ? ` · ${c.error}` : ''}{c.syncedAt ? ` · ${ago(c.syncedAt)}` : ''}</span></span></label>)}
      <div className="bulkbar"><span>已选 {sel.size} 章</span><button className="primary" disabled={busy || !sel.size || job?.running || (mode === 'timer' && !when)} onClick={start}>{mode === 'draft' ? '存为草稿' : mode === 'publish' ? '发布' : '定时发布'}</button></div></>}
  </>
}

function FqBooks({ onPick }: { onPick: (id: string) => void }) {
  const [items, setItems] = useState<{ id: string; name: string }[] | null>(null)
  const { busy, run } = useAction()
  return <>{items === null ? <button disabled={busy} onClick={() => run(async () => setItems((await get('api/fanqie/books')).items))}>从番茄读取我的作品</button>
    : items.map(b => <button key={b.id} className="row" onClick={() => onPick(b.id)}><b>{b.name}</b><span className="meta mono">{b.id}</span></button>)}</>
}
