/**
 * 密钥库、工单、决策、账本用量与事件审计路由
 * （`/secrets/*`、`/tickets/*`、`/decisions`、`/usage*`、`/events`）。
 */
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AdminError, type TicketStatusFilter } from '../host.ts'
import {
  SECURITY_HEADERS,
  SecretNameSchema,
  clampInt,
  decodeSegment,
  invalid,
  isInside,
  issuesOf,
  labelSummary,
  optionalCursor,
  parseJsonBody,
  sendJson,
  serveTarArchive,
} from '../http.ts'
import { decisionKindLabel, reasonLabels, ticketStatusLabel } from '../labels.ts'
import type { EventLevel } from '../../ledger/events.ts'
import type { UsageRange } from '../../ledger/ledger.ts'
import { GoalError, resolveGoal, type GoalSpec } from '../../goal/service.ts'
import { runBrowserVerify } from '../../verify/browser.ts'
import type { AdminRouteDeps, AdminRouteRequest } from './types.ts'

const CriterionSchema = z.union([
  z.string().trim().min(1).max(500),
  z.object({
    id: z.string().trim().max(40).default(''),
    text: z.string().trim().min(1).max(500),
    required: z.boolean().default(true),
  }).strict(),
])

const GoalInputSchema = z.object({
  text: z.string().trim().min(1, '请写清目标').max(4000, '目标不能超过 4000 字'),
  commands: z.array(z.string().trim().min(1, '验收命令不能是空的').max(1000, '一条验收命令不能超过 1000 字')).max(20, '最多 20 条验收命令').optional(),
  mode: z.enum(['commands+ai', 'commands', 'ai']).optional(),
  maxRounds: z.number().int('必须是整数').min(1, '至少 1 轮').max(50, '最多 50 轮').optional(),
  maxUsd: z.number().min(0.01, '至少 $0.01').max(100, '最多 $100').optional(),
  maxHours: z.number().min(0.1, '至少 0.1 小时').max(72, '最多 72 小时').optional(),
  criteria: z.array(CriterionSchema).max(30).optional(),
  requireEvidence: z.boolean().optional(),
}).strict()

const EvidenceInputSchema = z.object({
  kind: z.enum(['command', 'file', 'git', 'browser', 'data', 'judge']),
  criterionId: z.string().trim().max(40).optional(),
  runId: z.string().trim().min(1).max(80).default('manual'),
  artifactVersion: z.string().trim().max(80).default('working-tree'),
  passed: z.boolean(),
  summary: z.string().trim().min(1).max(400),
  detail: z.string().max(2000).optional(),
}).strict()

const CreateTicketSchema = z.object({
  text: z.string().trim().min(1, '请写一句任务内容').max(10_000, '任务内容不能超过 10000 字'),
  model: z.string().max(200, '模型名过长').optional(),
  secrets: z.array(SecretNameSchema).max(100, '一次最多授权 100 个密钥').optional(),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
  projectMode: z.enum(['copy', 'direct', 'worktree']).optional(),
  collab: z.boolean().optional(),
  goal: GoalInputSchema.optional(),
  runnerId: z.string().trim().max(40).optional(),
  scriptId: z.string().trim().max(80).optional(),
  scriptParams: z.record(z.string(), z.unknown()).optional(),
}).strict()

const ReviewPostSchema = z.object({
  action: z.enum(['comment', 'approve', 'rework']).default('comment'),
  file: z.string().trim().max(400).optional(),
  line: z.number().int().min(1).max(1_000_000).optional(),
  comment: z.string().trim().max(2000).optional(),
  note: z.string().trim().max(2000).optional(),
}).strict()

const MergePostSchema = z.object({
  mode: z.enum(['merge', 'pr']).default('merge'),
  force: z.boolean().optional(),
  repo: z.string().trim().max(200).optional(),
  base: z.string().trim().max(120).optional(),
  title: z.string().trim().max(200).optional(),
  body: z.string().max(10_000).optional(),
}).strict()

const BrowserVerifyPostSchema = z.object({
  url: z.string().url('请提供合法的 http/https 地址'),
  steps: z.array(z.object({
    action: z.enum(['goto', 'fill', 'click', 'submit', 'reload', 'wait', 'assertText', 'assertNotText', 'assertVisible', 'assertValue', 'assertStatus']),
    url: z.string().max(1000).optional(),
    selector: z.string().max(300).optional(),
    name: z.string().max(200).optional(),
    value: z.string().max(4000).optional(),
    text: z.string().max(1000).optional(),
    status: z.number().int().min(100).max(599).optional(),
    ms: z.number().int().min(10).max(10_000).optional(),
  }).strict()).max(40).default([]),
  criterionId: z.string().trim().max(40).optional(),
  artifactVersion: z.string().trim().max(80).optional(),
  preferPlaywright: z.boolean().optional(),
}).strict()

const ArchiveQuerySchema = z.enum(['project', 'output'])
const SecretCreateSchema = z.object({
  name: SecretNameSchema,
  value: z.string().min(1, '密钥值不能为空').max(8192, '密钥值不能超过 8192 个字符'),
  description: z.string().trim().max(300, '描述不能超过 300 个字').optional(),
}).strict()
const SecretUpdateSchema = z.object({
  value: z.string().min(1, '密钥值不能为空').max(8192, '密钥值不能超过 8192 个字符').optional(),
  description: z.string().trim().max(300, '描述不能超过 300 个字').optional(),
}).strict()
const TicketSecretsSchema = z.object({ names: z.array(SecretNameSchema).max(100, '一次最多授权 100 个密钥') }).strict()
const SecretDecisionSchema = z.object({ decision: z.enum(['grant', 'deny'], { message: '决定只能是 grant 或 deny' }) }).strict()
const StopSchema = z.object({ reason: z.string().trim().max(2_000, '停止原因不能超过 2000 字').optional() }).strict()
const TextSchema = z.object({ text: z.string().trim().min(1, '内容不能为空').max(10_000, '内容不能超过 10000 字') }).strict()
const ReplySchema = z.object({
  text: z.string().trim().min(1, '内容不能为空').max(10_000, '内容不能超过 10000 字'),
  model: z.string().max(200, '模型名过长').optional(),
}).strict()
const DeleteTicketSchema = z.object({
  deleteWorkspace: z.boolean().optional(),
  force: z.boolean().optional(),
}).strict()
const BatchDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, '至少选择一个任务').max(200, '一次最多删除 200 个任务'),
  deleteWorkspace: z.boolean().optional(),
  force: z.boolean().optional(),
}).strict()

export async function handleTicketsAndAuditRoutes(deps: AdminRouteDeps, { req, res, url, method, route }: AdminRouteRequest): Promise<boolean> {
  const { host, store, ledger, events, projects, councils, activity, goals, contracts, createTicketPr, handleFiles } = deps

  // Secrets.
  if (route === '/secrets' && method === 'GET') {
    sendJson(res, 200, { items: host.listSecrets() })
    return true
  }
  if (route === '/secrets' && method === 'POST') {
    const parsed = SecretCreateSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    try { host.createSecret(parsed.data) } catch (error) {
      if (error instanceof AdminError && error.code === 'exists') {
        sendJson(res, 409, { error: 'exists', message: error.message })
        return true
      }
      throw error
    }
    sendJson(res, 200, { ok: true })
    return true
  }
  if (route === '/secrets/requests' && method === 'GET') {
    sendJson(res, 200, { items: host.secretRequests() })
    return true
  }
  const secretRequestMatch = /^\/secrets\/requests\/([^/]+)$/.exec(route)
  if (secretRequestMatch !== null && method === 'POST') {
    const id = decodeSegment(secretRequestMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '请求编号不合法。' }); return true }
    const parsed = SecretDecisionSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    host.decideSecretRequest(id, parsed.data.decision)
    sendJson(res, 200, { ok: true })
    return true
  }
  const secretMatch = /^\/secrets\/([^/]+)$/.exec(route)
  if (secretMatch !== null && method === 'PUT') {
    const name = decodeSegment(secretMatch[1] ?? '')
    if (name === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '密钥名称不合法。' }); return true }
    const parsed = SecretUpdateSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    host.updateSecret(name, parsed.data)
    sendJson(res, 200, { ok: true })
    return true
  }
  if (secretMatch !== null && method === 'DELETE') {
    const name = decodeSegment(secretMatch[1] ?? '')
    if (name === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '密钥名称不合法。' }); return true }
    host.deleteSecret(name)
    sendJson(res, 200, { ok: true })
    return true
  }

  // Tickets.
  if (route === '/tickets' && method === 'GET') {
    const statusValue = url.searchParams.get('status') ?? 'all'
    if (statusValue !== 'open' && statusValue !== 'ended' && statusValue !== 'needs-person' && statusValue !== 'all') {
      sendJson(res, 400, { error: 'invalid', message: 'status 只能是 open、ended、needs-person 或 all。' })
      return true
    }
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000)
    const result = host.listTickets({ status: statusValue as TicketStatusFilter, ...(q === '' ? {} : { q }), limit, offset })
    sendJson(res, 200, { total: result.total, items: result.items.map(labelSummary) })
    return true
  }
  if (route === '/tickets' && method === 'POST') {
    const parsed = CreateTicketSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    let goal: GoalSpec | undefined
    if (parsed.data.goal !== undefined) {
      try { goal = resolveGoal(parsed.data.goal, store.get().goal) } catch (error) {
        if (error instanceof GoalError) { invalid(res, [{ path: `goal.${error.field}`, message: error.message }]); return true }
        throw error
      }
    }
    const runner = parsed.data.runnerId
      ? {
          runnerId: parsed.data.runnerId,
          ...(parsed.data.scriptId ? { scriptId: parsed.data.scriptId } : {}),
          ...(parsed.data.scriptParams ? { scriptParams: parsed.data.scriptParams } : {}),
        }
      : undefined
    const result = await host.createTicket(
      parsed.data.text,
      parsed.data.model || undefined,
      parsed.data.secrets,
      parsed.data.projectId,
      parsed.data.collab,
      goal,
      parsed.data.projectMode,
      ...(runner ? [runner] : []),
    )
    sendJson(res, 200, { ok: true, ...result })
    return true
  }
  if (route === '/tickets/delete' && method === 'POST') {
    const parsed = BatchDeleteSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    sendJson(res, 200, host.deleteTickets(parsed.data.ids, {
      deleteWorkspace: parsed.data.deleteWorkspace ?? true,
      force: parsed.data.force ?? false,
    }))
    return true
  }

  const streamMatch = /^\/tickets\/([^/]+)\/activity\/stream$/.exec(route)
  if (streamMatch !== null && method === 'GET') {
    const id = decodeSegment(streamMatch[1] ?? '')
    if (id === undefined || host.ticket(id) === undefined) {
      sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' })
      return true
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    let last = clampInt(String(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? ''), 0, 0, Number.MAX_SAFE_INTEGER)
    let beat = 0
    const push = (): void => {
      if (res.writableEnded || res.destroyed) return
      const view = activity ? activity.list(id, last, 120) : { items: [], last: 0 }
      if (view.last < last) last = 0
      for (const item of view.items) res.write(`id: ${item.seq}\nevent: step\ndata: ${JSON.stringify(item)}\n\n`)
      if (view.items.length > 0) last = Math.max(last, view.last)
      else if (++beat % 15 === 0) res.write(': ping\n\n')
    }
    res.write('retry: 3000\n\n')
    try { push() } catch { /* next tick */ }
    const timer = setInterval(() => { try { push() } catch { /* keep stream */ } }, 1000)
    timer.unref()
    const stopStream = (): void => clearInterval(timer)
    res.on('close', stopStream)
    res.on('error', stopStream)
    return true
  }

  const activityMatch = /^\/tickets\/([^/]+)\/activity$/.exec(route)
  if (activityMatch !== null && method === 'GET') {
    const id = decodeSegment(activityMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    if (host.ticket(id) === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    const after = clampInt(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = clampInt(url.searchParams.get('limit'), 120, 1, 300)
    sendJson(res, 200, activity ? activity.list(id, after, limit) : { items: [], last: 0 })
    return true
  }

  const goalMatch = /^\/tickets\/([^/]+)\/goal$/.exec(route)
  if (goalMatch !== null) {
    if (goals === undefined) throw new AdminError('not_found', '目标功能没有开启。', 404)
    const id = decodeSegment(goalMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    const ticket = host.ticket(id)
    if (ticket === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    if (method === 'GET') { sendJson(res, 200, { goal: goals.view(id) ?? null }); return true }
    if (method === 'PUT') {
      if (ticket.status === 'ended') {
        sendJson(res, 400, { error: 'invalid', message: '任务已经结束。先在任务里发一句话重新打开，再设目标。' })
        return true
      }
      const parsed = GoalInputSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      let spec: GoalSpec
      try { spec = resolveGoal(parsed.data, store.get().goal) } catch (error) {
        if (error instanceof GoalError) { invalid(res, [{ path: error.field, message: error.message }]); return true }
        throw error
      }
      sendJson(res, 200, { ok: true, goal: goals.set(id, spec) ?? null })
      return true
    }
    if (method === 'DELETE') { sendJson(res, 200, { ok: goals.cancel(id) }); return true }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  const diffMatch = /^\/tickets\/([^/]+)\/diff$/.exec(route)
  if (diffMatch !== null && method === 'GET') {
    const id = decodeSegment(diffMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    if (host.ticket(id) === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    if (!projects) { sendJson(res, 200, { available: false, reason: '项目服务未启用', files: [], diff: '', truncated: false }); return true }
    const diff = await projects.ticketDiff(id)
    sendJson(res, 200, diff)
    return true
  }

  const reviewMatch = /^\/tickets\/([^/]+)\/review$/.exec(route)
  if (reviewMatch !== null) {
    const id = decodeSegment(reviewMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    if (host.ticket(id) === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    if (!projects) throw new AdminError('not_found', '项目服务未启用。', 404)
    if (method === 'GET') {
      const diff = await projects.ticketDiff(id)
      sendJson(res, 200, {
        reviews: diff.reviews ?? [],
        reviewState: diff.reviewState ?? null,
        needsReverify: Boolean(diff.needsReverify),
        ...(diff.staleReason ? { staleReason: diff.staleReason } : {}),
        ...(diff.headSha ? { headSha: diff.headSha } : {}),
      })
      return true
    }
    if (method === 'POST') {
      const parsed = ReviewPostSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const d = parsed.data
      if (d.action === 'approve') {
        const state = await projects.approveReview(id, d.note ?? '')
        try { events.add({ kind: 'ticket.reviewed', level: 'info', ticketId: id, text: `审查通过（${state.reviewedSha.slice(0, 8)}）` }) } catch { /* ignore */ }
        sendJson(res, 200, { ok: true, state })
        return true
      }
      if (d.action === 'rework') {
        if (d.file && d.comment) {
          await projects.addReviewComment(id, { file: d.file, line: d.line ?? 1, comment: d.comment })
        }
        const rw = await projects.requestRework(id, d.note ?? '')
        host.replyTicket(id, rw.prompt)
        try { events.add({ kind: 'ticket.rework', level: 'info', ticketId: id, text: `发起一键返工（${rw.openCount} 条批注）` }) } catch { /* ignore */ }
        sendJson(res, 200, { ok: true, ...rw })
        return true
      }
      if (!d.file || !d.comment) {
        invalid(res, [{ path: 'comment', message: '添加行级批注必须填写 file 和 comment' }])
        return true
      }
      const item = await projects.addReviewComment(id, { file: d.file, line: d.line ?? 1, comment: d.comment })
      sendJson(res, 200, { ok: true, item })
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  const mergeMatch = /^\/tickets\/([^/]+)\/merge$/.exec(route)
  if (mergeMatch !== null && method === 'POST') {
    const id = decodeSegment(mergeMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    const ticket = host.ticket(id)
    if (ticket === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    if (!projects) throw new AdminError('not_found', '项目服务未启用。', 404)
    const parsed = MergePostSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }

    if (parsed.data.mode === 'pr') {
      if (!createTicketPr) {
        sendJson(res, 400, { error: 'github_unavailable', message: '未配置 GitHub PR 创建能力。' })
        return true
      }
      if (!parsed.data.repo) {
        invalid(res, [{ path: 'repo', message: '创建 PR 必须填写目标仓库（例如 owner/repo）' }])
        return true
      }
      if (!parsed.data.force) {
        const diff = await projects.ticketDiff(id)
        if (diff.needsReverify) {
          sendJson(res, 409, { error: 'needs_reverify', needsReverify: true, message: diff.staleReason ?? '审查后代码已变化，请重新校验审查后再创建 PR。' })
          return true
        }
      }
      const committed = await projects.commitTicketBranch(id)
      if (!committed.ok) { sendJson(res, 400, { error: 'commit_failed', message: committed.message }); return true }
      const pr = await createTicketPr(id, {
        repo: parsed.data.repo,
        head: committed.branch,
        ...(parsed.data.base ? { base: parsed.data.base } : {}),
        title: parsed.data.title || ticket.title,
        body: parsed.data.body || `来自工单 ${id}（分支 ${committed.branch}，commit ${committed.headSha.slice(0, 10)}）`,
      })
      if (!pr.ok) { sendJson(res, 400, { error: 'pr_failed', message: pr.message }); return true }
      sendJson(res, 200, { ...pr, mode: 'pr', branch: committed.branch })
      return true
    }

    const result = await projects.mergeTicketWorktree(
      id,
      tid => host.ticket(tid)?.status === 'open',
      { force: Boolean(parsed.data.force) },
    )
    if (!result.ok) {
      sendJson(res, 409, { error: result.needsReverify ? 'needs_reverify' : 'merge_conflict', ...result })
      return true
    }
    try {
      events.add({
        kind: 'ticket.merged',
        level: 'info',
        ticketId: id,
        text: `已将工单分支 ${result.branch} 合并回项目主分支（${result.mergedCommit.slice(0, 8)}）`,
      })
    } catch { /* ignore */ }
    sendJson(res, 200, { ...result, mode: 'merge' })
    return true
  }

  const bvMatch = /^\/tickets\/([^/]+)\/browser-verify$/.exec(route)
  if (bvMatch !== null && method === 'POST') {
    const id = decodeSegment(bvMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    if (host.ticket(id) === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    const ws = host.workspaceRoot(id)
    if (!ws) { sendJson(res, 404, { error: 'not_found', message: '找不到该工单的工作区。' }); return true }
    const parsed = BrowserVerifyPostSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const result = await runBrowserVerify({
      url: parsed.data.url,
      steps: parsed.data.steps,
      outputDir: join(ws, 'output', 'browser-verify'),
      ticketId: id,
      ...(parsed.data.criterionId ? { criterionId: parsed.data.criterionId } : {}),
      ...(parsed.data.artifactVersion ? { artifactVersion: parsed.data.artifactVersion } : {}),
      ...(parsed.data.preferPlaywright !== undefined ? { preferPlaywright: parsed.data.preferPlaywright } : {}),
      ...(goals ? { goals } : {}),
    })
    sendJson(res, 200, { ok: result.ok, result })
    return true
  }

  const receiptMatch = /^\/tickets\/([^/]+)\/receipt$/.exec(route)
  if (receiptMatch !== null && method === 'GET') {
    const id = decodeSegment(receiptMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    const ticket = host.ticket(id)
    if (ticket === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    const contract = contracts?.get('ticket', id)
    const deliverables = host.deliverables(id).map(d => ({ path: d.path, size: d.size, kind: d.kind }))
    const receipt = goals?.buildReceipt(id, {
      deliverables,
      contractVersion: contract?.version ?? null,
      ...(contract?.criteria ? { contractCriteria: contract.criteria } : {}),
      needsPerson: Boolean(ticket.attention?.question),
      ...(ticket.attention?.question ? { question: ticket.attention.question } : {}),
      ended: ticket.status === 'ended',
      ...(ticket.outcome ? { outcome: ticket.outcome } : {}),
    }) ?? null
    sendJson(res, 200, { receipt, contract: contract ?? null })
    return true
  }

  const evMatch = /^\/tickets\/([^/]+)\/evidences$/.exec(route)
  if (evMatch !== null) {
    if (goals === undefined) throw new AdminError('not_found', '目标验收服务未启用。', 404)
    const id = decodeSegment(evMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    if (host.ticket(id) === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    if (method === 'GET') {
      sendJson(res, 200, { items: goals.listEvidences(id) })
      return true
    }
    if (method === 'POST') {
      const parsed = EvidenceInputSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const item = goals.recordEvidence(id, {
        kind: parsed.data.kind,
        ...(parsed.data.criterionId ? { criterionId: parsed.data.criterionId } : {}),
        runId: parsed.data.runId,
        artifactVersion: parsed.data.artifactVersion,
        passed: parsed.data.passed,
        summary: parsed.data.summary,
        ...(parsed.data.detail ? { detail: parsed.data.detail } : {}),
      })
      sendJson(res, 200, { ok: true, item })
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  const actionMatch = /^\/tickets\/([^/]+)\/(stop|retry|note|reply|files|secrets|deliverables|archive)$/.exec(route)
  const ticketMatch = /^\/tickets\/([^/]+)$/.exec(route)
  if (ticketMatch !== null && method === 'GET') {
    const id = decodeSegment(ticketMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    const ticket = host.ticket(id)
    if (ticket === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
    const totals = ledger.ticketTotals(id)
    const label = ticket.project?.preparing
      ? { label: '正在准备项目文件', hint: '正在把项目复制到这个任务的工作区，第一次会久一点。' }
      : ticketStatusLabel(ticket)
    const council = councils?.forTicket(id)
    const contract = contracts?.get('ticket', id)
    let receipt
    if (goals) {
      let deliverables: { path: string; size?: number; kind?: string }[] = []
      try { deliverables = host.deliverables(id).map(d => ({ path: d.path, size: d.size, kind: d.kind })) } catch { /* mock host */ }
      receipt = goals.buildReceipt(id, {
        deliverables,
        contractVersion: contract?.version ?? null,
        ...(contract?.criteria ? { contractCriteria: contract.criteria } : {}),
        needsPerson: Boolean(ticket.attention?.question),
        ...(ticket.attention?.question ? { question: ticket.attention.question } : {}),
        ended: ticket.status === 'ended',
        ...(ticket.outcome ? { outcome: ticket.outcome } : {}),
      })
    }
    sendJson(res, 200, {
      ...ticket,
      ...(council === undefined ? {} : { council }),
      ...(contract === undefined ? {} : { contract }),
      ...(receipt === undefined ? {} : { receipt }),
      secrets: host.ticketSecrets(id),
      previews: host.ticketPreviews(id),
      links: host.ticketLinks(id),
      stageLabel: label.label,
      stageHint: label.hint,
      usage: { totalUsd: totals.usd, calls: totals.calls, hit: totals.hit, miss: totals.miss, out: totals.out, hitRate: totals.hitRate },
      calls: ledger.calls({ ticketId: id, limit: 50 }),
      byAgent: ledger.ticketByAgent(id),
      ...(goals ? { goal: goals.view(id) } : {}),
      events: events.list({ ticketId: id, limit: 100 }),
    })
    return true
  }
  if (ticketMatch !== null && method === 'DELETE') {
    const id = decodeSegment(ticketMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    const parsed = DeleteTicketSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    sendJson(res, 200, host.deleteTicket(id, {
      deleteWorkspace: parsed.data.deleteWorkspace ?? true,
      force: parsed.data.force ?? false,
    }))
    return true
  }
  if (actionMatch !== null) {
    const id = decodeSegment(actionMatch[1] ?? '')
    const action = actionMatch[2]
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' }); return true }
    if (action === 'files' && method === 'GET') {
      handleFiles(res, id, url.searchParams.get('path') ?? '', url.searchParams.get('raw') === '1', url.searchParams.get('download') === '1')
      return true
    }
    if (action === 'deliverables' && method === 'GET') {
      if (host.ticket(id) === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
      sendJson(res, 200, { items: host.deliverables(id) })
      return true
    }
    if (action === 'archive' && method === 'GET') {
      const which = url.searchParams.get('path') ?? ''
      if (!ArchiveQuerySchema.safeParse(which).success) {
        sendJson(res, 400, { error: 'invalid_path', message: 'path 只能是 project 或 output。' })
        return true
      }
      const workspace = host.workspaceRoot(id)
      if (workspace === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return true }
      const directory = join(workspace, which)
      let info
      try { info = lstatSync(directory) } catch {
        sendJson(res, 404, { error: 'not_found', message: which === 'project' ? '这张票没有项目目录。' : '这张票没有产出目录。' })
        return true
      }
      if (!info.isDirectory() || info.isSymbolicLink()) { sendJson(res, 404, { error: 'not_found', message: '这个目录不存在。' }); return true }
      let realDirectory: string
      let realWorkspace: string
      try { realDirectory = realpathSync(directory); realWorkspace = realpathSync(workspace) }
      catch { sendJson(res, 404, { error: 'not_found', message: '这个目录不存在。' }); return true }
      if (!isInside(realWorkspace, realDirectory)) { sendJson(res, 403, { error: 'forbidden', message: '这个目录超出了任务的工作区。' }); return true }
      serveTarArchive(res, realDirectory, `${id}-${which}.tar.gz`)
      return true
    }
    if (action === 'secrets' && method === 'PUT') {
      const parsed = TicketSecretsSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      sendJson(res, 200, host.setTicketSecrets(id, parsed.data.names))
      return true
    }
    if (action === 'stop' && method === 'POST') {
      const parsed = StopSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      host.stopTicket(id, parsed.data.reason === undefined || parsed.data.reason === '' ? undefined : parsed.data.reason)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (action === 'retry' && method === 'POST') { host.retryTicket(id); sendJson(res, 200, { ok: true }); return true }
    if (action === 'note' && method === 'POST') {
      const parsed = TextSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      host.noteTicket(id, parsed.data.text)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (action === 'reply' && method === 'POST') {
      const parsed = ReplySchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      if (parsed.data.model) host.replyTicket(id, parsed.data.text, parsed.data.model)
      else host.replyTicket(id, parsed.data.text)
      sendJson(res, 200, { ok: true })
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  // Decisions.
  if (route === '/decisions' && method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000)
    const kindValue = url.searchParams.get('kind') ?? ''
    const kinds = ['accept', 'ignore', 'stop', 'unavailable', 'reopen']
    if (kindValue !== '' && !kinds.includes(kindValue)) {
      sendJson(res, 400, { error: 'invalid', message: 'kind 只能是 accept、ignore、stop、unavailable 或 reopen。' })
      return true
    }
    const items = host.decisions(limit, offset, kindValue === '' ? undefined : kindValue).map(decision => {
      const { texts, unknown } = reasonLabels(decision.reasons)
      return {
        id: decision.id,
        at: decision.at,
        kind: decision.kind,
        kindLabel: decisionKindLabel(decision.kind),
        threadKey: decision.threadKey,
        ...(decision.ticketId === undefined ? {} : { ticketId: decision.ticketId }),
        triggerText: decision.triggerText,
        reasonText: texts,
        strength: decision.strength,
        ...(unknown.length === 0 ? {} : { data: { reasons: unknown } }),
      }
    })
    sendJson(res, 200, { items })
    return true
  }

  // Usage.
  if (route === '/usage' && method === 'GET') {
    const rangeValue = url.searchParams.get('range') ?? 'today'
    if (rangeValue !== 'today' && rangeValue !== '7d' && rangeValue !== '30d') {
      sendJson(res, 400, { error: 'invalid', message: 'range 只能是 today、7d 或 30d。' })
      return true
    }
    const summary = ledger.summary(rangeValue as UsageRange)
    const titles = host.ticketTitles(summary.topTickets.map(ticket => ticket.ticketId))
    sendJson(res, 200, {
      totals: summary.totals,
      byDay: summary.byDay,
      byModel: summary.byModel,
      topTickets: summary.topTickets.map(ticket => ({
        ticketId: ticket.ticketId,
        title: titles[ticket.ticketId] ?? '',
        usd: ticket.usd,
        calls: ticket.calls,
      })),
    })
    return true
  }
  if (route === '/usage/calls' && method === 'GET') {
    const ticketId = url.searchParams.get('ticketId') ?? undefined
    const model = url.searchParams.get('model') ?? undefined
    const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500)
    const before = optionalCursor(url.searchParams.get('before'))
    sendJson(res, 200, {
      items: ledger.calls({
        ...(ticketId === undefined || ticketId === '' ? {} : { ticketId }),
        ...(model === undefined || model === '' ? {} : { model }),
        limit,
        ...(before === undefined ? {} : { before }),
      }),
    })
    return true
  }

  // Events.
  if (route === '/events' && method === 'GET') {
    const ticketId = url.searchParams.get('ticketId') ?? undefined
    const level = url.searchParams.get('level') ?? undefined
    if (level !== undefined && level !== 'info' && level !== 'warn' && level !== 'error') {
      sendJson(res, 400, { error: 'invalid', message: 'level 只能是 info、warn 或 error。' })
      return true
    }
    const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500)
    const before = optionalCursor(url.searchParams.get('before'))
    sendJson(res, 200, {
      items: events.list({
        ...(ticketId === undefined || ticketId === '' ? {} : { ticketId }),
        ...(level === undefined ? {} : { level: level as EventLevel }),
        limit,
        ...(before === undefined ? {} : { before }),
      }),
    })
    return true
  }

  return false
}
