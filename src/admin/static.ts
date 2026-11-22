/**
 * Static files for the admin console's single-page app.
 *
 * `createStaticHandler(rootDir)` serves only `GET`/`HEAD`; `/` maps to `index.html` and every other path must name a file
 * directly (no SPA fallback, no directory listing). Paths are resolved against the real root and checked twice — before
 * and after `realpath` — so neither `..`, encoded separators, backslashes, NUL bytes nor a symlink can read outside it.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => boolean

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff2: 'font/woff2',
}

const CACHEABLE = new Set(['html', 'htm', 'css', 'js', 'mjs'])
const COMPRESSIBLE = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'map'])
/** Compressed copies keyed by path and ETag, so each file is gzipped once per change. */
const gzipCache = new Map<string, Buffer>()
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
}

function canonical(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isInside(root: string, target: string): boolean {
  const base = canonical(root)
  const value = canonical(target)
  return value === base || value.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

function notFound(res: ServerResponse, head: boolean): void {
  const body = 'Not Found'
  res.writeHead(404, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(head ? undefined : body)
}

/**
 * Resolve a request pathname to normalized segments inside the root; undefined means "refuse and 404".
 * The URL parser has already collapsed ordinary `..` segments; this catches what survives encoding.
 */
function segmentsOf(pathname: string): string[] | undefined {
  if (pathname.includes('\0') || pathname.includes('\\')) return undefined
  // A drive letter or a colon anywhere cannot be part of a served file name on Windows and signals an absolute path.
  if (pathname.includes(':')) return undefined
  const segments = pathname.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) return undefined
  return segments
}

export function createStaticHandler(rootDir: string): StaticHandler {
  const root = resolve(rootDir)
  let realRoot: string | undefined

  return (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return false

    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://static.invalid').pathname)
    } catch {
      notFound(res, method === 'HEAD')
      return true
    }

    const segments = segmentsOf(pathname)
    if (segments === undefined) {
      notFound(res, method === 'HEAD')
      return true
    }
    if (segments.length === 0) segments.push('index.html')

    if (realRoot === undefined) {
      try {
        realRoot = realpathSync(root)
      } catch {
        notFound(res, method === 'HEAD')
        return true
      }
    }

    const candidate = resolve(realRoot, ...segments)
    if (!isInside(realRoot, candidate)) {
      notFound(res, method === 'HEAD')
      return true
    }

    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      notFound(res, method === 'HEAD')
      return true
    }
    if (!isInside(realRoot, real)) {
      notFound(res, method === 'HEAD')
      return true
    }

    let info
    try {
      info = statSync(real)
    } catch {
      notFound(res, method === 'HEAD')
      return true
    }
    if (!info.isFile()) {
      notFound(res, method === 'HEAD')
      return true
    }

    let body: Buffer
    try {
      body = readFileSync(real)
    } catch {
      notFound(res, method === 'HEAD')
      return true
    }

    const extension = extname(real).slice(1).toLowerCase()
    const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'content-type': MIME[extension] ?? 'application/octet-stream',
      'cache-control': CACHEABLE.has(extension) ? 'no-cache' : 'public, max-age=3600',
      etag,
      vary: 'accept-encoding',
    }
    if (String(req.headers['if-none-match'] ?? '').split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) {
      res.writeHead(304, headers)
      res.end()
      return true
    }
    let payload = body
    if (COMPRESSIBLE.has(extension) && body.length > 512 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      const key = `${real}|${etag}`
      let packed = gzipCache.get(key)
      if (!packed) {
        packed = gzipSync(body)
        if (gzipCache.size > 200) gzipCache.clear()
        gzipCache.set(key, packed)
      }
      payload = packed
      headers['content-encoding'] = 'gzip'
    }
    headers['content-length'] = String(payload.length)
    res.writeHead(200, headers)
    res.end(method === 'HEAD' ? undefined : payload)
    return true
  }
}
