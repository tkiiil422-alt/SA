/**
 * 总控助手（Director）对话、审批与自动续接路由（`/director/*`）。
 */
import { z } from 'zod'
import { AdminError } from '../host.ts'
import { SECURITY_HEADERS, decodeSegment, invalid, issuesOf, parseJsonBody, sendJson } from '../http.ts'
import type { DirectorService } from '../../director/service.ts'
import type { AdminRouteDeps, AdminRouteRequest } from './types.ts'

const DirectorChatSchema = z.object({
  text: z.string().trim().min(1, '请输入对话内容').max(20_000, '对话内容不能超过 20000 字'),
  channel: z.enum(['web', 'wechat', 'feishu']).default('web'),
  userId: z.string().trim().min(1).max(200).default('console'),
  deliverToWechat: z.boolean().default(true),
}).strict()

const DirectorActionDecideSchema = z.object({
  decision: z.enum(['approve', 'reject']),
}).strict()

const DirectorCreateSessionSchema = z.object({
  channel: z.enum(['web', 'feishu', 'wechat']).default('web'),
  userId: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().max(120).optional(),
  resetIfExists: z.boolean().default(false),
}).strict()

const DirectorBatchDeleteSessionsSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(200)).min(1, '请至少选择一个会话').max(200, '单次最多删除 200 个会话'),
}).strict()

const DirectorBatchDeleteMessagesSchema = z.object({
  messageIds: z.array(z.number().int().positive()).min(1, '请至少选择一条消息').max(500, '单次最多删除 500 条消息'),
}).strict()

function requireDirector(deps: AdminRouteDeps): DirectorService {
  if (deps.director === undefined) throw new AdminError('not_found', '这台服务器没有启用总控助手。', 404)
  return deps.director
}

export async function handleDirectorRoutes(deps: AdminRouteDeps, { req, res, url, method, route }: AdminRouteRequest): Promise<boolean> {
  if (!route.startsWith('/director/')) return false

  if (route === '/director/status' && method === 'GET') {
    sendJson(res, 200, requireDirector(deps).status())
    return true
  }
  if (route === '/director/sessions' && method === 'POST') {
    const parsed = DirectorCreateSessionSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const svc = requireDirector(deps)
    const { channel, resetIfExists } = parsed.data
    const nowTag = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    const userId = parsed.data.userId || `${channel}-${Date.now().toString(36)}`
    const defaultTitle = channel === 'feishu'
      ? `飞书对话 (${userId.slice(0, 14)})`
      : channel === 'wechat'
        ? `微信对话 (${userId.slice(0, 14)})`
        : `网页对话 ${nowTag}`
    const title = parsed.data.title || defaultTitle
    const session = svc.store.getOrCreateSession(channel, userId, title)
    if (resetIfExists) svc.resetSession(session.id)
    sendJson(res, 201, { ok: true, session })
    return true
  }
  if (route === '/director/sessions' && method === 'GET') {
    const channelRaw = url.searchParams.get('channel')
    const channel = channelRaw === 'wechat' || channelRaw === 'web' || channelRaw === 'feishu' ? channelRaw : undefined
    const svc = requireDirector(deps)
    sendJson(res, 200, {
      status: svc.status(),
      items: svc.listSessions(channel),
      pendingActions: svc.listPendingActions(undefined, true),
    })
    return true
  }
  if (route === '/director/sessions/batch-delete' && method === 'POST') {
    const parsed = DirectorBatchDeleteSessionsSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const out = requireDirector(deps).deleteSessions(parsed.data.ids)
    sendJson(res, 200, { ok: true, ...out })
    return true
  }
  const dirMsgBatchDelMatch = /^\/director\/sessions\/([^/]+)\/messages\/batch-delete$/.exec(route)
  if (dirMsgBatchDelMatch !== null && method === 'POST') {
    const sid = decodeSegment(dirMsgBatchDelMatch[1] ?? '')
    const parsed = DirectorBatchDeleteMessagesSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const out = sid ? requireDirector(deps).deleteMessages(sid, parsed.data.messageIds) : { ok: false, deleted: 0 }
    if (!out.ok) {
      sendJson(res, 404, { error: 'not_found', message: '找不到这个总控会话。' })
      return true
    }
    sendJson(res, 200, out)
    return true
  }
  const dirResetMatch = /^\/director\/sessions\/([^/]+)\/reset$/.exec(route)
  if (dirResetMatch !== null && method === 'POST') {
    const sid = decodeSegment(dirResetMatch[1] ?? '')
    if (!sid || !requireDirector(deps).resetSession(sid)) {
      sendJson(res, 404, { error: 'not_found', message: '找不到这个总控会话。' })
      return true
    }
    sendJson(res, 200, { ok: true })
    return true
  }
  const dirSessionMatch = /^\/director\/sessions\/([^/]+)$/.exec(route)
  if (dirSessionMatch !== null && method === 'DELETE') {
    const sid = decodeSegment(dirSessionMatch[1] ?? '')
    if (!sid || !requireDirector(deps).deleteSession(sid)) {
      sendJson(res, 404, { error: 'not_found', message: '找不到这个总控会话。' })
      return true
    }
    sendJson(res, 200, { ok: true, id: sid })
    return true
  }
  if (dirSessionMatch !== null && method === 'GET') {
    const sid = decodeSegment(dirSessionMatch[1] ?? '')
    const detail = sid ? requireDirector(deps).getSessionDetail(sid) : undefined
    if (!detail) {
      sendJson(res, 404, { error: 'not_found', message: '找不到这个总控会话。' })
      return true
    }
    sendJson(res, 200, detail)
    return true
  }
  if (route === '/director/chat' && method === 'POST') {
    const svc = requireDirector(deps)
    const parsed = DirectorChatSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const resChat = await svc.chat(parsed.data)
    sendJson(res, 200, { ok: true, ...resChat })
    return true
  }
  if (route === '/director/chat/stream' && method === 'POST') {
    const svc = requireDirector(deps)
    const parsed = DirectorChatSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    const writeEvent = (ev: unknown): void => {
      if (res.writableEnded || res.destroyed) return
      res.write(`event: progress\ndata: ${JSON.stringify(ev)}\n\n`)
    }
    const abort = new AbortController()
    const onClose = (): void => abort.abort()
    req.on('close', onClose)
    try {
      const resChat = await svc.chat({
        ...parsed.data,
        signal: abort.signal,
        onProgress: ev => writeEvent(ev),
      })
      writeEvent({ type: 'done', result: { ok: true, ...resChat } })
    } catch (error) {
      writeEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      req.off('close', onClose)
      if (!res.writableEnded) res.end()
    }
    return true
  }
  if (route === '/director/actions' && method === 'GET') {
    const sid = url.searchParams.get('sessionId') || undefined
    const onlyPending = url.searchParams.get('pending') === '1'
    sendJson(res, 200, { items: requireDirector(deps).listPendingActions(sid, onlyPending) })
    return true
  }
  const dirActionMatch = /^\/director\/actions\/([^/]+)\/decide$/.exec(route)
  if (dirActionMatch !== null && method === 'POST') {
    const aid = decodeSegment(dirActionMatch[1] ?? '')
    if (!aid) { sendJson(res, 400, { error: 'invalid', message: '缺少操作短码。' }); return true }
    const parsed = DirectorActionDecideSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const decided = await requireDirector(deps).decidePendingAction(aid, parsed.data.decision)
    sendJson(res, decided.ok ? 200 : 400, decided)
    return true
  }
  if (route === '/director/followups' && method === 'GET') {
    const sid = url.searchParams.get('sessionId') || undefined
    const onlyPending = url.searchParams.get('pending') === '1'
    sendJson(res, 200, { items: requireDirector(deps).store.listFollowups(sid, onlyPending) })
    return true
  }
  const dirFwCancelMatch = /^\/director\/followups\/([^/]+)\/cancel$/.exec(route)
  if (dirFwCancelMatch !== null && method === 'POST') {
    const fid = decodeSegment(dirFwCancelMatch[1] ?? '')
    if (!fid) { sendJson(res, 400, { error: 'invalid', message: '缺少续接计划编号。' }); return true }
    const ok = requireDirector(deps).store.cancelFollowup(fid)
    sendJson(res, ok ? 200 : 404, ok ? { ok: true, id: fid } : { error: 'not_found', message: '未找到处于等待状态的续接计划。' })
    return true
  }

  return false
}
