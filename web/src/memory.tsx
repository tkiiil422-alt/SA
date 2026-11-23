/**
 * 长期记忆、主人意图画像与可进化技能库管理页面（#/memory）。
 */
import { useState } from 'react'
import { del, get, post, put } from './api'
import { ago, usePoll } from './hooks'
import { Empty, Markdown, Sheet, Tabs, confirmAction, toast, useAction } from './ui'
import type {
  BenchmarkMetrics,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  PluginDescriptor,
  PluginProposalRecord,
  SkillRecord,
  SkillScope,
  SkillVersionRecord,
} from '../../src/shared/api-types.ts'

const SCOPE_LABEL: Record<MemoryScope, string> = { user: '全局', project: '项目', ticket: '工单' }
const KIND_LABEL: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  pitfall: '避坑',
  decision: '决策',
  retro: '复盘',
}
const SKILL_SCOPE_LABEL: Record<SkillScope, string> = { director: '总控', worker: '执行者', both: '通用' }
const SOURCE_LABEL: Record<string, string> = {
  auto_intent: '对话自动习得',
  auto_retro: '工单自动复盘',
  user_correction: '主人纠正',
  director_correction: '总控纠偏',
  director: '总控沉淀',
  worker: '执行者沉淀',
  user: '手动录入',
}

interface MemoryListApi {
  items: MemoryRecord[]
  total: number
  stats?: { total: number; pinned: number; byScope: Record<MemoryScope, number>; ftsEnabled: boolean }
}

interface OwnerProfileApi {
  preferences: MemoryRecord[]
  decisions: MemoryRecord[]
  pitfalls: MemoryRecord[]
  recentCorrections: MemoryRecord[]
  autoLearnedCount: number
  totalActive: number
}

interface PendingCandidateItem {
  skillId: string
  skillSlug: string
  skillName: string
  activeVersion: number
  activeContent: string
  candidate: SkillVersionRecord
}

interface EvolutionOverviewApi {
  pendingCandidates: PendingCandidateItem[]
  stats: {
    skills: number
    totalVersions: number
    pendingCandidates: number
    proposals: number
    benchmarkRuns: number
  }
}

export function MemoryPage() {
  const [tab, setTab] = useState('memories')
  const [scope, setScope] = useState('')
  const [kind, setKind] = useState('')
  const [q, setQ] = useState('')
  const [recallQ, setRecallQ] = useState('')
  const [recalled, setRecalled] = useState<MemoryRecord[] | null>(null)
  const [editMem, setEditMem] = useState<Partial<MemoryRecord> | null>(null)
  const [editSkill, setEditSkill] = useState<Partial<SkillRecord> | null>(null)
  const [viewSkill, setViewSkill] = useState<SkillRecord | null>(null)
  const { busy, run } = useAction()

  const memQuery = `api/memories?limit=100${scope ? `&scope=${scope}` : ''}${kind ? `&kind=${kind}` : ''}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`
  const mems = usePoll<MemoryListApi>(memQuery, 15000)
  const profile = usePoll<OwnerProfileApi>('api/memories/profile', 20000)
  const skills = usePoll<{ items: SkillRecord[]; total: number }>(`api/skills?limit=100${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`, 15000)
  const plugins = usePoll<{ items: PluginDescriptor[] }>('api/plugins', 30000)
  const benches = usePoll<{ cases: { id: string; title: string; input: string }[]; runs: { id: string; suiteName: string; label: string; metrics: BenchmarkMetrics; createdAt: string }[] }>('api/evolution/benchmarks', 30000)
  const evoOverview = usePoll<EvolutionOverviewApi>('api/evolution/overview', 20000)
  const proposals = usePoll<{ items: PluginProposalRecord[]; total: number }>('api/evolution/proposals', 30000)
  const runners = usePoll<{ items: { id: string; name: string; kind: string; available: boolean; detail?: string }[]; scripts: { id: string; name?: string; description: string }[] }>('api/runners', 60000)

  const reloadMem = () => { mems.reload(); profile.reload() }

  const doRecall = () => {
    if (!recallQ.trim()) { setRecalled(null); return }
    run(async () => {
      const res = await get<{ items: MemoryRecord[] }>(`api/memories/recall?q=${encodeURIComponent(recallQ.trim())}&limit=8`)
      setRecalled(res.items || [])
    })
  }

  const togglePin = (m: MemoryRecord) =>
    run(() => put(`api/memories/${encodeURIComponent(m.id)}`, { pinned: !m.pinned }), m.pinned ? '已取消置顶' : '已置顶', reloadMem)

  const removeMem = async (m: MemoryRecord) => {
    if (!(await confirmAction(`确定永久删除记忆「${m.title}」吗？`, { title: '删除记忆', danger: true, okLabel: '删除' }))) return
    run(() => del(`api/memories/${encodeURIComponent(m.id)}`), '已删除记忆', reloadMem)
  }

  const toggleSkill = (sk: SkillRecord) =>
    run(() => put(`api/skills/${encodeURIComponent(sk.id)}`, { enabled: !sk.enabled }), sk.enabled ? '已停用技能' : '已启用技能', skills.reload)

  const removeSkill = async (sk: SkillRecord) => {
    if (!(await confirmAction(`确定删除技能「${sk.name}」吗？磁盘对应的 Markdown 文件也会一并删除。`, { title: '删除技能', danger: true, okLabel: '删除' }))) return
    run(() => del(`api/skills/${encodeURIComponent(sk.id)}`), '已删除技能', () => { skills.reload(); evoOverview.reload() })
  }

  const rollbackSkill = async (sk: SkillRecord) => {
    if (!(await confirmAction(`确定将技能「${sk.name}」从 v${sk.activeVersion} 回退至 v${sk.previousVersion} 吗？`, { title: '回退技能版本', okLabel: '回退' }))) return
    run(() => post(`api/evolution/skills/${encodeURIComponent(sk.id)}/rollback`, { reason: '控制台手动回退' }), '已回退至上一稳定版', () => { skills.reload(); evoOverview.reload() })
  }

  const promoteCandidate = async (item: PendingCandidateItem) => {
    if (!(await confirmAction(`批准启用技能「${item.skillName}」的进化候选版 v${item.candidate.version}？原版 v${item.activeVersion} 会保留以便随时一键回退。`, { title: '批准技能升级', okLabel: '批准启用' }))) return
    run(
      () => post(`api/evolution/skills/${encodeURIComponent(item.skillId)}/versions/${item.candidate.version}/promote`, {}),
      `已升级技能「${item.skillName}」至 v${item.candidate.version}`,
      () => { skills.reload(); evoOverview.reload() },
    )
  }

  const rejectCandidate = async (item: PendingCandidateItem) => {
    if (!(await confirmAction(`拒绝技能「${item.skillName}」的候选修订 v${item.candidate.version}？`, { title: '拒绝候选修订', danger: true, okLabel: '确认拒绝' }))) return
    run(
      () => post(`api/evolution/skills/${encodeURIComponent(item.skillId)}/versions/${item.candidate.version}/reject`, {}),
      '已拒绝候选修订',
      evoOverview.reload,
    )
  }

  const togglePlugin = (pl: PluginDescriptor) =>
    run(async () => {
      await put(`api/plugins/${encodeURIComponent(pl.id)}`, { enabled: !pl.enabled })
      window.dispatchEvent(new Event('sa-plugins-changed'))
    }, pl.enabled ? `已停用插件「${pl.name}」` : `已启用插件「${pl.name}」`, plugins.reload)

  const runCoreBenchmarks = () =>
    run(
      () => post('api/evolution/benchmarks/run', {}),
      '核心基准评测已运行并记录',
      () => { benches.reload(); evoOverview.reload() },
    )

  const approveProposal = async (p: PluginProposalRecord) => {
    const riskNote = [
      p.externalWritePermissions.length ? `外部写权限：${p.externalWritePermissions.join('、')}` : '',
      p.irreversibleMigration ? '包含不可逆数据迁移' : '',
    ].filter(Boolean).join('；')
    if (!(await confirmAction(
      `确认批准插件提案「${p.pluginName}」并启动独立分支研发？${riskNote ? `\n风险提示：${riskNote}` : ''}`,
      { title: '批准插件演进提案', okLabel: '批准并派发' },
    ))) return
    run(
      () => post(`api/evolution/proposals/${encodeURIComponent(p.id)}/approve`, { actorId: 'web:admin' }),
      '已批准并启动独立分支研发',
      () => { proposals.reload(); evoOverview.reload() },
    )
  }

  const rejectProposal = async (p: PluginProposalRecord) => {
    if (!(await confirmAction(`确认拒绝插件提案「${p.pluginName}」吗？`, { title: '拒绝提案', danger: true, okLabel: '拒绝' }))) return
    run(
      () => post(`api/evolution/proposals/${encodeURIComponent(p.id)}/reject`, {}),
      '已拒绝提案',
      () => { proposals.reload(); evoOverview.reload() },
    )
  }

  const stats = mems.d?.stats
  const prof = profile.d
  const pendingCands = evoOverview.d?.pendingCandidates ?? []
  const evoBadge = pendingCands.length + (proposals.d?.items?.filter(p => p.status === 'pending_approval').length ?? 0)

  return <div className="page">
    <header className="phead">
      <div>
        <h1>记忆与自进化</h1>
        <p className="phead__sub">主人意图画像、三层长期记忆、候选技能进化审批、基准评测与多执行器管理</p>
      </div>
      <div className="actions">
        {tab === 'memories'
          ? <button className="primary" onClick={() => setEditMem({ scope: 'user', kind: 'preference', title: '', content: '', tags: [], pinned: true })}>新建偏好 / 记忆</button>
          : tab === 'skills'
            ? <button className="primary" onClick={() => setEditSkill({ name: '', slug: '', description: '', scope: 'both', triggers: [], tags: [], content: '', enabled: true })}>新建技能 SOP</button>
            : tab === 'evolution'
              ? <button className="primary" disabled={busy} onClick={runCoreBenchmarks}>{busy ? '评测中…' : '运行核心基准评测'}</button>
              : null}
      </div>
    </header>

    <Tabs
      value={tab}
      onChange={setTab}
      items={[
        ['memories', `主人画像与记忆 (${stats?.total ?? mems.d?.total ?? 0})`],
        ['skills', `技能库 (${skills.d?.total ?? 0})`],
        ['evolution', `自进化与评测${evoBadge > 0 ? ` (${evoBadge} 待审)` : ''}`],
        ['runners', `本机执行器 (${runners.d?.items?.length ?? 0})`],
        ['plugins', `子系统插件 (${plugins.d?.items?.length ?? 0})`],
      ]}
    />

    {tab === 'memories' && <>
      {prof && <section className="card mem-profile" aria-label="主人意图画像">
        <div className="headrow">
          <div>
            <h2>主人意图画像（越用越懂你）</h2>
            <p className="meta">系统会自动从对话中的「以后都… / 记住… / 不要再…」和工单复盘中提炼偏好，每次调用总控与执行者时自动注入。</p>
          </div>
          <button className="ghost small" onClick={() => setEditMem({ scope: 'user', kind: 'preference', title: '', content: '', tags: ['habit'], pinned: true })}>
            ＋ 添加我的习惯
          </button>
        </div>
        <div className="kpi-strip">
          <div className="kpi-cell"><span>核心习惯偏好</span><b>{prof.preferences.length}</b><small>默认遵守</small></div>
          <div className="kpi-cell"><span>红线与避坑</span><b>{prof.pitfalls.length}</b><small>严格避免重犯</small></div>
          <div className="kpi-cell"><span>统一口径决策</span><b>{prof.decisions.length}</b><small>跨项目一致</small></div>
          <div className="kpi-cell"><span>自动习得沉淀</span><b>{prof.autoLearnedCount}</b><small>共 {prof.totalActive} 条活跃</small></div>
        </div>
        {(prof.preferences.length > 0 || prof.pitfalls.length > 0) && (
          <div className="mem-profile__lists">
            {prof.preferences.length > 0 && <div className="mem-profile__col">
              <h4>高频核心偏好</h4>
              <ul>
                {prof.preferences.slice(0, 4).map(m => <li key={m.id}><b>{m.title}</b><span>{m.content.slice(0, 90)}</span></li>)}
              </ul>
            </div>}
            {prof.pitfalls.length > 0 && <div className="mem-profile__col">
              <h4>红线与避坑</h4>
              <ul>
                {prof.pitfalls.slice(0, 4).map(m => <li key={m.id}><b>{m.title}</b><span>{m.content.slice(0, 90)}</span></li>)}
              </ul>
            </div>}
          </div>
        )}
      </section>}

      <div className="mem-filters">
        <input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="搜索标题、正文或标签…" />
        <select value={scope} onChange={e => setScope(e.target.value)} aria-label="按作用域筛选">
          <option value="">全部作用域</option>
          <option value="user">全局偏好</option>
          <option value="project">项目经验</option>
          <option value="ticket">工单复盘</option>
        </select>
        <select value={kind} onChange={e => setKind(e.target.value)} aria-label="按分类筛选">
          <option value="">全部分类</option>
          <option value="preference">偏好</option>
          <option value="pitfall">避坑</option>
          <option value="decision">决策</option>
          <option value="fact">事实</option>
          <option value="retro">复盘</option>
        </select>
      </div>

      <div className="card mem-recall">
        <div className="quick">
          <input
            value={recallQ}
            onChange={e => setRecallQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doRecall() }}
            placeholder="召回验证：输入一段任务描述，预览系统会给 AI 注入哪几条记忆…"
          />
          <button disabled={busy} onClick={doRecall}>模拟召回</button>
          {recalled && <button className="ghost" onClick={() => { setRecalled(null); setRecallQ('') }}>清除</button>}
        </div>
        {recalled && <div className="mem-recall__out">
          {recalled.length === 0
            ? <p className="meta">没有命中高相关记忆。</p>
            : <div className="list">
              {recalled.map(m => <div key={m.id} className="row">
                <b>[{SCOPE_LABEL[m.scope]} · {KIND_LABEL[m.kind]}] {m.title}</b>
                <span className="meta">{m.content.slice(0, 180)}</span>
              </div>)}
            </div>}
        </div>}
      </div>

      {!mems.d?.items?.length
        ? <Empty>还没有长期记忆。你可以手动新建，或在对话中直接对总控说「以后都用… / 记住…」，系统会自动学习并沉淀。</Empty>
        : <div className="list">
          {mems.d.items.map(m => <article key={m.id} className="card mem-card">
            <div className="mem-card__head">
              <div className="mem-card__title">
                <span className="tag">{SCOPE_LABEL[m.scope]}</span>
                <span className="tag" data-tone={m.kind === 'pitfall' ? 'bad' : m.kind === 'preference' ? 'run' : 'done'}>{KIND_LABEL[m.kind]}</span>
                {m.pinned && <span className="tag" data-tone="human">置顶</span>}
                <b>{m.title}</b>
              </div>
              <div className="actions">
                <button className="small" disabled={busy} onClick={() => togglePin(m)}>{m.pinned ? '取消置顶' : '置顶'}</button>
                <button className="small" disabled={busy} onClick={() => setEditMem(m)}>编辑</button>
                <button className="small danger" disabled={busy} onClick={() => removeMem(m)}>删除</button>
              </div>
            </div>
            <p className="mem-card__body">{m.content}</p>
            <p className="meta">
              来源：{SOURCE_LABEL[m.source] || m.source} · 命中 {m.useCount} 次{m.projectId ? ` · 项目 ${m.projectId}` : ''}{m.tags.length ? ` · 标签：${m.tags.join(' / ')}` : ''} · 更新于 {ago(m.updatedAt)}
            </p>
          </article>)}
        </div>}
    </>}

    {tab === 'skills' && <>
      <input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="搜索技能名称、slug、触发词…" />
      {!skills.d?.items?.length
        ? <Empty>还没有沉淀技能（SOP）。你可以把常用的部署、排障、代码规范保存为技能，总控和执行者会按触发词自动加载。</Empty>
        : <div className="list">
          {skills.d.items.map(sk => <article key={sk.id} className={sk.enabled ? 'card mem-card' : 'card mem-card is-dim'}>
            <div className="mem-card__head">
              <div className="mem-card__title">
                <span className="tag">{SKILL_SCOPE_LABEL[sk.scope]}</span>
                <span className="tag" data-tone={sk.enabled ? 'run' : 'done'}>{sk.enabled ? '启用' : '停用'}</span>
                <span className="tag mono">v{sk.activeVersion ?? 1}</span>
                <b>{sk.name}</b>
                <code className="meta">{sk.slug}</code>
              </div>
              <div className="actions">
                <button className="small" onClick={() => setViewSkill(sk)}>查看全文</button>
                {sk.previousVersion ? <button className="small" disabled={busy} onClick={() => rollbackSkill(sk)}>回退 v{sk.previousVersion}</button> : null}
                <button className="small" disabled={busy} onClick={() => toggleSkill(sk)}>{sk.enabled ? '停用' : '启用'}</button>
                <button className="small" disabled={busy} onClick={() => setEditSkill(sk)}>编辑</button>
                <button className="small danger" disabled={busy} onClick={() => removeSkill(sk)}>删除</button>
              </div>
            </div>
            {sk.description && <p className="mem-card__desc">{sk.description}</p>}
            <p className="meta">
              触发词：{sk.triggers.length ? sk.triggers.join('、') : '未设置'}
              {sk.preferredRunnerId ? ` · 优先执行器：${sk.preferredRunnerId}` : ''}
              {' · '}使用 {sk.useCount} 次 · 更新于 {ago(sk.updatedAt)}
            </p>
          </article>)}
        </div>}
    </>}

    {tab === 'evolution' && <>
      <section className="evo-sec" aria-label="待审核技能进化">
        <div className="sechead">
          <h2>待审核技能进化（自动迭代草案）</h2>
          <span className="sechead__note">{pendingCands.length ? `${pendingCands.length} 个候选修订待你拍板` : '当前全部版本均为稳定态'}</span>
        </div>
        {pendingCands.length === 0
          ? <Empty>暂无待审技能候选修订。当技能连续触发返工或你纠正执行口径时，系统会自动起草候选版并在此等你审核启用。</Empty>
          : <div className="list">
            {pendingCands.map(item => (
              <article key={`${item.skillId}-${item.candidate.version}`} className="card evo-cand">
                <div className="mem-card__head">
                  <div className="mem-card__title">
                    <span className="tag" data-tone="human">待审核</span>
                    <b>{item.skillName}</b>
                    <span className="mono meta">v{item.activeVersion} → v{item.candidate.version}</span>
                  </div>
                  <div className="actions">
                    <button className="primary small" disabled={busy} onClick={() => promoteCandidate(item)}>批准启用 v{item.candidate.version}</button>
                    <button className="small danger" disabled={busy} onClick={() => rejectCandidate(item)}>拒绝</button>
                  </div>
                </div>
                <p className="mem-card__desc">{item.candidate.reason}</p>
                <p className="meta">触发来源：{item.candidate.source} · 起草于 {ago(item.candidate.createdAt)}</p>
                <details>
                  <summary>查看候选修订内容</summary>
                  <pre>{item.candidate.content}</pre>
                </details>
              </article>
            ))}
          </div>}
      </section>

      <div className="card">
        <div className="headrow">
          <div>
            <h2>核心典型任务评测基准</h2>
            <p className="meta">持续对比首次验收通过率、人工介入次数、单任务成本与验收后返工率</p>
          </div>
          <button className="small" disabled={busy} onClick={runCoreBenchmarks}>{busy ? '评测中…' : '立即跑一轮'}</button>
        </div>
        {benches.d?.cases?.length ? <ul className="pt-checklist">
          {benches.d.cases.map(c => <li key={c.id}><b>{c.title}</b> <span className="mono meta">({c.id})</span></li>)}
        </ul> : null}
      </div>

      {!benches.d?.runs?.length
        ? <Empty>还没有评测记录。点击「立即跑一轮基准」建立当前基线，每次技能或策略更新后可横向对比。</Empty>
        : <div className="list">
          {benches.d.runs.map(r => <article key={r.id} className="card mem-card">
            <div className="headrow">
              <b>{r.label} <span className="meta">({r.suiteName})</span></b>
              <span className="meta">{ago(r.createdAt)}</span>
            </div>
            <div className="mem-metrics">
              <span>通过 <b>{r.metrics.passedTasks}/{r.metrics.totalTasks}</b></span>
              <span>首过率 <b>{Math.round(r.metrics.firstPassAcceptanceRate * 100)}%</b></span>
              <span>人工介入 <b>{r.metrics.humanInterventions} 次</b></span>
              <span>单通过成本 <b>{r.metrics.costPerPassingTaskUsd !== null ? `$${r.metrics.costPerPassingTaskUsd.toFixed(4)}` : '—'}</b></span>
              <span>验收后返工 <b>{Math.round(r.metrics.postAcceptanceReworkRate * 100)}%</b></span>
            </div>
          </article>)}
        </div>}

      <h2>插件自动演进提案</h2>
      {!proposals.d?.items?.length
        ? <Empty>暂无待处理的插件演进提案。当现有技能反复无法完成某类需求时，系统会自动登记缺口并在此发起研发与审批提案。</Empty>
        : <div className="list">
          {proposals.d.items.map(p => <article key={p.id} className="card mem-card">
            <div className="mem-card__head">
              <div className="mem-card__title">
                <span className="tag" data-tone={p.status === 'pending_approval' ? 'human' : p.status === 'dispatched' ? 'run' : 'done'}>
                  {p.status === 'pending_approval' ? '待主人审批' : p.status === 'dispatched' ? '已派发研发' : p.status === 'rejected' ? '已拒绝' : p.status}
                </span>
                {p.requiresUserApproval && <span className="tag" data-tone="bad">高风险门禁</span>}
                <b>{p.pluginName}</b>
                <code className="meta">{p.gapKey}</code>
              </div>
              {p.status === 'pending_approval' && <div className="actions">
                <button className="primary small" disabled={busy} onClick={() => approveProposal(p)}>批准并启动研发</button>
                <button className="small danger" disabled={busy} onClick={() => rejectProposal(p)}>拒绝</button>
              </div>}
            </div>
            <p className="mem-card__desc">{p.summary}</p>
            <p className="meta">
              缺口累计 {p.occurrences} 次
              {p.externalWritePermissions.length ? ` · 新增外部写权限：${p.externalWritePermissions.join('、')}` : ''}
              {p.irreversibleMigration ? ' · 含不可逆迁移' : ''}
              {p.approvedBy ? ` · 审批人：${p.approvedBy}` : ''}
              {p.missionId ? <> · <a href="#/director">关联 DAG {p.missionId}</a></> : null}
            </p>
          </article>)}
        </div>}
    </>}

    {tab === 'runners' && <>
      <h2>已注册本机执行器</h2>
      <div className="list">
        {(runners.d?.items || []).map(rn => <article key={rn.id} className={rn.available ? 'card mem-card' : 'card mem-card is-dim'}>
          <div className="mem-card__head">
            <div className="mem-card__title"><b>{rn.name}</b> <code className="meta">{rn.id}</code></div>
            <div className="actions">
              <span className="tag">{rn.kind}</span>
              {rn.kind === 'script' && <span className="tag" data-tone="run">0 Token</span>}
              <span className="tag" data-tone={rn.available ? 'run' : 'done'}>{rn.available ? '可用' : '未检测到 CLI'}</span>
            </div>
          </div>
          {rn.detail && <p className="meta">{rn.detail}</p>}
        </article>)}
      </div>
      <h2>已登记的 0 Token 确定性脚本</h2>
      {!runners.d?.scripts?.length
        ? <Empty>暂无已登记的确定性脚本。</Empty>
        : <div className="list">
          {runners.d.scripts.map(sc => <article key={sc.id} className="card mem-card">
            <b><code className="mono">{sc.id}</code>{sc.name ? ` · ${sc.name}` : ''}</b>
            <p className="meta">{sc.description}</p>
          </article>)}
        </div>}
    </>}

    {tab === 'plugins' && <>
      <div className="list">
        {(plugins.d?.items || []).map(pl => <article key={pl.id} className={pl.enabled ? 'card mem-card' : 'card mem-card is-dim'}>
          <div className="mem-card__head">
            <div className="mem-card__title"><b>{pl.name}</b> <code className="meta">{pl.id} v{pl.version}</code></div>
            <div className="actions">
              <span className="tag" data-tone={pl.enabled ? 'run' : 'done'}>{pl.enabled ? '已启用' : '已停用'}</span>
              {pl.routesPrefix && <button className="small" disabled={busy} onClick={() => togglePlugin(pl)}>{pl.enabled ? '停用插件' : '启用插件'}</button>}
            </div>
          </div>
          <p className="mem-card__desc">{pl.description}</p>
          <p className="meta">
            {pl.routesPrefix ? `路由：/api${pl.routesPrefix} · ` : ''}
            Director 动作：{pl.directorActions.length > 0 ? pl.directorActions.join(', ') : '内置'}
            {pl.workerTools.length > 0 ? ' · Worker 工具：已挂载 MCP' : ''}
          </p>
        </article>)}
      </div>
    </>}

    {editMem && <MemoryEditor initial={editMem} onClose={() => setEditMem(null)} onSaved={() => { setEditMem(null); reloadMem() }} />}
    {editSkill && <SkillEditor initial={editSkill} onClose={() => setEditSkill(null)} onSaved={() => { setEditSkill(null); skills.reload(); evoOverview.reload() }} />}
    {viewSkill && <Sheet title={`${viewSkill.name} (${viewSkill.slug})`} onClose={() => setViewSkill(null)}>
      <p className="meta">{viewSkill.description}</p>
      <Markdown text={viewSkill.content} />
    </Sheet>}
  </div>
}

function MemoryEditor({ initial, onClose, onSaved }: { initial: Partial<MemoryRecord>; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(initial.title || '')
  const [content, setContent] = useState(initial.content || '')
  const [scope, setScope] = useState<MemoryScope>(initial.scope || 'user')
  const [kind, setKind] = useState<MemoryKind>(initial.kind || 'preference')
  const [projectId, setProjectId] = useState(initial.projectId || '')
  const [tagsText, setTagsText] = useState((initial.tags || []).join(', '))
  const [pinned, setPinned] = useState(Boolean(initial.pinned))
  const { busy, run } = useAction()

  const save = () => {
    if (!title.trim() || !content.trim()) { toast('请填写标题和内容', true); return }
    const tags = tagsText.split(/[,，]/).map(s => s.trim()).filter(Boolean)
    const body = {
      scope,
      kind,
      projectId: scope === 'project' && projectId.trim() ? projectId.trim() : null,
      title: title.trim(),
      content: content.trim(),
      tags,
      pinned,
    }
    run(
      () => initial.id ? put(`api/memories/${encodeURIComponent(initial.id)}`, body) : post('api/memories', body),
      initial.id ? '记忆已更新' : '记忆已保存',
      onSaved,
    )
  }

  return <Sheet title={initial.id ? '编辑记忆' : '新建长期记忆'} onClose={onClose}>
    <label className="field"><span>标题</span><input value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：默认代码风格与提交规范" /></label>
    <div className="grid2">
      <label className="field"><span>作用域</span>
        <select value={scope} onChange={e => setScope(e.target.value as MemoryScope)}>
          <option value="user">全局（跨项目生效）</option>
          <option value="project">项目专属</option>
          <option value="ticket">工单复盘</option>
        </select>
      </label>
      <label className="field"><span>分类</span>
        <select value={kind} onChange={e => setKind(e.target.value as MemoryKind)}>
          <option value="preference">偏好</option>
          <option value="pitfall">避坑经验</option>
          <option value="decision">架构决策</option>
          <option value="fact">事实信息</option>
          <option value="retro">复盘总结</option>
        </select>
      </label>
    </div>
    {scope === 'project' && <label className="field"><span>项目 ID</span><input value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="例如 p_abc123" /></label>}
    <label className="field"><span>正文内容</span><textarea rows={5} value={content} onChange={e => setContent(e.target.value)} placeholder="写清楚具体约束、命令或踩坑解决方案…" /></label>
    <label className="field"><span>标签（逗号分隔）</span><input value={tagsText} onChange={e => setTagsText(e.target.value)} placeholder="例如：部署, podman, python" /></label>
    <label className="check">
      <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
      <span><b>置顶</b><small className="hint">始终优先注入给总控和执行者</small></span>
    </label>
    <div className="actions dialog__actions">
      <button onClick={onClose}>取消</button>
      <button className="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
    </div>
  </Sheet>
}

function SkillEditor({ initial, onClose, onSaved }: { initial: Partial<SkillRecord>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial.name || '')
  const [slug, setSlug] = useState(initial.slug || '')
  const [description, setDescription] = useState(initial.description || '')
  const [scope, setScope] = useState<SkillScope>(initial.scope || 'both')
  const [preferredRunnerId, setPreferredRunnerId] = useState(initial.preferredRunnerId || '')
  const [triggersText, setTriggersText] = useState((initial.triggers || []).join(', '))
  const [content, setContent] = useState(initial.content || '')
  const [enabled, setEnabled] = useState(initial.enabled !== false)
  const { busy, run } = useAction()

  const save = () => {
    if (!name.trim() || !content.trim()) { toast('请填写技能名称和 SOP 正文', true); return }
    const triggers = triggersText.split(/[,，]/).map(s => s.trim()).filter(Boolean)
    const body = {
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      name: name.trim(),
      description: description.trim(),
      scope,
      triggers,
      content: content.trim(),
      enabled,
      preferredRunnerId: preferredRunnerId.trim() || null,
    }
    run(
      () => initial.id ? put(`api/skills/${encodeURIComponent(initial.id)}`, body) : post('api/skills', body),
      initial.id ? '技能已更新' : '技能已保存并同步到磁盘',
      onSaved,
    )
  }

  return <Sheet title={initial.id ? '编辑技能 (SOP)' : '新建技能 (SOP)'} onClose={onClose}>
    <label className="field"><span>技能名称</span><input value={name} onChange={e => setName(e.target.value)} placeholder="例如：Debian 主机安全发布流程" /></label>
    <div className="grid2">
      <label className="field"><span>英文/标识 Slug（可选）</span><input value={slug} onChange={e => setSlug(e.target.value)} placeholder="deploy-debian" /></label>
      <label className="field"><span>适用范围</span>
        <select value={scope} onChange={e => setScope(e.target.value as SkillScope)}>
          <option value="both">通用（总控 + 执行者）</option>
          <option value="worker">仅执行者</option>
          <option value="director">仅总控助手</option>
        </select>
      </label>
    </div>
    <label className="field"><span>命中时优先执行器（可选）</span>
      <select value={preferredRunnerId} onChange={e => setPreferredRunnerId(e.target.value)}>
        <option value="">跟随默认（Pi 沙箱代理）</option>
        <option value="script">script（0 Token 确定性脚本）</option>
        <option value="claude-code">claude-code（Claude Code CLI）</option>
        <option value="opencode">opencode（OpenCode CLI）</option>
      </select>
    </label>
    <label className="field"><span>一句话简介</span><input value={description} onChange={e => setDescription(e.target.value)} placeholder="什么时候使用这个 SOP" /></label>
    <label className="field"><span>触发关键词（逗号分隔）</span><input value={triggersText} onChange={e => setTriggersText(e.target.value)} placeholder="部署, 上线, systemd" /></label>
    <label className="field"><span>SOP 步骤内容（支持 Markdown）</span><textarea rows={8} value={content} onChange={e => setContent(e.target.value)} placeholder="1. 先跑 pnpm check&#10;2. 检查 ..." /></label>
    <label className="check">
      <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
      <span><b>启用该技能</b></span>
    </label>
    <div className="actions dialog__actions">
      <button onClick={onClose}>取消</button>
      <button className="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
    </div>
  </Sheet>
}
