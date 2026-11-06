/**
 * Web previews for ticket workers: host-port allocation, durable registrations, and the public proxy.
 *
 * A ticket's container is started with `SA_PREVIEW_PORTS`, a comma list of host ports that pasta forwards into the
 * container. The worker's `sa_preview` tool turns one of those ports into a registration (a random token), and the admin
 * server's unauthenticated `/p/<token>/...` route forwards public traffic to `127.0.0.1:<port>`. Registrations live in
 * SQLite so a link keeps working across a daemon restart; port allocations do not, and are rebuilt at the next launch.
 *
 * Ports named by a registration are never handed to another ticket, even after the ticket ended: the token would
 * otherwise start pointing at a different worker's application.
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { PreviewOptions } from './options.ts'

/** One preview link, as the ticket detail and the console show it. */
export interface PreviewView {
  port: number
  title: string
  /** Public path below the admin prefix, without a leading slash: `p/<token>/`. */
  path: string
  /** Absolute URL when `publicBase` is set, otherwise the relative path. */
  url: string
  /** Whether the ticket's container is running now. */
  active: boolean
}

/** A stored registration; the token is the secret in the public link. */
export interface PreviewRegistration {
  token: string
  ticketId: string
  port: number
  title: string
  createdAt: string
}

export type PreviewRegisterResult =
  | { ok: true; token: string; url: string; path: string }
  | { ok: false; message: string }

export interface PreviewStoreOptions {
  db: DatabaseSync
  /** Read live, so a settings change applies to the next allocation. */
  options: () => PreviewOptions
  /** Whether the ticket's container is running now. */
  isRunning: (ticketId: string) => boolean
  now?: () => Date
  /** Override the loopback port probe; tests use it to keep allocation deterministic. */
  probe?: (port: number) => Promise<boolean>
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS previews (
  token TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  port INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS previews_ticket ON previews (ticket_id);
CREATE UNIQUE INDEX IF NOT EXISTS previews_ticket_port ON previews (ticket_id, port);
`

const TOKEN_BYTES = 18
const PATH_PREFIX = 'p'

/** Whether `port` can be bound on the loopback interface right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    const done = (free: boolean): void => {
      server.removeAllListeners()
      if (server.listening) {
        server.close(() => resolve(free))
      } else {
        resolve(free)
      }
    }
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => done(true))
  })
}

const pathFor = (token: string): string => `${PATH_PREFIX}/${token}/`

const rowToRegistration = (row: Record<string, unknown>): PreviewRegistration => ({
  token: String(row.token),
  ticketId: String(row.ticket_id),
  port: Number(row.port),
  title: String(row.title),
  createdAt: String(row.created_at),
})

/** Allocates ports, records preview links, and answers what the API and proxy need. */
export class PreviewStore {
  private readonly now: () => Date
  private readonly probe: (port: number) => Promise<boolean>
  /** Ports currently handed out in this process, by ticket. */
  private readonly allocations = new Map<string, number[]>()
  /** Serializes allocations so two tickets cannot probe and claim the same port. */
  private chain: Promise<unknown> = Promise.resolve()
  private readonly insert: StatementSync
  private readonly byTicket: StatementSync
  private readonly byToken: StatementSync
  private readonly byTicketPort: StatementSync
  private readonly updateTitle: StatementSync
  private readonly deleteTicket: StatementSync
  private readonly allPorts: StatementSync

  constructor(private readonly options: PreviewStoreOptions) {
    this.now = options.now ?? (() => new Date())
    this.probe = options.probe ?? isPortFree
    options.db.exec(SCHEMA)
    this.insert = options.db.prepare(
      'INSERT INTO previews (token, ticket_id, port, title, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    this.byTicket = options.db.prepare('SELECT * FROM previews WHERE ticket_id = ? ORDER BY port')
    this.byToken = options.db.prepare('SELECT * FROM previews WHERE token = ?')
    this.byTicketPort = options.db.prepare('SELECT * FROM previews WHERE ticket_id = ? AND port = ?')
    this.updateTitle = options.db.prepare('UPDATE previews SET title = ? WHERE token = ?')
    this.deleteTicket = options.db.prepare('DELETE FROM previews WHERE ticket_id = ?')
    this.allPorts = options.db.prepare('SELECT ticket_id, port FROM previews')
  }

  /** Ports currently allocated to `ticketId` in this process, oldest first. */
  allocated(ticketId: string): number[] {
    return [...(this.allocations.get(ticketId) ?? [])]
  }

  /**
   * Hand out `perTicket` ports for a launch. Ports the ticket already had (in this process, or named by its stored
   * registrations) are kept when they are still free, so a relaunch reuses its links' ports. Ports named by another
   * ticket's registration are never taken.
   */
  allocate(ticketId: string): Promise<number[]> {
    const run = this.chain.then(() => this.allocateInner(ticketId), () => this.allocateInner(ticketId))
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Give the ports back when the ticket ended; registrations stay so its links answer 503 instead of 404. */
  release(ticketId: string): void {
    this.allocations.delete(ticketId)
  }

  /** Drop both the allocation and every registration; used when the ticket itself is deleted. */
  removeTicket(ticketId: string): void {
    this.allocations.delete(ticketId)
    this.deleteTicket.run(ticketId)
  }

  /** The ticket's registrations, with `active` read from the live container state. */
  list(ticketId: string): PreviewView[] {
    const active = this.options.isRunning(ticketId)
    return this.byTicket.all(ticketId).map(row => {
      const registration = rowToRegistration(row)
      const path = pathFor(registration.token)
      return {
        port: registration.port,
        title: registration.title,
        path,
        url: this.urlFor(path),
        active,
      }
    })
  }

  /** The registration a public token names, or undefined for an unknown token. */
  lookup(token: string): PreviewRegistration | undefined {
    const row = this.byToken.get(token)
    return row === undefined ? undefined : rowToRegistration(row)
  }

  /** Whether the ticket's container is running now. */
  active(ticketId: string): boolean {
    return this.options.isRunning(ticketId)
  }

  /**
   * Create or reuse the registration of one allocated port. Re-registering the same port keeps its token and URL, so a
   * link a person already received does not change.
   */
  register(ticketId: string, port: number, title: string): PreviewRegisterResult {
    if (!this.allocated(ticketId).includes(port)) {
      return { ok: false, message: `端口 ${port} 不是这张任务票分配的预览端口。` }
    }
    const existing = this.byTicketPort.get(ticketId, port)
    if (existing !== undefined) {
      const registration = rowToRegistration(existing)
      if (registration.title !== title) this.updateTitle.run(title, registration.token)
      return { ok: true, token: registration.token, url: this.urlFor(pathFor(registration.token)), path: pathFor(registration.token) }
    }
    let token = randomBytes(TOKEN_BYTES).toString('base64url')
    for (let attempt = 0; attempt < 5 && this.byToken.get(token) !== undefined; attempt += 1) {
      token = randomBytes(TOKEN_BYTES).toString('base64url')
    }
    this.insert.run(token, ticketId, port, title, this.now().toISOString())
    const path = pathFor(token)
    return { ok: true, token, url: this.urlFor(path), path }
  }

  private urlFor(path: string): string {
    const base = this.options.options().publicBase.replace(/\/+$/, '')
    return base === '' ? path : `${base}/${path}`
  }

  private async allocateInner(ticketId: string): Promise<number[]> {
    const preview = this.options.options()
    const wanted = Math.max(1, Math.min(5, Math.trunc(preview.perTicket)))
    const prior = this.allocations.get(ticketId) ?? this.registeredPorts(ticketId)
    const taken = this.takenPorts(ticketId)
    const chosen: number[] = []
    for (const port of prior) {
      if (chosen.length >= wanted) break
      if (chosen.includes(port) || taken.has(port)) continue
      // A registered port is kept even if the operator later changed the pool: an existing link must not break.
      if (await this.probe(port)) chosen.push(port)
    }
    for (let port = preview.portStart; port <= preview.portEnd && chosen.length < wanted; port += 1) {
      if (chosen.includes(port) || taken.has(port)) continue
      if (await this.probe(port)) chosen.push(port)
    }
    this.allocations.set(ticketId, chosen)
    return [...chosen]
  }

  private registeredPorts(ticketId: string): number[] {
    return this.byTicket.all(ticketId).map(row => Number(row.port))
  }

  /** Ports another ticket holds or has registered; a token must never be re-pointed at a different application. */
  private takenPorts(exceptTicketId: string): Set<number> {
    const taken = new Set<number>()
    for (const [ticketId, ports] of this.allocations) {
      if (ticketId === exceptTicketId) continue
      for (const port of ports) taken.add(port)
    }
    for (const row of this.allPorts.all()) {
      if (String(row.ticket_id) === exceptTicketId) continue
      taken.add(Number(row.port))
    }
    return taken
  }
}

// --- Public proxy -------------------------------------------------------------------------------------------------

const PREFIX = '/p/'
const MAX_BODY = 10 * 1024 * 1024
const MAX_HTML = 2 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 60_000
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
/** Hop-by-hop headers never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])
/** Headers dropped from the client request; cookies and authorization must never reach a worker's application. */
const STRIP_REQUEST = new Set([...HOP_BY_HOP, 'host', 'cookie', 'authorization', 'accept-encoding', 'content-length'])

export interface PreviewProxyOptions {
  store: Pick<PreviewStore, 'lookup' | 'active'>
  /** Read live; when empty, HTML is not rewritten and the upstream document's relative URLs are used as-is. */
  publicBase: () => string
  fetch?: typeof fetch
  /**
   * The directory served as a static copy while the ticket's container is not running (its `/workspace/output`), or
   * undefined for no fallback.
   */
  staticRoot?: (ticketId: string) => string | undefined
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.pdf': 'application/pdf',
}

const inside = (base: string, path: string): boolean => path === base || path.startsWith(base + sep)

/**
 * Resolve a preview path inside `root`: no traversal, no symlink out of it, a directory means its index.html.
 * Returns `{ redirect: true }` for a directory asked for without its trailing slash, so relative URLs keep working.
 */
export function staticTarget(root: string, rest: string): { file: string } | { redirect: true } | undefined {
  let rel: string
  try {
    rel = decodeURIComponent(rest === '' ? '/' : rest)
  } catch {
    return undefined
  }
  if (rel.includes('\0')) return undefined
  try {
    const base = realpathSync(resolve(root))
    const asked = resolve(base, `.${rel.startsWith('/') ? rel : `/${rel}`}`)
    if (!inside(base, asked)) return undefined
    let file = asked
    let stat = statSync(file)
    if (stat.isDirectory()) {
      // `/p/<token>` (no rest) is the root asked for without its slash: redirect too, or relative URLs resolve one level up.
      if (rest === '' || !rel.endsWith('/')) return { redirect: true }
      file = join(file, 'index.html')
      stat = statSync(file)
    }
    if (!stat.isFile()) return undefined
    const real = realpathSync(file)
    return inside(base, real) ? { file: real } : undefined
  } catch {
    return undefined
  }
}

/** Serve one file of a stopped ticket's output; false when there is nothing to serve at that path. */
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  root: string,
  target: PreviewTarget,
  url: URL,
  publicBase: string,
): Promise<boolean> {
  const found = staticTarget(root, target.rest)
  if (found === undefined) {
    // A missing page inside an existing copy is a plain 404; only a missing copy falls back to the 503 page.
    if (staticTarget(root, '/') === undefined) return false
    sendPage(res, 404, '找不到这个文件', '这个预览的静态副本里没有这个文件。')
    return true
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD')
    sendPage(res, 405, '只能浏览', '任务已经结束，预览只是 output 目录的静态副本，不接受提交。')
    return true
  }
  if ('redirect' in found) {
    // Relative to the last segment, so it stays under Apache's /sa/ prefix: `/sa/p/<token>` -> `/sa/p/<token>/`.
    const last = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
    res.writeHead(301, { location: `${encodeURIComponent(decodeURIComponent(last))}/${url.search}`, 'cache-control': 'no-store' })
    res.end()
    return true
  }
  const type = STATIC_TYPES[extname(found.file).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': 'no-cache',
    'x-robots-tag': 'noindex',
    'x-sa-preview': 'static-copy',
  }
  const size = statSync(found.file).size
  if (type.startsWith('text/html') && size <= MAX_HTML) {
    const href = baseHrefFor(publicBase, target.token)
    let payload = readFileSync(found.file)
    if (href !== undefined) payload = Buffer.from(injectBase(payload.toString('utf8'), href), 'utf8')
    headers['content-length'] = String(payload.length)
    res.writeHead(200, headers)
    res.end(method === 'HEAD' ? undefined : payload)
    return true
  }
  headers['content-length'] = String(size)
  res.writeHead(200, headers)
  if (method === 'HEAD') {
    res.end()
    return true
  }
  const stream = createReadStream(found.file)
  stream.on('error', () => res.destroy())
  req.on('close', () => stream.destroy())
  stream.pipe(res)
  return true
}

interface PreviewTarget { token: string; rest: string }

function parsePreviewPath(pathname: string): PreviewTarget | undefined {
  if (!pathname.startsWith(PREFIX)) return undefined
  const tail = pathname.slice(PREFIX.length)
  const slash = tail.indexOf('/')
  return slash === -1
    ? { token: tail, rest: '' }
    : { token: tail.slice(0, slash), rest: tail.slice(slash) }
}

function sendPage(res: ServerResponse, status: number, title: string, message: string): void {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body><h1>${title}</h1><p>${message}</p></body></html>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
  })
  res.end(body)
}

/** Inject a document base right after `<head>` unless the document already declares one. */
export function injectBase(html: string, href: string): string {
  if (/<base[\s>]/i.test(html)) return html
  const match = /<head(?:\s[^>]*)?>/i.exec(html)
  if (!match) return html
  const at = match.index + match[0].length
  const escaped = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `${html.slice(0, at)}<base href="${escaped}">${html.slice(at)}`
}

/** The `<base href>` for a token, derived from the public base's path; undefined when no public base is configured. */
export function baseHrefFor(publicBase: string, token: string): string | undefined {
  if (publicBase === '') return undefined
  try {
    const path = new URL(publicBase).pathname.replace(/\/+$/, '')
    return `${path}/p/${token}/`
  } catch {
    return undefined
  }
}

function readRequestBody(req: IncomingMessage, limit: number): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ body: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge }))
    req.on('error', () => resolve({ body: Buffer.alloc(0), tooLarge }))
  })
}

interface LimitedBody {
  chunks: Buffer[]
  total: number
  /** Present only when the body exceeded the limit and the rest still has to be streamed. */
  reader?: ReadableStreamDefaultReader<Uint8Array>
}

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<LimitedBody> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { chunks, total }
    const chunk = Buffer.from(value)
    chunks.push(chunk)
    total += chunk.length
    if (total > limit) return { chunks, total, reader }
  }
}

/** Reads the remaining bytes of a web stream, so an oversized HTML body can still be passed through. */
async function* remainder(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Buffer> {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    yield Buffer.from(value)
  }
}

/**
 * Handle `/p/<token>/...`: unauthenticated, on the same server the Apache `/sa/` reverse proxy reaches. Returns false for
 * any other path so the caller can fall through.
 */
export function createPreviewProxy(options: PreviewProxyOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const fetchFn = options.fetch ?? fetch
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://admin.invalid')
    const target = parsePreviewPath(url.pathname)
    if (!target) return false

    const method = (req.method ?? 'GET').toUpperCase()
    const registration = target.token === '' ? undefined : options.store.lookup(target.token)
    if (!registration) {
      sendPage(res, 404, '预览不存在', '这个预览链接无效或已经被删除。')
      return true
    }
    if (!options.store.active(registration.ticketId)) {
      // The container stopped (the task finished or is idle): serve what it left in /workspace/output as a static copy,
      // so a delivered page keeps opening instead of answering 503 the moment the worker exits.
      const root = options.staticRoot?.(registration.ticketId)
      if (root !== undefined && await serveStatic(req, res, method, root, target, url, options.publicBase())) return true
      sendPage(res, 503, '预览已暂停', '预览已暂停：任务没有在运行，它的 output 目录里也没有可以直接打开的文件。')
      return true
    }
    if (!ALLOWED_METHODS.has(method)) {
      res.setHeader('allow', [...ALLOWED_METHODS].join(', '))
      sendPage(res, 405, '不支持这个请求', '预览只接受常见的网页请求。')
      return true
    }

    let body: Buffer | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const read = await readRequestBody(req, MAX_BODY)
      if (read.tooLarge) {
        sendPage(res, 413, '内容太大', '请求内容超过 10 MB，预览不接受。')
        return true
      }
      body = read.body
    }

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (STRIP_REQUEST.has(lower)) continue
      headers[lower] = Array.isArray(value) ? value.join(', ') : value
    }
    // Identity keeps the upstream document readable for `<base>` injection; no decompression is involved.
    headers['accept-encoding'] = 'identity'

    const path = target.rest === '' ? '/' : target.rest
    const upstream = `http://127.0.0.1:${registration.port}${path}${url.search}`
    let response: Response
    try {
      response = await fetchFn(upstream, {
        method,
        headers,
        ...(body !== undefined && body.length > 0 ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch {
      sendPage(res, 502, '预览应用没有响应', '预览应用暂时没有响应，请稍后再试。')
      return true
    }

    const outHeaders: Record<string, string | string[]> = {}
    response.headers.forEach((value, name) => {
      if (HOP_BY_HOP.has(name) || name === 'set-cookie') return
      outHeaders[name] = value
    })
    // Pass Set-Cookie through unchanged; the worker's application owns its own cookies.
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 0) outHeaders['set-cookie'] = cookies
    outHeaders['x-robots-tag'] = 'noindex'

    const contentType = response.headers.get('content-type') ?? ''
    const encoding = (response.headers.get('content-encoding') ?? '').toLowerCase()
    const html = /^text\/html\b/i.test(contentType) && (encoding === '' || encoding === 'identity')
    const declared = Number(response.headers.get('content-length') ?? 'NaN')
    const shouldInject = html && method !== 'HEAD' && !(Number.isFinite(declared) && declared > MAX_HTML)

    if (shouldInject && response.body !== null) {
      const limited = await readLimited(response.body, MAX_HTML)
      if (limited.reader === undefined) {
        const publicBase = options.publicBase()
        const href = baseHrefFor(publicBase, registration.token)
        let payload = Buffer.concat(limited.chunks)
        if (href !== undefined) payload = Buffer.from(injectBase(payload.toString('utf8'), href), 'utf8')
        delete outHeaders['content-length']
        outHeaders['content-length'] = String(payload.length)
        res.writeHead(response.status, outHeaders)
        res.end(payload)
        return true
      }
      // The body grew past the injection cap after the headers: send what was read and stream the rest untouched.
      delete outHeaders['content-length']
      res.writeHead(response.status, outHeaders)
      for (const chunk of limited.chunks) res.write(chunk)
      Readable.from(remainder(limited.reader)).pipe(res)
      return true
    }

    res.writeHead(response.status, outHeaders)
    if (method === 'HEAD' || response.body === null) {
      res.end()
      return true
    }
    const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return true
  }
}
