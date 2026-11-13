import { useState } from 'react'
import { put, del } from './api'
import { usePoll, ago, money } from './hooks'
import { useAction, Sheet } from './ui'

/* ---------- 目标：没达成就不停 ---------- */

export interface GoalDraft { text: string; commands: string; mode: string; maxRounds: string; maxUsd: string; maxHours: string }
export const emptyGoal = (): GoalDraft => ({ text: '', commands: '', mode: '', maxRounds: '', maxUsd: '', maxHours: '' })
const isOpen = (goal: any): boolean => !!goal && (goal.status === 'active' || goal.status === 'paused')
const draftOf = (goal: any): GoalDraft => !isOpen(goal) ? emptyGoal() : {
  text: goal.text || '',
  commands: (goal.commands || []).join('\n'),
  mode: goal.mode || '',
  maxRounds: goal.maxRounds ? String(goal.maxRounds) : '',
  maxUsd: goal.maxUsd ? String(goal.maxUsd) : '',
  maxHours: goal.maxHours ? String(goal.maxHours) : '',
}

/** What the API takes; undefined while no goal is written. Limits left empty come from 设置 → 目标. */
export function goalPayload(g: GoalDraft): Record<string, unknown> | undefined {
  const text = g.text.trim()
  if (!text) return undefined
  const commands = g.commands.split('\n').map(line => line.trim()).filter(Boolean)
  const num = (value: string): number | undefined => {
    const n = Number(value)
    return value.trim() !== '' && Number.isFinite(n) ? n : undefined
  }
  const rounds = num(g.maxRounds)
  const usd = num(g.maxUsd)
  const hours = num(g.maxHours)
  return {
    text,
    ...(commands.length ? { commands } : {}),
    ...(g.mode ? { mode: g.mode } : {}),
    ...(rounds !== undefined ? { maxRounds: Math.round(rounds) } : {}),
    ...(usd !== undefined ? { maxUsd: usd } : {}),
    ...(hours !== undefined ? { maxHours: hours } : {}),
  }
}

const MODES: [string, string][] = [
  ['', '自动：写了命令就先跑命令，再让 AI 复核'],
  ['commands+ai', '先跑验收命令，全过后再让 AI 复核'],
  ['commands', '只看验收命令'],
  ['ai', '只让 AI 判定'],
]

export function GoalFields({ g, set }: { g: GoalDraft; set: (patch: Partial<GoalDraft>) => void }) {
  const d = usePoll<any>('api/settings/goal', 600000).d
  return <div className="goalfields">
    <label className="field"><span>目标</span>
      <small className="hint">写清怎样才算达成。执行者说做完了时，宿主会先检查，没达成就让它接着干。</small>
      <textarea rows={3} value={g.text} onChange={e => set({ text: e.target.value })} placeholder="例如：output/ 下的 wordfreq.py 能统计词频，测试全部通过，README 写了用法" /></label>
    <label className="field"><span>验收命令（可选，一行一条）</span>
      <small className="hint">在执行者的工作区 /workspace 里逐条运行，全部退出码为 0 才算通过。</small>
      <textarea className="mono" rows={3} value={g.commands} onChange={e => set({ commands: e.target.value })} placeholder={'cd output && python3 -m unittest -v\nnpm test'} /></label>
    <label className="field"><span>判定方式</span>
      <select value={g.mode} onChange={e => set({ mode: e.target.value })}>{MODES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
    <div className="cols">
      <label className="field"><span>最多几轮</span><input type="number" min={1} max={50} step={1} value={g.maxRounds} placeholder={String(d?.maxRounds ?? 8)} onChange={e => set({ maxRounds: e.target.value })} /></label>
      <label className="field"><span>最多花多少（美元）</span><input type="number" min={0.01} max={100} step={0.5} value={g.maxUsd} placeholder={String(d?.maxUsd ?? 3)} onChange={e => set({ maxUsd: e.target.value })} /></label>
      <label className="field"><span>最长几小时</span><input type="number" min={0.1} max={72} step={0.5} value={g.maxHours} placeholder={String(d?.maxHours ?? 6)} onChange={e => set({ maxHours: e.target.value })} /></label>
    </div>
    <small className="hint">到了任何一个上限，任务会停下问你；回复“继续”就再给同样一批。</small>
  </div>
}

const STATE: Record<string, [string, string]> = {
  active: ['进行中', 'run'],
  met: ['已达成', 'done'],
  paused: ['停下等你', 'human'],
  cancelled: ['已取消', 'stop'],
}

/** The goal on the ticket page: where it stands, the last check and each acceptance command. */
export function GoalCard({ id, goal, ended, onChange }: { id: string; goal: any; ended: boolean; onChange: () => void }) {
  const { busy, run } = useAction()
  const [editing, setEditing] = useState(false)
  if (!goal) return null
  const [word, tone] = STATE[goal.status] ?? [goal.status, 'stop']
  const last = goal.last
  const missing: string[] = last && !last.met ? (last.verdict?.missing || []) : []
  const cancel = () => {
    if (!confirm('取消这个目标？之后任务按普通任务结束，执行者说做完就结束。')) return
    run(() => del(`api/tickets/${encodeURIComponent(id)}/goal`), '已取消目标', onChange)
  }
  return <section className="goalcard" data-tone={tone} aria-label="目标">
    <div className="goalcard__head">
      <b>目标</b>
      <span className="pill" data-tone={goal.checking ? 'human' : tone}>{goal.checking ? '正在检查' : word}</span>
      <span className="goalcard__nums">
        <span>第 {goal.rounds}/{goal.roundCap} 轮</span>
        <span>{money(goal.usdUsed)} / {money(goal.usdCap)}</span>
        {goal.status === 'active' && <span>截止 {new Date(goal.deadline).toLocaleString()}</span>}
      </span>
    </div>
    <p className="goalcard__text">{goal.text}</p>
    {goal.commands?.length > 0 && <ul className="goalcard__cmds">{goal.commands.map((command: string) => {
      const result = last?.commands?.find((item: any) => item.command === command)
      return <li key={command} data-ok={result === undefined ? undefined : String(result.code === 0)} title={result ? `退出码 ${result.code}` : '还没跑过'}>{command}</li>
    })}</ul>}
    {last && <p className="goalcard__last">最近一次{last.kind === 'nudge' ? '推进' : '检查'}（{ago(last.at)}）：{last.summary}</p>}
    {missing.length > 0 && <ul className="goalcard__missing">{missing.slice(0, 5).map((item, i) => <li key={i}>{item}</li>)}</ul>}
    {goal.checks?.length > 1 && <details className="goalcard__history"><summary>检查记录（{goal.checks.length} 次）</summary>
      <ol>{[...goal.checks].reverse().map((c: any, i: number) => <li key={i} data-met={c.met}>
        <time>{new Date(c.at).toLocaleTimeString()}</time> 第 {c.round} 轮 {c.kind === 'nudge' ? '推进' : c.met ? '达成' : '没通过'}：{c.summary}
      </li>)}</ol></details>}
    {isOpen(goal) && !ended && <p className="actions">
      <button disabled={busy} onClick={() => setEditing(true)}>修改目标</button>
      <button className="ghost danger" disabled={busy} onClick={cancel}>取消目标</button>
    </p>}
    {editing && <GoalSheet id={id} goal={goal} onClose={() => { setEditing(false); onChange() }} />}
  </section>
}

/** Sets or changes a ticket's goal while it runs. */
export function GoalSheet({ id, goal, onClose }: { id: string; goal?: any; onClose: () => void }) {
  const [g, setG] = useState<GoalDraft>(() => draftOf(goal))
  const { busy, run } = useAction()
  const body = goalPayload(g)
  const open = isOpen(goal)
  return <Sheet title={open ? '修改目标' : '设定目标'} onClose={onClose}>
    {open && <p className="hint">保存后轮数、花费和时限从现在重新算。</p>}
    <GoalFields g={g} set={patch => setG(x => ({ ...x, ...patch }))} />
    <button className="primary wide" disabled={busy || !body} onClick={() => run(() => put(`api/tickets/${encodeURIComponent(id)}/goal`, body), '已设定目标', onClose)}>保存目标</button>
  </Sheet>
}
