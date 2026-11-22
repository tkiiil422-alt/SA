import { useEffect, useState } from 'react'
import { post } from './api'
import { usePoll, ago } from './hooks'
import { toast, useAction, Empty, confirmAction } from './ui'
import { Loading } from './pages'

const FEATURE_WORD: Record<string, string> = {
  browser: '浏览器测试',
  dbserver: '测试用数据库',
  go: 'Go',
  java: 'Java',
}

function describeDevBrief(base?: string, features?: string[], packages?: string[]): string {
  if (!base) return '精简基础镜像（未含开发环境）'
  const tag = base.split(':').at(-1) || base
  const parts: string[] = []
  if (features?.length) parts.push(features.map(f => FEATURE_WORD[f] || f).join('、'))
  if (packages?.length) parts.push(`+${packages.length} 系统包`)
  return parts.length ? `开发底座 ${tag}（${parts.join('；')}）` : `开发底座 ${tag}（标准开发工具链）`
}

/* ---------- Pi 版本：检测、继承开发底座构建新镜像、切换给新任务用 ---------- */
export function PiVersions() {
  const s = usePoll<any>('api/pi/status', 4000)
  const { busy, run } = useAction()
  const [pick, setPick] = useState('')
  const [baseImage, setBaseImage] = useState<string>('')
  const [baseSeeded, setBaseSeeded] = useState(false)
  const [mirrors, setMirrors] = useState(true)
  const d = s.d
  const job = d?.job
  const building = job?.state === 'running'
  const target = pick || d?.upgrade || d?.latest || ''
  const devImages: any[] = d?.devImages || []

  // 首次加载时自动选中当前开发底座（若当前是裸镜像，则自动选中本机推荐的最新开发镜像）
  useEffect(() => {
    if (d && !baseSeeded) {
      setBaseImage(d.base || d.recommendedBase || '')
      setBaseSeeded(true)
    }
  }, [d, baseSeeded])

  const expectedTag = (v: string, base: string) => {
    const devTag = base && base.startsWith('localhost/superagent-dev:') ? base.slice('localhost/superagent-dev:'.length) : ''
    return devTag ? `${v}-dev${devTag}` : v
  }
  const expectedImage = (v: string, base: string) => `${(d?.image || 'localhost/superagent-pi:1.6.0').split(':')[0]}:${expectedTag(v, base)}`
  const hasExactImage = (v: string, base: string) => (d?.images || []).some((i: any) => i.tag === expectedTag(v, base))

  const check = () => run(async () => { await post('api/pi/check', {}); s.reload() }, '已检查 npm')
  const build = async (v: string, chosenBase = baseImage) => {
    const baseTip = chosenBase
      ? `将继承开发底座 ${chosenBase.split(':').at(-1)}（保留 ssh、patch 及已装开发组件），约 20–60 秒完成`
      : '不继承开发底座（仅含精简基础镜像）'
    if (!await confirmAction(`构建 Pi ${v} 镜像？${baseTip}，期间不影响正在跑的任务。`, { title: `构建 Pi ${v}`, okLabel: '开始构建' })) return
    run(() => post('api/pi/build', { version: v, baseImage: chosenBase, mirrors }), '开始构建', s.reload)
  }
  const apply = async (image: string, version?: string) => {
    if (!await confirmAction(`让新任务改用 ${image}${version ? `（Pi ${version}）` : ''}？正在跑的任务不受影响，要回退时切回原来的镜像即可。`, { title: '切换执行者镜像', okLabel: '确认切换' })) return
    run(async () => { const r = await post('api/pi/apply', { image }); toast(`新任务改用 Pi ${r.version}`) }, undefined, s.reload)
  }
  const remove = async (image: string) => {
    if (!await confirmAction(`删除镜像 ${image}？`, { title: '删除镜像', danger: true, okLabel: '删除' })) return
    run(() => post('api/pi/remove', { image }), '已删除', s.reload)
  }

  const currentImgObj = (d?.images || []).find((i: any) => i.current)

  return <><h1>Pi 版本</h1>
    <p className="meta">每个任务都在一个装好 Pi 的容器里跑。升级 Pi 时会自动继承当前开发环境底座，保留 ssh、patch、Python/uv、浏览器与数据库等预装环境，不再丢包。</p>
    <Loading d={d} err={s.err} />
    {d && <>
      <div className="card">
        <div className="headrow"><h2>正在使用</h2><button disabled={busy} onClick={check}>检查更新</button></div>
        <dl className="kvs">
          <dt>Pi 版本</dt><dd>{d.version ? <b>{d.version}</b> : <span className="warn">{d.versionError || '未知'}</span>}</dd>
          <dt>镜像</dt><dd className="mono">{d.image}</dd>
          <dt>开发底座</dt><dd>
            {d.base
              ? <span className="mono">{describeDevBrief(d.base, currentImgObj?.features, currentImgObj?.packages)}</span>
              : <span className="warn">未基于开发环境构建（缺少完整开发工具链）</span>}
          </dd>
          <dt>npm 最新</dt><dd>{d.latest || '—'}{d.latestPublishedAt ? `，发布于 ${ago(d.latestPublishedAt)}` : ''}</dd>
          <dt>上次检查</dt><dd>{ago(d.checkedAt) || '—'}</dd>
        </dl>
        {d.registryError && <p className="warn">{d.registryError}</p>}
        {d.imagesError && <p className="warn">{d.imagesError}</p>}
      </div>

      {!d.base && d.recommendedBase && !building && (
        <div className="alert" data-lv="warn">
          当前正在使用的镜像没有开发环境底座，本机仍保留历史开发镜像 <b className="mono">{d.recommendedBase.split(':').at(-1)}</b>。
          下方已自动帮你选中该开发底座，直接点击「构建」即可用约 20 秒为当前 Pi 版本套回全部开发环境（或前往 <a href="#/devenv"><b>开发环境页 →</b></a> 一键恢复）。
        </div>
      )}

      {d.upgrade && !building && <a className="alert" data-lv="info" href="#/pi" onClick={e => {
        e.preventDefault()
        const b = d.base || d.recommendedBase || ''
        if (hasExactImage(d.upgrade, b)) void apply(expectedImage(d.upgrade, b), d.upgrade)
        else void build(d.upgrade, b)
      }}>
        有新版本 Pi {d.upgrade}（在用 {d.version}）。{hasExactImage(d.upgrade, d.base || d.recommendedBase || '') ? '对应开发环境的镜像已构建好，点这里切换。' : '点这里保留开发环境并构建新镜像。'}
      </a>}

      <div className="card">
        <h2>构建镜像</h2>
        <p className="meta">按选中的 Pi 版本与开发底座构建执行者镜像，构建完会自动验证 <span className="mono">pi --version</span> 与全部内置扩展。</p>
        <div className="cols">
          <label className="field"><span>Pi 版本</span>
            <select value={target} onChange={e => setPick(e.target.value)} disabled={building}>
              {(d.releases || []).map((r: any) => <option key={r.version} value={r.version}>{r.version}{r.version === d.latest ? '（最新）' : ''}{r.version === d.version ? '（在用）' : ''}</option>)}
            </select></label>
          <label className="field"><span>开发环境底座（推荐继承，避免丢失 ssh 与开发包）</span>
            <select value={baseImage} onChange={e => setBaseImage(e.target.value)} disabled={building}>
              {devImages.map((dev: any) => (
                <option key={dev.image} value={dev.image}>
                  {dev.tag}（{dev.size}{dev.features?.length ? ` · ${dev.features.map((f: string) => FEATURE_WORD[f] || f).join('/')}` : ''}{dev.packages?.length ? ` · +${dev.packages.length}包` : ''}{dev.image === d.base ? ' · 在用' : ''}）
                </option>
              ))}
              <option value="">不继承开发底座（精简基础镜像，仅含基础 CLI/SSH）</option>
            </select></label>
        </div>
        <label className="check">
          <input type="checkbox" checked={mirrors} disabled={building} onChange={e => setMirrors(e.target.checked)} />
          <span><b>构建时优先用国内镜像源（npmmirror / 阿里云）</b><small className="hint">遇网络断连或镜像延迟会自动重试并回退官方 npm 源</small></span>
        </label>
        <div className="actions">
          <button className="primary" disabled={busy || building || !target || expectedImage(target, baseImage) === d.image} onClick={() => void build(target, baseImage)}>
            {building ? '构建中…' : `构建 ${target ? expectedTag(target, baseImage) : ''}`}
          </button>
        </div>
        {job && <>
          <p className="meta">
            Pi {job.version}（<span className="mono">{job.image}</span>）：{job.state === 'running' ? `构建中，已开始 ${ago(job.startedAt)}` : job.state === 'done' ? `构建完成 ${ago(job.endedAt)}` : <span className="warn">失败：{job.error}</span>}
          </p>
          <pre>{job.log.slice(-40).join('\n') || '…'}</pre>
          {job.state === 'done' && job.image !== d.image && <button className="primary" disabled={busy} onClick={() => void apply(job.image, job.version)}>让新任务改用 {job.image.split(':').at(-1)}</button>}
        </>}
      </div>

      <h2>本机镜像</h2>
      {(d.images || []).map((i: any) => <div className="row" key={i.image}>
        <span>
          <b className="mono">{i.tag}{i.current ? '（在用）' : ''}</b>
          <br />
          <span className="meta">Pi {i.version || '未知'} · {describeDevBrief(i.base, i.features, i.packages)} · {i.size} · {ago(i.createdAt)}</span>
        </span>
        {!i.current && <span className="actions">
          <button disabled={busy || building} onClick={() => void apply(i.image, i.version)}>切换到这个</button>
          <button className="ghost danger" disabled={busy} onClick={() => void remove(i.image)}>删除</button>
        </span>}
      </div>)}
      {!(d.images || []).length && <Empty>本机没有 superagent-pi 镜像。</Empty>}
    </>}
  </>
}
