import { useEffect, useState } from 'react'
import { post } from './api'
import { usePoll, ago } from './hooks'
import { toast, useAction, Empty, confirmAction, bytes } from './ui'
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

interface SharedBucket {
  id: string
  label: string
  desc: string
  bytes: number
  files: number
  exists: boolean
}

interface SharedEnvInfo {
  enabled: boolean
  mirrorsEnabled: boolean
  cacheDir: string
  toolsDir: string
  totalCacheBytes: number
  totalToolsBytes: number
  buckets: SharedBucket[]
  tools: string[]
}

/* ---------- 开发环境：执行者容器里预装的工具链与跨任务共享缓存 ---------- */
export function DevEnv() {
  const s = usePoll<any>('api/devenv/status', 5000)
  const { busy, run } = useAction()
  const d = s.d
  const job = d?.job
  const building = job?.state === 'running'
  const shared: SharedEnvInfo | undefined = d?.shared
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

  const cleanCache = async (bucket: string, label: string) => {
    const desc = bucket === 'all'
      ? '清空所有跨任务包下载缓存（npm、pnpm、pip、uv、Go、Cargo、Playwright 等）？全局安装的工具（~/superagent-tools）会完整保留。'
      : `清空「${label}」缓存目录？下次安装依赖时会自动重新拉取。`
    if (!await confirmAction(desc, { title: '清理共享缓存', danger: bucket === 'all', okLabel: '确认清理' })) return
    run(async () => {
      const r = await post<any>('api/devenv/cache/clean', { bucket })
      toast(`已清理 ${label}，释放 ${bytes(r?.freedBytes || 0) || '0 B'}`)
    }, undefined, s.reload)
  }

  return <div className="page">
    <header className="phead">
      <div>
        <h1>开发环境与共享缓存</h1>
        <p className="phead__sub">只读容器预装工具链、跨工单共享下载缓存（Node / Python / Go / Rust / Playwright）与全局复用工具</p>
      </div>
    </header>

    <Loading d={d} err={s.err} />
    {d && <>
      {!d.base && d.recommendedDev && !building && (
        <div className="alert" data-lv="warn">
          <div className="headrow">
            <span>
              <b>当前执行者镜像没有开发环境底座</b>（可能刚升级了精简版 Pi）。
              本机保留历史开发镜像 <b className="mono">{d.recommendedDev.tag}</b>（{d.recommendedDev.size}，组件：{formatFeatures(d.recommendedDev.features)}），可直接极速复用。
            </span>
            <button className="primary" disabled={busy} onClick={() => void repack(d.recommendedDev.image, d.recommendedDev.tag)}>
              一键极速复用（约 20 秒）
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>当前镜像状态</h2>
        <dl className="kvs">
          <dt>执行者镜像</dt><dd className="mono">{d.image}</dd>
          <dt>开发底座</dt><dd className="mono">{d.base || <span className="warn">（未基于开发镜像构建）</span>}</dd>
          <dt>额外系统包</dt><dd>{(d.packages || []).join(' ') || '—'}</dd>
          <dt>可选组件</dt><dd>{formatFeatures(d.features)}</dd>
        </dl>
        {d.imagesError && <p className="warn">{d.imagesError}</p>}
      </div>

      {shared && <section className="card env-shared" aria-label="跨任务共享环境">
        <div className="headrow">
          <div>
            <h2>跨任务共享缓存与全局工具链</h2>
            <p className="meta">
              任一工单下载的依赖包与全局 CLI 工具自动持久化到宿主机，后续所有工单秒级复用，大幅降低重复下载耗时。
            </p>
          </div>
          <div className="actions">
            <span className="tag" data-tone={shared.enabled ? 'run' : 'bad'}>{shared.enabled ? '共享挂载已开启' : '共享挂载已关闭'}</span>
            <span className="tag" data-tone={shared.mirrorsEnabled ? 'run' : 'done'}>{shared.mirrorsEnabled ? '国内镜像加速' : '官方源'}</span>
            {shared.totalCacheBytes > 0 && (
              <button className="small danger" disabled={busy} onClick={() => void cleanCache('all', '全部共享缓存')}>
                清理全部缓存
              </button>
            )}
          </div>
        </div>

        <div className="kpi-strip env-kpis">
          <div className="kpi-cell">
            <span>共享缓存总占用</span>
            <b>{bytes(shared.totalCacheBytes) || '0 B'}</b>
            <small className="mono">{shared.cacheDir}</small>
          </div>
          <div className="kpi-cell">
            <span>全局共享工具</span>
            <b>{bytes(shared.totalToolsBytes) || '0 B'}</b>
            <small className="mono">{shared.toolsDir}</small>
          </div>
          <div className="kpi-cell">
            <span>已复用生态桶</span>
            <b>{shared.buckets.filter(b => b.bytes > 0).length} / {shared.buckets.length}</b>
            <small>Node · Python · Go · Rust · Browser</small>
          </div>
          <div className="kpi-cell">
            <span>已安装共享 CLI</span>
            <b>{shared.tools.length} 个</b>
            <small>自动注入容器 PATH</small>
          </div>
        </div>

        <div className="env-buckets">
          {shared.buckets.map(b => (
            <div key={b.id} className={b.bytes > 0 ? 'env-bucket is-active' : 'env-bucket'}>
              <div className="env-bucket__head">
                <div>
                  <b>{b.label}</b>
                  <span className="meta">{b.desc}</span>
                </div>
                <span className="env-bucket__size">{bytes(b.bytes) || '0 B'}</span>
              </div>
              <div className="env-bucket__foot">
                <span className="meta">{b.exists ? `${b.files} 个缓存文件` : '待首次写入'}</span>
                {b.bytes > 0 && (
                  <button type="button" className="ghost small danger" disabled={busy} onClick={() => void cleanCache(b.id, b.label)}>
                    清理
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {shared.tools.length > 0 && (
          <div className="env-tools">
            <h4>已共享全局 CLI（<span className="mono">/opt/sa/bin</span>）</h4>
            <div className="env-toollist">
              {shared.tools.map(t => <code key={t} className="env-tool">{t}</code>)}
            </div>
          </div>
        )}
      </section>}

      <div className="card">
        <h2>重建开发环境镜像</h2>
        {seededFrom && !d.base && <p className="meta">已自动带入历史开发镜像 <span className="mono">{seededFrom}</span> 的组件与系统包配置，避免丢失原有选配。</p>}
        <label className="field"><span>额外系统包</span><small className="hint">Debian 包名，空格分开，比如 libmagic1 ffmpeg imagemagick</small>
          <input className="mono" value={packages} disabled={building} onChange={e => setPackages(e.target.value)} /></label>
        {(d.available?.features || []).map((f: string) => <label className="check" key={f}>
          <input type="checkbox" checked={features.includes(f)} disabled={building} onChange={() => toggle(f)} />
          <span><b>{FEATURE_WORD[f]?.[0] || f}</b><small className="hint">{FEATURE_WORD[f]?.[1]}</small></span></label>)}
        <label className="check"><input type="checkbox" checked={mirrors} disabled={building} onChange={e => setMirrors(e.target.checked)} />
          <span><b>构建时用国内镜像源（含 Pi 安装与自动重试兜底）</b><small className="hint">阿里云 Debian/PyPI、npmmirror、goproxy.cn；关掉则全程用官方源</small></span></label>
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
      {(d.devImages || []).map((i: any) => <div className="row env-imgrow" key={i.image}>
        <div>
          <b className="mono">{i.tag}{i.image === d.base ? '（当前在用）' : ''}</b>
          <span className="meta">
            {i.size} · {ago(i.createdAt)} · 组件：{formatFeatures(i.features)}{i.packages?.length ? ` · 额外包：${i.packages.join(' ')}` : ''}
          </span>
        </div>
        <div className="actions">
          <button disabled={busy || building} onClick={() => void repack(i.image, i.tag)}>封装当前 Pi</button>
          <button className="ghost" disabled={building} onClick={() => loadPreset(i)}>载入配置</button>
          {i.image !== d.base && <button className="ghost danger" disabled={busy || building} onClick={() => void removeDev(i)}>删除</button>}
        </div>
      </div>)}
      {!(d.devImages || []).length && <Empty>还没有构建过开发镜像。</Empty>}
    </>}
  </div>
}
