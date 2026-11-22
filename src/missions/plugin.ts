/**
 * DAG 任务计划与编排子系统插件（Missions Plugin）。
 *
 * 通过 `SubsystemPlugin` 协议接入（停用后路由、工具与后台任务同步退出）：
 * - HTTP API：`/api/missions*`（创建、查询、启停、绑定真实用户与计划版本的幂等审批、局部重试/跳过、删除）
 * - Director 工具：`missions_list`、`mission_detail`、`mission_create`、`mission_start`、`mission_pause`、`mission_resume`、`mission_cancel`、`mission_retry_node`、`mission_approve_node`
 * - 领域事件：自动订阅 `ticket.ended` 收集实际交付产物与提交 SHA，驱动 DAG 推进下游
 */
import { z } from 'zod'
import type { SubsystemPlugin } from '../plugins/types.ts'
import type { MissionService } from './service.ts'
import type { MissionNodeInput } from './store.ts'
import { issuesOf } from '../admin/http.ts'

const NodeInputSchema = z.object({
  key: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(160),
  kind: z.enum(['ticket', 'council', 'director', 'approval']).default('ticket'),
  prompt: z.string().trim().min(1).max(10_000),
  dependsOn: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict()

const MissionCreateSchema = z.object({
  sessionId: z.string().trim().max(120).nullable().optional(),
  title: z.string().trim().min(1, '请填写任务计划标题').max(160),
  goal: z.string().trim().min(1, '请填写总体目标').max(8_000),
  autoStart: z.boolean().default(true),
  nodes: z.array(NodeInputSchema).min(1, '至少需要 1 个执行节点').max(30),
}).strict()

export interface MissionPluginDeps {
  missions: MissionService
  getTicketResult?: (ticketId: string) => { outcome: string; summary: string; artifacts?: string[]; commitSha?: string } | undefined
  afterCommit?: (fn: () => void) => void
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function createMissionsPlugin(deps: MissionPluginDeps): SubsystemPlugin {
  const { missions, getTicketResult, afterCommit } = deps

  return {
    id: 'missions',
    name: 'DAG 任务计划编排',
    description: '将复杂多步骤需求拆解为并行依赖图（工单 / 会商 / 总控 / 人工拍板），支持产物与提交交接、断点恢复与幂等审批',
    version: '2.2.0',
    routesPrefix: '/missions',

    start: () => missions.start(),
    stop: () => missions.stop(),

    handleRoute: async ctx => {
      const { req, res, url, method, route, sendJson, parseJsonBody, invalid, decodeSegment, clampInt } = ctx
      if (!route.startsWith('/missions')) return false

      if (route === '/missions' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || undefined
        const rawStatus = url.searchParams.get('status')
        const status = rawStatus === 'draft' || rawStatus === 'running' || rawStatus === 'paused' || rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'cancelled'
          ? rawStatus
          : undefined
        const limit = clampInt(url.searchParams.get('limit'), 30, 1, 100)
        sendJson(res, 200, missions.list({ ...(sessionId ? { sessionId } : {}), ...(status ? { status } : {}), limit }))
        return true
      }

      if (route === '/missions' && method === 'POST') {
        const parsed = MissionCreateSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        try {
          const item = await missions.create({
            ...(parsed.data.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
            title: parsed.data.title,
            goal: parsed.data.goal,
            autoStart: parsed.data.autoStart,
            nodes: parsed.data.nodes,
          })
          sendJson(res, 200, { ok: true, item })
        } catch (error) {
          sendJson(res, 400, { error: 'invalid', message: error instanceof Error ? error.message : String(error) })
        }
        return true
      }

      const nodeAction = /^\/missions\/([^/]+)\/nodes\/([^/]+)\/(approve|retry|skip)$/.exec(route)
      if (nodeAction !== null && method === 'POST') {
        const id = decodeSegment(nodeAction[1] ?? '')
        const key = decodeSegment(nodeAction[2] ?? '')
        const action = nodeAction[3]
        if (!id || !key) { sendJson(res, 400, { error: 'invalid_path', message: '参数不合法。' }); return true }
        const body = (await parseJsonBody(req).catch(() => ({}))) as Record<string, unknown>
        const note = str(body?.note) || undefined
        try {
          if (action === 'approve') {
            const actorId = str(body?.actorId) || 'web:admin'
            const planVersion = typeof body?.planVersion === 'number' ? body.planVersion : undefined
            const idempotencyKey = str(body?.idempotencyKey) || undefined
            const out = await missions.approveNode(id, key, {
              actorId,
              ...(planVersion !== undefined ? { planVersion } : {}),
              ...(idempotencyKey ? { idempotencyKey } : {}),
              ...(note ? { note } : {}),
            })
            sendJson(res, 200, { ok: true, item: out.item, idempotent: out.idempotent })
            return true
          }
          const item = action === 'retry'
            ? await missions.retryNode(id, key)
            : await missions.skipNode(id, key, note)
          sendJson(res, 200, { ok: true, item })
        } catch (error) {
          sendJson(res, 400, { error: 'invalid', message: error instanceof Error ? error.message : String(error) })
        }
        return true
      }

      const missionAction = /^\/missions\/([^/]+)\/(start|pause|resume|cancel)$/.exec(route)
      if (missionAction !== null && method === 'POST') {
        const id = decodeSegment(missionAction[1] ?? '')
        const action = missionAction[2]
        if (!id) { sendJson(res, 400, { error: 'invalid_path', message: '计划编号不合法。' }); return true }
        try {
          const item = action === 'start'
            ? await missions.startMission(id)
            : action === 'pause'
              ? missions.pauseMission(id)
              : action === 'resume'
                ? await missions.resumeMission(id)
                : missions.cancelMission(id)
          sendJson(res, 200, { ok: true, item })
        } catch (error) {
          sendJson(res, 400, { error: 'invalid', message: error instanceof Error ? error.message : String(error) })
        }
        return true
      }

      const idMatch = /^\/missions\/([^/]+)$/.exec(route)
      if (idMatch !== null) {
        const id = decodeSegment(idMatch[1] ?? '')
        if (!id) { sendJson(res, 400, { error: 'invalid_path', message: '计划编号不合法。' }); return true }
        if (method === 'GET') {
          const item = missions.get(id)
          if (!item) { sendJson(res, 404, { error: 'not_found', message: '找不到这个任务计划。' }); return true }
          sendJson(res, 200, { item })
          return true
        }
        if (method === 'DELETE') {
          if (!missions.delete(id)) { sendJson(res, 404, { error: 'not_found', message: '找不到这个任务计划。' }); return true }
          sendJson(res, 200, { ok: true })
          return true
        }
        sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
        return true
      }

      return false
    },

    directorQueries: {
      missions_list: args => {
        const rawStatus = args.status
        const status = rawStatus === 'draft' || rawStatus === 'running' || rawStatus === 'paused' || rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'cancelled'
          ? rawStatus
          : undefined
        return missions.list({ ...(status ? { status } : {}), limit: Math.max(1, Math.min(50, Number(args.limit) || 20)) })
      },
      mission_detail: args => {
        const id = str(args.id) || str(args.missionId)
        if (!id) return { ok: false, error: '缺少任务计划 id' }
        const item = missions.get(id)
        return item ? { ok: true, item } : { ok: false, error: `找不到任务计划 ${id}` }
      },
    },

    directorActions: {
      mission_create: async (args, ctx) => {
        const title = str(args.title)
        const goal = str(args.goal) || title
        const rawNodes = Array.isArray(args.nodes) ? args.nodes : []
        const nodes: MissionNodeInput[] = rawNodes.map((n, idx) => {
          const obj = typeof n === 'object' && n !== null ? n as Record<string, unknown> : {}
          const rawCfg = typeof obj.config === 'object' && obj.config !== null && !Array.isArray(obj.config)
            ? { ...(obj.config as Record<string, unknown>) }
            : {}
          if (!rawCfg.projectId && str(obj.projectId)) rawCfg.projectId = str(obj.projectId)
          if (!rawCfg.projectMode && str(obj.projectMode)) rawCfg.projectMode = str(obj.projectMode)
          if (!rawCfg.model && str(obj.model)) rawCfg.model = str(obj.model)
          if (rawCfg.goal === undefined && obj.goal !== undefined) rawCfg.goal = obj.goal
          return {
            key: str(obj.key) || `step-${idx + 1}`,
            title: str(obj.title) || `步骤 ${idx + 1}`,
            kind: obj.kind === 'council' || obj.kind === 'director' || obj.kind === 'approval' ? obj.kind : 'ticket',
            prompt: str(obj.prompt),
            dependsOn: Array.isArray(obj.dependsOn) ? obj.dependsOn.filter((d): d is string => typeof d === 'string') : [],
            config: rawCfg,
          }
        })
        const item = await missions.create({
          sessionId: ctx.sessionId,
          title,
          goal,
          autoStart: typeof args.autoStart === 'boolean' ? args.autoStart : true,
          nodes,
        })
        return { ok: true, item }
      },
      mission_start: async args => ({ ok: true, item: await missions.startMission(str(args.id) || str(args.missionId)) }),
      mission_pause: args => ({ ok: true, item: missions.pauseMission(str(args.id) || str(args.missionId)) }),
      mission_resume: async args => ({ ok: true, item: await missions.resumeMission(str(args.id) || str(args.missionId)) }),
      mission_cancel: args => ({ ok: true, item: missions.cancelMission(str(args.id) || str(args.missionId)) }),
      mission_retry_node: async args => ({
        ok: true,
        item: await missions.retryNode(str(args.id) || str(args.missionId), str(args.nodeKey) || str(args.key)),
      }),
      mission_approve_node: async (args, ctx) => {
        const res = await missions.approveNode(str(args.id) || str(args.missionId), str(args.nodeKey) || str(args.key), {
          actorId: `${ctx.channel}:${ctx.userId}`,
          ...(typeof args.planVersion === 'number' ? { planVersion: args.planVersion } : {}),
          ...(str(args.idempotencyKey) ? { idempotencyKey: str(args.idempotencyKey) } : {}),
          ...(str(args.note) ? { note: str(args.note) } : {}),
        })
        return { ok: true, item: res.item, idempotent: res.idempotent }
      },
    },

    directorPromptSection: () => {
      const active = missions.list({ limit: 8 }).items.filter(m => m.status === 'running' || m.status === 'draft' || m.status === 'paused')
      const lines: string[] = [
        '## DAG 多步骤任务计划编排（已启用）',
        '- 复杂需求（出方案 → 并行子任务 → 汇总测试 → 人工批准）必须使用 `subsystem_action(mission_create)` 拆解为 DAG 计划，禁止硬塞单工单。',
        '- 节点支持 4 种类型：`ticket`、`council`、`director`、`approval`。同一 Git 仓库多个并行开发节点优先使用 `projectMode:"worktree"`。',
        '- 节点间自动传递实际交付产物路径与 Git 提交 SHA；审批节点严格绑定真实用户与计划版本且幂等。',
        '- 工具动作：查询 `missions_list` / `mission_detail({id})`；执行 `mission_create`、`mission_start`、`mission_pause`、`mission_resume`、`mission_cancel`、`mission_retry_node`、`mission_approve_node`。',
      ]
      if (active.length > 0) {
        lines.push('', `### 当前活跃的任务计划（共 ${active.length} 项）`)
        for (const m of active.slice(0, 5)) {
          const done = m.nodes.filter(n => n.status === 'completed' || n.status === 'skipped').length
          const wait = m.nodes.filter(n => n.status === 'waiting_approval').length
          lines.push(`- \`${m.id}\` **${m.title}** [v${m.planVersion} · ${m.status} · ${done}/${m.nodes.length} 步${wait > 0 ? ` · ${wait} 步待审批` : ''}]`)
        }
      }
      return lines.join('\n')
    },

    onDomainEvent: event => {
      if (event.type !== 'ticket.ended' || !getTicketResult) return
      const run = (): void => {
        const res = getTicketResult(event.data.ticketId)
        if (!res) return
        void missions.onTicketEnded(event.data.ticketId, res.outcome, res.summary, {
          ...(res.artifacts ? { artifacts: res.artifacts } : {}),
          ...(res.commitSha ? { commitSha: res.commitSha } : {}),
        })
      }
      if (afterCommit) afterCommit(run)
      else run()
    },
  }
}
