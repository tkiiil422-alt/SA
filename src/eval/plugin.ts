/**
 * 自进化与评测子系统插件（Evolution & Benchmarks Plugin）。
 *
 * 统一暴露 V2.3 能力（停用后路由、工具与提示词同步退出）：
 * - `/api/evolution/skills/:id/versions` / `candidate` / `rollback`
 * - `/api/evolution/proposals` / `gap` / `:id/approve`
 * - `/api/evolution/benchmarks` / `run`
 */
import { z } from 'zod'
import type { SubsystemPlugin } from '../plugins/types.ts'
import type { SkillStore } from '../skills/store.ts'
import type { SkillEvolutionService } from '../skills/evolution.ts'
import type { PluginEvolutionService } from '../plugins/evolution.ts'
import { coreBenchmarkCases, type BenchmarkStore } from './benchmarks.ts'
import { issuesOf } from '../admin/http.ts'

export interface EvolutionPluginDeps {
  skills: SkillStore
  skillEvolution: SkillEvolutionService
  pluginEvolution: PluginEvolutionService
  benchmarks: BenchmarkStore
}

const CandidateSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  triggers: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  source: z.enum(['user_correction', 'repeated_rework', 'repeated_success', 'manual']).default('user_correction'),
  reason: z.string().trim().min(1).max(600),
}).strict()

const GapSchema = z.object({
  gapKey: z.string().trim().min(1).max(80),
  pluginName: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(600),
  sampleTask: z.string().trim().min(1).max(400),
  projectId: z.string().trim().max(64).optional(),
  externalWritePermissions: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  irreversibleMigration: z.boolean().optional(),
}).strict()

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function createEvolutionPlugin(deps: EvolutionPluginDeps): SubsystemPlugin {
  const { skills, skillEvolution, pluginEvolution, benchmarks } = deps

  return {
    id: 'evolution',
    name: '自进化与持续评测引擎',
    description: '技能版本候选与历史样例对比切换/回退、重复能力缺口自动发起插件研发提案、典型任务基准评测对比',
    version: '2.3.0',
    routesPrefix: '/evolution',

    handleRoute: async ctx => {
      const { req, res, method, route, sendJson, parseJsonBody, invalid, decodeSegment } = ctx
      if (!route.startsWith('/evolution')) return false

      const skVer = /^\/evolution\/skills\/([^/]+)\/(versions|candidate|rollback)$/.exec(route)
      if (skVer !== null) {
        const idOrSlug = decodeSegment(skVer[1] ?? '')
        const action = skVer[2]
        const skill = idOrSlug ? (skills.get(idOrSlug) ?? skills.getBySlug(idOrSlug)) : undefined
        if (!skill) { sendJson(res, 404, { error: 'not_found', message: '找不到这个技能。' }); return true }

        if (action === 'versions' && method === 'GET') {
          sendJson(res, 200, { skill, versions: skills.listVersions(skill.id) })
          return true
        }
        if (action === 'candidate' && method === 'POST') {
          const parsed = CandidateSchema.safeParse(await parseJsonBody(req))
          if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
          const version = skillEvolution.proposeCandidate(skill.id, parsed.data)
          sendJson(res, 200, { ok: true, version })
          return true
        }
        if (action === 'rollback' && method === 'POST') {
          const body = (await parseJsonBody(req).catch(() => ({}))) as Record<string, unknown>
          try {
            const updated = skillEvolution.rollback(skill.id, str(body?.reason) || undefined)
            sendJson(res, 200, { ok: true, skill: updated })
          } catch (error) {
            sendJson(res, 400, { error: 'rollback_failed', message: error instanceof Error ? error.message : String(error) })
          }
          return true
        }
      }

      if (route === '/evolution/proposals' && method === 'GET') {
        const items = pluginEvolution.listProposals()
        sendJson(res, 200, { items, total: items.length })
        return true
      }
      if (route === '/evolution/proposals/gap' && method === 'POST') {
        const parsed = GapSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        const out = await pluginEvolution.recordCapabilityGap(parsed.data)
        sendJson(res, 200, { ok: true, ...out })
        return true
      }
      const propApprove = /^\/evolution\/proposals\/([^/]+)\/approve$/.exec(route)
      if (propApprove !== null && method === 'POST') {
        const id = decodeSegment(propApprove[1] ?? '')
        if (!id) { sendJson(res, 400, { error: 'invalid_path', message: '提案编号不合法。' }); return true }
        const body = (await parseJsonBody(req).catch(() => ({}))) as Record<string, unknown>
        try {
          const proposal = await pluginEvolution.approveProposal(id, str(body?.actorId) || 'web:admin', str(body?.projectId) || undefined)
          sendJson(res, 200, { ok: true, proposal })
        } catch (error) {
          sendJson(res, 400, { error: 'approve_failed', message: error instanceof Error ? error.message : String(error) })
        }
        return true
      }

      if (route === '/evolution/benchmarks' && method === 'GET') {
        sendJson(res, 200, {
          cases: coreBenchmarkCases().map(c => ({ id: c.id, title: c.title, input: c.input })),
          runs: benchmarks.listRuns(undefined, 20),
        })
        return true
      }

      return false
    },

    directorQueries: {
      evolution_benchmarks: () => ({
        cases: coreBenchmarkCases().map(c => ({ id: c.id, title: c.title })),
        runs: benchmarks.listRuns(undefined, 10),
      }),
      plugin_proposals_list: () => ({ items: pluginEvolution.listProposals(20) }),
    },

    directorActions: {
      skill_propose_candidate: args => {
        const key = str(args.skillId) || str(args.slug)
        const content = str(args.content)
        const reason = str(args.reason) || '根据用户纠正生成候选修订'
        if (!key || !content) throw new Error('skill_propose_candidate 需要 skillId/slug 与 content')
        const version = skillEvolution.proposeCandidate(key, {
          content,
          source: 'user_correction',
          reason,
        })
        return { ok: true, version }
      },
      skill_rollback: args => {
        const key = str(args.skillId) || str(args.slug)
        if (!key) throw new Error('skill_rollback 需要 skillId 或 slug')
        return { ok: true, skill: skillEvolution.rollback(key, str(args.reason) || undefined) }
      },
      plugin_gap_record: async args => {
        const res = await pluginEvolution.recordCapabilityGap({
          gapKey: str(args.gapKey),
          pluginName: str(args.pluginName) || str(args.gapKey),
          summary: str(args.summary),
          sampleTask: str(args.sampleTask) || str(args.summary),
          ...(str(args.projectId) ? { projectId: str(args.projectId) } : {}),
          ...(Array.isArray(args.externalWritePermissions)
            ? { externalWritePermissions: args.externalWritePermissions.filter((x): x is string => typeof x === 'string') }
            : {}),
          irreversibleMigration: Boolean(args.irreversibleMigration),
        })
        return { ok: true, ...res }
      },
    },

    directorPromptSection: () => [
      '## 自进化与评测（已启用）',
      '- 查询：`evolution_benchmarks`、`plugin_proposals_list`',
      '- 动作：`skill_propose_candidate`、`skill_rollback`、`plugin_gap_record`',
      '- 当主人纠正同类操作规律时，除纠正长期记忆外，可为对应技能生成候选修订版并通过历史基准对比后安全切换；若发现现有技能反复无法满足某类需求，用 `plugin_gap_record` 记录缺口走正常研发与审批流程。',
    ].join('\n'),
  }
}
