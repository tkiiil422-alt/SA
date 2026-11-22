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
import type { SkillRecord, SkillScope } from '../shared/api-types.ts'
import { extractSearchTerms } from '../memory/store.ts'

export type { SkillRecord, SkillScope }

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
  use_count: number
  last_used_at: string | null
  created_at: string
  updated_at: string
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
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled, updated_at DESC);
    `)
    if (this.skillsDir) {
      mkdirSync(this.skillsDir, { recursive: true })
    }
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
      this.db.prepare(`
        UPDATE skills
        SET name = ?, description = ?, scope = ?, triggers_json = ?, tags_json = ?,
            content = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(name, description, scope, JSON.stringify(triggers), JSON.stringify(tags), content, enabled, iso, existing.id)
      const updated = this.get(existing.id)!
      this.syncFile(updated)
      return updated
    }

    const id = makeId()
    this.db.prepare(`
      INSERT INTO skills (
        id, slug, name, description, scope, triggers_json, tags_json,
        content, enabled, use_count, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
    `).run(id, slug, name, description, scope, JSON.stringify(triggers), JSON.stringify(tags), content, enabled, iso, iso)
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
}
