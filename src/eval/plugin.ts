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
import type { MemoryStore } from '../memory/store.ts'
import type { SkillStore } from '../skills/store.ts'
import type { SkillEvolutionService } from '../skills/evolution.ts'
import type { SkillAutoObserver } from '../skills/auto-observer.ts'
import type { PluginEvolutionService } from '../plugins/evolution.ts'
import { coreBenchmarkCases, type BenchmarkStore } from './benchmarks.ts'
import { issuesOf } from '../admin/http.ts'

export interface EvolutionPluginDeps {
  memories?: MemoryStore
  skills: SkillStore
  skillEvolution: SkillEvolutionService
  autoObserver?: SkillAutoObserver
  pluginEvolution: PluginEvolutionService
  benchmarks: BenchmarkStore
  getTicketSummary?: (ticketId: string) => {
    title: string
    outcome?: string
    acceptanceStatus?: 'met' | 'unmet' | 'not_checked'
    summary?: string
  } | undefined
  afterCommit?: (fn: () => void) => void
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
  const { memories, skills, skillEvolution, autoObserver, pluginEvolution, benchmarks, getTicketSummary, afterCommit } = deps

  return {
    id: 'evolution',
    name: '自进化与持续评测引擎',
    description: '技能版本候选与历史样例对比切换/回退、重复能力缺口自动发起插件研发提案、典型任务基准评测对比',
    version: '2.3.0',
    routesPrefix: '/evolution',

    handleRoute: async ctx => {
      const { req, res, method, route, sendJson, parseJsonBody, invalid, decodeSegment } = ctx
      if (!route.startsWith('/evolution')) return false

      if (route === '/evolution/overview' && method === 'GET') {
        const allSkills = skills.list({ limit: 200 }).items
        const pendingCandidates: Array<{
          skillId: string
          skillSlug: string
          skillName: string
          activeVersion: number
          activeContent: string
          candidate: ReturnType<SkillStore['listVersions']>[number]
        }> = []
        let totalVersions = 0
        for (const sk of allSkills) {
          const vers = skills.listVersions(sk.id)
          totalVersions += vers.length
          for (const v of vers) {
            if (v.status === 'candidate') {
              pendingCandidates.push({
                skillId: sk.id,
                skillSlug: sk.slug,
                skillName: sk.name,
                activeVersion: sk.activeVersion,
                activeContent: sk.content,
                candidate: v,
              })
            }
          }
        }
        const proposals = pluginEvolution.listProposals(30)
        const runs = benchmarks.listRuns(undefined, 10)
        sendJson(res, 200, {
          pendingCandidates,
          stats: {
            skills: allSkills.length,
            totalVersions,
            pendingCandidates: pendingCandidates.length,
            proposals: proposals.length,
            benchmarkRuns: runs.length,
          },
          proposals,
          runs,
        })
        return true
      }

      const skVerDecision = /^\/evolution\/skills\/([^/]+)\/versions\/(\d+)\/(promote|reject)$/.exec(route)
      if (skVerDecision !== null && method === 'POST') {
        const idOrSlug = decodeSegment(skVerDecision[1] ?? '')
        const verNum = Number(skVerDecision[2])
        const op = skVerDecision[3]
        const skill = idOrSlug ? (skills.get(idOrSlug) ?? skills.getBySlug(idOrSlug)) : undefined
        if (!skill || !Number.isInteger(verNum) || verNum < 1) {
          sendJson(res, 404, { error: 'not_found', message: '找不到对应的技能或版本号。' })
          return true
        }
        const target = skills.getVersion(skill.id, verNum)
        if (!target) {
          sendJson(res, 404, { error: 'not_found', message: `找不到技能「${skill.name}」的候选版本 v${verNum}。` })
          return true
        }
        const body = (await parseJsonBody(req).catch(() => ({}))) as Record<string, unknown>
        const note = str(body?.reason) || (op === 'promote' ? '主人在控制台批准启用该进化版本' : '主人在控制台拒绝该候选修订')
        if (op === 'promote') {
          const updated = skills.promoteVersion(skill.id, verNum, { manualReview: 'approved', note })
          try {
            ctx.events.add({
              kind: 'skill.promoted',
              level: 'info',
              text: `技能「${updated.name}」已批准升级至 v${updated.activeVersion}`,
              data: { skillId: updated.id, version: updated.activeVersion },
            })
          } catch { /* ignore */ }
          sendJson(res, 200, { ok: true, skill: updated })
          return true
        }
        const rejected = skills.rejectVersion(skill.id, verNum, { manualReview: 'rejected', note })
        try {
          ctx.events.add({
            kind: 'skill.candidate_rejected',
            level: 'info',
            text: `技能「${skill.name}」候选修订 v${verNum} 已被拒绝`,
            data: { skillId: skill.id, version: verNum },
          })
        } catch { /* ignore */ }
        sendJson(res, 200, { ok: true, version: rejected })
        return true
      }

      const skVer = /^\/evolution\/skills\/([^/]+)\/(versions|candidate|rollback|auto-correct)$/.exec(route)
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
        if (action === 'auto-correct' && method === 'POST') {
          if (!autoObserver) { sendJson(res, 503, { error: 'unavailable', message: '技能自动观察器未装配。' }); return true }
          const body = (await parseJsonBody(req).catch(() => ({}))) as Record<string, unknown>
          const rule = str(body?.correctionRule)
          if (!rule) { sendJson(res, 400, { error: 'invalid', message: '请填写纠正规则 correctionRule。' }); return true }
          const evaluated = await autoObserver.onUserCorrection({
            skillIdOrSlug: skill.id,
            correctionRule: rule,
            reason: str(body?.reason) || '用户主动纠正触发 A/B 评测升级',
          })
          sendJson(res, 200, { ok: true, result: evaluated })
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
      const propAction = /^\/evolution\/proposals\/([^/]+)\/(approve|reject)$/.exec(route)
      if (propAction !== null && method === 'POST') {
        const id = decodeSegment(propAction[1] ?? '')
        const op = propAction[2]
        if (!id) { sendJson(res, 400, { error: 'invalid_path', message: '提案编号不合法。' }); return true }
        const body = (await parseJsonBody(req).catch(() => ({}))) as Record<string, unknown>
        try {
          const proposal = op === 'approve'
            ? await pluginEvolution.approveProposal(id, str(body?.actorId) || 'web:admin', str(body?.projectId) || undefined)
            : pluginEvolution.rejectProposal(id)
          sendJson(res, 200, { ok: true, proposal })
        } catch (error) {
          sendJson(res, 400, { error: `${op}_failed`, message: error instanceof Error ? error.message : String(error) })
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
      if (route === '/evolution/benchmarks/run' && method === 'POST') {
        const body = (await parseJsonBody(req).catch(() => ({}))) as Record<string, unknown>
        const label = str(body?.label) || `基准快照 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
        const run = await benchmarks.runAndRecord({
          suiteName: 'core-v2',
          label,
          runner: async item => {
            const matchedSkills = skills.match(item.input, 'worker', 3, false)
            const matchedMems = memories ? memories.recall({ query: item.input, limit: 5, recordUse: false }) : []
            const ctxParts = [
              item.input,
              ...matchedSkills.map(s => `[技能:${s.name}@v${s.activeVersion}] ${s.content}`),
              ...matchedMems.map(m => `[记忆:${m.title}] ${m.content}`),
            ]
            return { output: ctxParts.join('\n'), usd: 0, firstPass: true }
          },
        })
        sendJson(res, 200, { ok: true, run })
        return true
      }

      return false
    },

    onDomainEvent: event => {
      if (event.type !== 'ticket.ended' || !autoObserver || !getTicketSummary) return
      const run = (): void => {
        try {
          const info = getTicketSummary(event.data.ticketId)
          if (!info) return
          autoObserver.onTicketEnded({
            ticketId: event.data.ticketId,
            outcome: info.outcome ?? event.data.outcome ?? 'closed',
            acceptanceStatus: info.acceptanceStatus ?? 'not_checked',
            summary: info.summary ?? '',
          })
        } catch { /* best effort */ }
      }
      if (afterCommit) afterCommit(run)
      else run()
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
