/**
 * 主动定时与条件巡检调度页面（#/schedules）。
 */
import { useEffect, useState } from 'react'
import { del, get, post, put } from './api'
import { ago, usePoll } from './hooks'
import { Empty, Sheet, confirmAction, toast, useAction } from './ui'
import type {
  ScheduleActionKind,
  ScheduleListResponse,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleTriggerKind,
} from '../../src/shared/api-types.ts'

const ACTION_LABEL: Record<ScheduleActionKind, string> = {
  director_prompt: '唤醒总控巡检',
  dispatch_ticket: '自动派发工单',
  http_watch: 'HTTP 轻量监控',
}

const STATUS_LABEL: Record<ScheduleRecord['lastStatus'], string> = {
  never: '尚未运行',
  running: '运行中',
  ok: '正常',
  skipped: '已跳过',
  changed: '触发变更/告警',
  error: '失败',
}

const DISPATCH_LABEL: Record<ScheduleRunRecord['dispatchStatus'], string> = {
  pending: '待派发',
  dispatched: '已派发',
  skipped: '已跳过',
  failed: '派发失败',
}
const EXEC_LABEL: Record<ScheduleRunRecord['executionStatus'], string> = {
  pending: '待执行',
  running: '执行中',
  succeeded: '已执行(成功)',
  failed: '执行失败',
  skipped: '已跳过',
}
const ACCEPT_LABEL: Record<ScheduleRunRecord['acceptanceStatus'], string> = {
  not_required: '无需验收',
  pending: '待验收',
  passed: '已验收通过',
  failed: '验收未通过',
}

function fmtLocal(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function SchedulerPage() {
  const list = usePoll<ScheduleListResponse>('api/schedules', 10000)
  const [editing, setEditing] = useState<Partial<ScheduleRecord> | null>(null)
  const [runsOf, setRunsOf] = useState<{ schedule: ScheduleRecord; runs: ScheduleRunRecord[] } | null>(null)
  const { busy, run } = useAction()

  const toggle = (s: ScheduleRecord) =>
    run(() => put(`api/schedules/${encodeURIComponent(s.id)}`, { enabled: !s.enabled }), s.enabled ? '已暂停计划' : '已启用计划', list.reload)

  const runNow = (s: ScheduleRecord) =>
    run(async () => {
      const res = await post(`api/schedules/${encodeURIComponent(s.id)}/run`, {})
      toast(`执行完成（${STATUS_LABEL[(res.run?.status || 'ok') as ScheduleRecord['lastStatus']] || res.run?.status}）：${res.run?.summary || ''}`)
      list.reload()
    })

  const openRuns = (s: ScheduleRecord) =>
    run(async () => {
      const res = await get<{ items: ScheduleRunRecord[] }>(`api/schedules/${encodeURIComponent(s.id)}/runs?limit=30`)
      setRunsOf({ schedule: s, runs: res.items || [] })
    })

  const remove = async (s: ScheduleRecord) => {
    if (!(await confirmAction(`确定删除定时任务「${s.name}」及其全部运行历史吗？`, { title: '删除定时任务', danger: true, okLabel: '删除' }))) return
    run(() => del(`api/schedules/${encodeURIComponent(s.id)}`), '已删除', list.reload)
  }

  return <div className="page">
    <header className="phead">
      <div>
        <h1>定时与巡检</h1>
        <p className="phead__sub">Cron 定时派单、总控主动巡检、零空耗 Token HTTP 变更监控</p>
      </div>
      <div className="actions">
        <button className="primary" onClick={() => setEditing({
          name: '',
          description: '',
          enabled: true,
          triggerKind: 'cron',
          cronExpr: '30 8 * * *',
          intervalSec: 300,
          runAt: '',
          actionKind: 'director_prompt',
          actionConfig: { prompt: '', channel: 'web' },
          respectPause: true,
        })}>新建计划</button>
      </div>
    </header>

    {!list.d?.items?.length
      ? <Empty>还没有配置任何主动定时或巡检任务。点击右上角「新建计划」，或在微信/飞书直接告诉总控助手“每天早 8 点半帮我巡检服务器”。</Empty>
      : <div className="list">
        {list.d.items.map(s => <article key={s.id} className="card" style={{ marginBottom: 10, opacity: s.enabled ? 1 : 0.65 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <span className="pill" style={{ marginRight: 6 }}>{ACTION_LABEL[s.actionKind]}</span>
              <span className="pill" style={{ marginRight: 6 }}>{s.enabled ? '已启用' : '已停用'}</span>
              <span className="pill" style={{ marginRight: 6 }}>{STATUS_LABEL[s.lastStatus]}</span>
              <b>{s.name}</b>
            </div>
            <div className="actions">
              <button disabled={busy} onClick={() => runNow(s)}>立即运行</button>
              <button disabled={busy} onClick={() => openRuns(s)}>运行记录</button>
              <button disabled={busy} onClick={() => toggle(s)}>{s.enabled ? '暂停' : '启用'}</button>
              <button disabled={busy} onClick={() => setEditing(s)}>编辑</button>
              <button className="danger" disabled={busy} onClick={() => remove(s)}>删除</button>
            </div>
          </div>
          {s.description && <p style={{ margin: '6px 0' }}>{s.description}</p>}
          <p className="meta" style={{ margin: '6px 0 0' }}>
            触发：{s.triggerKind === 'cron' ? `Cron (${s.cronExpr})` : s.triggerKind === 'interval' ? `每 ${s.intervalSec} 秒` : `单次 (${fmtLocal(s.runAt)})`}
            {' · '}下次执行：{fmtLocal(s.nextRunAt)}
            {' · '}累计运行 {s.runCount} 次（失败 {s.failCount} 次）
          </p>
          {s.lastSummary && <p className="meta" style={{ margin: '4px 0 0' }}>最近结果（{s.lastRunAt ? ago(s.lastRunAt) : ''}）：{s.lastSummary}</p>}
        </article>)}
      </div>}

    {editing && <ScheduleEditor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />}
    {runsOf && <Sheet title={`运行历史 · ${runsOf.schedule.name}`} onClose={() => setRunsOf(null)}>
      {runsOf.runs.length === 0
        ? <Empty>还没有运行记录。</Empty>
        : <div className="list">
          {runsOf.runs.map(r => <div key={r.id} className="card" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <div>
                <b>{STATUS_LABEL[r.status]}</b>
                {r.contractVersion ? <span className="pill" style={{ marginLeft: 6 }}>约定 v{r.contractVersion}</span> : null}
              </div>
              <span className="meta">{fmtLocal(r.startedAt)}{r.durationMs !== null ? ` · ${r.durationMs}ms` : ''}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              <span className="pill">派发：{DISPATCH_LABEL[r.dispatchStatus] || r.dispatchStatus}</span>
              <span className="pill">执行：{EXEC_LABEL[r.executionStatus] || r.executionStatus}</span>
              <span className="pill">验收：{ACCEPT_LABEL[r.acceptanceStatus] || r.acceptanceStatus}</span>
            </div>
            {r.summary && <p style={{ margin: '6px 0 0' }}>{r.summary}</p>}
            {r.error && <p className="formerr" style={{ margin: '4px 0 0' }}>{r.error}</p>}
            {r.ticketId && <p style={{ margin: '4px 0 0' }}><a href={`#/tickets/${encodeURIComponent(r.ticketId)}`}>查看关联工单 {r.ticketId} →</a></p>}
          </div>)}
        </div>}
    </Sheet>}
  </div>
}

function ScheduleEditor({ initial, onClose, onSaved }: { initial: Partial<ScheduleRecord>; onClose: () => void; onSaved: () => void }) {
  const cfg = (initial.actionConfig || {}) as Record<string, any>
  const [name, setName] = useState(initial.name || '')
  const [description, setDescription] = useState(initial.description || '')
  const [enabled, setEnabled] = useState(initial.enabled !== false)
  const [triggerKind, setTriggerKind] = useState<ScheduleTriggerKind>(initial.triggerKind || 'cron')
  const [cronExpr, setCronExpr] = useState(initial.cronExpr || '30 8 * * *')
  const [intervalSec, setIntervalSec] = useState(String(initial.intervalSec || 300))
  const [runAt, setRunAt] = useState(initial.runAt || '')
  const [actionKind, setActionKind] = useState<ScheduleActionKind>(initial.actionKind || 'director_prompt')
  const [prompt, setPrompt] = useState(String(cfg.prompt || ''))
  const [channel, setChannel] = useState(String(cfg.channel || 'web'))
  const [projectId, setProjectId] = useState(String(cfg.projectId || ''))
  const [url, setUrl] = useState(String(cfg.url || ''))
  const [expectStatus, setExpectStatus] = useState(String(cfg.expectStatus ?? 200))
  const [mustContain, setMustContain] = useState(String(cfg.mustContain || ''))
  const [onChangePrompt, setOnChangePrompt] = useState(String(cfg.onChangePrompt || ''))
  const [respectPause, setRespectPause] = useState(initial.respectPause !== false)
  const [preview, setPreview] = useState<{ times?: string[]; err?: string }>({})
  const { busy, run } = useAction()

  useEffect(() => {
    if (triggerKind !== 'cron' || !cronExpr.trim()) { setPreview({}); return }
    const t = window.setTimeout(() => {
      post('api/schedules/preview-cron', { expr: cronExpr.trim(), count: 5 })
        .then(r => setPreview({ times: r.times || [] }))
        .catch(e => setPreview({ err: e.message || 'Cron 格式有误' }))
    }, 280)
    return () => window.clearTimeout(t)
  }, [triggerKind, cronExpr])

  const save = () => {
    if (!name.trim()) { toast('请填写计划名称', true); return }
    let actionConfig: Record<string, unknown> = {}
    if (actionKind === 'director_prompt') {
      if (!prompt.trim()) { toast('请填写巡检指令', true); return }
      actionConfig = { prompt: prompt.trim(), channel, deliverToWechat: true }
    } else if (actionKind === 'dispatch_ticket') {
      if (!prompt.trim()) { toast('请填写派单任务说明', true); return }
      actionConfig = { prompt: prompt.trim(), ...(projectId.trim() ? { projectId: projectId.trim() } : {}) }
    } else {
      if (!url.trim()) { toast('请填写要监控的 URL', true); return }
      actionConfig = {
        url: url.trim(),
        expectStatus: Number(expectStatus) || 200,
        detectChange: true,
        ...(mustContain.trim() ? { mustContain: mustContain.trim() } : {}),
        ...(onChangePrompt.trim() ? { onChangePrompt: onChangePrompt.trim() } : {}),
      }
    }

    const body = {
      name: name.trim(),
      description: description.trim(),
      enabled,
      triggerKind,
      cronExpr: triggerKind === 'cron' ? cronExpr.trim() : null,
      intervalSec: triggerKind === 'interval' ? Math.max(30, Number(intervalSec) || 300) : null,
      runAt: triggerKind === 'once' ? runAt.trim() : null,
      actionKind,
      actionConfig,
      respectPause,
    }
    run(
      () => initial.id ? put(`api/schedules/${encodeURIComponent(initial.id)}`, body) : post('api/schedules', body),
      initial.id ? '计划已更新' : '计划已创建',
      onSaved,
    )
  }

  return <Sheet title={initial.id ? '编辑定时/巡检计划' : '新建定时/巡检计划'} onClose={onClose}>
    <label className="field"><span>计划名称</span><input value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日 08:30 主机与账单巡检" /></label>
    <label className="field"><span>备注说明（可选）</span><input value={description} onChange={e => setDescription(e.target.value)} placeholder="简述该定时任务的用途" /></label>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <label className="field"><span>触发方式</span>
        <select value={triggerKind} onChange={e => setTriggerKind(e.target.value as ScheduleTriggerKind)}>
          <option value="cron">Cron 表达式</option>
          <option value="interval">固定间隔</option>
          <option value="once">单次定时</option>
        </select>
      </label>
      <label className="field"><span>执行动作</span>
        <select value={actionKind} onChange={e => setActionKind(e.target.value as ScheduleActionKind)}>
          <option value="director_prompt">唤醒总控巡检</option>
          <option value="dispatch_ticket">自动派发工单</option>
          <option value="http_watch">HTTP 零 Token 监控</option>
        </select>
      </label>
    </div>

    {triggerKind === 'cron' && <div className="field">
      <span>5 段 Cron（分 时 日 月 周，支持 @daily / @hourly）</span>
      <input value={cronExpr} onChange={e => setCronExpr(e.target.value)} placeholder="30 8 * * *" />
      {preview.err && <p className="formerr" style={{ margin: '4px 0 0' }}>{preview.err}</p>}
      {preview.times && preview.times.length > 0 && <p className="meta" style={{ margin: '4px 0 0' }}>
        接下来触发：{preview.times.slice(0, 3).map(fmtLocal).join(' ｜ ')}
      </p>}
    </div>}
    {triggerKind === 'interval' && <label className="field"><span>间隔秒数（最小 30 秒）</span><input type="number" min={30} value={intervalSec} onChange={e => setIntervalSec(e.target.value)} /></label>}
    {triggerKind === 'once' && <label className="field"><span>执行时间（ISO，如 2026-11-23T09:00:00+08:00）</span><input value={runAt} onChange={e => setRunAt(e.target.value)} /></label>}

    {actionKind === 'director_prompt' && <>
      <label className="field"><span>总控巡检指令</span><textarea rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="检查主机磁盘、Podman 状态、昨日花费和未处理工单，如有异常立即汇报。" /></label>
      <label className="field"><span>汇报会话频道</span>
        <select value={channel} onChange={e => setChannel(e.target.value)}>
          <option value="web">控制台会话</option>
          <option value="wechat">微信会话（推送）</option>
          <option value="feishu">飞书会话（推送）</option>
        </select>
      </label>
    </>}

    {actionKind === 'dispatch_ticket' && <>
      <label className="field"><span>派单任务说明</span><textarea rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="写清楚要执行者完成的具体工作和交付物…" /></label>
      <label className="field"><span>绑定项目 ID（可选）</span><input value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="p_..." /></label>
    </>}

    {actionKind === 'http_watch' && <>
      <label className="field"><span>监控目标 URL</span><input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/health" /></label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label className="field"><span>期望状态码</span><input type="number" value={expectStatus} onChange={e => setExpectStatus(e.target.value)} /></label>
        <label className="field"><span>必须包含关键词（可选）</span><input value={mustContain} onChange={e => setMustContain(e.target.value)} placeholder="ok" /></label>
      </div>
      <label className="field"><span>发生变更或异常时的自动处理指令（留空则仅推送告警，0 Token 消耗）</span>
        <textarea rows={3} value={onChangePrompt} onChange={e => setOnChangePrompt(e.target.value)} placeholder="可选：例如自动分析变更内容并总结发给我" />
      </label>
    </>}

    <div style={{ display: 'flex', gap: 16, margin: '8px 0 14px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span>启用</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={respectPause} onChange={e => setRespectPause(e.target.checked)} /><span>全局暂停接单时自动跳过</span>
      </label>
    </div>

    <div className="actions">
      <button onClick={onClose}>取消</button>
      <button className="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
    </div>
  </Sheet>
}
