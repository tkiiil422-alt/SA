/**
 * 长期记忆与可进化技能库子系统插件（Memory & Skills Plugin）。
 *
 * 通过 `SubsystemPlugin` 协议零侵入式接入：
 * - HTTP API：`/api/memories/*`、`/api/skills/*`
 * - Director：自动召回注入长期偏好/话题记忆/技能目录 + 完整增删改查工具
 * - Worker：工单启动注入项目记忆与匹配技能 + 受工单令牌保护的 MCP 工具（`sa_memory_search`、`sa_memory_save`、`sa_skill_get`）
 * - 领域事件：监听 `ticket.ended` 自动沉淀工单复盘经验（`retro`）
 */
import { z } from 'zod'
import type { SubsystemPlugin } from '../plugins/types.ts'
import type { MemoryKind, MemoryScope, MemoryStore } from './store.ts'
import type { SkillScope, SkillStore } from '../skills/store.ts'
import { issuesOf } from '../admin/http.ts'

export interface MemoryPluginDeps {
  memories: MemoryStore
  skills: SkillStore
  redact: (text: string) => string
  /** 根据 ticketId 查工单摘要信息（用于 `ticket.ended` 自动复盘沉淀）。 */
  getTicketSummary?: (ticketId: string) => {
    title: string
    outcome?: string
    summary?: string
    projectId?: string
  } | undefined
  /** 将复盘动作安排在数据库事务提交后执行。 */
  afterCommit?: (fn: () => void) => void
}

const ScopeSchema = z.enum(['user', 'project', 'ticket'])
const KindSchema = z.enum(['preference', 'fact', 'pitfall', 'decision', 'retro'])
const SkillScopeSchema = z.enum(['director', 'worker', 'both'])

const MemoryCreateSchema = z.object({
  scope: ScopeSchema.default('user'),
  kind: KindSchema.default('fact'),
  projectId: z.string().trim().max(64).nullable().optional(),
  ticketId: z.string().trim().max(64).nullable().optional(),
  title: z.string().trim().min(1, '请填写记忆标题').max(160, '标题不能超过 160 字'),
  content: z.string().trim().min(1, '请填写记忆内容').max(8000, '内容不能超过 8000 字'),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  confidence: z.number().min(0.1).max(1).optional(),
  pinned: z.boolean().optional(),
}).strict()

const MemoryUpdateSchema = z.object({
  scope: ScopeSchema.optional(),
  kind: KindSchema.optional(),
  projectId: z.string().trim().max(64).nullable().optional(),
  title: z.string().trim().min(1, '标题不能为空').max(160).optional(),
  content: z.string().trim().min(1, '内容不能为空').max(8000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  confidence: z.number().min(0.1).max(1).optional(),
  pinned: z.boolean().optional(),
}).strict()

const SkillCreateSchema = z.object({
  slug: z.string().trim().max(60).optional(),
  name: z.string().trim().min(1, '请填写技能名称').max(120),
  description: z.string().trim().max(400).default(''),
  scope: SkillScopeSchema.default('both'),
  triggers: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  content: z.string().trim().min(1, '请填写技能步骤内容').max(20_000),
  enabled: z.boolean().default(true),
}).strict()

const SkillUpdateSchema = SkillCreateSchema.partial().strict()

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()) : [])
const parseScope = (v: unknown, fallback: MemoryScope): MemoryScope => (v === 'user' || v === 'project' || v === 'ticket' ? v : fallback)
const parseKind = (v: unknown, fallback: MemoryKind): MemoryKind => (v === 'preference' || v === 'fact' || v === 'pitfall' || v === 'decision' || v === 'retro' ? v : fallback)
const parseSkillScope = (v: unknown, fallback: SkillScope): SkillScope => (v === 'director' || v === 'worker' || v === 'both' ? v : fallback)

const SCOPE_LABEL: Record<MemoryScope, string> = { user: '全局', project: '项目', ticket: '工单' }
const KIND_LABEL: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  pitfall: '避坑',
  decision: '决策',
  retro: '复盘',
}

export function createMemoryAndSkillsPlugin(deps: MemoryPluginDeps): SubsystemPlugin {
  const { memories, skills, redact, getTicketSummary, afterCommit } = deps

  return {
    id: 'memory-skills',
    name: '长期记忆与技能库',
    description: '三层持久化记忆（全局偏好 / 项目经验 / 工单复盘）与可复用 SOP 技能库，支持混合召回、自动注入与工单复盘沉淀',
    version: '2.0.0',
    routesPrefix: '/memories',

    handleRoute: async ctx => {
      const { req, res, url, method, route, sendJson, parseJsonBody, invalid, decodeSegment, clampInt, events } = ctx

      // ---- 长期记忆 API ----
      if (route === '/memories' && method === 'GET') {
        const rawScope = url.searchParams.get('scope')
        const rawKind = url.searchParams.get('kind')
        const projectId = url.searchParams.get('projectId') || undefined
        const pinnedRaw = url.searchParams.get('pinned')
        const q = url.searchParams.get('q') || undefined
        const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
        const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000)
        const resList = memories.list({
          ...(rawScope === 'user' || rawScope === 'project' || rawScope === 'ticket' ? { scope: rawScope } : {}),
          ...(rawKind === 'preference' || rawKind === 'fact' || rawKind === 'pitfall' || rawKind === 'decision' || rawKind === 'retro' ? { kind: rawKind } : {}),
          ...(projectId ? { projectId } : {}),
          ...(pinnedRaw === '1' ? { pinned: true } : pinnedRaw === '0' ? { pinned: false } : {}),
          ...(q ? { q } : {}),
          limit,
          offset,
        })
        sendJson(res, 200, { ...resList, stats: memories.stats() })
        return true
      }

      if (route === '/memories/recall' && method === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        const projectId = url.searchParams.get('projectId') || undefined
        const limit = clampInt(url.searchParams.get('limit'), 8, 1, 20)
        const items = memories.recall({ query: q, ...(projectId ? { projectId } : {}), limit, recordUse: false })
        sendJson(res, 200, { items })
        return true
      }

      if (route === '/memories' && method === 'POST') {
        const parsed = MemoryCreateSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        const item = memories.save({
          scope: parsed.data.scope,
          kind: parsed.data.kind,
          ...(parsed.data.projectId !== undefined ? { projectId: parsed.data.projectId } : {}),
          ...(parsed.data.ticketId !== undefined ? { ticketId: parsed.data.ticketId } : {}),
          title: redact(parsed.data.title),
          content: redact(parsed.data.content),
          ...(parsed.data.tags ? { tags: parsed.data.tags } : {}),
          ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
          ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
          source: 'user',
        })
        try { events.add({ kind: 'memory.saved', level: 'info', text: `保存记忆「${item.title}」`, data: { id: item.id, scope: item.scope } }) } catch { /* ignore */ }
        sendJson(res, 200, { ok: true, item })
        return true
      }

      const memMatch = /^\/memories\/([^/]+)$/.exec(route)
      if (memMatch !== null) {
        const id = decodeSegment(memMatch[1] ?? '')
        if (!id) { sendJson(res, 400, { error: 'invalid_path', message: '记忆编号不合法。' }); return true }
        if (method === 'GET') {
          const item = memories.get(id)
          if (!item) { sendJson(res, 404, { error: 'not_found', message: '找不到这条记忆。' }); return true }
          sendJson(res, 200, { item })
          return true
        }
        if (method === 'PUT') {
          const parsed = MemoryUpdateSchema.safeParse(await parseJsonBody(req))
          if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
          const item = memories.update(id, {
            ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
            ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
            ...(parsed.data.projectId !== undefined ? { projectId: parsed.data.projectId } : {}),
            ...(parsed.data.title !== undefined ? { title: redact(parsed.data.title) } : {}),
            ...(parsed.data.content !== undefined ? { content: redact(parsed.data.content) } : {}),
            ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
            ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
            ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
          })
          if (!item) { sendJson(res, 404, { error: 'not_found', message: '找不到这条记忆。' }); return true }
          sendJson(res, 200, { ok: true, item })
          return true
        }
        if (method === 'DELETE') {
          if (!memories.delete(id)) { sendJson(res, 404, { error: 'not_found', message: '找不到这条记忆。' }); return true }
          sendJson(res, 200, { ok: true })
          return true
        }
        sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
        return true
      }

      // ---- 技能库 API ----
      if (route === '/skills' && method === 'GET') {
        const rawScope = url.searchParams.get('scope')
        const enabledRaw = url.searchParams.get('enabled')
        const q = url.searchParams.get('q') || undefined
        const limit = clampInt(url.searchParams.get('limit'), 100, 1, 200)
        sendJson(res, 200, skills.list({
          ...(rawScope === 'director' || rawScope === 'worker' || rawScope === 'both' ? { scope: rawScope } : {}),
          ...(enabledRaw === '1' ? { enabled: true } : enabledRaw === '0' ? { enabled: false } : {}),
          ...(q ? { q } : {}),
          limit,
        }))
        return true
      }

      if (route === '/skills' && method === 'POST') {
        const parsed = SkillCreateSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        const item = skills.save({
          ...(parsed.data.slug ? { slug: parsed.data.slug } : {}),
          name: parsed.data.name,
          description: parsed.data.description,
          scope: parsed.data.scope,
          triggers: parsed.data.triggers,
          tags: parsed.data.tags,
          content: redact(parsed.data.content),
          enabled: parsed.data.enabled,
        })
        try { events.add({ kind: 'skill.saved', level: 'info', text: `保存技能「${item.name}」(${item.slug})`, data: { id: item.id, slug: item.slug } }) } catch { /* ignore */ }
        sendJson(res, 200, { ok: true, item })
        return true
      }

      const skillMatch = /^\/skills\/([^/]+)$/.exec(route)
      if (skillMatch !== null) {
        const id = decodeSegment(skillMatch[1] ?? '')
        if (!id) { sendJson(res, 400, { error: 'invalid_path', message: '技能编号不合法。' }); return true }
        if (method === 'GET') {
          const item = skills.get(id) ?? skills.getBySlug(id)
          if (!item) { sendJson(res, 404, { error: 'not_found', message: '找不到这个技能。' }); return true }
          sendJson(res, 200, { item })
          return true
        }
        if (method === 'PUT') {
          const parsed = SkillUpdateSchema.safeParse(await parseJsonBody(req))
          if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
          const item = skills.update(id, {
            ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
            ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
            ...(parsed.data.triggers !== undefined ? { triggers: parsed.data.triggers } : {}),
            ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
            ...(parsed.data.content !== undefined ? { content: redact(parsed.data.content) } : {}),
            ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
          })
          if (!item) { sendJson(res, 404, { error: 'not_found', message: '找不到这个技能。' }); return true }
          sendJson(res, 200, { ok: true, item })
          return true
        }
        if (method === 'DELETE') {
          if (!skills.delete(id)) { sendJson(res, 404, { error: 'not_found', message: '找不到这个技能。' }); return true }
          sendJson(res, 200, { ok: true })
          return true
        }
        sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
        return true
      }

      return false
    },

    directorQueries: {
      memory_search: args => {
        const query = str(args.query) || str(args.q)
        const projectId = str(args.projectId) || undefined
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 8))
        const items = query
          ? memories.recall({ query, ...(projectId ? { projectId } : {}), limit, recordUse: true })
          : memories.list({ ...(projectId ? { projectId } : {}), limit }).items
        return { items, stats: memories.stats() }
      },
      memory_list: args => {
        const rawScope = args.scope
        const rawKind = args.kind
        const projectId = str(args.projectId) || undefined
        const q = str(args.q) || undefined
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 30))
        return {
          ...memories.list({
            ...(rawScope === 'user' || rawScope === 'project' || rawScope === 'ticket' ? { scope: rawScope } : {}),
            ...(rawKind === 'preference' || rawKind === 'fact' || rawKind === 'pitfall' || rawKind === 'decision' || rawKind === 'retro' ? { kind: rawKind } : {}),
            ...(projectId ? { projectId } : {}),
            ...(q ? { q } : {}),
            limit,
          }),
          stats: memories.stats(),
        }
      },
      skill_list: args => {
        const q = str(args.q) || undefined
        const rawScope = args.scope
        return skills.list({
          ...(rawScope === 'director' || rawScope === 'worker' || rawScope === 'both' ? { scope: rawScope } : {}),
          ...(q ? { q } : {}),
          limit: Math.max(1, Math.min(100, Number(args.limit) || 50)),
        })
      },
      skill_get: args => {
        const key = str(args.slug) || str(args.id) || str(args.name)
        if (!key) return { ok: false, error: '请提供技能 slug 或 id' }
        const hit = skills.get(key) ?? skills.getBySlug(key) ?? skills.match(key, 'director', 1, true)[0]
        if (!hit) return { ok: false, error: `未找到技能「${key}」` }
        skills.markUsed([hit.id])
        return { ok: true, item: hit }
      },
    },

    directorActions: {
      memory_save: args => {
        const title = str(args.title)
        const content = str(args.content)
        if (!title || !content) throw new Error('memory_save 需要提供 title 和 content')
        const item = memories.save({
          scope: parseScope(args.scope, args.projectId ? 'project' : 'user'),
          kind: parseKind(args.kind, 'preference'),
          projectId: str(args.projectId) || null,
          title: redact(title),
          content: redact(content),
          tags: strArr(args.tags),
          ...(typeof args.pinned === 'boolean' ? { pinned: args.pinned } : {}),
          source: 'director',
        })
        return { ok: true, item }
      },
      memory_update: args => {
        const id = str(args.id)
        if (!id) throw new Error('memory_update 缺少 id')
        const updated = memories.update(id, {
          ...(args.title !== undefined ? { title: redact(str(args.title)) } : {}),
          ...(args.content !== undefined ? { content: redact(str(args.content)) } : {}),
          ...(args.scope !== undefined ? { scope: parseScope(args.scope, 'user') } : {}),
          ...(args.kind !== undefined ? { kind: parseKind(args.kind, 'fact') } : {}),
          ...(args.tags !== undefined ? { tags: strArr(args.tags) } : {}),
          ...(typeof args.pinned === 'boolean' ? { pinned: args.pinned } : {}),
        })
        if (!updated) throw new Error(`找不到记忆 ${id}`)
        return { ok: true, item: updated }
      },
      memory_delete: args => {
        const id = str(args.id)
        if (!id) throw new Error('memory_delete 缺少 id')
        return { ok: memories.delete(id), id }
      },
      skill_save: args => {
        const name = str(args.name)
        const content = str(args.content)
        if (!name || !content) throw new Error('skill_save 需要提供 name 和 content')
        const item = skills.save({
          ...(str(args.slug) ? { slug: str(args.slug) } : {}),
          name,
          description: str(args.description),
          scope: parseSkillScope(args.scope, 'both'),
          triggers: strArr(args.triggers),
          tags: strArr(args.tags),
          content: redact(content),
          enabled: typeof args.enabled === 'boolean' ? args.enabled : true,
        })
        return { ok: true, item }
      },
      skill_delete: args => {
        const id = str(args.id)
        const target = id ? skills.get(id) : (str(args.slug) ? skills.getBySlug(str(args.slug)) : undefined)
        if (!target) throw new Error('找不到要删除的技能')
        return { ok: skills.delete(target.id), id: target.id, slug: target.slug }
      },
    },

    directorPromptSection: ctx => {
      const blocks: string[] = []
      const pinned = memories.list({ pinned: true, limit: 6 }).items
      const recalled = ctx.userMessage
        ? memories.recall({ query: ctx.userMessage, limit: 5, includePinned: false, recordUse: true })
        : []
      const seenIds = new Set(pinned.map(m => m.id))
      const relevant = recalled.filter(m => !seenIds.has(m.id))

      blocks.push(
        '## 长期记忆与技能库（已启用）',
        '- 查询动作（`platform_query`）：`memory_search({query,projectId?,limit?})`、`memory_list({scope?,kind?,q?})`、`skill_list({q?,scope?})`、`skill_get({slug|id})`',
        '- 写入动作（`subsystem_action`）：`memory_save({title,content,scope?:"user"|"project",kind?:"preference"|"fact"|"pitfall"|"decision",projectId?,tags?,pinned?})`、`memory_update`、`memory_delete`、`skill_save({name,slug?,description?,scope?,triggers?,content})`、`skill_delete`',
        '- 当主人明确交代长期偏好、环境约定或避坑经验时，主动用 `memory_save` 沉淀；当形成可复用操作 SOP 时，可建议或主动用 `skill_save` 沉淀为技能。',
      )

      if (pinned.length > 0) {
        blocks.push('', '### 置顶长期记忆（高优先级）')
        for (const m of pinned) {
          blocks.push(`- [${SCOPE_LABEL[m.scope]}·${KIND_LABEL[m.kind]}] **${m.title}**：${m.content.slice(0, 260)}`)
        }
      }
      if (relevant.length > 0) {
        blocks.push('', '### 与当前话题相关的历史记忆')
        for (const m of relevant) {
          blocks.push(`- [${SCOPE_LABEL[m.scope]}·${KIND_LABEL[m.kind]}] **${m.title}**：${m.content.slice(0, 240)}`)
        }
      }

      const enabledSkills = skills.list({ scope: 'director', enabled: true, limit: 15 }).items
      if (enabledSkills.length > 0) {
        blocks.push('', '### 可用技能索引（需要细节时调用 `skill_get`）')
        for (const sk of enabledSkills) {
          const tr = sk.triggers.length > 0 ? `（触发：${sk.triggers.slice(0, 4).join('/')}）` : ''
          blocks.push(`- \`${sk.slug}\` **${sk.name}**：${sk.description || '已沉淀 SOP'}${tr}`)
        }
      }
      return blocks.join('\n')
    },

    workerPromptSection: ctx => {
      const queryText = [ctx.title ?? '', ctx.promptText ?? ''].join(' ').trim()
      const recalled = memories.recall({
        query: queryText,
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        limit: 6,
        includePinned: true,
        recordUse: true,
      })
      const matchedSkills = queryText ? skills.match(queryText, 'worker', 3, true) : []
      if (recalled.length === 0 && matchedSkills.length === 0) {
        return [
          '## 平台长期记忆与技能工具',
          '- 你可以调用 MCP 工具 `sa_memory_search` 检索历史避坑经验与用户偏好，调用 `sa_memory_save` 沉淀新发现的重要项目约定或踩坑解法，调用 `sa_skill_get` 查阅可复用 SOP。',
        ].join('\n')
      }

      const lines: string[] = [
        '## 平台长期记忆与相关技能（自动召回，供执行参考）',
        '- 过程中可随时调用 MCP 工具 `sa_memory_search`、`sa_memory_save`、`sa_skill_get` 读写长期经验。',
      ]
      if (recalled.length > 0) {
        lines.push('', '### 相关历史记忆与项目避坑')
        for (const m of recalled) {
          lines.push(`- [${SCOPE_LABEL[m.scope]}·${KIND_LABEL[m.kind]}] **${m.title}**：${m.content.slice(0, 380)}`)
        }
      }
      if (matchedSkills.length > 0) {
        lines.push('', '### 匹配的参考技能（SOP）')
        let budget = 3600
        for (const sk of matchedSkills) {
          const body = sk.content.slice(0, Math.min(1400, budget))
          if (!body) break
          budget -= body.length
          lines.push(`#### ${sk.name} (\`${sk.slug}\`)`, body)
        }
      }
      return lines.join('\n')
    },

    registerWorkerMcpTools: (server, ctx) => {
      server.registerTool('sa_memory_search', {
        description: 'Search long-term platform memories (user preferences, project pitfalls, architecture decisions, and past ticket retrospectives).',
        inputSchema: z.strictObject({
          query: z.string().trim().min(1).max(400).describe('Keywords or topic to search.'),
          scope: z.enum(['user', 'project', 'ticket']).optional().describe('Optional scope filter.'),
          limit: z.number().int().min(1).max(15).optional().describe('Max records to return (default 6).'),
        }),
      }, async args => {
        const items = memories.recall({
          query: args.query,
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
          ...(args.scope ? { scopes: [args.scope] } : {}),
          limit: args.limit ?? 6,
          recordUse: true,
        })
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              items: items.map(m => ({
                id: m.id,
                scope: m.scope,
                kind: m.kind,
                title: m.title,
                content: m.content,
                tags: m.tags,
                pinned: m.pinned,
              })),
            }),
          }],
        }
      })

      server.registerTool('sa_memory_save', {
        description: 'Save a durable engineering pitfall, architecture decision, or project convention into long-term memory so future tickets avoid repeating mistakes. Never store secrets.',
        inputSchema: z.strictObject({
          title: z.string().trim().min(1).max(160).describe('Concise title summarizing the lesson or fact.'),
          content: z.string().trim().min(1).max(4000).describe('Actionable details, commands, or constraints.'),
          scope: z.enum(['user', 'project', 'ticket']).optional().describe('Defaults to project when bound to a project, otherwise ticket.'),
          kind: z.enum(['preference', 'fact', 'pitfall', 'decision', 'retro']).optional().describe('Defaults to pitfall.'),
          tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
        }),
      }, async args => {
        const scope: MemoryScope = args.scope ?? (ctx.projectId ? 'project' : 'ticket')
        const saved = memories.save({
          scope,
          kind: args.kind ?? 'pitfall',
          projectId: scope === 'project' ? (ctx.projectId ?? null) : null,
          ticketId: ctx.ticketId,
          title: redact(args.title),
          content: redact(args.content),
          ...(args.tags ? { tags: args.tags } : {}),
          source: 'worker',
        })
        return {
          content: [{ type: 'text', text: JSON.stringify({ saved: true, id: saved.id, scope: saved.scope, title: saved.title }) }],
        }
      })

      server.registerTool('sa_skill_get', {
        description: 'Look up a reusable platform SOP / Skill by slug or topic keywords.',
        inputSchema: z.strictObject({
          query: z.string().trim().min(1).max(200).describe('Skill slug, name, or keywords.'),
        }),
      }, async args => {
        const hit = skills.getBySlug(args.query) ?? skills.get(args.query) ?? skills.match(args.query, 'worker', 1, true)[0]
        if (!hit) {
          return { content: [{ type: 'text', text: JSON.stringify({ found: false, available: skills.list({ scope: 'worker', enabled: true, limit: 20 }).items.map(s => ({ slug: s.slug, name: s.name })) }) }] }
        }
        skills.markUsed([hit.id])
        return {
          content: [{ type: 'text', text: JSON.stringify({ found: true, slug: hit.slug, name: hit.name, description: hit.description, content: hit.content }) }],
        }
      })
    },

    onDomainEvent: event => {
      if (event.type !== 'ticket.ended' || !getTicketSummary) return
      const runRetro = (): void => {
        const info = getTicketSummary(event.data.ticketId)
        if (!info) return
        if (info.outcome === 'stopped' || info.outcome === 'abandoned') return
        const summary = redact((info.summary ?? '').trim())
        if (summary.length < 12) return
        const outcomeLabel = info.outcome === 'failed' ? '失败教训' : '完工复盘'
        memories.save({
          scope: info.projectId ? 'project' : 'ticket',
          kind: 'retro',
          projectId: info.projectId ?? null,
          ticketId: event.data.ticketId,
          title: `${outcomeLabel}：${redact(info.title).slice(0, 120)}`,
          content: summary.slice(0, 1800),
          tags: [info.outcome === 'failed' ? 'failed' : 'completed', 'auto-retro'],
          confidence: info.outcome === 'failed' ? 0.8 : 0.75,
          source: 'auto_retro',
        })
      }
      if (afterCommit) afterCommit(runRetro)
      else runRetro()
    },
  }
}
