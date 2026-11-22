/**
 * 三层长期记忆存储与混合检索引擎（SQLite + FTS5 + CJK 片段打分）。
 *
 * 作用域三层划分：
 * - `user`：跨项目的全局偏好、常用环境、沟通习惯、系统约束；
 * - `project`：绑定具体 `projectId` 的代码库约定、构建部署坑点、架构决策；
 * - `ticket`：单次工单提炼的复盘经验（`retro`）与事实片段。
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
}

export interface MemoryListQuery {
  scope?: MemoryScope
  kind?: MemoryKind
  projectId?: string
  pinned?: boolean
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
  created_at: string
  updated_at: string
}

function makeId(): string {
  return `mem_${randomBytes(6).toString('hex')}`
}

function cleanTags(tags?: readonly string[]): string[] {
  if (!tags) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim().slice(0, 40)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
    if (out.length >= 20) break
  }
  return out
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags_json)
    if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string')
  } catch { /* ignore malformed json */ }
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    kind: row.kind as MemoryKind,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    title: row.title,
    content: row.content,
    tags,
    confidence: row.confidence,
    pinned: row.pinned === 1,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 提取查询词项：同时保留英文/数字标识词，以及中文连续片段的 2-gram / 整词，
 * 避免 SQLite 默认 unicode61 对无空格中文召回率低的问题。
 */
export function extractSearchTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const terms = new Set<string>()
  // 英文 / 数字 / 标识符词
  for (const m of normalized.matchAll(/[a-z0-9_.-]{2,}/g)) {
    terms.add(m[0])
  }
  // 中文片段与 2-gram
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

/** 构造安全的 FTS5 MATCH 表达式（仅放英数词项，用引号包裹防语法注入）。 */
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_ticket ON memories(ticket_id);
    `)

    // 尝试启用 SQLite FTS5 全文索引与自动触发器；若宿主 SQLite 未编译 FTS5 则平滑降级至混合词项评分。
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

  /** 新增一条记忆；若同作用域、同项目下已有完全同名标题，则合并更新，防止重复堆积。 */
  save(input: MemoryCreateInput, now = new Date()): MemoryRecord {
    const title = input.title.trim().slice(0, 160)
    const content = input.content.trim().slice(0, 8_000)
    if (!title) throw new Error('记忆标题不能为空')
    if (!content) throw new Error('记忆内容不能为空')
    const projectId = input.scope === 'project' ? (input.projectId?.trim() || null) : (input.projectId?.trim() || null)
    const ticketId = input.ticketId?.trim() || null
    const tags = cleanTags(input.tags)
    const confidence = Math.max(0.1, Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : 0.85))
    const pinned = input.pinned ? 1 : 0
    const source = (input.source ?? 'user').trim().slice(0, 40) || 'user'
    const iso = now.toISOString()

    // 检查是否存在同类同标题记忆以便去重合并
    const existing = this.db.prepare(`
      SELECT * FROM memories
      WHERE scope = ? AND COALESCE(project_id, '') = COALESCE(?, '') AND lower(title) = lower(?)
      LIMIT 1
    `).get(input.scope, projectId, title) as MemoryRow | undefined

    if (existing) {
      const mergedTags = cleanTags([...rowToRecord(existing).tags, ...tags])
      this.db.prepare(`
        UPDATE memories
        SET kind = ?, content = ?, tags_json = ?, confidence = ?, pinned = ?,
            ticket_id = COALESCE(?, ticket_id), source = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.kind,
        content,
        JSON.stringify(mergedTags),
        Math.max(existing.confidence, confidence),
        input.pinned === undefined ? existing.pinned : pinned,
        ticketId,
        source,
        iso,
        existing.id,
      )
      return this.get(existing.id)!
    }

    const id = makeId()
    this.db.prepare(`
      INSERT INTO memories (
        id, scope, kind, project_id, ticket_id, title, content, tags_json,
        confidence, pinned, use_count, last_used_at, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
    `).run(
      id, input.scope, input.kind, projectId, ticketId, title, content,
      JSON.stringify(tags), confidence, pinned, source, iso, iso,
    )
    return this.get(id)!
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
    const tags = patch.tags !== undefined ? cleanTags(patch.tags) : cur.tags
    const confidence = patch.confidence !== undefined
      ? Math.max(0.1, Math.min(1, Number(patch.confidence)))
      : cur.confidence
    const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : (cur.pinned ? 1 : 0)
    const iso = now.toISOString()

    this.db.prepare(`
      UPDATE memories
      SET scope = ?, kind = ?, project_id = ?, title = ?, content = ?, tags_json = ?,
          confidence = ?, pinned = ?, updated_at = ?
      WHERE id = ?
    `).run(scope, kind, projectId, title, content, JSON.stringify(tags), confidence, pinned, iso, id)
    return this.get(id)
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  /** 按条件过滤与搜索列表。 */
  list(query: MemoryListQuery = {}): { items: MemoryRecord[]; total: number } {
    const where: string[] = []
    const params: (string | number)[] = []
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
   * 智能上下文召回：结合 FTS5 倒排 + CJK/英文词项打分 + 作用域权重 + 置顶权重。
   */
  recall(opts: MemoryRecallOptions): MemoryRecord[] {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 6))
    const terms = extractSearchTerms(opts.query)
    const allowedScopes = opts.scopes && opts.scopes.length > 0 ? new Set(opts.scopes) : undefined

    // 1) FTS5 命中集（英文/精准词项）
    const ftsHitIds = new Set<string>()
    if (this.ftsEnabled && terms.length > 0) {
      const ftsExpr = buildFtsQuery(terms)
      if (ftsExpr) {
        try {
          const hitRows = this.db.prepare(`
            SELECT m.id FROM memories_fts f
            JOIN memories m ON m.rowid = f.rowid
            WHERE memories_fts MATCH ?
            LIMIT 40
          `).all(ftsExpr) as unknown as { id: string }[]
          for (const h of hitRows) ftsHitIds.add(h.id)
        } catch {
          // FTS 查询语法异常时平滑降级到词项打分
        }
      }
    }

    // 2) 拉取候选池（最近 300 条 + 全部置顶 + 当前项目记忆）
    const rows = this.db.prepare(`
      SELECT * FROM memories
      ORDER BY pinned DESC, updated_at DESC
      LIMIT 300
    `).all() as unknown as MemoryRow[]

    const nowMs = Date.now()
    const scored: { rec: MemoryRecord; score: number }[] = []

    for (const row of rows) {
      const rec = rowToRecord(row)
      if (allowedScopes && !allowedScopes.has(rec.scope)) continue
      // 指定了 projectId 时，排除绑定到“其他项目”的专属记忆，防止跨项目串台
      if (rec.scope === 'project' && rec.projectId && opts.projectId && rec.projectId !== opts.projectId) continue
      if (rec.scope === 'project' && rec.projectId && !opts.projectId && !rec.pinned) continue

      const titleL = rec.title.toLowerCase()
      const contentL = rec.content.toLowerCase()
      const tagsL = rec.tags.map(t => t.toLowerCase())

      let score = 0
      let lexicalHit = false
      if (ftsHitIds.has(rec.id)) {
        score += 2.2
        lexicalHit = true
      }

      for (const term of terms) {
        if (titleL.includes(term)) { score += 3.0; lexicalHit = true }
        if (tagsL.some(t => t.includes(term))) { score += 2.5; lexicalHit = true }
        if (contentL.includes(term)) { score += 1.1; lexicalHit = true }
      }

      // 置顶项或项目绑定项的基础权重
      if (rec.pinned && (opts.includePinned ?? true)) score += 2.0
      if (opts.projectId && rec.projectId === opts.projectId) score += 2.4
      if (rec.scope === 'user' && rec.kind === 'preference' && rec.pinned) score += 1.0

      // 如果有查询词但既不置顶、又不属于当前项目、也没命中任何词项，则不强行召回噪音
      if (terms.length > 0 && !lexicalHit && !rec.pinned && !(opts.projectId && rec.projectId === opts.projectId)) {
        continue
      }
      if (score <= 0) continue

      // 置信度与时间衰减微调（30 天内轻微加分）
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

  /** 记录记忆被注入或检索使用，便于统计价值。 */
  markUsed(ids: readonly string[], now = new Date()): void {
    if (ids.length === 0) return
    const iso = now.toISOString()
    const stmt = this.db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(iso, id)
  }

  /** 获取统计摘要（供总控自省或控制台展示）。 */
  stats(): { total: number; pinned: number; byScope: Record<MemoryScope, number>; ftsEnabled: boolean } {
    const rows = this.db.prepare('SELECT scope, COUNT(*) AS c, SUM(pinned) AS p FROM memories GROUP BY scope').all() as unknown as {
      scope: string; c: number; p: number | null
    }[]
    const byScope: Record<MemoryScope, number> = { user: 0, project: 0, ticket: 0 }
    let total = 0
    let pinned = 0
    for (const r of rows) {
      const c = Number(r.c)
      total += c
      pinned += Number(r.p ?? 0)
      if (r.scope === 'user' || r.scope === 'project' || r.scope === 'ticket') byScope[r.scope] = c
    }
    return { total, pinned, byScope, ftsEnabled: this.ftsEnabled }
  }
}
