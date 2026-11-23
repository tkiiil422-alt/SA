/**
 * Pi 版本、开发环境镜像与多角色会商路由（`/pi/*`、`/devenv/*`、`/councils/*`）。
 */
import { z } from 'zod'
import { AdminError } from '../host.ts'
import { clampInt, decodeSegment, invalidWithHint, parseJsonBody, SecretNameSchema, sendJson } from '../http.ts'
import { MAX_COUNCIL_BRIEF_CHARS, type CouncilService } from '../../council/service.ts'
import { PiVersionError } from '../../executor/pi-versions.ts'
import { DevEnvError } from '../../executor/dev-env.ts'
import type { AdminRouteDeps, AdminRouteRequest } from './types.ts'

const CouncilCreateSchema = z.object({
  mode: z.enum(['brief', 'decision'], { message: '会商模式只能是 brief 或 decision' }),
  text: z.string().trim().min(1, '会商话题不能为空').max(10_000, '会商话题不能超过 10000 字，请精简后再召集会商。'),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
  ticketId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '任务票编号不合法').optional(),
  rounds: z.number().int('必须是整数').min(1, '轮数不能小于 1').max(3, '轮数不能大于 3').optional(),
  roles: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, '角色 id 不合法')).max(20, '一次最多选择 20 个角色').optional(),
  autoStart: z.boolean().optional(),
}).strict()

const CouncilCommitSchema = z.object({
  brief: z.string().max(MAX_COUNCIL_BRIEF_CHARS, '会商任务书不能超过 10000 字，请精简后再开票。').optional(),
  model: z.string().max(200, '模型名过长').optional(),
  secrets: z.array(SecretNameSchema).max(100, '一次最多授权 100 个密钥').optional(),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
}).strict()

function requireCouncils(deps: AdminRouteDeps): CouncilService {
  if (deps.councils === undefined) throw new AdminError('not_found', '这台服务器没有启用会商。', 404)
  return deps.councils
}

export async function handleCouncilsAndRuntimeRoutes(deps: AdminRouteDeps, { req, res, url, method, route }: AdminRouteRequest): Promise<boolean> {
  const { host, piVersions, devEnv } = deps

  if (route.startsWith('/pi/')) {
    if (piVersions === undefined) throw new AdminError('not_found', 'Pi 版本管理没有开启。', 404)
    const pi = async <T>(work: () => Promise<T>): Promise<void> => {
      try { sendJson(res, 200, await work()) } catch (e) {
        if (e instanceof PiVersionError) throw new AdminError('pi', e.message, e.status)
        throw e
      }
    }
    const field = async (name: 'version' | 'image'): Promise<string> => {
      const body = await parseJsonBody(req)
      const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined
      if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new AdminError('invalid', `缺少 ${name}。`, 400)
      return value.trim()
    }
    if (route === '/pi/status' && method === 'GET') { await pi(() => piVersions.status()); return true }
    if (route === '/pi/check' && method === 'POST') { await pi(() => piVersions.check()); return true }
    if (route === '/pi/build' && method === 'POST') {
      const body = await parseJsonBody(req)
      const obj = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
      const v = typeof obj.version === 'string' ? obj.version.trim() : ''
      if (!v || v.length > 200) throw new AdminError('invalid', '缺少 version。', 400)
      const baseImage = obj.baseImage === null || typeof obj.baseImage === 'string' ? obj.baseImage : undefined
      const mirrors = typeof obj.mirrors === 'boolean' ? obj.mirrors : undefined
      await pi(() => piVersions.startBuild(v, {
        ...(baseImage !== undefined ? { baseImage } : {}),
        ...(mirrors !== undefined ? { mirrors } : {}),
      }))
      return true
    }
    if (route === '/pi/apply' && method === 'POST') { const i = await field('image'); await pi(() => piVersions.apply(i)); return true }
    if (route === '/pi/remove' && method === 'POST') { const i = await field('image'); await pi(() => piVersions.remove(i)); return true }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route.startsWith('/devenv/')) {
    if (devEnv === undefined) throw new AdminError('not_found', '开发环境管理没有开启。', 404)
    const dev = async <T>(work: () => Promise<T>): Promise<void> => {
      try { sendJson(res, 200, await work()) } catch (e) {
        if (e instanceof DevEnvError) throw new AdminError('devenv', e.message, e.status)
        throw e
      }
    }
    if (route === '/devenv/status' && method === 'GET') { await dev(() => devEnv.status()); return true }
    if (route === '/devenv/build' && method === 'POST') {
      const body = await parseJsonBody(req)
      const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
      await dev(() => devEnv.startBuild({ packages: input.packages, features: input.features, mirrors: input.mirrors }))
      return true
    }
    if (route === '/devenv/repack' && method === 'POST') {
      const body = await parseJsonBody(req)
      const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
      const devImage = typeof input.devImage === 'string' ? input.devImage.trim() : ''
      if (!devImage || devImage.length > 200) throw new AdminError('invalid', '缺少 devImage。', 400)
      const mirrors = typeof input.mirrors === 'boolean' ? input.mirrors : undefined
      await dev(() => devEnv.startRepack(devImage, { ...(mirrors !== undefined ? { mirrors } : {}) }))
      return true
    }
    if (route === '/devenv/apply' && method === 'POST') {
      const body = await parseJsonBody(req)
      const image = body && typeof body === 'object' ? (body as Record<string, unknown>).image : undefined
      if (typeof image !== 'string' || !image.trim() || image.length > 200) throw new AdminError('invalid', '缺少 image。', 400)
      await dev(() => devEnv.apply(image.trim()))
      return true
    }
    if (route === '/devenv/remove' && method === 'POST') {
      const body = await parseJsonBody(req)
      const image = body && typeof body === 'object' ? (body as Record<string, unknown>).image : undefined
      if (typeof image !== 'string' || !image.trim() || image.length > 200) throw new AdminError('invalid', '缺少 image。', 400)
      await dev(() => devEnv.removeDevImage(image.trim()))
      return true
    }
    if (route === '/devenv/cache/clean' && method === 'POST') {
      const body = await parseJsonBody(req)
      const bucket = body && typeof body === 'object' ? (body as Record<string, unknown>).bucket : undefined
      if (typeof bucket !== 'string' || !bucket.trim() || bucket.length > 64) throw new AdminError('invalid', '缺少要清理的缓存桶名称 bucket。', 400)
      await dev(() => Promise.resolve(devEnv.cleanSharedCache(bucket.trim())))
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/councils' && method === 'GET') {
    const ticketId = url.searchParams.get('ticketId') ?? ''
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
    sendJson(res, 200, {
      items: requireCouncils(deps).list({ ...(ticketId === '' ? {} : { ticketId }), limit }),
    })
    return true
  }
  if (route === '/councils' && method === 'POST') {
    const service = requireCouncils(deps)
    const parsed = CouncilCreateSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalidWithHint(res, parsed.error, ['text']); return true }
    const created = service.create({
      mode: parsed.data.mode,
      text: parsed.data.text,
      ...(parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
      ...(parsed.data.ticketId === undefined ? {} : { ticketId: parsed.data.ticketId }),
      ...(parsed.data.rounds === undefined ? {} : { rounds: parsed.data.rounds }),
      ...(parsed.data.roles === undefined ? {} : { roles: parsed.data.roles }),
      ...(parsed.data.autoStart === undefined ? {} : { autoStart: parsed.data.autoStart }),
    })
    sendJson(res, 200, created)
    return true
  }
  const councilActionMatch = /^\/councils\/([^/]+)\/(cancel|commit)$/.exec(route)
  if (councilActionMatch !== null && method === 'POST') {
    const service = requireCouncils(deps)
    const id = decodeSegment(councilActionMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '会商编号不合法。' }); return true }
    const action = councilActionMatch[2]
    if (action === 'cancel') {
      service.cancel(id)
      sendJson(res, 200, { ok: true })
      return true
    }
    const parsed = CouncilCommitSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalidWithHint(res, parsed.error, ['brief']); return true }
    const record = service.get(id)
    if (record === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这次会商。' }); return true }
    if (record.mode !== 'brief') throw new AdminError('invalid', '只有任务书模式的会商可以开票。', 400)
    if (record.status !== 'done') throw new AdminError('invalid', '会商还没完成，不能开票。', 400)
    if (record.ticketId !== undefined) throw new AdminError('invalid', '这次会商已经开过任务了。', 400)
    const brief = (parsed.data.brief ?? record.brief ?? '').trim()
    if (brief === '') throw new AdminError('invalid', '这次会商还没有任务书，请等主持人汇总完成。', 400)
    if (brief.length > MAX_COUNCIL_BRIEF_CHARS) throw new AdminError('invalid', '会商任务书不能超过 10000 字，请精简后再开票。', 400)
    const projectId = parsed.data.projectId ?? record.projectId
    service.rememberBrief(id, brief)
    const result = await host.createTicket(brief, parsed.data.model || undefined, parsed.data.secrets, projectId)
    if (result.ticketId !== undefined) service.attachTicket(id, result.ticketId)
    sendJson(res, 200, {
      ok: true,
      ...(result.ticketId === undefined ? {} : { ticketId: result.ticketId }),
      triggerId: result.triggerId,
    })
    return true
  }
  const councilMatch = /^\/councils\/([^/]+)$/.exec(route)
  if (councilMatch !== null) {
    const service = requireCouncils(deps)
    const id = decodeSegment(councilMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '会商编号不合法。' }); return true }
    if (method === 'GET') {
      const detail = service.detail(id)
      if (detail === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这次会商。' }); return true }
      sendJson(res, 200, detail)
      return true
    }
    if (method === 'DELETE') {
      if (!service.remove(id)) { sendJson(res, 404, { error: 'not_found', message: '找不到这次会商。' }); return true }
      sendJson(res, 200, { ok: true })
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  return false
}
