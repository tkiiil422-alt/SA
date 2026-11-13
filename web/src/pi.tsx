import { useState } from 'react'
import { post } from './api'
import { usePoll, ago } from './hooks'
import { toast, useAction, Empty } from './ui'
import { Loading } from './pages'

/* ---------- Pi 版本：检测、构建新镜像、切换给新任务用 ---------- */
export function PiVersions() {
  const s = usePoll<any>('api/pi/status', 4000)
  const { busy, run } = useAction()
  const [pick, setPick] = useState('')
  const d = s.d
  const job = d?.job
  const building = job?.state === 'running'
  const target = pick || d?.upgrade || d?.latest || ''
  const hasImage = (v: string) => (d?.images || []).some((i: any) => i.tag === v)
  const check = () => run(async () => { await post('api/pi/check', {}); s.reload() }, '已检查 npm')
  const build = (v: string) => {
    if (!confirm(`构建 Pi ${v} 镜像？需要几分钟，期间不影响正在跑的任务。`)) return
    run(() => post('api/pi/build', { version: v }), '开始构建', s.reload)
  }
  const apply = (image: string, version?: string) => {
    if (!confirm(`让新任务改用 ${image}${version ? `（Pi ${version}）` : ''}？正在跑的任务不受影响，要回退时切回原来的镜像即可。`)) return
    run(async () => { const r = await post('api/pi/apply', { image }); toast(`新任务改用 Pi ${r.version}`) }, undefined, s.reload)
  }
  const remove = (image: string) => {
    if (!confirm(`删除镜像 ${image}？`)) return
    run(() => post('api/pi/remove', { image }), '已删除', s.reload)
  }
  return <><h1>Pi 版本</h1>
    <p className="meta">每个任务都在一个装好 Pi 的容器里跑。这里能看到在用的版本、npm 上的新版本，构建新镜像并切换给新任务。</p>
    <Loading d={d} err={s.err} />
    {d && <>
      <div className="card">
        <div className="headrow"><h2>正在使用</h2><button disabled={busy} onClick={check}>检查更新</button></div>
        <dl className="kvs">
          <dt>Pi 版本</dt><dd>{d.version ? <b>{d.version}</b> : <span className="warn">{d.versionError || '未知'}</span>}</dd>
          <dt>镜像</dt><dd className="mono">{d.image}</dd>
          <dt>npm 最新</dt><dd>{d.latest || '—'}{d.latestPublishedAt ? `，发布于 ${ago(d.latestPublishedAt)}` : ''}</dd>
          <dt>上次检查</dt><dd>{ago(d.checkedAt) || '—'}</dd>
        </dl>
        {d.registryError && <p className="warn">{d.registryError}</p>}
        {d.imagesError && <p className="warn">{d.imagesError}</p>}
      </div>

      {d.upgrade && !building && <a className="alert" data-lv="info" href="#/pi" onClick={e => { e.preventDefault(); hasImage(d.upgrade) ? apply(`${d.image.split(':')[0]}:${d.upgrade}`, d.upgrade) : build(d.upgrade) }}>
        有新版本 Pi {d.upgrade}（在用 {d.version}）。{hasImage(d.upgrade) ? '镜像已构建好，点这里切换。' : '点这里构建新镜像。'}
      </a>}

      <div className="card">
        <h2>构建镜像</h2>
        <p className="meta">按选中的版本构建 <span className="mono">superagent-pi:&lt;版本&gt;</span>，构建完会在新镜像里跑一次 <span className="mono">pi --version</span> 确认。</p>
        <div className="quick">
          <select value={target} onChange={e => setPick(e.target.value)} disabled={building} aria-label="选择版本" style={{ flex: 1, minHeight: 40, borderRadius: 8, border: '1px solid var(--line2)', background: 'var(--surface)', padding: '0 10px' }}>
            {(d.releases || []).map((r: any) => <option key={r.version} value={r.version}>{r.version}{r.version === d.latest ? '（最新）' : ''}{r.version === d.version ? '（在用）' : ''}{hasImage(r.version) ? '，已有镜像' : ''}</option>)}
          </select>
          <button className="primary" disabled={busy || building || !target || `${d.image.split(':')[0]}:${target}` === d.image} onClick={() => build(target)}>{building ? '构建中…' : '构建'}</button>
        </div>
        {job && <>
          <p className="meta">Pi {job.version}：{job.state === 'running' ? `构建中，已开始 ${ago(job.startedAt)}` : job.state === 'done' ? `构建完成 ${ago(job.endedAt)}` : <span className="warn">失败：{job.error}</span>}</p>
          <pre>{job.log.slice(-40).join('\n') || '…'}</pre>
          {job.state === 'done' && job.image !== d.image && <button className="primary" disabled={busy} onClick={() => apply(job.image, job.version)}>让新任务改用 Pi {job.version}</button>}
        </>}
      </div>

      <h2>本机镜像</h2>
      {(d.images || []).map((i: any) => <div className="row" key={i.image}>
        <b className="mono">{i.tag}{i.current ? '（在用）' : ''}</b>
        <span className="meta">Pi {i.version || '未知'}，{i.size}，{ago(i.createdAt)}</span>
        {!i.current && <span className="actions">
          <button disabled={busy || building} onClick={() => apply(i.image, i.version)}>切换到这个</button>
          <button className="ghost danger" disabled={busy} onClick={() => remove(i.image)}>删除</button>
        </span>}
      </div>)}
      {!(d.images || []).length && <Empty>本机没有 superagent-pi 镜像。</Empty>}
    </>}
  </>
}
