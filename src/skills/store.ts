/**
 * 可进化技能库（Skills / Playbooks）存储与 Markdown 文件同步。
 *
 * 每条技能同时持久化在 SQLite（用于高速过滤、统计与 API 管理）与 `<stateDir>/skills/<slug>.md`
 * （人类可读、带 YAML frontmatter、可直接随目录备份或版本管理）。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { SkillRecord, SkillScope, SkillVersionRecord } from '../shared/api-types.ts'
import { extractSearchTerms } from '../memory/store.ts'

export type { SkillRecord, SkillScope, SkillVersionRecord }

export interface SkillCreateInput {
  slug?: string
  name: string
  description: string
  scope?: SkillScope
  triggers?: string[]
  tags?: string[]
  content: string
  enabled?: boolean
}

export interface SkillUpdateInput {
  slug?: string
  name?: string
  description?: string
  scope?: SkillScope
  triggers?: string[]
  tags?: string[]
  content?: string
  enabled?: boolean
}

interface SkillRow {
  id: string
  slug: string
  name: string
  description: string
  scope: string
  triggers_json: string
  tags_json: string
  content: string
  enabled: number
  active_version: number
  previous_version: number | null
  use_count: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}

interface SkillVersionRow {
  skill_id: string
  version: number
  status: string
  content: string
  triggers_json: string
  source: string
  reason: string
  eval_report_json: string | null
  created_at: string
}

function makeId(): string {
  return `sk_${randomBytes(5).toString('hex')}`
}

/** 将名称或自定义标识规范化为安全的 kebab-case 文件名 slug。 */
export function normalizeSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || `skill-${randomBytes(3).toString('hex')}`
}

function cleanList(items?: readonly string[], max = 20): string[] {
  if (!items) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const s = raw.trim().slice(0, 60)
    if (!s || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

function parseJsonStrings(raw: string): string[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToSkill(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    scope: row.scope as SkillScope,
    triggers: parseJsonStrings(row.triggers_json),
    tags: parseJsonStrings(row.tags_json),
    content: row.content,
    enabled: row.enabled === 1,
    activeVersion: row.active_version ?? 1,
    previousVersion: row.previous_version ?? null,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToVersion(row: SkillVersionRow): SkillVersionRecord {
  let evalReport: Record<string, unknown> | null = null
  if (row.eval_report_json) {
    try { evalReport = JSON.parse(row.eval_report_json) as Record<string, unknown> } catch { evalReport = null }
  }
  return {
    skillId: row.skill_id,
    version: row.version,
    status: row.status as SkillVersionRecord['status'],
    content: row.content,
    triggers: parseJsonStrings(row.triggers_json),
    source: row.source,
    reason: row.reason,
    evalReport,
    createdAt: row.created_at,
  }
}

function formatSkillMarkdown(skill: SkillRecord): string {
  const quote = (s: string): string => JSON.stringify(s)
  return [
    '---',
    `id: ${quote(skill.id)}`,
    `slug: ${quote(skill.slug)}`,
    `name: ${quote(skill.name)}`,
    `description: ${quote(skill.description)}`,
    `scope: ${quote(skill.scope)}`,
    `enabled: ${skill.enabled}`,
    `triggers: ${JSON.stringify(skill.triggers)}`,
    `tags: ${JSON.stringify(skill.tags)}`,
    `updatedAt: ${quote(skill.updatedAt)}`,
    '---',
    '',
    skill.content.trim(),
    '',
  ].join('\n')
}

export class SkillStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly skillsDir?: string,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'both',
        triggers_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        active_version INTEGER NOT NULL DEFAULT 1,
        previous_version INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled, updated_at DESC);

      CREATE TABLE IF NOT EXISTS skill_versions (
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        triggers_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'manual',
        reason TEXT NOT NULL DEFAULT '',
        eval_report_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (skill_id, version)
      );

      CREATE TABLE IF NOT EXISTS ticket_skill_uses (
        ticket_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_slug TEXT NOT NULL,
        skill_version INTEGER NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, skill_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_skill_uses_skill ON ticket_skill_uses(skill_id, used_at DESC);
    `)
    this.ensureMigrations()
    if (this.skillsDir) {
      mkdirSync(this.skillsDir, { recursive: true })
    }
  }

  private ensureMigrations(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(skills)').all() as unknown as { name: string }[]).map(c => c.name),
    )
    if (!cols.has('active_version')) this.db.exec('ALTER TABLE skills ADD COLUMN active_version INTEGER NOT NULL DEFAULT 1')
    if (!cols.has('previous_version')) this.db.exec('ALTER TABLE skills ADD COLUMN previous_version INTEGER')
  }

  private syncFile(skill: SkillRecord, previousSlug?: string): void {
    if (!this.skillsDir) return
    try {
      mkdirSync(this.skillsDir, { recursive: true })
      if (previousSlug && previousSlug !== skill.slug) {
        rmSync(join(this.skillsDir, `${previousSlug}.md`), { force: true })
      }
      writeFileSync(join(this.skillsDir, `${skill.slug}.md`), formatSkillMarkdown(skill), 'utf8')
    } catch {
      // 文件镜像为尽力同步，不影响主库事务
    }
  }

  private removeFile(slug: string): void {
    if (!this.skillsDir) return
    try {
      rmSync(join(this.skillsDir, `${slug}.md`), { force: true })
    } catch { /* ignore */ }
  }

  /** 创建或按 slug 覆盖保存一条技能。 */
  save(input: SkillCreateInput, now = new Date()): SkillRecord {
    const name = input.name.trim().slice(0, 120)
    const description = input.description.trim().slice(0, 400)
    const content = input.content.trim().slice(0, 20_000)
    if (!name) throw new Error('技能名称不能为空')
    if (!content) throw new Error('技能内容不能为空')
    const slug = normalizeSlug(input.slug?.trim() || name)
    const scope: SkillScope = input.scope ?? 'both'
    const triggers = cleanList(input.triggers)
    const tags = cleanList(input.tags)
    const enabled = input.enabled === false ? 0 : 1
    const iso = now.toISOString()

    const existing = this.getBySlug(slug)
    if (existing) {
      const nextVer = this.nextVersionNumber(existing.id)
      this.db.prepare(`UPDATE skill_versions SET status = 'previous' WHERE skill_id = ? AND status = 'active'`).run(existing.id)
      this.db.prepare(`
        INSERT OR REPLACE INTO skill_versions (skill_id, version, status, content, triggers_json, source, reason, eval_report_json, created_at)
        VALUES (?, ?, 'active', ?, ?, 'manual', '直接保存更新技能', NULL, ?)
      `).run(existing.id, nextVer, content, JSON.stringify(triggers), iso)
      this.db.prepare(`
        UPDATE skills
        SET name = ?, description = ?, scope = ?, triggers_json = ?, tags_json = ?,
            content = ?, enabled = ?, active_version = ?, previous_version = ?, updated_at = ?
        WHERE id = ?
      `).run(name, description, scope, JSON.stringify(triggers), JSON.stringify(tags), content, enabled, nextVer, existing.activeVersion, iso, existing.id)
      const updated = this.get(existing.id)!
      this.syncFile(updated)
      return updated
    }

    const id = makeId()
    this.db.prepare(`
      INSERT INTO skills (
        id, slug, name, description, scope, triggers_json, tags_json,
        content, enabled, active_version, previous_version, use_count, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, NULL, ?, ?)
    `).run(id, slug, name, description, scope, JSON.stringify(triggers), JSON.stringify(tags), content, enabled, iso, iso)
    this.db.prepare(`
      INSERT OR REPLACE INTO skill_versions (skill_id, version, status, content, triggers_json, source, reason, eval_report_json, created_at)
      VALUES (?, 1, 'active', ?, ?, 'manual', '初始版本', NULL, ?)
    `).run(id, content, JSON.stringify(triggers), iso)
    const created = this.get(id)!
    this.syncFile(created)
    return created
  }

  get(id: string): SkillRecord | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined
    return row ? rowToSkill(row) : undefined
  }

  getBySlug(slug: string): SkillRecord | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE slug = ?').get(normalizeSlug(slug)) as SkillRow | undefined
    return row ? rowToSkill(row) : undefined
  }

  update(id: string, patch: SkillUpdateInput, now = new Date()): SkillRecord | undefined {
    const cur = this.get(id)
    if (!cur) return undefined
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 120) : cur.name
    const description = patch.description !== undefined ? patch.description.trim().slice(0, 400) : cur.description
    const content = patch.content !== undefined ? patch.content.trim().slice(0, 20_000) : cur.content
    if (!name) throw new Error('技能名称不能为空')
    if (!content) throw new Error('技能内容不能为空')
    const slug = patch.slug !== undefined ? normalizeSlug(patch.slug) : cur.slug
    const scope = patch.scope ?? cur.scope
    const triggers = patch.triggers !== undefined ? cleanList(patch.triggers) : cur.triggers
    const tags = patch.tags !== undefined ? cleanList(patch.tags) : cur.tags
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (cur.enabled ? 1 : 0)
    const iso = now.toISOString()

    this.db.prepare(`
      UPDATE skills
      SET slug = ?, name = ?, description = ?, scope = ?, triggers_json = ?, tags_json = ?,
          content = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(slug, name, description, scope, JSON.stringify(triggers), JSON.stringify(tags), content, enabled, iso, id)
    const updated = this.get(id)!
    this.syncFile(updated, cur.slug)
    return updated
  }

  delete(id: string): boolean {
    const cur = this.get(id)
    if (!cur) return false
    const res = this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
    if (Number(res.changes) > 0) {
      this.removeFile(cur.slug)
      return true
    }
    return false
  }

  list(filter: { scope?: SkillScope; enabled?: boolean; q?: string; limit?: number } = {}): { items: SkillRecord[]; total: number } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.scope && filter.scope !== 'both') {
      where.push("(scope = ? OR scope = 'both')")
      params.push(filter.scope)
    }
    if (filter.enabled !== undefined) {
      where.push('enabled = ?')
      params.push(filter.enabled ? 1 : 0)
    }
    const q = filter.q?.trim()
    if (q) {
      where.push('(name LIKE ? OR slug LIKE ? OR description LIKE ? OR triggers_json LIKE ? OR content LIKE ?)')
      const like = `%${q}%`
      params.push(like, like, like, like, like)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM skills ${clause}`).get(...params) as { c: number }
    const limit = Math.max(1, Math.min(200, filter.limit ?? 100))
    const rows = this.db.prepare(`
      SELECT * FROM skills ${clause}
      ORDER BY enabled DESC, use_count DESC, updated_at DESC
      LIMIT ?
    `).all(...params, limit) as unknown as SkillRow[]
    return { items: rows.map(rowToSkill), total: Number(totalRow.c) }
  }

  /** 根据用户指令或任务文本匹配最相关的启用技能。 */
  match(query: string, scope: 'director' | 'worker', limit = 3, recordUse = false): SkillRecord[] {
    const qLower = query.trim().toLowerCase()
    if (!qLower) return []
    const terms = extractSearchTerms(query)
    const { items } = this.list({ scope, enabled: true, limit: 100 })
    const scored: { skill: SkillRecord; score: number }[] = []

    for (const skill of items) {
      let score = 0
      // 触发词完整包含命中给最高分
      for (const trig of skill.triggers) {
        const tl = trig.toLowerCase()
        if (tl && qLower.includes(tl)) score += 5.0
      }
      const nameL = skill.name.toLowerCase()
      const slugL = skill.slug.toLowerCase()
      const descL = skill.description.toLowerCase()
      const tagsL = skill.tags.map(t => t.toLowerCase())
      if (qLower.includes(slugL) || qLower.includes(nameL)) score += 4.5
      for (const term of terms) {
        if (nameL.includes(term)) score += 2.2
        if (tagsL.some(t => t.includes(term))) score += 2.0
        if (descL.includes(term)) score += 1.0
      }
      if (score > 0) scored.push({ skill, score })
    }

    scored.sort((a, b) => b.score - a.score || b.skill.useCount - a.skill.useCount)
    const picked = scored.slice(0, limit).map(s => s.skill)
    if (recordUse && picked.length > 0) this.markUsed(picked.map(s => s.id))
    return picked
  }

  markUsed(ids: readonly string[], now = new Date()): void {
    if (ids.length === 0) return
    const iso = now.toISOString()
    const stmt = this.db.prepare('UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(iso, id)
  }

  private nextVersionNumber(skillId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS m FROM skill_versions WHERE skill_id = ?').get(skillId) as { m: number }
    return Math.max(Number(row.m), this.get(skillId)?.activeVersion ?? 0) + 1
  }

  /** 列出某个技能的所有版本（含当前生效版、上一版、候选版与回退版）。 */
  listVersions(skillId: string): SkillVersionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version ASC',
    ).all(skillId) as unknown as SkillVersionRow[]
    return rows.map(rowToVersion)
  }

  getVersion(skillId: string, version: number): SkillVersionRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?',
    ).get(skillId, version) as SkillVersionRow | undefined
    return row ? rowToVersion(row) : undefined
  }

  /** 创建一条候选技能修订（不直接覆盖当前生效版，待历史样例评测对比通过后再切换）。 */
  createCandidateVersion(
    skillId: string,
    input: { content: string; triggers?: string[]; source: string; reason: string },
    now = new Date(),
  ): SkillVersionRecord {
    const cur = this.get(skillId)
    if (!cur) throw new Error(`找不到技能 ${skillId}`)
    const version = this.nextVersionNumber(skillId)
    const triggers = input.triggers ? cleanList(input.triggers) : cur.triggers
    const iso = now.toISOString()
    this.db.prepare(`
      INSERT INTO skill_versions (skill_id, version, status, content, triggers_json, source, reason, eval_report_json, created_at)
      VALUES (?, ?, 'candidate', ?, ?, ?, ?, NULL, ?)
    `).run(skillId, version, input.content.trim().slice(0, 20_000), JSON.stringify(triggers), input.source.trim() || 'evolution', input.reason.trim().slice(0, 600), iso)
    return this.getVersion(skillId, version)!
  }

  /** 激活指定候选版本，并把原生效版保留为 `previous` 以便随时回退。 */
  promoteVersion(
    skillId: string,
    version: number,
    evalReport?: Record<string, unknown>,
    now = new Date(),
  ): SkillRecord {
    const cur = this.get(skillId)
    if (!cur) throw new Error(`找不到技能 ${skillId}`)
    const target = this.getVersion(skillId, version)
    if (!target) throw new Error(`找不到技能 ${skillId} 的版本 v${version}`)
    const iso = now.toISOString()

    // 确保原生效版本在 skill_versions 里有完整快照
    if (!this.getVersion(skillId, cur.activeVersion)) {
      this.db.prepare(`
        INSERT OR REPLACE INTO skill_versions (skill_id, version, status, content, triggers_json, source, reason, eval_report_json, created_at)
        VALUES (?, ?, 'previous', ?, ?, 'legacy', '升级前自动归档', NULL, ?)
      `).run(skillId, cur.activeVersion, cur.content, JSON.stringify(cur.triggers), cur.updatedAt)
    } else {
      this.db.prepare(`UPDATE skill_versions SET status = 'previous' WHERE skill_id = ? AND version = ?`).run(skillId, cur.activeVersion)
    }

    this.db.prepare(`
      UPDATE skill_versions SET status = 'active', eval_report_json = ? WHERE skill_id = ? AND version = ?
    `).run(evalReport ? JSON.stringify(evalReport) : null, skillId, version)

    this.db.prepare(`
      UPDATE skills
      SET content = ?, triggers_json = ?, active_version = ?, previous_version = ?, updated_at = ?
      WHERE id = ?
    `).run(target.content, JSON.stringify(target.triggers), version, cur.activeVersion, iso, skillId)

    const updated = this.get(skillId)!
    this.syncFile(updated)
    return updated
  }

  /** 标记某候选版本评测退化/未通过，保留当前生效版不变。 */
  rejectVersion(skillId: string, version: number, evalReport?: Record<string, unknown>): SkillVersionRecord | undefined {
    this.db.prepare(`
      UPDATE skill_versions SET status = 'rejected', eval_report_json = ? WHERE skill_id = ? AND version = ?
    `).run(evalReport ? JSON.stringify(evalReport) : null, skillId, version)
    return this.getVersion(skillId, version)
  }

  /** 回退到上一版生效版本（发现线上或评测退化时恢复旧版）。 */
  rollbackVersion(skillId: string, reason = '检测到退化，回退至上一稳定版', now = new Date()): SkillRecord {
    const cur = this.get(skillId)
    if (!cur) throw new Error(`找不到技能 ${skillId}`)
    const prevVer = cur.previousVersion
    if (!prevVer) throw new Error(`技能「${cur.name}」没有可回退的上一版本`)
    const prev = this.getVersion(skillId, prevVer)
    if (!prev) throw new Error(`找不到上一版本 v${prevVer} 的快照`)
    const iso = now.toISOString()

    this.db.prepare(`UPDATE skill_versions SET status = 'rolled_back', reason = ? WHERE skill_id = ? AND version = ?`)
      .run(reason.slice(0, 600), skillId, cur.activeVersion)
    this.db.prepare(`UPDATE skill_versions SET status = 'active' WHERE skill_id = ? AND version = ?`)
      .run(skillId, prevVer)
    this.db.prepare(`
      UPDATE skills
      SET content = ?, triggers_json = ?, active_version = ?, previous_version = ?, updated_at = ?
      WHERE id = ?
    `).run(prev.content, JSON.stringify(prev.triggers), prevVer, cur.activeVersion, iso, skillId)

    const updated = this.get(skillId)!
    this.syncFile(updated)
    return updated
  }

  /** 记录工单实际使用的技能版本号，供审计与退化追踪。 */
  recordTicketUse(ticketId: string, skill: Pick<SkillRecord, 'id' | 'slug' | 'activeVersion'>, now = new Date()): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO ticket_skill_uses (ticket_id, skill_id, skill_slug, skill_version, used_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(ticketId, skill.id, skill.slug, skill.activeVersion, now.toISOString())
  }

  listTicketSkillUses(ticketId: string): { skillId: string; skillSlug: string; skillVersion: number; usedAt: string }[] {
    const rows = this.db.prepare(
      'SELECT skill_id, skill_slug, skill_version, used_at FROM ticket_skill_uses WHERE ticket_id = ? ORDER BY used_at ASC',
    ).all(ticketId) as unknown as { skill_id: string; skill_slug: string; skill_version: number; used_at: string }[]
    return rows.map(r => ({
      skillId: r.skill_id,
      skillSlug: r.skill_slug,
      skillVersion: r.skill_version,
      usedAt: r.used_at,
    }))
  }
}
