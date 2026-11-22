/**
 * 长期记忆与可进化技能库管理页面（#/memory）。
 */
import { useState } from 'react'
import { del, get, post, put } from './api'
import { ago, usePoll } from './hooks'
import { Empty, Markdown, Sheet, Tabs, confirmAction, toast, useAction } from './ui'
import type { BenchmarkMetrics, MemoryKind, MemoryRecord, MemoryScope, PluginDescriptor, PluginProposalRecord, SkillRecord, SkillScope } from '../../src/shared/api-types.ts'

const SCOPE_LABEL: Record<MemoryScope, string> = { user: '全局', project: '项目', ticket: '工单' }
const KIND_LABEL: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  pitfall: '避坑',
  decision: '决策',
  retro: '复盘',
}
const SKILL_SCOPE_LABEL: Record<SkillScope, string> = { director: '总控', worker: '执行者', both: '通用' }

interface MemoryListApi {
  items: MemoryRecord[]
  total: number
  stats?: { total: number; pinned: number; byScope: Record<MemoryScope, number>; ftsEnabled: boolean }
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
  const skills = usePoll<{ items: SkillRecord[]; total: number }>(`api/skills?limit=100${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`, 15000)
  const plugins = usePoll<{ items: PluginDescriptor[] }>('api/plugins', 30000)
  const benches = usePoll<{ cases: { id: string; title: string; input: string }[]; runs: { id: string; suiteName: string; label: string; metrics: BenchmarkMetrics; createdAt: string }[] }>('api/evolution/benchmarks', 30000)
  const proposals = usePoll<{ items: PluginProposalRecord[]; total: number }>('api/evolution/proposals', 30000)
  const runners = usePoll<{ runners: { id: string; name: string; kind: string; zeroToken?: boolean; description?: string }[]; scripts: { id: string; description: string }[] }>('api/runners', 60000)

  const doRecall = () => {
    if (!recallQ.trim()) { setRecalled(null); return }
    run(async () => {
      const res = await get<{ items: MemoryRecord[] }>(`api/memories/recall?q=${encodeURIComponent(recallQ.trim())}&limit=8`)
      setRecalled(res.items || [])
    })
  }

  const togglePin = (m: MemoryRecord) =>
    run(() => put(`api/memories/${encodeURIComponent(m.id)}`, { pinned: !m.pinned }), m.pinned ? '已取消置顶' : '已置顶', mems.reload)

  const removeMem = async (m: MemoryRecord) => {
    if (!(await confirmAction(`确定永久删除记忆「${m.title}」吗？`, { title: '删除记忆', danger: true, okLabel: '删除' }))) return
    run(() => del(`api/memories/${encodeURIComponent(m.id)}`), '已删除记忆', mems.reload)
  }

  const toggleSkill = (sk: SkillRecord) =>
    run(() => put(`api/skills/${encodeURIComponent(sk.id)}`, { enabled: !sk.enabled }), sk.enabled ? '已停用技能' : '已启用技能', skills.reload)

  const removeSkill = async (sk: SkillRecord) => {
    if (!(await confirmAction(`确定删除技能「${sk.name}」吗？磁盘对应的 Markdown 文件也会一并删除。`, { title: '删除技能', danger: true, okLabel: '删除' }))) return
    run(() => del(`api/skills/${encodeURIComponent(sk.id)}`), '已删除技能', skills.reload)
  }

  const rollbackSkill = async (sk: SkillRecord) => {
    if (!(await confirmAction(`确定将技能「${sk.name}」从 v${sk.activeVersion} 回退至 v${sk.previousVersion} 吗？`, { title: '回退技能版本', okLabel: '回退' }))) return
    run(() => post(`api/evolution/skills/${encodeURIComponent(sk.id)}/rollback`, { reason: '控制台手动回退' }), '已回退至上一稳定版', skills.reload)
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
      benches.reload,
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
      proposals.reload,
    )
  }

  const rejectProposal = async (p: PluginProposalRecord) => {
    if (!(await confirmAction(`确认拒绝插件提案「${p.pluginName}」吗？`, { title: '拒绝提案', danger: true, okLabel: '拒绝' }))) return
    run(
      () => post(`api/evolution/proposals/${encodeURIComponent(p.id)}/reject`, {}),
      '已拒绝提案',
      proposals.reload,
    )
  }

  const stats = mems.d?.stats

  return <div className="page">
    <header className="phead">
      <div>
        <h1>记忆与进化</h1>
        <p className="phead__sub">三层长期记忆、可回退 SOP 技能库、基准评测指标、插件提案与本机多执行器</p>
      </div>
      <div className="actions">
        {tab === 'memories'
          ? <button className="primary" onClick={() => setEditMem({ scope: 'user', kind: 'preference', title: '', content: '', tags: [], pinned: false })}>新建记忆</button>
          : tab === 'skills'
            ? <button className="primary" onClick={() => setEditSkill({ name: '', slug: '', description: '', scope: 'both', triggers: [], tags: [], content: '', enabled: true })}>新建技能</button>
            : tab === 'evolution'
              ? <button className="primary" disabled={busy} onClick={runCoreBenchmarks}>{busy ? '评测中…' : '运行核心基准评测'}</button>
              : null}
      </div>
    </header>

    <Tabs
      value={tab}
      onChange={setTab}
      items={[
        ['memories', `长期记忆 (${stats?.total ?? mems.d?.total ?? 0})`],
        ['skills', `技能库 (${skills.d?.total ?? 0})`],
        ['evolution', `进化与评测 (${benches.d?.runs?.length ?? 0})`],
        ['runners', `本机执行器 (${runners.d?.runners?.length ?? 0})`],
        ['plugins', `子系统插件 (${plugins.d?.items?.length ?? 0})`],
      ]}
    />

    {tab === 'memories' && <>
      {stats && <div className="card" style={{ marginBottom: 12 }}>
        <p className="meta" style={{ margin: 0 }}>
          共 <b>{stats.total}</b> 条（置顶 {stats.pinned} · 全局 {stats.byScope.user} · 项目 {stats.byScope.project} · 工单 {stats.byScope.ticket} · 索引：{stats.ftsEnabled ? 'SQLite FTS5 + 中文词项' : '中文词项'}）
        </p>
      </div>}

      <div className="filters" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <input className="search" style={{ flex: '1 1 200px' }} value={q} onChange={e => setQ(e.target.value)} placeholder="搜索标题、正文或标签…" />
        <select value={scope} onChange={e => setScope(e.target.value)}>
          <option value="">全部作用域</option>
          <option value="user">全局偏好</option>
          <option value="project">项目经验</option>
          <option value="ticket">工单复盘</option>
        </select>
        <select value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">全部分类</option>
          <option value="preference">偏好</option>
          <option value="pitfall">避坑</option>
          <option value="decision">决策</option>
          <option value="fact">事实</option>
          <option value="retro">复盘</option>
        </select>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="search"
            style={{ flex: 1 }}
            value={recallQ}
            onChange={e => setRecallQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doRecall() }}
            placeholder="召回模拟：输入一段任务描述，看看系统会给 AI 注入哪几条记忆…"
          />
          <button disabled={busy} onClick={doRecall}>模拟召回</button>
          {recalled && <button onClick={() => { setRecalled(null); setRecallQ('') }}>清除</button>}
        </div>
        {recalled && <div style={{ marginTop: 10 }}>
          {recalled.length === 0
            ? <p className="meta">没有命中高相关记忆。</p>
            : <ul className="list" style={{ margin: 0 }}>
              {recalled.map(m => <li key={m.id} className="row">
                <div>
                  <b>[{SCOPE_LABEL[m.scope]}·{KIND_LABEL[m.kind]}] {m.title}</b>
                  <p className="meta" style={{ margin: '4px 0 0' }}>{m.content.slice(0, 180)}</p>
                </div>
              </li>)}
            </ul>}
        </div>}
      </div>

      {!mems.d?.items?.length
        ? <Empty>还没有长期记忆。你可以手动新建，或在对话中让总控助手记住偏好；工单完工后系统也会自动沉淀复盘经验。</Empty>
        : <div className="list">
          {mems.d.items.map(m => <article key={m.id} className="card" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
              <div>
                <span className="pill" style={{ marginRight: 6 }}>{SCOPE_LABEL[m.scope]}</span>
                <span className="pill" style={{ marginRight: 6 }}>{KIND_LABEL[m.kind]}</span>
                {m.pinned && <span className="pill" style={{ marginRight: 6 }}>置顶</span>}
                <b>{m.title}</b>
              </div>
              <div className="actions">
                <button disabled={busy} onClick={() => togglePin(m)}>{m.pinned ? '取消置顶' : '置顶'}</button>
                <button disabled={busy} onClick={() => setEditMem(m)}>编辑</button>
                <button className="danger" disabled={busy} onClick={() => removeMem(m)}>删除</button>
              </div>
            </div>
            <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{m.content}</p>
            <p className="meta" style={{ margin: 0 }}>
              来源：{m.source} · 命中 {m.useCount} 次{m.projectId ? ` · 项目 ${m.projectId}` : ''}{m.tags.length ? ` · 标签：${m.tags.join(' / ')}` : ''} · 更新于 {ago(m.updatedAt)}
            </p>
          </article>)}
        </div>}
    </>}

    {tab === 'skills' && <>
      <div style={{ marginBottom: 12 }}>
        <input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="搜索技能名称、slug、触发词…" />
      </div>
      {!skills.d?.items?.length
        ? <Empty>还没有沉淀技能（SOP）。你可以把常用的部署、排障、代码规范保存为技能，总控和执行者会按触发词自动加载。</Empty>
        : <div className="list">
          {skills.d.items.map(sk => <article key={sk.id} className="card" style={{ marginBottom: 10, opacity: sk.enabled ? 1 : 0.65 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
              <div>
                <span className="pill" style={{ marginRight: 6 }}>{SKILL_SCOPE_LABEL[sk.scope]}</span>
                <span className="pill" style={{ marginRight: 6 }}>{sk.enabled ? '启用' : '停用'}</span>
                <span className="pill" style={{ marginRight: 6 }}>v{sk.activeVersion ?? 1}</span>
                <b>{sk.name}</b> <code className="meta">{sk.slug}</code>
              </div>
              <div className="actions">
                <button onClick={() => setViewSkill(sk)}>查看全文</button>
                {sk.previousVersion ? <button disabled={busy} onClick={() => rollbackSkill(sk)}>回退 v{sk.previousVersion}</button> : null}
                <button disabled={busy} onClick={() => toggleSkill(sk)}>{sk.enabled ? '停用' : '启用'}</button>
                <button disabled={busy} onClick={() => setEditSkill(sk)}>编辑</button>
                <button className="danger" disabled={busy} onClick={() => removeSkill(sk)}>删除</button>
              </div>
            </div>
            {sk.description && <p style={{ margin: '6px 0' }}>{sk.description}</p>}
            <p className="meta" style={{ margin: 0 }}>
              触发词：{sk.triggers.length ? sk.triggers.join('、') : '未设置'}
              {sk.preferredRunnerId ? ` · 优先执行器：${sk.preferredRunnerId}` : ''}
              {' · '}使用 {sk.useCount} 次 · 更新于 {ago(sk.updatedAt)}
            </p>
          </article>)}
        </div>}
    </>}

    {tab === 'evolution' && <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div>
            <b>核心典型任务评测基准</b>
            <p className="meta" style={{ margin: '4px 0 0' }}>持续对比首次验收通过率、人工介入次数、每通过任务成本与验收后返工率</p>
          </div>
          <button className="primary" disabled={busy} onClick={runCoreBenchmarks}>{busy ? '评测中…' : '立即跑一轮基准'}</button>
        </div>
        {benches.d?.cases?.length ? <ul className="meta" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {benches.d.cases.map(c => <li key={c.id}><b>{c.title}</b>（{c.id}）</li>)}
        </ul> : null}
      </div>

      {!benches.d?.runs?.length
        ? <Empty>还没有评测记录。点击「立即跑一轮基准」建立当前基线，每次技能或策略更新后可横向对比。</Empty>
        : <div className="list" style={{ marginBottom: 18 }}>
          {benches.d.runs.map(r => <article key={r.id} className="card" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <b>{r.label} <span className="meta">({r.suiteName})</span></b>
              <span className="meta">{ago(r.createdAt)}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <span className="pill">通过：{r.metrics.passedTasks}/{r.metrics.totalTasks}</span>
              <span className="pill">首过率：{Math.round(r.metrics.firstPassAcceptanceRate * 100)}%</span>
              <span className="pill">人工介入：{r.metrics.humanInterventions} 次</span>
              <span className="pill">单通过成本：{r.metrics.costPerPassingTaskUsd !== null ? `$${r.metrics.costPerPassingTaskUsd.toFixed(4)}` : '—'}</span>
              <span className="pill">验收后返工：{Math.round(r.metrics.postAcceptanceReworkRate * 100)}%</span>
            </div>
          </article>)}
        </div>}

      <h2 style={{ marginTop: 14 }}>插件自动演进提案</h2>
      {!proposals.d?.items?.length
        ? <Empty>暂无待处理的插件演进提案。当现有技能反复无法完成某类需求时，系统会自动登记缺口并在此发起研发与审批提案。</Empty>
        : <div className="list">
          {proposals.d.items.map(p => <article key={p.id} className="card" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <span className="pill" style={{ marginRight: 6 }}>{p.status === 'pending_approval' ? '待主人审批' : p.status === 'dispatched' ? '已派发研发' : p.status === 'rejected' ? '已拒绝' : p.status}</span>
                {p.requiresUserApproval && <span className="pill" style={{ marginRight: 6 }}>高风险审批门禁</span>}
                <b>{p.pluginName}</b> <code className="meta">{p.gapKey}</code>
              </div>
              {p.status === 'pending_approval' && <div className="actions">
                <button className="primary" disabled={busy} onClick={() => approveProposal(p)}>批准并启动研发</button>
                <button className="danger" disabled={busy} onClick={() => rejectProposal(p)}>拒绝</button>
              </div>}
            </div>
            <p style={{ margin: '6px 0' }}>{p.summary}</p>
            <p className="meta" style={{ margin: 0 }}>
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
      <div className="list" style={{ marginBottom: 16 }}>
        {(runners.d?.runners || []).map(rn => <article key={rn.id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div><b>{rn.name}</b> <code className="meta">{rn.id}</code></div>
            <div className="actions">
              <span className="pill">{rn.kind}</span>
              {rn.zeroToken && <span className="pill">0 Token</span>}
            </div>
          </div>
          {rn.description && <p className="meta" style={{ margin: '6px 0 0' }}>{rn.description}</p>}
        </article>)}
      </div>
      <h2>已登记的 0 Token 确定性脚本</h2>
      {!runners.d?.scripts?.length
        ? <Empty>暂无已登记的确定性脚本。</Empty>
        : <div className="list">
          {runners.d.scripts.map(sc => <article key={sc.id} className="card" style={{ marginBottom: 8 }}>
            <b><code className="mono">{sc.id}</code></b>
            <p className="meta" style={{ margin: '4px 0 0' }}>{sc.description}</p>
          </article>)}
        </div>}
    </>}

    {tab === 'plugins' && <>
      <div className="list">
        {(plugins.d?.items || []).map(pl => <article key={pl.id} className="card" style={{ marginBottom: 10, opacity: pl.enabled ? 1 : 0.65 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div><b>{pl.name}</b> <code className="meta">{pl.id} v{pl.version}</code></div>
            <div className="actions">
              <span className="pill">{pl.enabled ? '已启用' : '已停用'}</span>
              {pl.routesPrefix && <button disabled={busy} onClick={() => togglePlugin(pl)}>{pl.enabled ? '停用插件' : '启用插件'}</button>}
            </div>
          </div>
          <p style={{ margin: '6px 0' }}>{pl.description}</p>
          <p className="meta" style={{ margin: 0 }}>
            {pl.routesPrefix ? `路由：/api${pl.routesPrefix} · ` : ''}
            Director 动作：{pl.directorActions.length > 0 ? pl.directorActions.join(', ') : '内置'}
            {pl.workerTools.length > 0 ? ` · Worker 工具：已挂载 MCP` : ''}
          </p>
        </article>)}
      </div>
    </>}

    {editMem && <MemoryEditor initial={editMem} onClose={() => setEditMem(null)} onSaved={() => { setEditMem(null); mems.reload() }} />}
    {editSkill && <SkillEditor initial={editSkill} onClose={() => setEditSkill(null)} onSaved={() => { setEditSkill(null); skills.reload() }} />}
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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
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
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 14px' }}>
      <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
      <span>置顶（始终优先注入给总控和执行者）</span>
    </label>
    <div className="actions">
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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
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
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 14px' }}>
      <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
      <span>启用该技能</span>
    </label>
    <div className="actions">
      <button onClick={onClose}>取消</button>
      <button className="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
    </div>
  </Sheet>
}
