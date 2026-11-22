/**
 * 统一任务约定（Task Contract）子系统插件。
 *
 * 通过 `SubsystemPlugin` 协议统一接入：
 * - HTTP API：`/api/contracts/*`（查看、保存、历史版本、中途修订）
 * - Director 查询与动作：`contract_get` / `contract_list` / `contract_save` / `contract_amend`
 * - 自动联动：
 *   - 当用户中途纠正且范围为 `project` 或 `preference` 时，自动写入或纠正长期记忆（保留来源与替代关系），后续任务/周报无需重复提醒；
 *   - 当纠正对象是进行中的 `ticket` 时，同步更新 Goal 验收条件并仅要求重做受影响部分。
 * - Worker Prompt：把当前工单的任务约定自动注入系统提示词。
 */
import { z } from 'zod'
import type { SubsystemPlugin } from '../plugins/types.ts'
import type { ContractStore, ContractTargetKind, AmendmentScope } from './store.ts'
import type { MemoryStore } from '../memory/store.ts'
import type { GoalService } from '../goal/service.ts'
import { issuesOf } from '../admin/http.ts'

export interface ContractsPluginDeps {
  contracts: ContractStore
  memories: MemoryStore
  redact: (text: string) => string
  getGoals?: () => Pick<GoalService, 'view' | 'set'> | undefined
  getGoalDefaults?: () => { maxRounds: number; maxUsd: number; maxHours: number }
  notifyTicket?: (ticketId: string, text: string) => void
}

const TargetKindSchema = z.enum(['ticket', 'schedule', 'mission'])
const AmendmentScopeSchema = z.enum(['once', 'project', 'preference'])
const CriterionInputSchema = z.union([
  z.string().trim().min(1).max(500),
  z.object({
    id: z.string().trim().max(40).default(''),
    text: z.string().trim().min(1).max(500),
    required: z.boolean().default(true),
  }).strict(),
])

const ContractSaveSchema = z.object({
  projectId: z.string().trim().max(64).nullable().optional(),
  goal: z.string().trim().min(1, '请填写目标').max(4000),
  deliverables: z.array(z.string().trim().min(1).max(400)).max(30).optional(),
  criteria: z.array(CriterionInputSchema).max(30).optional(),
  assumptions: z.array(z.string().trim().min(1).max(400)).max(30).optional(),
  budgetUsd: z.number().min(0.01).max(500).nullable().optional(),
  allowedScope: z.string().trim().max(300).optional(),
  amendmentScope: AmendmentScopeSchema.optional(),
  amendmentReason: z.string().trim().max(600).optional(),
}).strict()

const ContractAmendSchema = z.object({
  goal: z.string().trim().min(1).max(4000).optional(),
  deliverables: z.array(z.string().trim().min(1).max(400)).max(30).optional(),
  criteria: z.array(CriterionInputSchema).max(30).optional(),
  addCriteria: z.array(CriterionInputSchema).max(30).optional(),
  assumptions: z.array(z.string().trim().min(1).max(400)).max(30).optional(),
  budgetUsd: z.number().min(0.01).max(500).nullable().optional(),
  allowedScope: z.string().trim().max(300).optional(),
  projectId: z.string().trim().max(64).nullable().optional(),
  scope: AmendmentScopeSchema.default('once'),
  reason: z.string().trim().min(1, '请说明本次纠正或修订的原因').max(600),
  /** 可选：该条修订要纠正/替代的旧记忆 ID（若不传，将按目标自动检索并链式纠正）。 */
  supersedesMemoryId: z.string().trim().max(64).optional(),
}).strict()

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()) : []
const parseKind = (v: unknown): ContractTargetKind | undefined =>
  v === 'ticket' || v === 'schedule' || v === 'mission' ? v : undefined
const parseAmendScope = (v: unknown): AmendmentScope =>
  v === 'once' || v === 'project' || v === 'preference' ? v : 'once'

export function createContractsPlugin(deps: ContractsPluginDeps): SubsystemPlugin {
  const { contracts, memories, redact, getGoals, getGoalDefaults, notifyTicket } = deps

  /** 执行修订并同步沉淀长期记忆与运行中工单目标。 */
  const applyAmendment = (
    targetKind: ContractTargetKind,
    targetId: string,
    input: {
      goal?: string
      deliverables?: string[]
      criteria?: (string | { id: string; text: string; required: boolean })[]
      addCriteria?: (string | { id: string; text: string; required: boolean })[]
      assumptions?: string[]
      budgetUsd?: number | null
      allowedScope?: string
      projectId?: string | null
      scope: AmendmentScope
      reason: string
      supersedesMemoryId?: string
    },
  ) => {
    const res = contracts.amend(
      targetKind,
      targetId,
      {
        ...(input.goal !== undefined ? { goal: redact(input.goal) } : {}),
        ...(input.deliverables !== undefined ? { deliverables: input.deliverables.map(redact) } : {}),
        ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
        ...(input.addCriteria !== undefined ? { addCriteria: input.addCriteria } : {}),
        ...(input.assumptions !== undefined ? { assumptions: input.assumptions.map(redact) } : {}),
        ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
        ...(input.allowedScope !== undefined ? { allowedScope: input.allowedScope } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      },
      { scope: input.scope, reason: redact(input.reason), ...(input.projectId !== undefined ? { projectId: input.projectId } : {}) },
    )

    // 区分“这次这样做 (once) / 这个项目以后这样做 (project) / 我的长期偏好 (preference)”
    let savedMemoryId: string | undefined
    if (input.scope === 'project' || input.scope === 'preference') {
      const memScope = input.scope === 'project' && res.contract.projectId ? 'project' : 'user'
      const ruleTag = `contract:${targetKind}:${targetId}`
      const content = [
        `纠正说明：${redact(input.reason)}`,
        `最新目标：${res.contract.goal}`,
        ...(res.contract.criteria.length > 0
          ? [`验收标准：${res.contract.criteria.map(c => c.text).join('；')}`]
          : []),
        ...(res.contract.assumptions.length > 0
          ? [`口径与假设：${res.contract.assumptions.join('；')}`]
          : []),
      ].join('\n')

      // 查找是否已有同源旧记忆，有则用 correct() 建立正式替代链
      let oldId = input.supersedesMemoryId
      if (!oldId) {
        const prev = memories.list({
          scope: memScope,
          ...(memScope === 'project' && res.contract.projectId ? { projectId: res.contract.projectId } : {}),
          q: ruleTag,
          limit: 5,
        }).items.find(m => !m.supersededBy && m.tags.includes(ruleTag))
        oldId = prev?.id
      }

      if (oldId && memories.get(oldId)) {
        const updatedMem = memories.correct(oldId, {
          title: `口径约定（v${res.contract.version}）：${res.contract.goal.slice(0, 80)}`,
          content,
          scope: memScope,
          kind: input.scope === 'preference' ? 'preference' : 'decision',
          projectId: memScope === 'project' ? res.contract.projectId : null,
          tags: [ruleTag, `scope:${input.scope}`, 'contract-amendment'],
          pinned: true,
          userFeedback: redact(input.reason),
          source: 'contract_amendment',
        })
        savedMemoryId = updatedMem.id
      } else {
        const createdMem = memories.save({
          scope: memScope,
          kind: input.scope === 'preference' ? 'preference' : 'decision',
          projectId: memScope === 'project' ? res.contract.projectId : null,
          ticketId: targetKind === 'ticket' ? targetId : null,
          title: `口径约定（v${res.contract.version}）：${res.contract.goal.slice(0, 80)}`,
          content,
          tags: [ruleTag, `scope:${input.scope}`, 'contract-amendment'],
          confidence: 0.96,
          pinned: true,
          source: 'contract_amendment',
          userFeedback: redact(input.reason),
          evidence: [`contract:${res.contract.id}:v${res.contract.version}`],
        })
        savedMemoryId = createdMem.id
      }
    }

    // 若是对进行中工单的中途纠正，同步更新 Goal 并仅通知重做受影响部分
    if (targetKind === 'ticket') {
      const goals = getGoals?.()
      const existingGoal = goals?.view(targetId)
      if (goals && existingGoal && (existingGoal.status === 'active' || existingGoal.status === 'paused')) {
        const defaults = getGoalDefaults?.() ?? { maxRounds: 6, maxUsd: 5, maxHours: 4 }
        goals.set(targetId, {
          text: res.contract.goal,
          commands: existingGoal.commands,
          mode: existingGoal.mode,
          maxRounds: existingGoal.maxRounds || defaults.maxRounds,
          maxUsd: res.contract.budgetUsd ?? existingGoal.maxUsd ?? defaults.maxUsd,
          maxHours: existingGoal.maxHours || defaults.maxHours,
          criteria: res.contract.criteria,
          requireEvidence: existingGoal.requireEvidence ?? true,
        })
      }
      if (notifyTicket) {
        const affectedLines = res.affectedCriteria.map(c => `- [${c.id}] ${c.text}`).join('\n')
        notifyTicket(
          targetId,
          `任务约定已升级至 v${res.contract.version}（原因：${res.contract.amendmentReason}）。已完成且未受影响的结果保持原样，请仅重做受影响的部分：\n${affectedLines}`,
        )
      }
    }

    return { ...res, ...(savedMemoryId ? { savedMemoryId } : {}) }
  }

  return {
    id: 'contracts',
    name: '统一任务约定与版本修订',
    description: '跨对话、Web、定时调度与 DAG 共用的结构化任务约定，支持版本保留与中途按作用范围（本次/项目/长期偏好）纠正',
    version: '2.1.0',
    routesPrefix: '/contracts',

    handleRoute: async ctx => {
      const { req, res, url, method, route, sendJson, parseJsonBody, invalid, decodeSegment, clampInt, events } = ctx
      if (!route.startsWith('/contracts')) return false

      if (route === '/contracts' && method === 'GET') {
        const rawKind = url.searchParams.get('targetKind')
        const projectId = url.searchParams.get('projectId') || undefined
        const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
        const items = contracts.list({
          ...(rawKind === 'ticket' || rawKind === 'schedule' || rawKind === 'mission' ? { targetKind: rawKind } : {}),
          ...(projectId ? { projectId } : {}),
          limit,
        })
        sendJson(res, 200, { items, total: items.length })
        return true
      }

      const amendMatch = /^\/contracts\/([^/]+)\/([^/]+)\/amend$/.exec(route)
      if (amendMatch !== null && method === 'POST') {
        const kindParsed = TargetKindSchema.safeParse(decodeSegment(amendMatch[1] ?? ''))
        const targetId = decodeSegment(amendMatch[2] ?? '')
        if (!kindParsed.success || !targetId) {
          sendJson(res, 400, { error: 'invalid_path', message: '任务约定目标不合法。' })
          return true
        }
        const parsed = ContractAmendSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        const result = applyAmendment(kindParsed.data, targetId, {
          ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal } : {}),
          ...(parsed.data.deliverables !== undefined ? { deliverables: parsed.data.deliverables } : {}),
          ...(parsed.data.criteria !== undefined ? { criteria: parsed.data.criteria } : {}),
          ...(parsed.data.addCriteria !== undefined ? { addCriteria: parsed.data.addCriteria } : {}),
          ...(parsed.data.assumptions !== undefined ? { assumptions: parsed.data.assumptions } : {}),
          ...(parsed.data.budgetUsd !== undefined ? { budgetUsd: parsed.data.budgetUsd } : {}),
          ...(parsed.data.allowedScope !== undefined ? { allowedScope: parsed.data.allowedScope } : {}),
          ...(parsed.data.projectId !== undefined ? { projectId: parsed.data.projectId } : {}),
          scope: parsed.data.scope,
          reason: parsed.data.reason,
          ...(parsed.data.supersedesMemoryId !== undefined ? { supersedesMemoryId: parsed.data.supersedesMemoryId } : {}),
        })
        try {
          events.add({
            kind: 'contract.amended',
            level: 'info',
            ...(kindParsed.data === 'ticket' ? { ticketId: targetId } : {}),
            text: `任务约定升级至 v${result.contract.version}（${parsed.data.scope}）：${parsed.data.reason.slice(0, 100)}`,
            data: { contractId: result.contract.id, version: result.contract.version, scope: parsed.data.scope },
          })
        } catch { /* ignore */ }
        sendJson(res, 200, { ok: true, ...result })
        return true
      }

      const targetMatch = /^\/contracts\/([^/]+)\/([^/]+)$/.exec(route)
      if (targetMatch !== null) {
        const kindParsed = TargetKindSchema.safeParse(decodeSegment(targetMatch[1] ?? ''))
        const targetId = decodeSegment(targetMatch[2] ?? '')
        if (!kindParsed.success || !targetId) {
          sendJson(res, 400, { error: 'invalid_path', message: '任务约定目标不合法。' })
          return true
        }
        if (method === 'GET') {
          const item = contracts.get(kindParsed.data, targetId)
          if (!item) { sendJson(res, 404, { error: 'not_found', message: '该目标尚未建立任务约定。' }); return true }
          sendJson(res, 200, { item, versions: contracts.listVersions(item.id) })
          return true
        }
        if (method === 'PUT') {
          const parsed = ContractSaveSchema.safeParse(await parseJsonBody(req))
          if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
          const item = contracts.save({
            targetKind: kindParsed.data,
            targetId,
            ...(parsed.data.projectId !== undefined ? { projectId: parsed.data.projectId } : {}),
            goal: redact(parsed.data.goal),
            ...(parsed.data.deliverables !== undefined ? { deliverables: parsed.data.deliverables.map(redact) } : {}),
            ...(parsed.data.criteria !== undefined ? { criteria: parsed.data.criteria } : {}),
            ...(parsed.data.assumptions !== undefined ? { assumptions: parsed.data.assumptions.map(redact) } : {}),
            ...(parsed.data.budgetUsd !== undefined ? { budgetUsd: parsed.data.budgetUsd } : {}),
            ...(parsed.data.allowedScope !== undefined ? { allowedScope: parsed.data.allowedScope } : {}),
            ...(parsed.data.amendmentScope !== undefined ? { amendmentScope: parsed.data.amendmentScope } : {}),
            ...(parsed.data.amendmentReason !== undefined ? { amendmentReason: redact(parsed.data.amendmentReason) } : {}),
          })
          sendJson(res, 200, { ok: true, item, versions: contracts.listVersions(item.id) })
          return true
        }
        sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
        return true
      }

      return false
    },

    directorQueries: {
      contract_get: args => {
        const targetKind = parseKind(args.targetKind) ?? 'ticket'
        const targetId = str(args.targetId) || str(args.id)
        if (!targetId) return { ok: false, error: '请提供 targetId' }
        const item = contracts.get(targetKind, targetId)
        if (!item) return { ok: false, error: `未找到 ${targetKind}:${targetId} 的任务约定` }
        return { ok: true, item, versions: contracts.listVersions(item.id) }
      },
      contract_list: args => {
        const targetKind = parseKind(args.targetKind)
        const projectId = str(args.projectId) || undefined
        const items = contracts.list({
          ...(targetKind ? { targetKind } : {}),
          ...(projectId ? { projectId } : {}),
          limit: Math.max(1, Math.min(100, Number(args.limit) || 30)),
        })
        return { items, total: items.length }
      },
    },

    directorActions: {
      contract_save: args => {
        const targetKind = parseKind(args.targetKind)
        const targetId = str(args.targetId) || str(args.id)
        const goal = str(args.goal)
        if (!targetKind || !targetId || !goal) {
          throw new Error('contract_save 需要 targetKind(ticket|schedule|mission)、targetId 与 goal')
        }
        const item = contracts.save({
          targetKind,
          targetId,
          projectId: str(args.projectId) || null,
          goal: redact(goal),
          deliverables: strArr(args.deliverables).map(redact),
          criteria: Array.isArray(args.criteria) ? args.criteria : strArr(args.criteria),
          assumptions: strArr(args.assumptions).map(redact),
          ...(typeof args.budgetUsd === 'number' ? { budgetUsd: args.budgetUsd } : {}),
          ...(str(args.allowedScope) ? { allowedScope: str(args.allowedScope) } : {}),
          amendmentScope: parseAmendScope(args.amendmentScope),
          ...(str(args.amendmentReason) ? { amendmentReason: redact(str(args.amendmentReason)) } : {}),
        })
        return { ok: true, item }
      },
      contract_amend: args => {
        const targetKind = parseKind(args.targetKind)
        const targetId = str(args.targetId) || str(args.id)
        const reason = str(args.reason) || str(args.amendmentReason) || '用户纠正要求'
        if (!targetKind || !targetId) {
          throw new Error('contract_amend 需要 targetKind(ticket|schedule|mission) 与 targetId')
        }
        const res = applyAmendment(targetKind, targetId, {
          ...(str(args.goal) ? { goal: str(args.goal) } : {}),
          ...(args.deliverables !== undefined ? { deliverables: strArr(args.deliverables) } : {}),
          ...(Array.isArray(args.criteria) ? { criteria: args.criteria } : {}),
          ...(Array.isArray(args.addCriteria) ? { addCriteria: args.addCriteria } : {}),
          ...(args.assumptions !== undefined ? { assumptions: strArr(args.assumptions) } : {}),
          ...(typeof args.budgetUsd === 'number' ? { budgetUsd: args.budgetUsd } : {}),
          ...(str(args.allowedScope) ? { allowedScope: str(args.allowedScope) } : {}),
          ...(args.projectId !== undefined ? { projectId: str(args.projectId) || null } : {}),
          scope: parseAmendScope(args.scope),
          reason,
          ...(str(args.supersedesMemoryId) ? { supersedesMemoryId: str(args.supersedesMemoryId) } : {}),
        })
        return { ok: true, ...res }
      },
    },

    directorPromptSection: () => [
      '## 统一任务约定与版本修订（已启用）',
      '- 查询动作（`platform_query`）：`contract_get({targetKind,targetId})`、`contract_list({targetKind?,projectId?})`',
      '- 写入动作（`subsystem_action`）：`contract_save({targetKind:"ticket"|"schedule"|"mission",targetId,goal,deliverables?,criteria?,assumptions?,budgetUsd?,allowedScope?})`、`contract_amend({targetKind,targetId,scope:"once"|"project"|"preference",reason,goal?,criteria?,addCriteria?,assumptions?,deliverables?})`',
      '- 当主人中途纠正要求时，必须明确区分作用范围：仅限本次（`once`）、该项目以后都这样做（`project`）、主人的长期偏好（`preference`），并调用 `contract_amend` 升级版本，同时保留旧产物原版本依据。',
    ].join('\n'),

    workerPromptSection: ctx => {
      const c = contracts.get('ticket', ctx.ticketId)
      if (!c) return undefined
      return contracts.formatForPrompt(c)
    },
  }
}
