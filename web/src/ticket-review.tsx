/**
 * 工单交付回执、统一任务约定修订与彩色代码 Diff 行级审查面板（V2.0 + V2.1）。
 */
import { useState } from 'react'
import { API, post } from './api'
import { ago, usePoll } from './hooks'
import { Empty, Sheet, bytes, confirmAction, promptAction, toast, useAction } from './ui'
import type {
  AmendmentScope,
  DeliveryReceipt,
  TaskContractRecord,
  TicketDiffResponse,
} from '../../src/shared/api-types.ts'

const RECEIPT_LABEL: Record<DeliveryReceipt['status'], { text: string; tone: string }> = {
  verified: { text: '全部通过验收', tone: 'done' },
  partial: { text: '部分通过', tone: 'human' },
  failed: { text: '验收未通过', tone: 'bad' },
  pending: { text: '待验收', tone: 'run' },
}

const CRIT_LABEL: Record<'passed' | 'failed' | 'pending', { text: string; color: string }> = {
  passed: { text: '已通过', color: 'var(--ok, #16a34a)' },
  failed: { text: '未通过', color: 'var(--bad, #dc2626)' },
  pending: { text: '待验证', color: 'var(--muted, #64748b)' },
}

const EV_KIND: Record<string, string> = {
  command: '验收命令',
  file: '文件检查',
  git: 'Git 核对',
  browser: '浏览器自检',
  data: '数据核对',
  judge: '裁判核验',
}

/** 交付回执总览卡：一眼看到交付物、逐项验收证据、待处理项与是否需要人工决定。 */
export function DeliveryReceiptCard({
  ticketId,
  receipt,
}: {
  ticketId: string
  receipt: DeliveryReceipt
}) {
  const badge = RECEIPT_LABEL[receipt.status] ?? RECEIPT_LABEL.pending
  const base = `api/tickets/${encodeURIComponent(ticketId)}`
  return <section className="card" style={{ marginBottom: 12 }}>
    <div className="headrow" style={{ marginBottom: 8 }}>
      <h2 style={{ margin: 0 }}>
        交付回执
        {receipt.contractVersion ? <small style={{ marginLeft: 8 }}>约定 v{receipt.contractVersion}</small> : null}
      </h2>
      <span className="pill" data-tone={badge.tone}>{badge.text}</span>
    </div>

    {receipt.needsDecision && <div className="ask" style={{ marginBottom: 10 }}>
      <b>需要你做决定</b>
      <p style={{ margin: '4px 0 0' }}>{receipt.decisionPrompt || '该任务需要你确认下一步处理方式。'}</p>
    </div>}

    {receipt.deliverables.length > 0 && <div style={{ marginBottom: 10 }}>
      <div className="meta" style={{ marginBottom: 4 }}><b>交付物（{receipt.deliverables.length} 项）</b></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {receipt.deliverables.map(d => <a
          key={d.path}
          className="pill"
          href={API(`${base}/files?path=${encodeURIComponent(d.path)}&download=1`)}
          title="点击下载交付物"
        >
          📄 {d.path}{typeof d.size === 'number' ? ` (${bytes(d.size)})` : ''}
        </a>)}
      </div>
    </div>}

    {receipt.criteria.length > 0 && <div style={{ marginBottom: 10 }}>
      <div className="meta" style={{ marginBottom: 4 }}><b>逐项验收条件</b></div>
      <ul className="list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {receipt.criteria.map(c => {
          const st = CRIT_LABEL[c.status]
          return <li key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>
                <code className="meta">[{c.id}]</code> {c.text}
                {c.required ? '' : <span className="meta">（可选）</span>}
              </span>
              <b style={{ color: st.color, whiteSpace: 'nowrap' }}>{st.text}</b>
            </div>
            {c.evidences.length > 0 && <div style={{ marginTop: 4, paddingLeft: 12 }}>
              {c.evidences.map(ev => <p key={ev.id} className="meta" style={{ margin: '2px 0' }}>
                [{EV_KIND[ev.kind] || ev.kind} · {ev.passed ? '通过' : '失败'} · 执行 {ev.runId} · 版本 {ev.artifactVersion}] {ev.summary}
              </p>)}
            </div>}
          </li>
        })}
      </ul>
    </div>}

    {receipt.evidences.length > 0 && <details style={{ marginBottom: 8 }}>
      <summary className="meta">全部结构化验证证据（{receipt.evidences.length} 条）</summary>
      <div style={{ marginTop: 6 }}>
        {receipt.evidences.map(ev => <p key={ev.id} className="meta" style={{ margin: '4px 0' }}>
          <b>[{EV_KIND[ev.kind] || ev.kind}]</b> {ev.passed ? '✅' : '❌'} {ev.summary}
          {' '}（run={ev.runId} · ver={ev.artifactVersion} · {ago(ev.at)}）
        </p>)}
      </div>
    </details>}

    {receipt.pendingItems.length > 0 && <div style={{ marginTop: 6 }}>
      <div className="meta" style={{ color: 'var(--bad, #dc2626)' }}><b>仍待处理事项</b></div>
      <ul style={{ margin: '4px 0 0 18px' }}>
        {receipt.pendingItems.map((p, idx) => <li key={idx} className="meta">{p}</li>)}
      </ul>
    </div>}
  </section>
}

/** 统一任务约定卡 + 中途纠正弹窗（区分本次 / 项目以后 / 长期偏好）。 */
export function ContractCard({
  ticketId,
  contract,
  onUpdated,
}: {
  ticketId: string
  contract: TaskContractRecord
  onUpdated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<AmendmentScope>('once')
  const [reason, setReason] = useState('')
  const [goal, setGoal] = useState(contract.goal)
  const [newCrit, setNewCrit] = useState('')
  const { busy, run } = useAction()

  const submitAmend = () => {
    if (!reason.trim()) { toast('请写明纠正或修订原因', true); return }
    const addCriteria = newCrit.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    run(() => post(`api/contracts/ticket/${encodeURIComponent(ticketId)}/amend`, {
      scope,
      reason: reason.trim(),
      ...(goal.trim() && goal.trim() !== contract.goal ? { goal: goal.trim() } : {}),
      ...(addCriteria.length > 0 ? { addCriteria } : {}),
    }), '任务约定已升级并同步', () => {
      setOpen(false)
      setReason('')
      setNewCrit('')
      onUpdated()
    })
  }

  return <section className="card" style={{ marginBottom: 12 }}>
    <div className="headrow">
      <h2 style={{ margin: 0 }}>任务约定 <small>v{contract.version} · {contract.allowedScope}</small></h2>
      <button type="button" className="ghost small" onClick={() => setOpen(true)}>中途纠正要求</button>
    </div>
    <p style={{ margin: '6px 0' }}>{contract.goal}</p>
    {contract.assumptions.length > 0 && <p className="meta" style={{ margin: '4px 0' }}>
      口径与假设：{contract.assumptions.join('；')}
    </p>}
    {contract.amendmentReason && contract.version > 1 && <p className="meta" style={{ margin: '4px 0 0' }}>
      最近修订（{contract.amendmentScope}）：{contract.amendmentReason}
    </p>}

    {open && <Sheet title={`修订任务约定（当前 v${contract.version}）`} onClose={() => setOpen(false)}>
      <label className="field"><span>作用范围</span>
        <select value={scope} onChange={e => setScope(e.target.value as AmendmentScope)}>
          <option value="once">仅这一次这样做（once）</option>
          <option value="project">这个项目以后都这样做（project，写入项目记忆）</option>
          <option value="preference">我的长期偏好（preference，跨项目记住）</option>
        </select>
      </label>
      <label className="field"><span>纠正原因 / 新口径说明</span>
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="例如：按付款日期统计，金额保留两位小数" />
      </label>
      <label className="field"><span>目标（可调整）</span>
        <textarea rows={2} value={goal} onChange={e => setGoal(e.target.value)} />
      </label>
      <label className="field"><span>追加逐项验收条件（每行一条，可选）</span>
        <textarea rows={3} value={newCrit} onChange={e => setNewCrit(e.target.value)} placeholder="每行一条必选验收条件…" />
      </label>
      <button type="button" className="primary" disabled={busy} onClick={submitAmend}>生成新版本并同步</button>
    </Sheet>}
  </section>
}

interface ParsedDiffLine {
  file: string
  newLine: number
  kind: 'header' | 'hunk' | 'add' | 'del' | 'ctx'
  text: string
}

function parseColoredDiff(diff: string): ParsedDiffLine[] {
  const lines = diff.split('\n')
  const out: ParsedDiffLine[] = []
  let curFile = ''
  let newLine = 0
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(raw)
      curFile = m ? m[1]! : ''
      out.push({ file: curFile, newLine: 0, kind: 'header', text: raw })
    } else if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('new file mode') || raw.startsWith('index ')) {
      out.push({ file: curFile, newLine: 0, kind: 'header', text: raw })
    } else if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw)
      newLine = m ? Number(m[1]) : 1
      out.push({ file: curFile, newLine, kind: 'hunk', text: raw })
    } else if (raw.startsWith('+')) {
      out.push({ file: curFile, newLine, kind: 'add', text: raw })
      newLine += 1
    } else if (raw.startsWith('-')) {
      out.push({ file: curFile, newLine: Math.max(1, newLine), kind: 'del', text: raw })
    } else {
      out.push({ file: curFile, newLine: Math.max(1, newLine), kind: 'ctx', text: raw })
      if (newLine > 0) newLine += 1
    }
  }
  return out
}

/** 彩色 Diff 审查 + 行级批注 + 一键返工 + 签核复检 + 合并/建 PR 面板。 */
export function TicketDiffReviewPanel({ ticketId, onChanged }: { ticketId: string; onChanged?: () => void }) {
  const { d, err, reload } = usePoll<TicketDiffResponse>(`api/tickets/${encodeURIComponent(ticketId)}/diff`, 12000)
  const [commentTarget, setCommentTarget] = useState<{ file: string; line: number } | null>(null)
  const [commentText, setCommentText] = useState('')
  const [prSheet, setPrSheet] = useState(false)
  const [prRepo, setPrRepo] = useState('')
  const [prBase, setPrBase] = useState('main')
  const [prTitle, setPrTitle] = useState('')
  const { busy, run } = useAction()
  const base = `api/tickets/${encodeURIComponent(ticketId)}`

  const addComment = () => {
    if (!commentTarget || !commentText.trim()) return
    run(() => post(`${base}/review`, {
      action: 'comment',
      file: commentTarget.file,
      line: commentTarget.line,
      comment: commentText.trim(),
    }), '已添加行级批注', () => {
      setCommentTarget(null)
      setCommentText('')
      reload()
    })
  }

  const approve = () =>
    run(() => post(`${base}/review`, { action: 'approve', note: '控制台审查通过' }), '当前代码版本已签核通过', reload)

  const rework = async () => {
    const note = await promptAction('把未解决的行级批注打包发回工单执行一键返工（可补充总体意见）：', {
      title: '一键返工',
      placeholder: '补充返工说明（可选）…',
      okLabel: '发送返工',
    })
    if (note === null) return
    run(() => post(`${base}/review`, { action: 'rework', note }), '已触发一键返工', () => {
      reload()
      onChanged?.()
    })
  }

  const mergeToMain = async () => {
    if (!(await confirmAction('将当前 worktree 分支的已审查改动合并回项目主分支？（合并前自动拍照，冲突会自动中止保护主分支）', { title: '合并回主分支', okLabel: '确认合并' }))) return
    run(async () => {
      const r = await post(`${base}/merge`, { mode: 'merge' })
      if (r?.ok) toast(`已合并分支 ${r.branch} → ${String(r.mergedCommit || '').slice(0, 8)}`)
    }, undefined, () => { reload(); onChanged?.() })
  }

  const createPr = () => {
    if (!prRepo.trim()) { toast('请填写 GitHub 仓库（owner/repo）', true); return }
    run(async () => {
      const r = await post(`${base}/merge`, {
        mode: 'pr',
        repo: prRepo.trim(),
        base: prBase.trim() || 'main',
        ...(prTitle.trim() ? { title: prTitle.trim() } : {}),
      })
      if (r?.url) toast(`已创建 PR #${r.number}：${r.url}`)
    }, undefined, () => { setPrSheet(false); reload(); onChanged?.() })
  }

  if (err) return <p className="warn">读取代码 Diff 失败：{err}</p>
  if (!d) return <p className="meta">正在加载代码改动…</p>
  if (!d.available) return <Empty>{d.reason || '该任务没有可审查的 Git 代码改动。'}</Empty>

  const parsedLines = d.diff ? parseColoredDiff(d.diff) : []
  const openComments = (d.reviews ?? []).filter(r => r.status === 'open')

  return <div>
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="headrow" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <b>分支 {d.branch || '—'}</b>
          <span className="meta" style={{ marginLeft: 8 }}>
            模式：{d.mode || '—'} · HEAD {d.headSha?.slice(0, 8) || '—'} · 改动 {d.files.length} 个文件
          </span>
        </div>
        <div className="actions">
          <button type="button" disabled={busy} onClick={approve}>签核通过</button>
          <button type="button" disabled={busy} onClick={rework}>一键返工{openComments.length ? ` (${openComments.length})` : ''}</button>
          {d.mode === 'worktree' && <button type="button" className="primary" disabled={busy || !d.canMerge || Boolean(d.needsReverify)} onClick={mergeToMain}>合并回主分支</button>}
          {d.mode === 'worktree' && <button type="button" disabled={busy || Boolean(d.needsReverify)} onClick={() => setPrSheet(true)}>创建 GitHub PR</button>}
        </div>
      </div>

      {d.needsReverify && <p className="warn" style={{ marginTop: 8 }}>
        ⚠️ {d.staleReason || '审查后代码发生变化，请重新检视并点击「签核通过」后再合并。'}
      </p>}

      {d.reviewState && !d.needsReverify && <p className="meta" style={{ marginTop: 6, color: 'var(--ok, #16a34a)' }}>
        ✅ 已签核通过版本 {d.reviewState.reviewedSha.slice(0, 8)}（{ago(d.reviewState.reviewedAt)}）
      </p>}

      {d.files.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {d.files.map(f => <span key={f.path} className="pill">
          <code style={{ marginRight: 4 }}>{f.status}</code>{f.path}
          <span style={{ color: '#16a34a', marginLeft: 6 }}>+{f.additions}</span>
          <span style={{ color: '#dc2626', marginLeft: 4 }}>-{f.deletions}</span>
        </span>)}
      </div>}
    </div>

    {(d.reviews?.length ?? 0) > 0 && <div className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>行级批注（{d.reviews!.length} 条）</h3>
      {d.reviews!.map(r => <div key={r.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line, #e5e7eb)', opacity: r.status === 'resolved' ? 0.6 : 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <code className="meta">{r.file}:{r.line} · @{r.commitSha.slice(0, 8)}</code>
          <span className="pill">{r.status === 'resolved' ? '已解决' : '待返工'}</span>
        </div>
        <p style={{ margin: '4px 0 0' }}>{r.comment}</p>
      </div>)}
    </div>}

    {parsedLines.length === 0
      ? <Empty>当前工作区与基线之间没有代码改动。</Empty>
      : <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="meta" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
          点击任意代码行可添加绑定文件与提交版本的行级批注（新增未追踪文件也会完整显示）
        </div>
        <div style={{ maxHeight: 520, overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.55 }}>
          {parsedLines.map((ln, idx) => {
            const bg = ln.kind === 'add' ? 'rgba(22, 163, 74, 0.14)'
              : ln.kind === 'del' ? 'rgba(220, 38, 38, 0.14)'
                : ln.kind === 'hunk' ? 'rgba(59, 130, 246, 0.12)'
                  : ln.kind === 'header' ? 'rgba(148, 163, 184, 0.12)' : 'transparent'
            const clickable = Boolean(ln.file && ln.newLine > 0 && ln.kind !== 'header' && ln.kind !== 'hunk')
            return <div
              key={idx}
              onClick={() => clickable && setCommentTarget({ file: ln.file, line: ln.newLine })}
              style={{
                display: 'flex',
                gap: 8,
                padding: '1px 10px',
                background: bg,
                cursor: clickable ? 'pointer' : 'default',
                whiteSpace: 'pre',
              }}
              title={clickable ? `点击批注 ${ln.file}:${ln.newLine}` : undefined}
            >
              <span style={{ width: 42, textAlign: 'right', opacity: 0.55, userSelect: 'none', flexShrink: 0 }}>
                {ln.newLine > 0 ? ln.newLine : ''}
              </span>
              <span style={{ flex: 1 }}>{ln.text}</span>
            </div>
          })}
        </div>
      </div>}

    {commentTarget && <Sheet title={`行级批注 · ${commentTarget.file}:${commentTarget.line}`} onClose={() => setCommentTarget(null)}>
      <p className="meta">绑定提交版本：{d.headSha?.slice(0, 12) || 'HEAD'}</p>
      <label className="field"><span>批注意见</span>
        <textarea rows={3} autoFocus value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="指出需要修改的问题或期望写法…" />
      </label>
      <button type="button" className="primary" disabled={busy || !commentText.trim()} onClick={addComment}>保存批注</button>
    </Sheet>}

    {prSheet && <Sheet title="创建 GitHub Pull Request" onClose={() => setPrSheet(false)}>
      <label className="field"><span>目标仓库（owner/repo）</span>
        <input value={prRepo} onChange={e => setPrRepo(e.target.value)} placeholder="例如：myorg/myapp" />
      </label>
      <label className="field"><span>目标基分支</span>
        <input value={prBase} onChange={e => setPrBase(e.target.value)} placeholder="main" />
      </label>
      <label className="field"><span>PR 标题（可选）</span>
        <input value={prTitle} onChange={e => setPrTitle(e.target.value)} placeholder="留空默认使用工单标题" />
      </label>
      <button type="button" className="primary" disabled={busy || !prRepo.trim()} onClick={createPr}>提交分支并创建 PR</button>
    </Sheet>}
  </div>
}
