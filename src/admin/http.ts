/**
 * Admin API 共享 HTTP 协议、文件受限访问与 Zod 校验辅助模块。
 */
import { spawn } from 'node:child_process'
import { closeSync, createReadStream, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { z } from 'zod'
import { AdminError, type AdminIssue, type TicketSummaryView } from './host.ts'
import { ticketStatusLabel } from './labels.ts'

export const API_PREFIX = '/api'
export const MAX_BODY = 1_000_000
export const SESSION_MAX_AGE_SEC = 12 * 60 * 60
export const MAX_TEXT_FILE = 200 * 1024
export const MAX_LISTED_FILES = 1000
/** 内联图片预览大小上限。 */
export const MAX_RAW_FILE = 10 * 1024 * 1024
/** 附件直接下载大小上限。 */
export const MAX_DOWNLOAD_FILE = 200 * 1024 * 1024

/** 允许内联预览的图片后缀（刻意排除 SVG，防止脚本执行）。 */
export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

export const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
}

export function securityHeaders(): Record<string, string> {
  if (process.env.SA_ALLOW_IFRAME !== '1') return SECURITY_HEADERS
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  }
}

export interface BodyResult {
  ok: boolean
  text?: string
  reason?: 'too_large' | 'read_error'
}

export function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export function cookieValue(headerText: string, name: string): string | undefined {
  for (const part of headerText.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    const value = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

export function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise(resolveBody => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    let settled = false
    const finish = (result: BodyResult): void => {
      if (settled) return
      settled = true
      resolveBody(result)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(tooLarge ? { ok: false, reason: 'too_large' } : { ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => finish({ ok: false, reason: 'read_error' }))
    req.on('aborted', () => finish({ ok: false, reason: 'read_error' }))
  })
}

export async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const result = await readBody(req)
  if (!result.ok) {
    throw result.reason === 'too_large'
      ? new AdminError('body_too_large', '请求内容太大（上限 1MB）。', 413)
      : new AdminError('body_read_error', '读取请求内容失败，请重试。', 400)
  }
  const text = result.text ?? ''
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new AdminError('invalid_json', '请求内容不是有效的 JSON。', 400)
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    ...securityHeaders(),
    ...headers,
  })
  res.end(payload)
}

export function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 120) || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(name)}`
}

export function serveDownload(res: ServerResponse, file: string, name: string, size: number): void {
  if (size > MAX_DOWNLOAD_FILE) {
    sendJson(res, 413, { error: 'too_large', message: '这个文件超过 200 MB，不能直接下载。' })
    return
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(size),
    'content-disposition': attachmentHeader(name),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  const stream = createReadStream(file)
  stream.on('error', () => {
    if (!res.writableEnded) res.destroy()
  })
  stream.pipe(res)
}

export function serveTarArchive(res: ServerResponse, dir: string, name: string): void {
  const child = spawn('tar', ['-czf', '-', '-C', dir, '.'])
  child.stderr.resume()
  child.once('error', () => {
    if (res.headersSent) res.destroy()
    else sendJson(res, 500, { error: 'archive_failed', message: '打包失败，请稍后重试。' })
  })
  child.once('spawn', () => {
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-disposition': attachmentHeader(name),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    child.stdout.pipe(res)
  })
  child.once('close', code => {
    if (code !== 0 && !res.writableEnded) res.destroy()
  })
  res.on('close', () => {
    if (child.exitCode === null && !child.killed) child.kill()
  })
}

function cookiePolicy(req?: IncomingMessage): string {
  if (process.env.SA_ALLOW_IFRAME !== '1') return 'SameSite=Strict'
  const proto = req ? header(req, 'x-forwarded-proto').toLowerCase() : ''
  return proto.includes('https') ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax'
}

export function sessionCookie(token: string, req?: IncomingMessage): string {
  return `sa_session=${token}; HttpOnly; ${cookiePolicy(req)}; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}`
}

export function clearSessionCookie(req?: IncomingMessage): string {
  return `sa_session=; HttpOnly; ${cookiePolicy(req)}; Path=/; Max-Age=0`
}

export function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

export function optionalCursor(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

export function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export function isWrite(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

function describeExpected(expected: string): string {
  switch (expected) {
    case 'int': return '整数'
    case 'number': return '数字'
    case 'string': return '字符串'
    case 'boolean': return '布尔值'
    case 'object': return '对象'
    case 'array': return '数组'
    default: return expected
  }
}

export function issueMessage(issue: z.ZodIssue): string {
  if (/[一-龥]/.test(issue.message)) return issue.message
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? '缺少必填字段' : `类型不正确：期望${describeExpected(issue.expected)}`
    case 'too_small':
      if (issue.origin === 'string') return issue.inclusive === false ? `长度必须大于 ${issue.minimum}` : `长度不能小于 ${issue.minimum}`
      if (issue.origin === 'array') return `至少需要 ${issue.minimum} 项`
      return issue.inclusive === false ? `必须大于 ${issue.minimum}` : `不能小于 ${issue.minimum}`
    case 'too_big':
      if (issue.origin === 'string') return issue.inclusive === false ? `长度必须小于 ${issue.maximum}` : `长度不能超过 ${issue.maximum}`
      if (issue.origin === 'array') return `最多允许 ${issue.maximum} 项`
      return issue.inclusive === false ? `必须小于 ${issue.maximum}` : `不能超过 ${issue.maximum}`
    case 'invalid_format':
      return issue.format === 'url' ? '必须是有效的地址' : '格式不正确'
    case 'unrecognized_keys':
      return `不支持的字段：${issue.keys.join('、')}`
    case 'custom':
      return '取值不符合要求'
    case 'invalid_union':
      return '取值不符合任何允许的形式'
    case 'not_multiple_of':
      return `必须是 ${String(issue.divisor)} 的倍数`
    default:
      return '格式不正确'
  }
}

export function issuesOf(error: z.ZodError): AdminIssue[] {
  return error.issues.map(issue => ({
    path: issue.path.map(String).join('.'),
    message: issueMessage(issue),
  }))
}

export function invalid(res: ServerResponse, issues: AdminIssue[]): void {
  sendJson(res, 400, { error: 'invalid', message: '提交的内容有误，请检查标出来的字段。', issues })
}

export function invalidWithHint(res: ServerResponse, error: z.ZodError, fields: readonly string[]): void {
  const issues = issuesOf(error)
  const hit = error.issues.find(issue => fields.includes(String(issue.path[0] ?? '')))
  sendJson(res, 400, {
    error: 'invalid',
    message: hit === undefined ? '提交的内容有误，请检查标出来的字段。' : issueMessage(hit),
    issues,
  })
}

export function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

export function relativeSegments(input: string): string[] | undefined {
  if (input === '' || input === '.') return []
  if (input.includes('\0') || input.includes('\\')) return undefined
  if (input.startsWith('/')) return undefined
  if (/^[A-Za-z]:/.test(input)) return undefined
  const segments = input.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) return undefined
  return segments
}

function canonical(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function isInside(root: string, target: string): boolean {
  const base = canonical(root)
  const value = canonical(target)
  return value === base || value.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

function readPrefix(file: string, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(file, 'r')
  try {
    const read = readSync(fd, buffer, 0, length, 0)
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  let controls = 0
  for (const byte of buffer) {
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) controls += 1
  }
  return controls / buffer.length > 0.1
}

/** 通用沙箱目录文件浏览与下载（工单工作区与项目树共用）。 */
export function handleFilesInRoot(res: ServerResponse, root: string, requested: string, raw: boolean, download: boolean): void {
  const segments = relativeSegments(requested)
  if (segments === undefined) {
    sendJson(res, 400, { error: 'invalid_path', message: '路径不合法，只能查看任务工作区里的文件。' })
    return
  }
  const path = segments.join('/')
  const name = segments.at(-1) ?? ''
  const empty = { exists: false, type: 'dir' as const, path, name, entries: [] as unknown[] }
  if (root === '') {
    sendJson(res, 200, empty)
    return
  }

  let realRoot: string
  try { realRoot = realpathSync(root) } catch { sendJson(res, 200, empty); return }
  let rootStat
  try { rootStat = statSync(realRoot) } catch { sendJson(res, 200, empty); return }
  if (!rootStat.isDirectory()) { sendJson(res, 200, empty); return }

  const candidate = segments.length === 0 ? realRoot : resolve(realRoot, ...segments)
  if (!isInside(realRoot, candidate)) {
    sendJson(res, 400, { error: 'invalid_path', message: '路径不合法，只能查看任务工作区里的文件。' })
    return
  }

  let real: string
  try { real = realpathSync(candidate) } catch { sendJson(res, 200, empty); return }
  if (!isInside(realRoot, real)) {
    sendJson(res, 403, { error: 'forbidden', message: '这个路径超出了任务的工作区。' })
    return
  }

  let info
  try { info = statSync(real) } catch { sendJson(res, 200, empty); return }

  if (info.isDirectory()) {
    let dirents
    try { dirents = readdirSync(real, { withFileTypes: true }).slice(0, MAX_LISTED_FILES) }
    catch { throw new AdminError('read_failed', '无法读取这个文件夹。', 500) }
    const entries = dirents.map(dirent => {
      const full = resolve(real, dirent.name)
      let type: 'dir' | 'file' = dirent.isDirectory() ? 'dir' : 'file'
      let size: number | undefined
      if (dirent.isSymbolicLink()) {
        try {
          const target = statSync(full)
          type = target.isDirectory() ? 'dir' : 'file'
          if (target.isFile()) size = target.size
        } catch {
          type = 'file'
        }
      } else if (dirent.isFile()) {
        try { size = statSync(full).size } catch { size = undefined }
      }
      return { name: dirent.name, type, ...(size === undefined ? {} : { size }) }
    })
    entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name, 'zh-CN'))
    sendJson(res, 200, { exists: true, type: 'dir', path, name, entries })
    return
  }

  if (!info.isFile()) { sendJson(res, 200, empty); return }

  if (download) {
    let link = false
    try { link = lstatSync(candidate).isSymbolicLink() } catch { link = false }
    if (link) {
      sendJson(res, 400, { error: 'invalid_path', message: '符号链接不能下载。' })
      return
    }
    serveDownload(res, real, name, info.size)
    return
  }

  const length = Math.min(info.size, MAX_TEXT_FILE)
  let prefix: Buffer
  try { prefix = readPrefix(real, length) }
  catch { throw new AdminError('read_failed', '无法读取这个文件。', 500) }
  const base = {
    exists: true,
    type: 'file',
    path,
    name,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  }
  if (raw) {
    const mime = IMAGE_MIME[extname(name).toLowerCase()]
    if (mime === undefined) {
      sendJson(res, 415, { error: 'not_previewable', message: '只有图片可以直接预览。' })
      return
    }
    if (info.size > MAX_RAW_FILE) {
      sendJson(res, 413, { error: 'too_large', message: '这张图太大，不能在线预览。' })
      return
    }
    let body: Buffer
    try { body = readFileSync(real) }
    catch { throw new AdminError('read_failed', '无法读取这个文件。', 500) }
    res.writeHead(200, {
      'content-type': mime,
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    })
    res.end(body)
    return
  }
  if (looksBinary(prefix)) {
    sendJson(res, 200, { ...base, binary: true })
    return
  }
  sendJson(res, 200, { ...base, text: prefix.toString('utf8'), truncated: info.size > MAX_TEXT_FILE })
}

export function labelSummary(item: TicketSummaryView): TicketSummaryView & { stageLabel: string; stageHint: string } {
  const label = ticketStatusLabel(item)
  return { ...item, stageLabel: label.label, stageHint: label.hint }
}

/** 密钥名通用正则校验。 */
export const SecretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, '名称只能是大写字母、数字和下划线，以字母开头，最长 64 位')
