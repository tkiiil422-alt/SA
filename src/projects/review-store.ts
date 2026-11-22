/**
 * 工单代码审查存储（行级批注 + 审查签核 + 变更失效复检）。
 *
 * 每条批注和签核都绑定具体文件路径、行号、Git commit SHA 与工作区内容指纹（`treeFingerprint`）。
 * 审查完成后如果代码发生任何变更，`checkStale` 立即返回 `needsReverify: true`，防止未复审代码被直接合入主分支。
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TicketReviewComment, TicketReviewState } from '../shared/api-types.ts'

export type { TicketReviewComment, TicketReviewState }

interface ReviewRow {
  id: string
  ticket_id: string
  file: string
  line: number
  commit_sha: string
  tree_fingerprint: string
  comment: string
  status: string
  created_at: string
}

interface ReviewStateRow {
  ticket_id: string
  reviewed_sha: string
  reviewed_fingerprint: string
  decision: string
  note: string
  reviewed_at: string
}

function rowToComment(row: ReviewRow): TicketReviewComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    file: row.file,
    line: row.line,
    commitSha: row.commit_sha,
    treeFingerprint: row.tree_fingerprint,
    comment: row.comment,
    status: row.status === 'resolved' ? 'resolved' : 'open',
    createdAt: row.created_at,
  }
}

function rowToState(row: ReviewStateRow): TicketReviewState {
  return {
    ticketId: row.ticket_id,
    reviewedSha: row.reviewed_sha,
    reviewedFingerprint: row.reviewed_fingerprint,
    decision: row.decision === 'approved' ? 'approved' : 'changes_requested',
    note: row.note,
    reviewedAt: row.reviewed_at,
  }
}

export class TicketReviewStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_reviews (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        tree_fingerprint TEXT NOT NULL,
        comment TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_reviews_ticket ON ticket_reviews(ticket_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS ticket_review_state (
        ticket_id TEXT PRIMARY KEY,
        reviewed_sha TEXT NOT NULL,
        reviewed_fingerprint TEXT NOT NULL,
        decision TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        reviewed_at TEXT NOT NULL
      );
    `)
  }

  addComment(input: {
    ticketId: string
    file: string
    line: number
    commitSha: string
    treeFingerprint: string
    comment: string
  }, now = new Date()): TicketReviewComment {
    const file = input.file.trim().slice(0, 400)
    const comment = input.comment.trim().slice(0, 2000)
    if (!file || !comment) throw new Error('批注必须包含文件路径与批注内容')
    const line = Math.max(1, Math.trunc(Number(input.line) || 1))
    const id = `rev_${randomBytes(5).toString('hex')}`
    const createdAt = now.toISOString()
    this.db.prepare(`
      INSERT INTO ticket_reviews (id, ticket_id, file, line, commit_sha, tree_fingerprint, comment, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(id, input.ticketId, file, line, input.commitSha || 'HEAD', input.treeFingerprint || '', comment, createdAt)
    return {
      id,
      ticketId: input.ticketId,
      file,
      line,
      commitSha: input.commitSha || 'HEAD',
      treeFingerprint: input.treeFingerprint || '',
      comment,
      status: 'open',
      createdAt,
    }
  }

  listComments(ticketId: string): TicketReviewComment[] {
    const rows = this.db.prepare(
      'SELECT * FROM ticket_reviews WHERE ticket_id = ? ORDER BY created_at ASC',
    ).all(ticketId) as unknown as ReviewRow[]
    return rows.map(rowToComment)
  }

  resolveComments(ticketId: string, ids?: readonly string[]): number {
    if (!ids || ids.length === 0) {
      const res = this.db.prepare(`UPDATE ticket_reviews SET status = 'resolved' WHERE ticket_id = ? AND status = 'open'`).run(ticketId)
      return Number(res.changes)
    }
    let count = 0
    const stmt = this.db.prepare(`UPDATE ticket_reviews SET status = 'resolved' WHERE ticket_id = ? AND id = ?`)
    for (const id of ids) {
      count += Number(stmt.run(ticketId, id).changes)
    }
    return count
  }

  recordDecision(input: {
    ticketId: string
    reviewedSha: string
    reviewedFingerprint: string
    decision: 'approved' | 'changes_requested'
    note?: string
  }, now = new Date()): TicketReviewState {
    const reviewedAt = now.toISOString()
    this.db.prepare(`
      INSERT INTO ticket_review_state (ticket_id, reviewed_sha, reviewed_fingerprint, decision, note, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET
        reviewed_sha = excluded.reviewed_sha,
        reviewed_fingerprint = excluded.reviewed_fingerprint,
        decision = excluded.decision,
        note = excluded.note,
        reviewed_at = excluded.reviewed_at
    `).run(
      input.ticketId,
      input.reviewedSha || 'HEAD',
      input.reviewedFingerprint || '',
      input.decision,
      (input.note ?? '').trim().slice(0, 600),
      reviewedAt,
    )
    return this.getState(input.ticketId)!
  }

  getState(ticketId: string): TicketReviewState | null {
    const row = this.db.prepare('SELECT * FROM ticket_review_state WHERE ticket_id = ?').get(ticketId) as ReviewStateRow | undefined
    return row ? rowToState(row) : null
  }

  /** 判断在最近一次审查之后代码是否发生了新的改动。 */
  checkStale(
    ticketId: string,
    currentSha: string | undefined,
    currentFingerprint: string | undefined,
  ): { needsReverify: boolean; staleReason?: string; state: TicketReviewState | null } {
    const state = this.getState(ticketId)
    if (!state) return { needsReverify: false, state: null }
    if (state.decision === 'changes_requested') {
      return {
        needsReverify: true,
        staleReason: '上次审查要求返工，修改完成后需重新审查确认通过。',
        state,
      }
    }
    if (
      (currentSha && state.reviewedSha && currentSha !== state.reviewedSha)
      || (currentFingerprint && state.reviewedFingerprint && currentFingerprint !== state.reviewedFingerprint)
    ) {
      return {
        needsReverify: true,
        staleReason: `审查通过（${state.reviewedSha.slice(0, 8)} / ${state.reviewedFingerprint.slice(0, 8)}）后代码已发生新改动，合并前需重新校验审查。`,
        state,
      }
    }
    return { needsReverify: false, state }
  }

  /** 把开放中的行级批注拼装成精准返工指令，直接发给 Worker 执行返工。 */
  formatReworkPrompt(ticketId: string, extraNote = ''): string {
    const open = this.listComments(ticketId).filter(c => c.status === 'open')
    const lines = [
      '【代码审查返工指令】请逐条修复以下绑定文件与提交版本的行级批注，修复后重新运行测试验证：',
    ]
    for (const c of open) {
      lines.push(`- ${c.file}:${c.line}（基于 ${c.commitSha.slice(0, 8)}）：${c.comment}`)
    }
    if (extraNote.trim()) {
      lines.push('', `补充说明：${extraNote.trim()}`)
    }
    return lines.join('\n')
  }
}
