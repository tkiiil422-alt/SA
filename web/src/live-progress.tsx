/**
 * 实时任务执行与进度面板（PC 右侧 38% 常驻分屏 / 手机端顶部可展开抽屉）：
 * - 单行等宽数字态势汇总（工位 / 待拍板 / 今日花费）
 * - 待你拍板（行内直接回复 / 一键批准继续）
 * - 实时执行中工位（真实命令步骤、平滑细进度线、计时、花费、一键「让总控介入」）
 * - 活跃 DAG 任务计划（保留全部开工/暂停/恢复/取消/节点批准/局部重试能力）
 * - 最近交付清单
 */
import { useState } from 'react'
import { post } from './api'
import { ago, money } from './hooks'
import { useLive, useTick, clock, secondsSince, type RunningStep } from './useLive'
import { Icon } from './icons'
import { useAction } from './ui'
import type { LiveNovelEdit, MissionNodeRecord, MissionRecord } from '../../src/shared/api-types.ts'

const STATUS_WORD: Record<string, string> = {
  completed: '已完成',
  stopped: '已停止',
  failed: '失败',
  abandoned: '已放弃',
}
const TOOL_WORD: Record<string, string> = {
  bash: '命令',
  read: '读文件',
  write: '写文件',
  edit: '改文件',
  subagent: '子代理',
  say: '回复',
  think: '思考',
  turn: '节点',
  goal: '目标',
  web_search: '搜索',
  web_fetch: '读网页',
}
const MISSION_STATUS: Record<MissionRecord['status'], string> = {
  draft: '草稿',
  running: '执行中',
  paused: '已暂停',
  completed: '已交付',
  failed: '受阻',
  cancelled: '已取消',
}
const NODE_STATUS: Record<MissionNodeRecord['status'], string> = {
  pending: '待依赖',
  dispatching: '派单中',
  running: '执行中',
  waiting_approval: '待审批',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
}

function InlineTicketDecision({
  ticket,
  onIntervene,
}: {
  ticket: { id: string; title: string; question?: string; stageLabel?: string }
  onIntervene?: (prompt: string) => void
}) {
  const [reply, setReply] = useState('')
  const { busy, run } = useAction()
  const submit = (text: string) => {
    const clean = text.trim()
    if (!clean) return
    void run(() => post(`api/tickets/${encodeURIComponent(ticket.id)}/reply`, { text: clean }), '已回复工单', () => setReply(''))
  }
  return <div className="lp__needcard">
    <div className="lp__needtop">
      <a className="lp__needtitle" href={`#/tickets/${encodeURIComponent(ticket.id)}`}>{ticket.title}</a>
      {onIntervene && (
        <button
          type="button"
          className="lp__linkbtn"
          onClick={() => onIntervene(`工单 ${ticket.id}「${ticket.title}」正在等待拍板（${ticket.question || ticket.stageLabel || '需要人工决策'}），请帮我分析利弊并给出建议方案。`)}
        >
          问总控
        </button>
      )}
    </div>
    <p className="lp__needq">{ticket.question || ticket.stageLabel || '任务已暂停，等待你的回复或批准'}</p>
    <div className="lp__needform">
      <input
        value={reply}
        onChange={e => setReply(e.target.value)}
        placeholder="输入回复内容…"
        onKeyDown={e => { if (e.key === 'Enter' && reply.trim()) submit(reply) }}
      />
      {reply.trim()
        ? <button type="button" className="primary small" disabled={busy} onClick={() => submit(reply)}>回复</button>
        : <button type="button" className="primary small" disabled={busy} onClick={() => submit('批准继续执行')}>批准</button>}
    </div>
  </div>
}

export interface LiveProgressPanelProps {
  missions: MissionRecord[]
  onReloadMissions: () => void
  onMissionOp: (m: MissionRecord, op: 'start' | 'pause' | 'resume' | 'cancel') => void
  onApproveMissionNode: (m: MissionRecord, n: MissionNodeRecord) => void
  onRetryMissionNode: (m: MissionRecord, n: MissionNodeRecord) => void
  onIntervene?: (prompt: string) => void
  busy?: boolean
  compact?: boolean
}

export function LiveProgressPanel({
  missions,
  onReloadMissions,
  onMissionOp,
  onApproveMissionNode,
  onRetryMissionNode,
  onIntervene,
  busy = false,
  compact = false,
}: LiveProgressPanelProps) {
  const { board: b, skew, live } = useLive()
  useTick()

  const steps = new Map<string, RunningStep>((b?.runningSteps ?? []).map(s => [s.id, s]))
  const open = b?.open ?? []
  const need = open.filter(t => t.needsPerson)
  const running = open.filter(t => !t.needsPerson && steps.has(t.id))
  const queued = open.filter(t => !t.needsPerson && !steps.has(t.id))
  const novelEdits: LiveNovelEdit[] = b?.novelEdits ?? []
  const runningEdits = novelEdits.filter(e => e.status === 'running')
  const recentEdits = novelEdits.filter(e => e.status !== 'running').slice(0, 4)
  const ended = b?.ended ?? []
  const slotsMax = b?.slots.max ?? 0
  const todayUsd = b?.usage.todayUsd ?? 0
  const dailyBudget = b?.usage.dailyBudgetUsd ?? 0
  const activeMissions = missions.filter(m => m.status === 'running' || m.status === 'draft' || m.status === 'paused')
  const shownMissions = activeMissions.length > 0 ? activeMissions : missions.slice(0, 3)

  return <div className={compact ? 'lp is-compact' : 'lp'}>
    <div className="lp__head">
      <div className="lp__headtop">
        <div className="lp__titlerow">
          <h2>任务执行与实时进度</h2>
          <span className="lp__livedot" data-on={live} title={live ? '实时连接' : '轮询同步'} />
        </div>
        <div className="lp__headacts">
          <a className="ghost small lp__iconlink" href="#/new" title="直接派发新任务">
            <Icon name="new" size={13} /><span>发任务</span>
          </a>
          <a className="ghost small lp__iconlink" href="#/tickets" title="全部任务列表">
            <span>全部</span>
          </a>
        </div>
      </div>
      <div className="lp__summary mono">
        <span>运行 <b>{running.length}/{slotsMax}</b></span>
        <span aria-hidden="true">·</span>
        <span className={need.length > 0 ? 'is-warn' : ''}>待拍板 <b>{need.length}</b></span>
        <span aria-hidden="true">·</span>
        <span>今日 <b>${todayUsd.toFixed(2)}</b>{dailyBudget > 0 ? ` / $${dailyBudget.toFixed(0)}` : ''}</span>
      </div>
    </div>

    <div className="lp__body">
      {b?.paused && (
        <a className="lp__banner is-warn" href="#/system">
          <span>当前已暂停接单，新任务暂不会被受理</span>
          <Icon name="chev" size={14} />
        </a>
      )}

      {/* 1. 待你拍板 */}
      {need.length > 0 && (
        <section className="lp__card" aria-label="待你拍板">
          <div className="lp__cardhead">
            <span className="lp__seclabel"><i className="lp__dot is-warn" />待你拍板 ({need.length})</span>
            <a className="lp__more" href="#/tickets">查看全部</a>
          </div>
          <div className="lp__stack">
            {need.map(t => <InlineTicketDecision key={t.id} ticket={t} onIntervene={onIntervene} />)}
          </div>
        </section>
      )}

      {/* 2. 实时执行中 */}
      <section className="lp__card" aria-label="实时执行中">
        <div className="lp__cardhead">
          <span className="lp__seclabel">
            <i className={running.length > 0 ? 'lp__dot is-run' : 'lp__dot'} />
            实时执行中 ({running.length}/{slotsMax})
          </span>
          {queued.length > 0 && <span className="meta">排队 {queued.length}</span>}
        </div>
        {running.length === 0 ? (
          <div className="lp__idle">
            <p>当前 {slotsMax || 3} 个工位全部待命</p>
            <span className="meta">在左侧向总控交代目标，或直接 <a href="#/new">派发新工单</a></span>
          </div>
        ) : (
          <div className="lp__lanes">
            {running.map((t, idx) => {
              const step = steps.get(t.id)
              const starting = !step || step.kind === 'none'
              const idleSec = secondsSince(step?.at, skew)
              const stalled = !starting && step.tool !== 'subagent' && idleSec > 300
              const toolLabel = starting ? '启动中' : (TOOL_WORD[step.tool || step.kind] || step.tool || step.kind)
              const stepText = starting ? '正在初始化执行环境…' : (step.summary || '执行中…')
              const goalPct = t.goal && t.goal.roundCap > 0 ? Math.min(100, Math.max(12, Math.round((t.goal.rounds / t.goal.roundCap) * 100))) : null
              return <div key={t.id} className={stalled ? 'lp__lane is-stall' : 'lp__lane'}>
                <div className="lp__lanetop">
                  <a className="lp__lanetitle" href={`#/tickets/${encodeURIComponent(t.id)}`}>
                    <span className="lp__slotno mono">{idx + 1}</span>
                    <b>{t.title}</b>
                  </a>
                  <span className="lp__lanetime mono">
                    {clock(step?.since || t.updatedAt, skew)}
                    {t.costUsd > 0 ? ` · ${money(t.costUsd)}` : ''}
                  </span>
                </div>
                <div className="lp__lanestep">
                  <span className="lp__tool">{toolLabel}</span>
                  <span className="lp__cmd mono">{stepText}</span>
                </div>
                <div className="lp__track" aria-hidden="true">
                  <span
                    className={goalPct === null ? 'lp__bar is-live' : 'lp__bar'}
                    style={goalPct !== null ? { width: `${goalPct}%` } : undefined}
                  />
                </div>
                <div className="lp__lanefoot">
                  <span className="meta">
                    {stalled ? `${Math.floor(idleSec / 60)} 分钟无新步骤` : (t.stageLabel || '正常推进')}
                    {t.goal ? ` · 第 ${t.goal.rounds}/${t.goal.roundCap} 轮` : ''}
                  </span>
                  {onIntervene && (
                    <button
                      type="button"
                      className="lp__linkbtn"
                      onClick={() => onIntervene(`请帮我查看并跟进正在执行的工单 ${t.id}「${t.title}」（当前步骤：${stepText}），如有阻塞请直接给出处理建议。`)}
                    >
                      让总控介入
                    </button>
                  )}
                </div>
              </div>
            })}
          </div>
        )}
        {queued.length > 0 && (
          <div className="lp__queued">
            <span className="meta">排队等待：</span>
            {queued.slice(0, 3).map((t, i) => (
              <a key={t.id} href={`#/tickets/${encodeURIComponent(t.id)}`}>{i > 0 ? '、' : ''}{t.title}</a>
            ))}
          </div>
        )}
      </section>

      {/* 2.5 小说章节改稿进度 */}
      {novelEdits.length > 0 && (
        <section className="lp__card" aria-label="小说改稿进度">
          <div className="lp__cardhead">
            <span className="lp__seclabel">
              <i className={runningEdits.length > 0 ? 'lp__dot is-run' : 'lp__dot'} />
              小说改稿进度 {runningEdits.length > 0 ? `(${runningEdits.length} 进行中)` : `(${recentEdits.length})`}
            </span>
            <a className="lp__more" href="#/novels">书库</a>
          </div>
          {runningEdits.length > 0 && (
            <div className="lp__lanes">
              {runningEdits.map(ed => {
                const pct = Math.max(8, Math.min(100, ed.progressPct ?? 25))
                return (
                  <div key={ed.id} className="lp__lane">
                    <div className="lp__lanetop">
                      <a className="lp__lanetitle" href={`#/novels/${encodeURIComponent(ed.bookId)}/${ed.n}`}>
                        <b>《{ed.bookTitle}》第 {ed.n} 章{ed.chapterTitle ? ` · ${ed.chapterTitle}` : ''}</b>
                      </a>
                      <span className="lp__lanetime mono">
                        {clock(ed.createdAt, skew)} · {pct}%
                      </span>
                    </div>
                    <div className="lp__lanestep">
                      <span className="lp__tool">改稿</span>
                      <span className="lp__cmd">{ed.stageLabel || '正在按意见修改章节…'}</span>
                    </div>
                    <div className="lp__track" aria-hidden="true">
                      <span className="lp__bar" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="lp__lanefoot">
                      <span className="meta">
                        意见：{ed.note.slice(0, 48)}{ed.note.length > 48 ? '…' : ''}
                        {ed.attempt && ed.maxAttempts ? ` · 第 ${ed.attempt}/${ed.maxAttempts} 轮` : ''}
                      </span>
                      {ed.model && <span className="meta mono">{ed.model}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {recentEdits.length > 0 && (
            <ul className="lp__ended" style={runningEdits.length > 0 ? { marginTop: 8 } : undefined}>
              {recentEdits.map(ed => (
                <li key={ed.id}>
                  <a href={`#/novels/${encodeURIComponent(ed.bookId)}/${ed.n}`}>
                    <span className="lp__endedtitle">
                      《{ed.bookTitle}》第 {ed.n} 章 · {ed.note.slice(0, 26)}
                    </span>
                    <span className="lp__endedmeta">
                      <span data-tone={ed.status === 'failed' ? 'bad' : 'done'}>
                        {ed.status === 'done' ? '改稿完成' : ed.status === 'failed' ? '未通过' : '已撤销'}
                      </span>
                      <span>·</span>
                      <span>{ago(ed.updatedAt)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 3. DAG 任务计划（有计划时展示） */}
      {shownMissions.length > 0 && (
        <section className="lp__card" aria-label="DAG 任务计划">
          <div className="lp__cardhead">
            <span className="lp__seclabel">DAG 任务计划 ({missions.length})</span>
            <button type="button" className="lp__linkbtn" onClick={onReloadMissions}>刷新</button>
          </div>
          <div className="lp__missions">
            {shownMissions.map(m => {
              const done = m.nodes.filter(n => n.status === 'completed' || n.status === 'skipped').length
              const pct = m.nodes.length > 0 ? Math.round((done / m.nodes.length) * 100) : 0
              return <div key={m.id} className="lp__mcard">
                <div className="lp__mhead">
                  <b>{m.title}</b>
                  <span className="meta mono">v{m.planVersion} · {MISSION_STATUS[m.status]}</span>
                </div>
                <div className="lp__mprog">
                  <div className="lp__track"><span className="lp__bar" style={{ width: `${pct}%` }} /></div>
                  <span className="meta mono">{done}/{m.nodes.length}</span>
                </div>
                <div className="lp__mops">
                  {m.status === 'draft' && <button type="button" className="primary small" disabled={busy} onClick={() => onMissionOp(m, 'start')}>开工</button>}
                  {m.status === 'running' && <button type="button" className="ghost small" disabled={busy} onClick={() => onMissionOp(m, 'pause')}>暂停</button>}
                  {(m.status === 'paused' || m.status === 'failed') && <button type="button" className="primary small" disabled={busy} onClick={() => onMissionOp(m, 'resume')}>恢复</button>}
                  {(m.status === 'draft' || m.status === 'running' || m.status === 'paused') && <button type="button" className="ghost small danger" disabled={busy} onClick={() => onMissionOp(m, 'cancel')}>取消</button>}
                </div>
                <div className="lp__nodes">
                  {m.nodes.map(n => <div key={n.id} className={n.status === 'waiting_approval' ? 'lp__node is-wait' : 'lp__node'}>
                    <div className="lp__nodehead">
                      <span><code className="mono">{n.key}</code> {n.title}</span>
                      <span className="meta">{NODE_STATUS[n.status]}</span>
                    </div>
                    {n.ticketId && <a className="lp__nodelink" href={`#/tickets/${encodeURIComponent(n.ticketId)}`}>工单 {n.ticketId.slice(0, 10)} →</a>}
                    {n.status === 'waiting_approval' && (
                      <button type="button" className="primary small wide lp__nodebtn" disabled={busy} onClick={() => onApproveMissionNode(m, n)}>
                        批准继续 (v{m.planVersion})
                      </button>
                    )}
                    {n.status === 'failed' && (
                      <button type="button" className="ghost small lp__nodebtn" disabled={busy} onClick={() => onRetryMissionNode(m, n)}>
                        局部重试
                      </button>
                    )}
                  </div>)}
                </div>
              </div>
            })}
          </div>
        </section>
      )}

      {/* 4. 最近交付 */}
      <section className="lp__card" aria-label="最近交付">
        <div className="lp__cardhead">
          <span className="lp__seclabel">最近交付</span>
          <a className="lp__more" href="#/tickets">全部记录</a>
        </div>
        {ended.length === 0 ? (
          <p className="lp__empty">今日暂无已结束任务</p>
        ) : (
          <ul className="lp__ended">
            {ended.slice(0, 6).map(t => (
              <li key={t.id}>
                <a href={`#/tickets/${encodeURIComponent(t.id)}`}>
                  <span className="lp__endedtitle">{t.title}</span>
                  <span className="lp__endedmeta">
                    <span data-tone={t.outcome === 'failed' ? 'bad' : 'done'}>{STATUS_WORD[t.outcome ?? ''] || '已结束'}</span>
                    <span>·</span>
                    <span>{ago(t.updatedAt)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 5. 低频快捷跳转（记忆/共享环境/花费） */}
      <div className="lp__footlinks">
        <a href="#/memory">主人记忆与进化</a>
        <span aria-hidden="true">·</span>
        <a href="#/devenv">共享缓存环境</a>
        <span aria-hidden="true">·</span>
        <a href="#/usage">花费统计</a>
        <span aria-hidden="true">·</span>
        <a href="#/settings">系统配置</a>
      </div>
    </div>
  </div>
}
