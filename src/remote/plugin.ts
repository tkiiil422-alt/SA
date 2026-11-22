/**
 * 远程执行节点子系统插件（Remote Nodes Plugin）。
 *
 * 停用后，`/api/remote/*` 路由、Director 远程查询/派发动作与后台心跳租约巡检定时器将同步退出。
 */
import { z } from 'zod'
import type { SubsystemPlugin } from '../plugins/types.ts'
import type { RemoteNodeService } from './service.ts'
import { issuesOf } from '../admin/http.ts'

const RegisterNodeSchema = z.object({
  id: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(100),
  sshConnection: z.string().trim().max(100).nullable().optional(),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  maxJobs: z.number().int().min(1).max(32).optional(),
}).strict()

const EnqueueJobSchema = z.object({
  executionId: z.string().trim().min(1).max(120),
  ticketId: z.string().trim().max(64).nullable().optional(),
  requiredCapabilities: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict()

const HeartbeatSchema = z.object({
  activeExecutionIds: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
}).strict()

const UploadArtifactSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(15_000_000),
  expectedSha256: z.string().trim().max(64).optional(),
}).strict()

const ReportUsageSchema = z.object({
  callId: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(100),
  promptHit: z.number().int().min(0).optional(),
  promptMiss: z.number().int().min(0).optional(),
  completion: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).max(500),
  latencyMs: z.number().int().min(0).optional(),
}).strict()

const CompleteJobSchema = z.object({
  ok: z.boolean(),
  summary: z.string().trim().min(1).max(2000),
  error: z.string().trim().max(1000).optional(),
}).strict()

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function createRemoteNodesPlugin(remote: RemoteNodeService): SubsystemPlugin {
  return {
    id: 'remote-nodes',
    name: '远程执行节点（可选，默认停用）',
    description: '单台主机模式默认关闭；按需开启后支持多机租约领取、心跳保活、产物回传与去重结算',
    version: '2.2.0',
    routesPrefix: '/remote',
    enabled: () => false,

    start: () => remote.start(),
    stop: () => remote.stop(),

    handleRoute: async ctx => {
      const { req, res, method, route, sendJson, parseJsonBody, invalid, decodeSegment } = ctx
      if (!route.startsWith('/remote')) return false

      if (route === '/remote/nodes' && method === 'GET') {
        const items = remote.listNodes()
        sendJson(res, 200, { items, total: items.length })
        return true
      }

      if (route === '/remote/nodes/register' && method === 'POST') {
        const parsed = RegisterNodeSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        const node = remote.registerNode(parsed.data)
        sendJson(res, 200, { ok: true, node })
        return true
      }

      const nodeOp = /^\/remote\/nodes\/([^/]+)\/(claim|heartbeat)$/.exec(route)
      if (nodeOp !== null && method === 'POST') {
        const nodeId = decodeSegment(nodeOp[1] ?? '')
        const op = nodeOp[2]
        if (!nodeId) { sendJson(res, 400, { error: 'invalid_path', message: '节点编号不合法。' }); return true }
        try {
          if (op === 'claim') {
            sendJson(res, 200, { ok: true, ...remote.claim(nodeId) })
          } else {
            const parsed = HeartbeatSchema.safeParse(await parseJsonBody(req))
            if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
            sendJson(res, 200, remote.heartbeat(nodeId, parsed.data.activeExecutionIds))
          }
        } catch (error) {
          sendJson(res, 404, { error: 'not_found', message: error instanceof Error ? error.message : String(error) })
        }
        return true
      }

      if (route === '/remote/jobs' && method === 'GET') {
        const items = remote.listJobs()
        sendJson(res, 200, { items, total: items.length })
        return true
      }

      if (route === '/remote/jobs' && method === 'POST') {
        const parsed = EnqueueJobSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        const resJob = remote.enqueueJob(parsed.data)
        sendJson(res, 200, { ok: true, ...resJob })
        return true
      }

      const jobOp = /^\/remote\/jobs\/([^/]+)\/(cancel|artifact|usage|complete)$/.exec(route)
      if (jobOp !== null && method === 'POST') {
        const jobId = decodeSegment(jobOp[1] ?? '')
        const op = jobOp[2]
        if (!jobId) { sendJson(res, 400, { error: 'invalid_path', message: '作业编号不合法。' }); return true }
        try {
          if (op === 'cancel') {
            const body = (await parseJsonBody(req).catch(() => ({}))) as Record<string, unknown>
            const job = remote.cancelJob(jobId, str(body?.reason) || undefined)
            sendJson(res, 200, { ok: true, job })
            return true
          }
          if (op === 'artifact') {
            const parsed = UploadArtifactSchema.safeParse(await parseJsonBody(req))
            if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
            const out = remote.uploadArtifact(jobId, parsed.data)
            sendJson(res, 200, { ok: true, ...out })
            return true
          }
          if (op === 'usage') {
            const parsed = ReportUsageSchema.safeParse(await parseJsonBody(req))
            if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
            const out = remote.reportUsage(jobId, parsed.data)
            sendJson(res, 200, { ok: true, ...out })
            return true
          }
          const parsed = CompleteJobSchema.safeParse(await parseJsonBody(req))
          if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
          const job = remote.completeJob(jobId, parsed.data)
          sendJson(res, 200, { ok: true, job })
          return true
        } catch (error) {
          sendJson(res, 400, { error: 'remote_error', message: error instanceof Error ? error.message : String(error) })
        }
        return true
      }

      return false
    },

    directorQueries: {
      remote_nodes_list: () => ({ items: remote.listNodes() }),
      remote_jobs_list: () => ({ items: remote.listJobs() }),
    },

    directorActions: {
      remote_job_enqueue: args => {
        const executionId = str(args.executionId) || `rexec_${Date.now().toString(36)}`
        const caps = Array.isArray(args.requiredCapabilities)
          ? args.requiredCapabilities.filter((x): x is string => typeof x === 'string')
          : []
        const payload = (typeof args.payload === 'object' && args.payload !== null && !Array.isArray(args.payload))
          ? args.payload as Record<string, unknown>
          : { task: str(args.task) || str(args.prompt) }
        return {
          ok: true,
          ...remote.enqueueJob({
            executionId,
            ticketId: str(args.ticketId) || null,
            requiredCapabilities: caps,
            payload,
          }),
        }
      },
      remote_job_cancel: args => ({
        ok: true,
        job: remote.cancelJob(str(args.jobId) || str(args.id), str(args.reason) || undefined),
      }),
    },

    directorPromptSection: () => {
      const nodes = remote.listNodes()
      const online = nodes.filter(n => n.status === 'online')
      return [
        '## 远程执行节点（已启用）',
        `- 当前注册节点 ${nodes.length} 台（在线 ${online.length} 台）。对于确实需要 GPU / 专用网络 / 独立算力的任务，可通过 \`remote_job_enqueue\` 下发至匹配能力的远程节点执行。`,
        '- 查询：`remote_nodes_list`、`remote_jobs_list`；动作：`remote_job_enqueue`、`remote_job_cancel`。',
      ].join('\n')
    },
  }
}
