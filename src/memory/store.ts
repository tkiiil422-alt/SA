/**
 * 三层长期记忆存储与混合检索引擎（SQLite + FTS5 + SQL 关键词直查 + 纠正链）。
 *
 * 作用域三层划分：
 * - `user`：跨项目的全局偏好、常用环境、沟通习惯、系统约束；
 * - `project`：绑定具体 `projectId` 的代码库约定、构建部署坑点、架构决策；
 * - `ticket`：单次工单提炼的复盘经验（`retro`）与事实片段，分别记录工单终态、验收结果与用户反馈。
 *
 * 召回保证：
 * - 不再受“最近 N 条”候选截断限制：通过 FTS5 倒排 + SQL LIKE 直查 + 项目全量 + 置顶四路并集取候选，
 *   即便后续写入 300+ 条无关记录，含唯一关键词的旧记忆依然可稳定召回，且严格遵守 `projectId` 作用域隔离；
 * - 已被更新记忆纠正替代（`superseded_by IS NOT NULL`）的旧记忆自动退出默认召回。
 */
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryKind, MemoryRecord, MemoryScope } from '../shared/api-types.ts'

export type { MemoryKind, MemoryRecord, MemoryScope }

export interface MemoryCreateInput {
  scope: MemoryScope
  kind: MemoryKind
  projectId?: string | null
  ticketId?: string | null
  title: string
  content: string
  tags?: string[]
  confidence?: number
  pinned?: boolean
  source?: string
  ticketOutcome?: string | null
  acceptanceStatus?: string | null
  userFeedback?: string | null
  supersedesId?: string | null
  evidence?: string[]
}

export interface MemoryUpdateInput {
  scope?: MemoryScope
  kind?: MemoryKind
  projectId?: string | null
  title?: string
  content?: string
  tags?: string[]
  confidence?: number
  pinned?: boolean
  userFeedback?: string | null
  evidence?: string[]
}

export interface MemoryListQuery {
  scope?: MemoryScope
  kind?: MemoryKind
  projectId?: string
  pinned?: boolean
  includeSuperseded?: boolean
  q?: string
  limit?: number
  offset?: number
}

export interface MemoryRecallOptions {
  query: string
  projectId?: string
  scopes?: readonly MemoryScope[]
  limit?: number
  includePinned?: boolean
  includeSuperseded?: boolean
  /** 命中后是否自动递增 `useCount`（默认 false，仅实际注入 Prompt 时置 true）。 */
  recordUse?: boolean
}

interface MemoryRow {
  id: string
  scope: string
  kind: string
  project_id: string | null
  ticket_id: string | null
  title: string
  content: string
  tags_json: string
  confidence: number
  pinned: number
  use_count: number
  last_used_at: string | null
  source: string
  ticket_outcome: string | null
  acceptance_status: string | null
  user_feedback: string | null
  supersedes_id: string | null
  superseded_by: string | null
  evidence_json: string | null
  created_at: string
  updated_at: string
}

function makeId(): string {
  return `mem_${randomBytes(6).toString('hex')}`
}

function cleanStrings(items?: readonly string[], max = 20, maxLen = 40): string[] {
  if (!items) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const t = raw.trim().slice(0, maxLen)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

function parseStrings(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  const evidence = parseStrings(row.evidence_json)
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    kind: row.kind as MemoryKind,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    title: row.title,
    content: row.content,
    tags: parseStrings(row.tags_json),
    confidence: row.confidence,
    pinned: row.pinned === 1,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    source: row.source,
    ...(row.ticket_outcome !== null ? { ticketOutcome: row.ticket_outcome } : {}),
    ...(row.acceptance_status !== null ? { acceptanceStatus: row.acceptance_status } : {}),
    ...(row.user_feedback !== null ? { userFeedback: row.user_feedback } : {}),
    ...(row.supersedes_id !== null ? { supersedesId: row.supersedes_id } : {}),
    ...(row.superseded_by !== null ? { supersededBy: row.superseded_by } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 提取查询词项：同时保留英文/数字标识词，以及中文连续片段的整词与 2-gram，
 * 确保无论是唯一英文标识（如 `ZXQ-9981`）还是中文短语都能精确召回。
 */
export function extractSearchTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const terms = new Set<string>()
  for (const m of normalized.matchAll(/[a-z0-9_.-]{2,}/g)) {
    terms.add(m[0])
  }
  for (const m of normalized.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0]
    terms.add(seg)
    if (seg.length > 2) {
      for (let i = 0; i <= seg.length - 2 && terms.size < 40; i += 1) {
        terms.add(seg.slice(i, i + 2))
      }
    }
  }
  return [...terms].slice(0, 40)
}

function buildFtsQuery(terms: readonly string[]): string | undefined {
  const safe = terms
    .filter(t => /^[a-z0-9_.-]{2,}$/.test(t) || /^[\u4e00-\u9fa5]{2,}$/.test(t))
    .slice(0, 12)
    .map(t => `"${t.replace(/"/g, '')}"`)
  return safe.length > 0 ? safe.join(' OR ') : undefined
}

export class MemoryStore {
  private readonly ftsEnabled: boolean

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        ticket_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.85,
        pinned INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        source TEXT NOT NULL DEFAULT 'user',
        ticket_outcome TEXT,
        acceptance_status TEXT,
        user_feedback TEXT,
        supersedes_id TEXT,
        superseded_by TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_ticket ON memories(ticket_id);
    `)

    // 兼容已存在的旧版 memories 表：增量补充新增列
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(memories)').all() as unknown as { name: string }[]).map(c => c.name),
    )
    const addColumn = (name: string, ddl: string): void => {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl}`)
    }
    addColumn('ticket_outcome', 'TEXT')
    addColumn('acceptance_status', 'TEXT')
    addColumn('user_feedback', 'TEXT')
    addColumn('supersedes_id', 'TEXT')
    addColumn('superseded_by', 'TEXT')
    addColumn('evidence_json', "TEXT NOT NULL DEFAULT '[]'")

    let fts = false
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          title,
          content,
          tags_json,
          content='memories',
          content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, content, tags_json) VALUES (new.rowid, new.title, new.content, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags_json) VALUES('delete', old.rowid, old.title, old.content, old.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags_json) VALUES('delete', old.rowid, old.title, old.content, old.tags_json);
          INSERT INTO memories_fts(rowid, title, content, tags_json) VALUES (new.rowid, new.title, new.content, new.tags_json);
        END;
      `)
      fts = true
    } catch {
      fts = false
    }
    this.ftsEnabled = fts
  }

  /** 新增一条记忆；若未指定 `supersedesId` 且同作用域/同项目存在未过时的同名标题，则合并更新。 */
  save(input: MemoryCreateInput, now = new Date()): MemoryRecord {
    const title = input.title.trim().slice(0, 160)
    const content = input.content.trim().slice(0, 8_000)
    if (!title) throw new Error('记忆标题不能为空')
    if (!content) throw new Error('记忆内容不能为空')
    const projectId = input.projectId?.trim() || null
    const ticketId = input.ticketId?.trim() || null
    const tags = cleanStrings(input.tags, 20, 40)
    const evidence = cleanStrings(input.evidence, 12, 300)
    const confidence = Math.max(0.1, Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : 0.85))
    const pinned = input.pinned ? 1 : 0
    const source = (input.source ?? 'user').trim().slice(0, 40) || 'user'
    const ticketOutcome = input.ticketOutcome?.trim() || null
    const acceptanceStatus = input.acceptanceStatus?.trim() || null
    const userFeedback = input.userFeedback?.trim().slice(0, 1000) || null
    const supersedesId = input.supersedesId?.trim() || null
    const iso = now.toISOString()

    // 若非显式纠正旧记忆，按 (scope, projectId, title) 去重合并活跃记忆
    if (!supersedesId) {
      const existing = this.db.prepare(`
        SELECT * FROM memories
        WHERE scope = ? AND COALESCE(project_id, '') = COALESCE(?, '')
          AND lower(title) = lower(?) AND superseded_by IS NULL
        LIMIT 1
      `).get(input.scope, projectId, title) as MemoryRow | undefined

      if (existing) {
        const prev = rowToRecord(existing)
        const mergedTags = cleanStrings([...prev.tags, ...tags], 20, 40)
        const mergedEvidence = cleanStrings([...(prev.evidence ?? []), ...evidence], 12, 300)
        this.db.prepare(`
          UPDATE memories
          SET kind = ?, content = ?, tags_json = ?, confidence = ?, pinned = ?,
              ticket_id = COALESCE(?, ticket_id), source = ?,
              ticket_outcome = COALESCE(?, ticket_outcome),
              acceptance_status = COALESCE(?, acceptance_status),
              user_feedback = COALESCE(?, user_feedback),
              evidence_json = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.kind,
          content,
          JSON.stringify(mergedTags),
          Math.max(existing.confidence, confidence),
          input.pinned === undefined ? existing.pinned : pinned,
          ticketId,
          source,
          ticketOutcome,
          acceptanceStatus,
          userFeedback,
          JSON.stringify(mergedEvidence),
          iso,
          existing.id,
        )
        return this.get(existing.id)!
      }
    }

    const id = makeId()
    this.db.prepare(`
      INSERT INTO memories (
        id, scope, kind, project_id, ticket_id, title, content, tags_json,
        confidence, pinned, use_count, last_used_at, source,
        ticket_outcome, acceptance_status, user_feedback, supersedes_id, superseded_by, evidence_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      id, input.scope, input.kind, projectId, ticketId, title, content,
      JSON.stringify(tags), confidence, pinned, source,
      ticketOutcome, acceptanceStatus, userFeedback, supersedesId,
      JSON.stringify(evidence), iso, iso,
    )

    // 如果本条记忆纠正了旧记忆，把旧记忆标为已被替代并取消其置顶，保证下一次召回自动生效新约定
    if (supersedesId) {
      this.db.prepare(`
        UPDATE memories SET superseded_by = ?, pinned = 0, updated_at = ? WHERE id = ?
      `).run(id, iso, supersedesId)
    }

    return this.get(id)!
  }

  /** 用新约定纠正一条已有记忆，建立双向纠正链（`supersedesId` / `supersededBy`）。 */
  correct(
    oldId: string,
    patch: { title?: string; content: string; scope?: MemoryScope; kind?: MemoryKind; projectId?: string | null; tags?: string[]; pinned?: boolean; userFeedback?: string; source?: string },
    now = new Date(),
  ): MemoryRecord {
    const prev = this.get(oldId)
    if (!prev) throw new Error(`找不到要纠正的旧记忆 ${oldId}`)
    return this.save({
      scope: patch.scope ?? prev.scope,
      kind: patch.kind ?? prev.kind,
      projectId: patch.projectId !== undefined ? patch.projectId : prev.projectId,
      ticketId: prev.ticketId,
      title: patch.title?.trim() || prev.title,
      content: patch.content,
      tags: patch.tags ?? prev.tags,
      confidence: 0.95,
      pinned: patch.pinned ?? prev.pinned,
      source: patch.source ?? 'user_correction',
      userFeedback: patch.userFeedback ?? `纠正旧记忆 ${oldId}`,
      supersedesId: oldId,
      evidence: [`supersedes:${oldId}`],
    }, now)
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  update(id: string, patch: MemoryUpdateInput, now = new Date()): MemoryRecord | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const title = patch.title !== undefined ? patch.title.trim().slice(0, 160) : cur.title
    const content = patch.content !== undefined ? patch.content.trim().slice(0, 8_000) : cur.content
    if (!title) throw new Error('记忆标题不能为空')
    if (!content) throw new Error('记忆内容不能为空')
    const scope = patch.scope ?? cur.scope
    const kind = patch.kind ?? cur.kind
    const projectId = patch.projectId !== undefined ? (patch.projectId?.trim() || null) : cur.projectId
    const tags = patch.tags !== undefined ? cleanStrings(patch.tags, 20, 40) : cur.tags
    const confidence = patch.confidence !== undefined
      ? Math.max(0.1, Math.min(1, Number(patch.confidence)))
      : cur.confidence
    const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : (cur.pinned ? 1 : 0)
    const userFeedback = patch.userFeedback !== undefined ? (patch.userFeedback?.trim().slice(0, 1000) || null) : (cur.userFeedback ?? null)
    const evidence = patch.evidence !== undefined ? cleanStrings(patch.evidence, 12, 300) : (cur.evidence ?? [])
    const iso = now.toISOString()

    this.db.prepare(`
      UPDATE memories
      SET scope = ?, kind = ?, project_id = ?, title = ?, content = ?, tags_json = ?,
          confidence = ?, pinned = ?, user_feedback = ?, evidence_json = ?, updated_at = ?
      WHERE id = ?
    `).run(scope, kind, projectId, title, content, JSON.stringify(tags), confidence, pinned, userFeedback, JSON.stringify(evidence), iso, id)
    return this.get(id)
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  list(query: MemoryListQuery = {}): { items: MemoryRecord[]; total: number } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (!query.includeSuperseded) where.push('superseded_by IS NULL')
    if (query.scope) { where.push('scope = ?'); params.push(query.scope) }
    if (query.kind) { where.push('kind = ?'); params.push(query.kind) }
    if (query.projectId) { where.push('project_id = ?'); params.push(query.projectId) }
    if (query.pinned !== undefined) { where.push('pinned = ?'); params.push(query.pinned ? 1 : 0) }
    const q = query.q?.trim()
    if (q) {
      where.push('(title LIKE ? OR content LIKE ? OR tags_json LIKE ?)')
      const like = `%${q}%`
      params.push(like, like, like)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM memories ${clause}`).get(...params) as { c: number }
    const limit = Math.max(1, Math.min(200, query.limit ?? 50))
    const offset = Math.max(0, query.offset ?? 0)
    const rows = this.db.prepare(`
      SELECT * FROM memories ${clause}
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown as MemoryRow[]
    return { items: rows.map(rowToRecord), total: Number(totalRow.c) }
  }

  /**
   * 全库无截断智能召回：
   * 候选集 = FTS5 全库倒排命中 ∪ SQL LIKE 关键词直查命中 ∪ 全部置顶项 ∪ 当前项目全部记忆 ∪ 最近 100 条活跃记录。
   * 彻底修复超过 300 条后旧记忆被截断漏召的问题，同时严格保证项目作用域不串台且跳过已被纠正替代的旧记忆。
   */
  recall(opts: MemoryRecallOptions): MemoryRecord[] {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 6))
    const terms = extractSearchTerms(opts.query)
    const allowedScopes = opts.scopes && opts.scopes.length > 0 ? new Set(opts.scopes) : undefined
    const activeClause = opts.includeSuperseded ? '1=1' : 'm.superseded_by IS NULL'

    const candidateMap = new Map<string, MemoryRow>()
    const addRows = (rows: MemoryRow[]): void => {
      for (const r of rows) candidateMap.set(r.id, r)
    }

    // 1) FTS5 全库倒排命中（不受时间与条数截断！）
    const ftsHitIds = new Set<string>()
    if (this.ftsEnabled && terms.length > 0) {
      const ftsExpr = buildFtsQuery(terms)
      if (ftsExpr) {
        try {
          const hitRows = this.db.prepare(`
            SELECT m.* FROM memories_fts f
            JOIN memories m ON m.rowid = f.rowid
            WHERE memories_fts MATCH ? AND ${activeClause}
            LIMIT 80
          `).all(ftsExpr) as unknown as MemoryRow[]
          for (const h of hitRows) ftsHitIds.add(h.id)
          addRows(hitRows)
        } catch {
          // 语法降级至下方的 LIKE 检索
        }
      }
    }

    // 2) SQL LIKE 关键词直查（解决无空格中文短语或特殊符号唯一标识词，全库扫描绝不漏掉 300 条以前的记忆！）
    const rawNeedle = opts.query.trim()
    const likeTerms = [...new Set([
      ...(rawNeedle.length >= 2 && rawNeedle.length <= 60 ? [rawNeedle] : []),
      ...terms.filter(t => t.length >= 2).sort((a, b) => b.length - a.length).slice(0, 8),
    ])]
    if (likeTerms.length > 0) {
      const parts: string[] = []
      const params: string[] = []
      for (const lt of likeTerms) {
        parts.push('(m.title LIKE ? OR m.content LIKE ? OR m.tags_json LIKE ?)')
        const pat = `%${lt}%`
        params.push(pat, pat, pat)
      }
      const likeRows = this.db.prepare(`
        SELECT m.* FROM memories m
        WHERE (${parts.join(' OR ')}) AND ${activeClause}
        ORDER BY m.pinned DESC, m.updated_at DESC
        LIMIT 120
      `).all(...params) as unknown as MemoryRow[]
      addRows(likeRows)
    }

    // 3) 全部置顶项 + 当前项目记忆 + 最近 100 条活跃记录
    const pinnedRows = this.db.prepare(`
      SELECT m.* FROM memories m WHERE m.pinned = 1 AND ${activeClause} ORDER BY m.updated_at DESC LIMIT 50
    `).all() as unknown as MemoryRow[]
    addRows(pinnedRows)

    if (opts.projectId) {
      const projRows = this.db.prepare(`
        SELECT m.* FROM memories m WHERE m.project_id = ? AND ${activeClause} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT 100
      `).all(opts.projectId) as unknown as MemoryRow[]
      addRows(projRows)
    }

    const recentRows = this.db.prepare(`
      SELECT m.* FROM memories m WHERE ${activeClause} ORDER BY m.updated_at DESC LIMIT 100
    `).all() as unknown as MemoryRow[]
    addRows(recentRows)

    const nowMs = Date.now()
    const scored: { rec: MemoryRecord; score: number }[] = []

    for (const row of candidateMap.values()) {
      const rec = rowToRecord(row)
      if (!opts.includeSuperseded && rec.supersededBy) continue
      if (allowedScopes && !allowedScopes.has(rec.scope)) continue
      // 严格项目范围隔离：绑定到某 projectId 的记忆绝不泄露给其他项目或无项目上下文
      if (rec.scope === 'project' && rec.projectId) {
        if (!opts.projectId || rec.projectId !== opts.projectId) continue
      }

      const titleL = rec.title.toLowerCase()
      const contentL = rec.content.toLowerCase()
      const tagsL = rec.tags.map(t => t.toLowerCase())

      let score = 0
      let lexicalHit = false
      if (ftsHitIds.has(rec.id)) {
        score += 2.5
        lexicalHit = true
      }
      if (rawNeedle.length >= 2) {
        const nl = rawNeedle.toLowerCase()
        if (titleL.includes(nl)) { score += 4.0; lexicalHit = true }
        else if (contentL.includes(nl)) { score += 2.8; lexicalHit = true }
      }
      for (const term of terms) {
        if (titleL.includes(term)) { score += 3.0; lexicalHit = true }
        if (tagsL.some(t => t.includes(term))) { score += 2.5; lexicalHit = true }
        if (contentL.includes(term)) { score += 1.2; lexicalHit = true }
      }

      if (rec.pinned && (opts.includePinned ?? true)) score += 2.0
      if (opts.projectId && rec.projectId === opts.projectId) score += 2.4
      if (rec.scope === 'user' && rec.kind === 'preference' && rec.pinned) score += 1.0
      // 用户主动纠正生成的新约定给予高优先级加成
      if (rec.supersedesId) score += 1.2

      if (terms.length > 0 && !lexicalHit && !rec.pinned && !(opts.projectId && rec.projectId === opts.projectId)) {
        continue
      }
      if (score <= 0) continue

      const ageDays = Math.max(0, (nowMs - Date.parse(rec.updatedAt)) / 86_400_000)
      const recency = Math.max(0, 1 - ageDays / 90) * 0.6
      score += rec.confidence * 0.8 + recency
      scored.push({ rec, score })
    }

    scored.sort((a, b) => b.score - a.score || b.rec.updatedAt.localeCompare(a.rec.updatedAt))
    const picked = scored.slice(0, limit).map(s => s.rec)
    if (opts.recordUse && picked.length > 0) {
      this.markUsed(picked.map(r => r.id))
    }
    return picked
  }

  markUsed(ids: readonly string[], now = new Date()): void {
    if (ids.length === 0) return
    const iso = now.toISOString()
    const stmt = this.db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(iso, id)
  }

  stats(): { total: number; pinned: number; superseded: number; byScope: Record<MemoryScope, number>; ftsEnabled: boolean } {
    const rows = this.db.prepare('SELECT scope, COUNT(*) AS c, SUM(pinned) AS p FROM memories WHERE superseded_by IS NULL GROUP BY scope').all() as unknown as {
      scope: string; c: number; p: number | null
    }[]
    const supRow = this.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE superseded_by IS NOT NULL').get() as { c: number }
    const byScope: Record<MemoryScope, number> = { user: 0, project: 0, ticket: 0 }
    let total = 0
    let pinned = 0
    for (const r of rows) {
      const c = Number(r.c)
      total += c
      pinned += Number(r.p ?? 0)
      if (r.scope === 'user' || r.scope === 'project' || r.scope === 'ticket') byScope[r.scope] = c
    }
    return { total, pinned, superseded: Number(supRow.c), byScope, ftsEnabled: this.ftsEnabled }
  }
}
