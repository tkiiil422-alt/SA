/**
 * 项目库与分块上传路由（`/uploads/*`、`/projects/*`）。
 */
import { z } from 'zod'
import { AdminError } from '../host.ts'
import { decodeSegment, handleFilesInRoot, header, invalid, issuesOf, parseJsonBody, sendJson } from '../http.ts'
import { UploadConflict, type ProjectService } from '../../projects/service.ts'
import type { AdminRouteDeps, AdminRouteRequest } from './types.ts'

const ProjectImportSchema = z.object({
  path: z.string().trim().min(1, '请填写要导入的目录').max(1000),
  name: z.string().trim().min(1, '请填写项目名').max(120),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
}).strict()

const ProjectRestoreSchema = z.object({
  snapshot: z.string().regex(/^[0-9a-f]{7,40}$/, '快照编号不合法'),
}).strict()

const UploadCreateSchema = z.object({
  name: z.string().trim().min(1, '请填写压缩包文件名').max(255, '文件名不能超过 255 个字符'),
  size: z.number().int('文件大小必须是整数').positive('文件大小必须大于 0').max(Number.MAX_SAFE_INTEGER, '文件太大'),
  kind: z.literal('project').optional(),
}).strict()

const UploadFinishSchema = z.object({
  projectName: z.string().trim().max(120, '项目名不能超过 120 个字').optional(),
}).strict()

function requireProjects(deps: AdminRouteDeps): ProjectService {
  if (deps.projects === undefined) throw new AdminError('not_found', '这台服务器没有启用项目库。', 404)
  return deps.projects
}

export async function handleProjectsRoutes(deps: AdminRouteDeps, { req, res, url, method, route }: AdminRouteRequest): Promise<boolean> {
  const { host, events } = deps

  if (route === '/uploads' && method === 'POST') {
    const service = requireProjects(deps)
    const parsed = UploadCreateSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    sendJson(res, 200, service.createUpload({ name: parsed.data.name, size: parsed.data.size }))
    return true
  }

  const uploadFinishMatch = /^\/uploads\/([^/]+)\/finish$/.exec(route)
  if (uploadFinishMatch !== null && method === 'POST') {
    const service = requireProjects(deps)
    const uploadId = decodeSegment(uploadFinishMatch[1] ?? '')
    if (uploadId === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '上传编号不合法。' }); return true }
    const parsed = UploadFinishSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    sendJson(res, 200, service.finishUpload(uploadId, parsed.data.projectName))
    return true
  }

  const uploadMatch = /^\/uploads\/([^/]+)$/.exec(route)
  if (uploadMatch !== null) {
    const service = requireProjects(deps)
    const uploadId = decodeSegment(uploadMatch[1] ?? '')
    if (uploadId === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '上传编号不合法。' }); return true }
    if (method === 'GET') {
      const info = service.uploadInfo(uploadId)
      if (info === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这个上传任务，请重新开始。' }); return true }
      sendJson(res, 200, info)
      return true
    }
    if (method === 'PUT') {
      const offsetText = url.searchParams.get('offset') ?? ''
      const offset = Number(offsetText)
      if (offsetText.trim() === '' || !Number.isInteger(offset) || offset < 0) {
        req.resume()
        sendJson(res, 400, { error: 'invalid_offset', message: 'offset 必须是从 0 开始的整数。' })
        return true
      }
      try {
        const result = await service.appendChunk(uploadId, offset, req, header(req, 'x-chunk-sha256') || undefined)
        sendJson(res, 200, result)
      } catch (error) {
        if (error instanceof UploadConflict) {
          sendJson(res, 409, {
            error: 'offset_mismatch',
            message: `这一块的位置不对，服务端已收到 ${error.received} 字节，请从这里继续。`,
            received: error.received,
          })
          return true
        }
        throw error
      }
      return true
    }
    if (method === 'DELETE') {
      if (!service.cancelUpload(uploadId)) { sendJson(res, 404, { error: 'not_found', message: '找不到这个上传任务。' }); return true }
      sendJson(res, 200, { ok: true })
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/projects' && method === 'GET') {
    sendJson(res, 200, { items: requireProjects(deps).list() })
    return true
  }

  const ticketIsOpen = (id: string): boolean => {
    const ticket = host.ticket(id)
    return ticket !== undefined && ticket.status !== 'ended'
  }

  if (route === '/projects/import' && method === 'POST') {
    const parsed = ProjectImportSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const result = await requireProjects(deps).importDirectory({
      sourceDir: parsed.data.path,
      name: parsed.data.name,
      ...(parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
    }, ticketIsOpen)
    sendJson(res, 200, { ok: true, ...result })
    return true
  }

  const projectSnapshotsMatch = /^\/projects\/([^/]+)\/snapshots$/.exec(route)
  if (projectSnapshotsMatch !== null && method === 'GET') {
    const id = decodeSegment(projectSnapshotsMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' }); return true }
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50))
    sendJson(res, 200, { items: await requireProjects(deps).snapshots(id, limit) })
    return true
  }

  const projectDiffMatch = /^\/projects\/([^/]+)\/snapshots\/diff$/.exec(route)
  if (projectDiffMatch !== null && method === 'GET') {
    const id = decodeSegment(projectDiffMatch[1] ?? '')
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? undefined
    if (id === undefined || !/^[0-9a-f]{7,40}$/.test(from) || (to !== undefined && !/^[0-9a-f]{7,40}$/.test(to))) {
      sendJson(res, 400, { error: 'invalid', message: '项目编号或快照编号不合法。' })
      return true
    }
    try {
      sendJson(res, 200, await requireProjects(deps).snapshotDiff(id, from, to))
    } catch (error) {
      if (error instanceof AdminError) throw error
      sendJson(res, 400, { error: 'invalid', message: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  const projectDeleteSnapshotMatch = /^\/projects\/([^/]+)\/snapshots\/([^/]+)$/.exec(route)
  if (projectDeleteSnapshotMatch !== null && method === 'DELETE') {
    const id = decodeSegment(projectDeleteSnapshotMatch[1] ?? '')
    const sha = decodeSegment(projectDeleteSnapshotMatch[2] ?? '')
    if (id === undefined || sha === undefined || !/^[0-9a-f]{7,40}$/.test(sha)) {
      sendJson(res, 400, { error: 'invalid', message: '项目编号或快照编号不合法。' })
      return true
    }
    const deleted = await requireProjects(deps).deleteSnapshot(id, sha, ticketIsOpen)
    try {
      events.add({
        kind: 'project.snapshot_deleted',
        level: 'info',
        text: `删除了项目 ${id} 的历史快照 ${deleted.deleted.slice(0, 8)}（剩余 ${deleted.remaining} 条）`,
        data: { projectId: id, ...deleted },
      })
    } catch { /* 审计写入失败不影响成功返回 */ }
    sendJson(res, 200, { ok: true, ...deleted })
    return true
  }

  const projectRestoreMatch = /^\/projects\/([^/]+)\/restore$/.exec(route)
  if (projectRestoreMatch !== null && method === 'POST') {
    const id = decodeSegment(projectRestoreMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' }); return true }
    const parsed = ProjectRestoreSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    sendJson(res, 200, { ok: true, ...await requireProjects(deps).restoreSnapshot(id, parsed.data.snapshot, ticketIsOpen) })
    return true
  }

  const projectFilesMatch = /^\/projects\/([^/]+)\/files$/.exec(route)
  if (projectFilesMatch !== null && method === 'GET') {
    const id = decodeSegment(projectFilesMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' }); return true }
    const root = requireProjects(deps).treeRoot(id)
    if (root === undefined) { sendJson(res, 404, { error: 'not_found', message: '项目还没准备好，或找不到这个项目。' }); return true }
    handleFilesInRoot(res, root, url.searchParams.get('path') ?? '', url.searchParams.get('raw') === '1', url.searchParams.get('download') === '1')
    return true
  }

  const projectMatch = /^\/projects\/([^/]+)$/.exec(route)
  if (projectMatch !== null) {
    const id = decodeSegment(projectMatch[1] ?? '')
    if (id === undefined) { sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' }); return true }
    const service = requireProjects(deps)
    if (method === 'GET') {
      const project = service.get(id)
      if (project === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这个项目。' }); return true }
      sendJson(res, 200, project)
      return true
    }
    if (method === 'DELETE') {
      if (!service.delete(id)) { sendJson(res, 404, { error: 'not_found', message: '找不到这个项目。' }); return true }
      sendJson(res, 200, { ok: true })
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  return false
}
