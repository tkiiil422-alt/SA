/**
 * 总控助手（Director）的 SQLite 持久化存储。
 *
 * 与任务状态共库（`state.sqlite`），随每日状态备份自动保护：
 * - `director_sessions`: 每个通道+用户的主会话、滚动摘要、偏好与聚焦工单
 * - `director_messages`: 完整对话与工具调用审计记录（支持归档重置，不丢审计）
 * - `director_pending_actions`: 高危操作二次确认记录（短码、过期时间、审批结果）
 * - `director_ticket_links`: 工单与总控会话的归属映射
 * - `director_undelivered`: 微信离线推送失败时的待补报队列
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ToolCall } from './llm.ts'

export type DirectorChannel = 'wechat' | 'web' | 'feishu'

export interface DirectorSession {
  id: string
  channel: DirectorChannel
  userId: string
  title: string
  summary: string
  preferences: Record<string, unknown>
  focusTicketId?: string
  createdAt: string
  updatedAt: string
}

export interface DirectorMessage {
  id: number
  sessionId: string
  role: 'user' | 'assistant' | 'tool' | 'event'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  meta?: Record<string, unknown>
  archived: boolean
  createdAt: string
}

export type PendingActionStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface PendingAction {
  id: string
  sessionId: string
  toolName: string
  args: Record<string, unknown>
  summary: string
  status: PendingActionStatus
  resultText?: string
  expiresAt: string
  createdAt: string
  decidedAt?: string
}

export interface TicketLink {
  ticketId: string
  sessionId: string
  channel: DirectorChannel
  userId: string
  createdAt: string
}

export interface UndeliveredNotice {
  id: number
  sessionId: string
  channel: DirectorChannel
  userId: string
  text: string
  createdAt: string
}

export type FollowupTriggerKind = 'ticket.ended' | 'council.ended'
export type FollowupOnFailure = 'report' | 'continue'
export type FollowupStatus = 'pending' | 'running' | 'done' | 'cancelled' | 'failed'

export interface DirectorFollowup {
  id: string
  sessionId: string
  triggerKind: FollowupTriggerKind
  targetId: string
  instruction: string
  onFailure: FollowupOnFailure
  status: FollowupStatus
  resultText?: string
  createdAt: string
  triggeredAt?: string
}

export interface SessionListItem extends DirectorSession {
  messageCount: number
  pendingActions: number
  lastMessage?: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS director_sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  preferences_json TEXT NOT NULL DEFAULT '{}',
  focus_ticket_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, user_id)
);

CREATE TABLE IF NOT EXISTS director_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls_json TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS director_messages_session ON director_messages (session_id, id);

CREATE TABLE IF NOT EXISTS director_pending_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_text TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS director_pending_session ON director_pending_actions (session_id, status, created_at);

CREATE TABLE IF NOT EXISTS director_ticket_links (
  ticket_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, session_id)
);
CREATE INDEX IF NOT EXISTS director_ticket_links_ticket ON director_ticket_links (ticket_id);

CREATE TABLE IF NOT EXISTS director_undelivered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS director_undelivered_session ON director_undelivered (session_id, id);

CREATE TABLE IF NOT EXISTS director_followups (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  on_failure TEXT NOT NULL DEFAULT 'report',
  status TEXT NOT NULL DEFAULT 'pending',
  result_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  triggered_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS director_followups_target ON director_followups (trigger_kind, target_id, status);
CREATE INDEX IF NOT EXISTS director_followups_session ON director_followups (session_id, status, created_at);
`

const MAX_MESSAGES_PER_SESSION = 500
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function makeShortCode(): string {
  const bytes = randomBytes(4)
  let out = ''
  for (let i = 0; i < 4; i += 1) {
    out += SHORT_CODE_ALPHABET[bytes[i]! % SHORT_CODE_ALPHABET.length]!
  }
  return out
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function parseToolCalls(raw: string): ToolCall[] | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed as ToolCall[] : undefined
  } catch {
    return undefined
  }
}

export class DirectorStore {
  private readonly now: () => Date

  constructor(private readonly db: DatabaseSync, opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date())
    this.db.exec(SCHEMA)
  }

  getOrCreateSession(channel: DirectorChannel, userId: string, title = ''): DirectorSession {
    const cleanUser = userId.trim() || 'default'
    const existing = this.db.prepare(
      'SELECT * FROM director_sessions WHERE channel = ? AND user_id = ?',
    ).get(channel, cleanUser) as Record<string, string> | undefined
    if (existing) return this.rowToSession(existing)

    const now = this.now().toISOString()
    const id = `ds_${channel}_${randomBytes(6).toString('hex')}`
    const defaultTitle = title || (channel === 'wechat'
      ? `微信总控 (${cleanUser.slice(0, 16)})`
      : channel === 'feishu' ? `飞书总控 (${cleanUser.slice(0, 16)})` : `控制台总控 (${cleanUser})`)
    this.db.prepare(`
      INSERT INTO director_sessions (id, channel, user_id, title, summary, preferences_json, focus_ticket_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', '{}', '', ?, ?)
    `).run(id, channel, cleanUser, defaultTitle, now, now)
    return {
      id,
      channel,
      userId: cleanUser,
      title: defaultTitle,
      summary: '',
      preferences: {},
      createdAt: now,
      updatedAt: now,
    }
  }

  getSession(id: string): DirectorSession | undefined {
    const row = this.db.prepare('SELECT * FROM director_sessions WHERE id = ?').get(id) as Record<string, string> | undefined
    return row ? this.rowToSession(row) : undefined
  }

  findSessionByChannelUser(channel: DirectorChannel, userId: string): DirectorSession | undefined {
    const row = this.db.prepare(
      'SELECT * FROM director_sessions WHERE channel = ? AND user_id = ?',
    ).get(channel, userId.trim()) as Record<string, string> | undefined
    return row ? this.rowToSession(row) : undefined
  }

  listSessions(channel?: DirectorChannel): SessionListItem[] {
    const rows = (channel
      ? this.db.prepare('SELECT * FROM director_sessions WHERE channel = ? ORDER BY updated_at DESC').all(channel)
      : this.db.prepare('SELECT * FROM director_sessions ORDER BY updated_at DESC').all()) as Record<string, string>[]
    const nowIso = this.now().toISOString()
    return rows.map(row => {
      const session = this.rowToSession(row)
      const countRow = this.db.prepare('SELECT COUNT(*) AS c FROM director_messages WHERE session_id = ?').get(session.id) as { c: number }
      const pendingRow = this.db.prepare(
        'SELECT COUNT(*) AS c FROM director_pending_actions WHERE session_id = ? AND status = \'pending\' AND expires_at > ?',
      ).get(session.id, nowIso) as { c: number }
      const lastRow = this.db.prepare(
        'SELECT content FROM director_messages WHERE session_id = ? AND role IN (\'user\', \'assistant\', \'event\') ORDER BY id DESC LIMIT 1',
      ).get(session.id) as { content?: string } | undefined
      return {
        ...session,
        messageCount: countRow.c,
        pendingActions: pendingRow.c,
        ...(lastRow?.content ? { lastMessage: lastRow.content.slice(0, 120) } : {}),
      }
    })
  }

  updateSession(id: string, patch: { summary?: string; preferences?: Record<string, unknown>; focusTicketId?: string; title?: string }): void {
    const cur = this.getSession(id)
    if (!cur) return
    const now = this.now().toISOString()
    this.db.prepare(`
      UPDATE director_sessions
      SET title = ?, summary = ?, preferences_json = ?, focus_ticket_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.title ?? cur.title,
      patch.summary ?? cur.summary,
      JSON.stringify(patch.preferences ?? cur.preferences),
      patch.focusTicketId !== undefined ? patch.focusTicketId : (cur.focusTicketId ?? ''),
      now,
      id,
    )
  }

  addMessage(input: {
    sessionId: string
    role: DirectorMessage['role']
    content: string
    toolCalls?: ToolCall[]
    toolCallId?: string
    toolName?: string
    meta?: Record<string, unknown>
  }): DirectorMessage {
    const now = this.now().toISOString()
    const res = this.db.prepare(`
      INSERT INTO director_messages (session_id, role, content, tool_calls_json, tool_call_id, tool_name, meta_json, archived, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      input.sessionId,
      input.role,
      input.content,
      input.toolCalls && input.toolCalls.length > 0 ? JSON.stringify(input.toolCalls) : '',
      input.toolCallId ?? '',
      input.toolName ?? '',
      input.meta ? JSON.stringify(input.meta) : '',
      now,
    )
    this.db.prepare('UPDATE director_sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId)
    this.trimOldMessages(input.sessionId)
    return {
      id: Number(res.lastInsertRowid),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      ...(input.toolCalls && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      archived: false,
      createdAt: now,
    }
  }

  /** 读取当前活跃（未归档）的对话消息，按时间正序。 */
  activeMessages(sessionId: string, limit = 80): DirectorMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM director_messages
        WHERE session_id = ? AND archived = 0
        ORDER BY id DESC
        LIMIT ?
      ) ORDER BY id ASC
    `).all(sessionId, limit) as Record<string, unknown>[]
    return rows.map(r => this.rowToMessage(r))
  }

  /** 读取审计视图用的历史消息（包含已归档），按时间正序。 */
  recentMessages(sessionId: string, limit = 120): DirectorMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM director_messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      ) ORDER BY id ASC
    `).all(sessionId, limit) as Record<string, unknown>[]
    return rows.map(r => this.rowToMessage(r))
  }

  /** 归档指定消息 ID 列表（用于滚动摘要压缩）或清空整个会话的活跃上下文（`/新对话`）。 */
  archiveMessages(sessionId: string, upToId?: number): number {
    const res = upToId !== undefined
      ? this.db.prepare('UPDATE director_messages SET archived = 1 WHERE session_id = ? AND archived = 0 AND id <= ?').run(sessionId, upToId)
      : this.db.prepare('UPDATE director_messages SET archived = 1 WHERE session_id = ? AND archived = 0').run(sessionId)
    return Number(res.changes ?? 0)
  }

  resetSession(sessionId: string, clearSummary = true): void {
    this.archiveMessages(sessionId)
    if (clearSummary) {
      this.updateSession(sessionId, { summary: '', focusTicketId: '' })
    }
  }

  // --- 高危操作二次确认 ---

  createPendingAction(input: {
    sessionId: string
    toolName: string
    args: Record<string, unknown>
    summary: string
    ttlMs?: number
  }): PendingAction {
    const now = this.now()
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 10 * 60_000)).toISOString()
    let id = makeShortCode()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const exists = this.db.prepare('SELECT id FROM director_pending_actions WHERE id = ?').get(id)
      if (!exists) break
      id = makeShortCode()
    }
    this.db.prepare(`
      INSERT INTO director_pending_actions (id, session_id, tool_name, args_json, summary, status, result_text, expires_at, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, 'pending', '', ?, ?, '')
    `).run(id, input.sessionId, input.toolName, JSON.stringify(input.args), input.summary, expiresAt, now.toISOString())
    return {
      id,
      sessionId: input.sessionId,
      toolName: input.toolName,
      args: input.args,
      summary: input.summary,
      status: 'pending',
      expiresAt,
      createdAt: now.toISOString(),
    }
  }

  expireStaleActions(): void {
    const now = this.now().toISOString()
    // 已过期操作不会再执行，清空参数载荷避免敏感字段残留
    this.db.prepare(`
      UPDATE director_pending_actions
      SET status = 'expired', decided_at = ?, args_json = '{}'
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now)
  }

  getPendingAction(id: string): PendingAction | undefined {
    this.expireStaleActions()
    const row = this.db.prepare('SELECT * FROM director_pending_actions WHERE id = ? COLLATE NOCASE').get(id.trim()) as Record<string, string> | undefined
    return row ? this.rowToAction(row) : undefined
  }

  listPendingActions(sessionId?: string, onlyPending = false): PendingAction[] {
    this.expireStaleActions()
    let rows: Record<string, string>[]
    if (sessionId && onlyPending) {
      rows = this.db.prepare('SELECT * FROM director_pending_actions WHERE session_id = ? AND status = \'pending\' ORDER BY created_at DESC LIMIT 30').all(sessionId) as Record<string, string>[]
    } else if (sessionId) {
      rows = this.db.prepare('SELECT * FROM director_pending_actions WHERE session_id = ? ORDER BY created_at DESC LIMIT 30').all(sessionId) as Record<string, string>[]
    } else if (onlyPending) {
      rows = this.db.prepare('SELECT * FROM director_pending_actions WHERE status = \'pending\' ORDER BY created_at DESC LIMIT 50').all() as Record<string, string>[]
    } else {
      rows = this.db.prepare('SELECT * FROM director_pending_actions ORDER BY created_at DESC LIMIT 50').all() as Record<string, string>[]
    }
    return rows.map(r => this.rowToAction(r))
  }

  latestPendingAction(sessionId: string): PendingAction | undefined {
    this.expireStaleActions()
    const row = this.db.prepare(
      'SELECT * FROM director_pending_actions WHERE session_id = ? AND status = \'pending\' ORDER BY created_at DESC LIMIT 1',
    ).get(sessionId) as Record<string, string> | undefined
    return row ? this.rowToAction(row) : undefined
  }

  setActionStatus(id: string, status: PendingActionStatus, resultText = '', redactedArgs?: Record<string, unknown>): void {
    const now = this.now().toISOString()
    if (redactedArgs !== undefined) {
      this.db.prepare(`
        UPDATE director_pending_actions
        SET status = ?, result_text = ?, decided_at = ?, args_json = ?
        WHERE id = ?
      `).run(status, resultText, now, JSON.stringify(redactedArgs), id)
      return
    }
    this.db.prepare(`
      UPDATE director_pending_actions
      SET status = ?, result_text = ?, decided_at = ?
      WHERE id = ?
    `).run(status, resultText, now, id)
  }

  // --- 工单关联与离线补报队列 ---

  linkTicket(ticketId: string, session: Pick<DirectorSession, 'id' | 'channel' | 'userId'>): void {
    const now = this.now().toISOString()
    this.db.prepare(`
      INSERT OR IGNORE INTO director_ticket_links (ticket_id, session_id, channel, user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(ticketId, session.id, session.channel, session.userId, now)
    this.updateSession(session.id, { focusTicketId: ticketId })
  }

  linksForTicket(ticketId: string): TicketLink[] {
    const rows = this.db.prepare('SELECT * FROM director_ticket_links WHERE ticket_id = ? ORDER BY created_at DESC').all(ticketId) as Record<string, string>[]
    return rows.map(r => ({
      ticketId: r.ticket_id!,
      sessionId: r.session_id!,
      channel: r.channel as DirectorChannel,
      userId: r.user_id!,
      createdAt: r.created_at!,
    }))
  }

  addUndelivered(session: Pick<DirectorSession, 'id' | 'channel' | 'userId'>, text: string): void {
    this.db.prepare(`
      INSERT INTO director_undelivered (session_id, channel, user_id, text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(session.id, session.channel, session.userId, text, this.now().toISOString())
  }

  takeUndelivered(sessionId: string): UndeliveredNotice[] {
    const rows = this.db.prepare(
      'SELECT * FROM director_undelivered WHERE session_id = ? ORDER BY id ASC',
    ).all(sessionId) as Record<string, unknown>[]
    if (rows.length > 0) {
      this.db.prepare('DELETE FROM director_undelivered WHERE session_id = ?').run(sessionId)
    }
    return rows.map(r => ({
      id: Number(r.id),
      sessionId: String(r.session_id),
      channel: String(r.channel) as DirectorChannel,
      userId: String(r.user_id),
      text: String(r.text),
      createdAt: String(r.created_at),
    }))
  }

  // --- 任务/会商完成后的自动续接触发器 ---

  createFollowup(input: {
    sessionId: string
    triggerKind: FollowupTriggerKind
    targetId: string
    instruction: string
    onFailure?: FollowupOnFailure
  }): DirectorFollowup {
    const now = this.now().toISOString()
    let id = `fw_${makeShortCode()}`
    for (let i = 0; i < 6; i += 1) {
      const clash = this.db.prepare('SELECT 1 FROM director_followups WHERE id = ?').get(id)
      if (!clash) break
      id = `fw_${makeShortCode()}`
    }
    const onFailure: FollowupOnFailure = input.onFailure === 'continue' ? 'continue' : 'report'
    const instruction = input.instruction.trim()
    this.db.prepare(`
      INSERT INTO director_followups (id, session_id, trigger_kind, target_id, instruction, on_failure, status, result_text, created_at, triggered_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', '', ?, '')
    `).run(id, input.sessionId, input.triggerKind, input.targetId.trim(), instruction, onFailure, now)
    return {
      id,
      sessionId: input.sessionId,
      triggerKind: input.triggerKind,
      targetId: input.targetId.trim(),
      instruction,
      onFailure,
      status: 'pending',
      createdAt: now,
    }
  }

  getFollowup(id: string): DirectorFollowup | undefined {
    const row = this.db.prepare('SELECT * FROM director_followups WHERE id = ?').get(id.trim()) as Record<string, string> | undefined
    return row ? this.rowToFollowup(row) : undefined
  }

  listFollowups(sessionId?: string, onlyPending = false): DirectorFollowup[] {
    let rows: Record<string, string>[]
    if (sessionId && onlyPending) {
      rows = this.db.prepare(
        "SELECT * FROM director_followups WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 30",
      ).all(sessionId) as Record<string, string>[]
    } else if (sessionId) {
      rows = this.db.prepare(
        'SELECT * FROM director_followups WHERE session_id = ? ORDER BY created_at DESC LIMIT 30',
      ).all(sessionId) as Record<string, string>[]
    } else if (onlyPending) {
      rows = this.db.prepare(
        "SELECT * FROM director_followups WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50",
      ).all() as Record<string, string>[]
    } else {
      rows = this.db.prepare(
        'SELECT * FROM director_followups ORDER BY created_at DESC LIMIT 50',
      ).all() as Record<string, string>[]
    }
    return rows.map(r => this.rowToFollowup(r))
  }

  /** 原子认领指定目标的所有待触发后续计划（pending → running），防止并发或重复触发。 */
  claimPendingFollowups(triggerKind: FollowupTriggerKind, targetId: string): DirectorFollowup[] {
    const cleanId = targetId.trim()
    const rows = this.db.prepare(
      "SELECT * FROM director_followups WHERE trigger_kind = ? AND target_id = ? AND status = 'pending' ORDER BY created_at ASC",
    ).all(triggerKind, cleanId) as Record<string, string>[]
    if (rows.length === 0) return []
    const now = this.now().toISOString()
    const claimed: DirectorFollowup[] = []
    for (const r of rows) {
      const res = this.db.prepare(
        "UPDATE director_followups SET status = 'running', triggered_at = ? WHERE id = ? AND status = 'pending'",
      ).run(now, r.id!)
      if (Number(res.changes ?? 0) > 0) {
        claimed.push({ ...this.rowToFollowup(r), status: 'running', triggeredAt: now })
      }
    }
    return claimed
  }

  finishFollowup(id: string, status: 'done' | 'failed' | 'cancelled', resultText = ''): void {
    this.db.prepare(
      'UPDATE director_followups SET status = ?, result_text = ? WHERE id = ?',
    ).run(status, resultText.slice(0, 1000), id)
  }

  cancelFollowup(id: string): boolean {
    const res = this.db.prepare(
      "UPDATE director_followups SET status = 'cancelled', result_text = '已取消' WHERE id = ? AND status = 'pending'",
    ).run(id.trim())
    return Number(res.changes ?? 0) > 0
  }

  private trimOldMessages(sessionId: string): void {
    this.db.prepare(`
      DELETE FROM director_messages
      WHERE session_id = ? AND id <= (
        SELECT id FROM director_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
      )
    `).run(sessionId, sessionId, MAX_MESSAGES_PER_SESSION)
  }

  private rowToSession(row: Record<string, string>): DirectorSession {
    return {
      id: row.id!,
      channel: row.channel as DirectorChannel,
      userId: row.user_id!,
      title: row.title ?? '',
      summary: row.summary ?? '',
      preferences: parseJsonObject(row.preferences_json ?? ''),
      ...(row.focus_ticket_id ? { focusTicketId: row.focus_ticket_id } : {}),
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    }
  }

  private rowToMessage(row: Record<string, unknown>): DirectorMessage {
    const toolCalls = parseToolCalls(String(row.tool_calls_json ?? ''))
    const metaRaw = String(row.meta_json ?? '')
    const meta = metaRaw ? parseJsonObject(metaRaw) : undefined
    const toolCallId = String(row.tool_call_id ?? '')
    const toolName = String(row.tool_name ?? '')
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      role: String(row.role) as DirectorMessage['role'],
      content: String(row.content ?? ''),
      ...(toolCalls ? { toolCalls } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
      archived: Number(row.archived) === 1,
      createdAt: String(row.created_at),
    }
  }

  private rowToAction(row: Record<string, string>): PendingAction {
    return {
      id: row.id!,
      sessionId: row.session_id!,
      toolName: row.tool_name!,
      args: parseJsonObject(row.args_json ?? ''),
      summary: row.summary ?? '',
      status: row.status as PendingActionStatus,
      ...(row.result_text ? { resultText: row.result_text } : {}),
      expiresAt: row.expires_at!,
      createdAt: row.created_at!,
      ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    }
  }

  private rowToFollowup(row: Record<string, string>): DirectorFollowup {
    return {
      id: row.id!,
      sessionId: row.session_id!,
      triggerKind: row.trigger_kind as FollowupTriggerKind,
      targetId: row.target_id!,
      instruction: row.instruction ?? '',
      onFailure: row.on_failure === 'continue' ? 'continue' : 'report',
      status: row.status as FollowupStatus,
      ...(row.result_text ? { resultText: row.result_text } : {}),
      createdAt: row.created_at!,
      ...(row.triggered_at ? { triggeredAt: row.triggered_at } : {}),
    }
  }
}
