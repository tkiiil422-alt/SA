import { useEffect, useState } from 'react'
import { post } from './api'
import { usePoll, ago } from './hooks'
import { toast, useAction, Empty, confirmAction } from './ui'
import { Loading } from './pages'

const FEATURE_WORD: Record<string, [string, string]> = {
  browser: ['浏览器测试', 'Playwright + Chromium，约 600 MB'],
  dbserver: ['测试用数据库', 'PostgreSQL 和 Redis 服务端，在容器里以普通用户运行'],
  go: ['Go', '官方最新稳定版'],
  java: ['Java', 'OpenJDK + Maven'],
}

function formatFeatures(features?: string[]): string {
  return (features || []).map(f => FEATURE_WORD[f]?.[0] || f).join('、') || '—'
}

/* ---------- 开发环境：执行者容器里预装的工具链 ---------- */
export function DevEnv() {
  const s = usePoll<any>('api/devenv/status', 4000)
  const { busy, run } = useAction()
  const d = s.d
  const job = d?.job
  const building = job?.state === 'running'
  const [packages, setPackages] = useState('')
  const [features, setFeatures] = useState<string[]>([])
  const [mirrors, setMirrors] = useState(true)
  const [seededFrom, setSeededFrom] = useState<string>('')
  const [seeded, setSeeded] = useState(false)

  useEffect(() => {
    if (d && !seeded) {
      if (d.base) {
        setPackages((d.packages || []).join(' '))
        setFeatures(d.features || [])
      } else if (d.recommendedDev) {
        // 当前在用的是裸镜像时，自动回填最近历史开发镜像的包与组件，避免重建时默默丢失
        setPackages((d.recommendedDev.packages || []).join(' '))
        setFeatures(d.recommendedDev.features || [])
        setSeededFrom(d.recommendedDev.tag || '')
      }
      setSeeded(true)
    }
  }, [d, seeded])

  const toggle = (f: string) => setFeatures(x => x.includes(f) ? x.filter(y => y !== f) : [...x, f])

  const build = async () => {
    if (!await confirmAction('构建新的开发环境？需要几分钟到十几分钟，期间不影响正在跑的任务。', { title: '构建开发环境', okLabel: '开始构建' })) return
    const list = packages.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean)
    run(() => post('api/devenv/build', { packages: list, features, mirrors }), '开始构建', s.reload)
  }

  const repack = async (devImage: string, tag: string) => {
    if (!await confirmAction(`直接复用本机已有的开发镜像 ${tag} 并封装当前 Pi 版本？跳过系统包重下，通常 20–60 秒即可完成。`, { title: '极速复用开发镜像', okLabel: '立即封装' })) return
    run(() => post('api/devenv/repack', { devImage, mirrors }), `开始基于 ${tag} 封装当前 Pi`, s.reload)
  }

  const loadPreset = (img: any) => {
    setPackages((img.packages || []).join(' '))
    setFeatures(img.features || [])
    setSeededFrom(img.tag || '')
    toast(`已载入开发镜像 ${img.tag} 的选配到重建表单`)
  }

  const removeDev = async (img: any) => {
    if (!await confirmAction(`删除本机开发镜像 ${img.tag}（${img.size}）？`, { title: '删除开发镜像', danger: true, okLabel: '确认删除' })) return
    run(() => post('api/devenv/remove', { image: img.image }), '已删除开发镜像', s.reload)
  }

  const apply = async (image: string) => {
    if (!await confirmAction(`让新任务改用 ${image}？正在跑的任务不受影响，要回退时在“Pi 版本”页切回原来的镜像即可。`, { title: '切换开发环境', okLabel: '确认切换' })) return
    run(async () => { await post('api/devenv/apply', { image }); toast('新任务改用新开发环境') }, undefined, s.reload)
  }

  return <><h1>开发环境</h1>
    <p className="meta">执行者的容器里预装了 Python（pip、venv、uv）、Node（pnpm、tsx）、gcc/make、patch、常见开发库、数据库客户端、ssh 和 rsync。
      容器是只读的，任务里装不了系统包；要加系统包或可选组件，在这里重建一次，之后所有新任务都有。</p>
    <Loading d={d} err={s.err} />
    {d && <>
      {!d.base && d.recommendedDev && !building && (
        <div className="alert" data-lv="warn">
          <div className="headrow" style={{ margin: 0 }}>
            <span>
              <b>当前执行者镜像没有开发环境底座</b>（可能刚升级了精简版 Pi，缺少 ssh、patch 及预装工具链）。
              本机仍完整保留历史开发镜像 <b className="mono">{d.recommendedDev.tag}</b>（{d.recommendedDev.size}，组件：{formatFeatures(d.recommendedDev.features)}），无需重新下载环境包！
            </span>
            <button className="primary" disabled={busy} onClick={() => void repack(d.recommendedDev.image, d.recommendedDev.tag)}>
              一键极速复用并恢复（约 20 秒）
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>正在使用</h2>
        <dl className="kvs">
          <dt>执行者镜像</dt><dd className="mono">{d.image}</dd>
          <dt>开发镜像</dt><dd className="mono">{d.base || <span className="warn">（没有基于开发镜像构建）</span>}</dd>
          <dt>额外系统包</dt><dd>{(d.packages || []).join(' ') || '—'}</dd>
          <dt>可选组件</dt><dd>{formatFeatures(d.features)}</dd>
        </dl>
        {d.imagesError && <p className="warn">{d.imagesError}</p>}
        <p className="meta">任务之间共享：下载缓存（npm、pnpm、pip、uv，宿主机 <span className="mono">~/superagent-cache</span>），以及任务里全局装的工具（npm -g、uv tool、uv 装的 Python，宿主机 <span className="mono">~/superagent-tools</span>）。装过一次，后面的任务直接能用。</p>
      </div>

      <div className="card">
        <h2>重建开发环境</h2>
        {seededFrom && !d.base && <p className="meta">已自动带入历史开发镜像 <span className="mono">{seededFrom}</span> 的组件与系统包配置，避免丢失原有选配。</p>}
        <label className="field"><span>额外系统包</span><small className="hint">Debian 包名，空格分开，比如 libmagic1 ffmpeg imagemagick</small>
          <input className="mono" value={packages} disabled={building} onChange={e => setPackages(e.target.value)} /></label>
        {(d.available?.features || []).map((f: string) => <label className="check" key={f}>
          <input type="checkbox" checked={features.includes(f)} disabled={building} onChange={() => toggle(f)} />
          <span><b>{FEATURE_WORD[f]?.[0] || f}</b><small className="hint">{FEATURE_WORD[f]?.[1]}</small></span></label>)}
        <label className="check"><input type="checkbox" checked={mirrors} disabled={building} onChange={e => setMirrors(e.target.checked)} />
          <span><b>构建时用国内镜像源（含 Pi 安装与自动重试兜底）</b><small className="hint">阿里云 Debian/PyPI、npmmirror（若 npmmirror 同步延迟自动回退官方 npm 源）；关掉则全程用官方源</small></span></label>
        <div className="actions"><button className="primary" disabled={busy || building} onClick={() => void build()}>{building ? '构建中…' : '全量构建'}</button></div>
        {job && <>
          <p className="meta">
            {job.mode === 'repack' ? '极速复用封装 ' : ''}<span className="mono">{job.piImage || job.devImage}</span>：{job.state === 'running' ? `进行中，已开始 ${ago(job.startedAt)}` : job.state === 'done' ? `已完成 ${ago(job.endedAt)}` : <span className="warn">失败：{job.error}</span>}
          </p>
          <pre>{job.log.slice(-40).join('\n') || '…'}</pre>
          {job.state === 'done' && job.piImage && job.piImage !== d.image && <button className="primary" disabled={busy} onClick={() => void apply(job.piImage)}>让新任务改用这个环境</button>}
        </>}
      </div>

      <h2>本机开发镜像（可直接极速复用）</h2>
      {(d.devImages || []).map((i: any) => <div className="row" key={i.image}>
        <span>
          <b className="mono">{i.tag}{i.image === d.base ? '（在用）' : ''}</b>
          <br />
          <span className="meta">
            {i.size} · {ago(i.createdAt)} · 组件：{formatFeatures(i.features)}{i.packages?.length ? ` · 额外包：${i.packages.join(' ')}` : ''}
          </span>
        </span>
        <span className="actions">
          <button disabled={busy || building} onClick={() => void repack(i.image, i.tag)}>封装当前 Pi</button>
          <button className="ghost" disabled={building} onClick={() => loadPreset(i)}>载入配置</button>
          {i.image !== d.base && <button className="ghost danger" disabled={busy || building} onClick={() => void removeDev(i)}>删除</button>}
        </span>
      </div>)}
      {!(d.devImages || []).length && <Empty>还没有构建过开发镜像。</Empty>}
    </>}
  </>
}
