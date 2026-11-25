/**
 * 小说创作与番茄发布路由（`/novels/*`、`/fanqie/*`）。
 */
import { z } from 'zod'
import { AdminError } from '../host.ts'
import { clampInt, decodeSegment, invalid, invalidWithHint, issuesOf, parseJsonBody, sendJson } from '../http.ts'
import { NovelError, type NovelService } from '../../novel/service.ts'
import type { AdminRouteDeps, AdminRouteRequest } from './types.ts'

const BookIdSchema = z.string().regex(/^b_[A-Za-z0-9]{1,32}$/)
const NovelOpenSchema = z.object({
  idea: z.string().trim().min(1, '请写一句灵感').max(4000, '灵感不能超过 4000 字'),
  genre: z.enum(['xianxia', 'xuanhuan'], { message: '题材只能是仙侠或玄幻' }),
  title: z.string().trim().max(60, '书名不能超过 60 个字').optional(),
  chapterChars: z.tuple([z.number().int().min(500), z.number().int().max(20000)]).optional(),
  volumes: z.number().int().min(1).max(50).optional(),
  chaptersPerVolume: z.number().int().min(5).max(1000).optional(),
}).strict()
const NovelImportSchema = z.object({
  title: z.string().trim().min(1, '请写书名').max(60),
  genre: z.enum(['xianxia', 'xuanhuan']),
  idea: z.string().max(4000).optional(),
  chapterChars: z.tuple([z.number().int().min(500), z.number().int().max(20000)]).optional(),
  volumes: z.number().int().min(1).max(50).optional(),
  chaptersPerVolume: z.number().int().min(5).max(1000).optional(),
  setup: z.unknown(),
}).strict()
const NovelArcSchema = z.object({ note: z.string().trim().max(500, '要求不能超过 500 字').optional() }).strict()
const NovelEditSchema = z.object({ note: z.string().trim().min(1, '请写一句要怎么改').max(1000, '修改意见不能超过 1000 字') }).strict()

function requireNovels(deps: AdminRouteDeps): NovelService {
  if (deps.novels === undefined || !deps.store.get().novel.enabled) {
    throw new AdminError('not_found', '写小说功能没有开启。', 404)
  }
  return deps.novels
}

async function novelCall<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof NovelError) {
      const status = error.code === 'not_found' || error.code === 'disabled' ? 404 : error.code === 'conflict' ? 409 : 400
      throw new AdminError(error.code === 'disabled' ? 'not_found' : error.code, error.message, status)
    }
    throw error
  }
}

export async function handleNovelsRoutes(deps: AdminRouteDeps, { req, res, url, method, route }: AdminRouteRequest): Promise<boolean> {
  const { fanqie } = deps

  if (route === '/novels' && method === 'GET') {
    const service = requireNovels(deps)
    sendJson(res, 200, { items: await novelCall(() => service.list()) })
    return true
  }
  if (route === '/novels' && method === 'POST') {
    const service = requireNovels(deps)
    const parsed = NovelOpenSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalidWithHint(res, parsed.error, ['idea']); return true }
    const input = parsed.data
    const created = await novelCall(() => service.openBook({
      idea: input.idea,
      genre: input.genre,
      ...(input.title ? { title: input.title } : {}),
      ...(input.chapterChars ? { chapterChars: input.chapterChars } : {}),
      ...(input.volumes ? { volumes: input.volumes } : {}),
      ...(input.chaptersPerVolume ? { chaptersPerVolume: input.chaptersPerVolume } : {}),
    }))
    sendJson(res, 200, created)
    return true
  }
  if (route === '/novels/import' && method === 'POST') {
    const service = requireNovels(deps)
    const parsed = NovelImportSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const input = parsed.data
    const book = await novelCall(() => service.importBook({
      title: input.title,
      genre: input.genre,
      setup: input.setup,
      ...(input.idea ? { idea: input.idea } : {}),
      ...(input.chapterChars ? { chapterChars: input.chapterChars } : {}),
      ...(input.volumes ? { volumes: input.volumes } : {}),
      ...(input.chaptersPerVolume ? { chaptersPerVolume: input.chaptersPerVolume } : {}),
    }))
    sendJson(res, 200, { id: book.id })
    return true
  }

  if (route.startsWith('/fanqie/')) {
    if (fanqie === undefined) throw new AdminError('not_found', '番茄发布功能没有开启。', 404)
    if (route === '/fanqie/status' && method === 'GET') { sendJson(res, 200, fanqie.status()); return true }
    if (route === '/fanqie/check' && method === 'POST') { sendJson(res, 200, await fanqie.check()); return true }
    if (route === '/fanqie/books' && method === 'GET') {
      try { sendJson(res, 200, { items: await fanqie.remoteBooks() }) }
      catch (e) { throw new AdminError('fanqie', e instanceof Error ? e.message : String(e), 502) }
      return true
    }
    const fb = /^\/fanqie\/novels\/([^/]+)(\/bind)?$/.exec(route)
    if (fb !== null) {
      const bookId = BookIdSchema.safeParse(decodeSegment(fb[1] ?? '') ?? '')
      if (!bookId.success) { sendJson(res, 400, { error: 'invalid_path', message: '书的编号不合法。' }); return true }
      if (fb[2] === '/bind' && method === 'PUT') {
        const parsed = z.object({ fqBookId: z.string().regex(/^\d{6,30}$/, '番茄作品 ID 应是一串数字') }).strict().safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        fanqie.bind(bookId.data, parsed.data.fqBookId)
        sendJson(res, 200, { ok: true })
        return true
      }
      if (!fb[2] && method === 'GET') {
        sendJson(res, 200, { fqBookId: fanqie.boundTo(bookId.data) ?? null, chapters: fanqie.list(bookId.data) })
        return true
      }
    }
    if (route === '/fanqie/sync' && method === 'POST') {
      const parsed = z.object({
        bookId: BookIdSchema,
        chapters: z.array(z.number().int().min(1).max(99999)).min(1, '请至少选一章').max(500, '一次最多 500 章'),
        mode: z.enum(['draft', 'publish', 'timer']),
        timerTime: z.number().int().optional(),
        useAi: z.boolean().default(true),
      }).strict().safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      try { sendJson(res, 200, fanqie.start(parsed.data)) }
      catch (e) { throw new AdminError('invalid', e instanceof Error ? e.message : String(e), 400) }
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/novels/edits' && method === 'GET') {
    const service = requireNovels(deps)
    const limit = clampInt(url.searchParams.get('limit'), 12, 1, 50)
    sendJson(res, 200, { items: await novelCall(() => service.listRecentEdits(limit)) })
    return true
  }

  const novelMatch = /^\/novels\/([^/]+)(?:\/(arcs|canon|work|export|chapters\/(\d{1,5})(?:\/(edit|undo|read))?))?$/.exec(route)
  if (novelMatch !== null) {
    const service = requireNovels(deps)
    const id = BookIdSchema.safeParse(decodeSegment(novelMatch[1] ?? '') ?? '')
    if (!id.success) { sendJson(res, 400, { error: 'invalid_path', message: '书的编号不合法。' }); return true }
    const bookId = id.data
    const sub = novelMatch[2]
    if (sub === undefined && method === 'GET') { sendJson(res, 200, await novelCall(() => service.detail(bookId))); return true }
    if (sub === undefined && method === 'DELETE') { await novelCall(() => service.deleteBook(bookId)); sendJson(res, 200, { ok: true }); return true }
    if (sub === 'arcs' && method === 'POST') {
      const parsed = NovelArcSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalidWithHint(res, parsed.error, ['note']); return true }
      const result = await novelCall(() => service.startArc(bookId, parsed.data.note))
      sendJson(res, 200, { ok: true, ...result })
      return true
    }
    if (sub === 'canon' && method === 'GET') { sendJson(res, 200, await novelCall(() => service.canon(bookId))); return true }
    if (sub === 'work' && method === 'GET') { sendJson(res, 200, await novelCall(() => service.work(bookId))); return true }
    if (sub === 'export' && method === 'GET') {
      const from = clampInt(url.searchParams.get('from'), 1, 1, 100000)
      const toRaw = url.searchParams.get('to')
      const exported = await novelCall(() => service.exportText(bookId, from, toRaw === null ? undefined : clampInt(toRaw, from, from, 100000)))
      const name = encodeURIComponent(`${exported.title}.txt`)
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${name}`,
        'cache-control': 'no-store',
      })
      res.end(exported.text)
      return true
    }
    const chapterAction = novelMatch[4]
    if (sub?.startsWith('chapters/') && chapterAction === undefined && method === 'GET') {
      sendJson(res, 200, await novelCall(() => service.chapter(bookId, Number(novelMatch[3]))))
      return true
    }
    if (sub?.startsWith('chapters/') && chapterAction !== undefined && method === 'POST') {
      const n = Number(novelMatch[3])
      if (chapterAction === 'edit') {
        const parsed = NovelEditSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalidWithHint(res, parsed.error, ['note']); return true }
        sendJson(res, 200, { ok: true, edit: await novelCall(() => service.editChapter(bookId, n, parsed.data.note)) })
        return true
      }
      if (chapterAction === 'undo') {
        sendJson(res, 200, { ok: true, edit: await novelCall(() => service.undoEdit(bookId, n)) })
        return true
      }
      await novelCall(() => service.markRead(bookId, n))
      sendJson(res, 200, { ok: true })
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  return false
}
