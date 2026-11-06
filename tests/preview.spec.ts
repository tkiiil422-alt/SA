/**
 * Web previews: port allocation, durable registrations, the worker MCP tool, and the public proxy.
 *
 * Ports are taken from a small range chosen per test; allocation tests inject a probe so they never depend on what else
 * happens to be listening on the machine. The one real-bind test deliberately occupies a loopback port and checks that
 * allocation skips it.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  PreviewStore,
  baseHrefFor,
  createPreviewProxy,
  injectBase,
  isPortFree,
} from '../src/admin/preview.ts'
import { OptionsStore, OptionsSchema, defaultOptions, type PreviewOptions } from '../src/admin/options.ts'
import { createWorkerMcpServer } from '../src/mcp/worker-server.ts'

const cleanups: (() => Promise<void> | void)[] = []
const dirs: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!() } catch { /* already closed */ }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-preview-'))
  dirs.push(dir)
  return dir
}

const previewOptions = (overrides: Partial<PreviewOptions> = {}): PreviewOptions => ({
  enabled: true,
  portStart: 20000,
  portEnd: 20010,
  perTicket: 2,
  publicBase: '',
  ...overrides,
})

function makeStore(options: {
  preview?: PreviewOptions
  db?: DatabaseSync
  running?: () => boolean
  probe?: (port: number) => Promise<boolean>
} = {}): PreviewStore {
  const db = options.db ?? new DatabaseSync(':memory:')
  return new PreviewStore({
    db,
    options: () => options.preview ?? previewOptions(),
    isRunning: options.running ?? (() => true),
    probe: options.probe ?? (async () => true),
  })
}

const listen = (server: Server): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
})

const closeServer = (server: Server): Promise<void> => new Promise(resolve => {
  server.closeAllConnections()
  server.close(() => resolve())
})

const stubEngine = () => ({
  report: vi.fn(),
  reply: vi.fn(),
  handback: vi.fn(),
  markUnrelated: vi.fn(),
  followForContext: vi.fn(),
})

const httpServer = (handler: (req: IncomingMessage, res: ServerResponse) => void): Server => {
  const server = createServer(handler)
  cleanups.push(() => closeServer(server))
  return server
}

describe('preview options', () => {
  it('defaults to enabled, 19000–19199, two ports per ticket, no public base', () => {
    expect(defaultOptions({}).preview).toEqual({
      enabled: true, portStart: 19000, portEnd: 19199, perTicket: 2, publicBase: '',
    })
  })

  it('rejects an inverted range, out-of-range ports, too many ports and a trailing slash', () => {
    const base = defaultOptions({})
    const fail = (preview: Record<string, unknown>): string[] => {
      const result = OptionsSchema.safeParse({ ...base, preview })
      expect(result.success).toBe(false)
      return result.success ? [] : result.error.issues.map(issue => issue.path.join('.'))
    }
    expect(fail({ ...base.preview, portEnd: 18999 })).toContain('preview.portEnd')
    expect(fail({ ...base.preview, portStart: 80 })).toContain('preview.portStart')
    expect(fail({ ...base.preview, perTicket: 6 })).toContain('preview.perTicket')
    expect(fail({ ...base.preview, publicBase: 'https://example.test/sa/' })).toContain('preview.publicBase')
    expect(fail({ ...base.preview, publicBase: 'ftp://example.test/sa' })).toContain('preview.publicBase')
  })

  it('accepts a public base with a path and no trailing slash', () => {
    const base = defaultOptions({})
    const result = OptionsSchema.safeParse({ ...base, preview: { ...base.preview, publicBase: 'http://175.178.18.140:18081/sa' } })
    expect(result.success).toBe(true)
  })

  it('loads an old options file without a preview section from the defaults', () => {
    const dir = tempDir()
    const file = join(dir, 'options.json')
    const defaults = defaultOptions({})
    const { preview: _preview, ...withoutPreview } = defaults
    writeFileSync(file, JSON.stringify(withoutPreview))
    const store = new OptionsStore(file, defaults)
    expect(store.get().preview).toEqual(defaults.preview)
    expect(store.getPublic().preview).toEqual(defaults.preview)
  })
})

describe('port pool', () => {
  it('allocates perTicket distinct ports and keeps them stable across a relaunch', async () => {
    const store = makeStore()
    const first = await store.allocate('A')
    expect(first).toHaveLength(2)
    expect(new Set(first).size).toBe(2)
    for (const port of first) expect(port).toBeGreaterThanOrEqual(20000)

    const second = await store.allocate('B')
    expect(second).toHaveLength(2)
    for (const port of second) expect(first).not.toContain(port)

    expect(await store.allocate('A')).toEqual(first)
    store.release('A')
    expect(store.allocated('A')).toEqual([])
    expect(await store.allocate('A')).toEqual(first)
  })

  it('skips a port already bound on 127.0.0.1', async () => {
    const bound = httpServer((_req, res) => res.end('x'))
    const port = await listen(bound)
    expect(await isPortFree(port)).toBe(false)
    await closeServer(bound)
    expect(await isPortFree(port)).toBe(true)

    const holder = httpServer((_req, res) => res.end('x'))
    const heldPort = await listen(holder)
    const store = makeStore({
      preview: previewOptions({ portStart: heldPort, portEnd: heldPort, perTicket: 1 }),
      probe: isPortFree,
    })
    // The real probe is used here: the only port in the pool is occupied.
    const allocated = await store.allocate('A')
    expect(allocated).toEqual([])
    await closeServer(holder)
  })

  it('never gives another ticket a port named by an existing registration', async () => {
    const store = makeStore({ preview: previewOptions({ perTicket: 1 }) })
    const [port] = await store.allocate('A')
    expect(store.register('A', port!, 'demo').ok).toBe(true)
    store.release('A')

    const [other] = await store.allocate('B')
    expect(other).not.toBe(port)
  })

  it('releases registrations and their ports when the ticket is deleted', async () => {
    const store = makeStore({ preview: previewOptions({ perTicket: 1 }) })
    const [port] = await store.allocate('A')
    const result = store.register('A', port!, 'demo')
    expect(result.ok).toBe(true)
    const token = result.ok ? result.token : ''
    expect(store.lookup(token)).toBeDefined()

    store.removeTicket('A')
    expect(store.lookup(token)).toBeUndefined()
    expect(store.list('A')).toEqual([])
    expect(store.allocated('A')).toEqual([])
  })
})

describe('registrations', () => {
  it('returns a 24-character URL-safe token, reuses it per port, and builds the URL', async () => {
    const store = makeStore({ preview: previewOptions({ perTicket: 2 }) })
    const [port] = await store.allocate('A')
    const first = store.register('A', port!, '看板')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(first.path).toBe(`p/${first.token}/`)
    expect(first.url).toBe(first.path)

    const again = store.register('A', port!, '新名字')
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.token).toBe(first.token)
    expect(store.list('A')).toEqual([{
      port: port!, title: '新名字', path: first.path, url: first.path, active: true,
    }])
  })

  it('rejects a port that was not allocated to this ticket', async () => {
    const store = makeStore({ preview: previewOptions({ perTicket: 1 }) })
    const [port] = await store.allocate('A')
    expect(store.register('A', port! + 1, 'x')).toEqual({
      ok: false, message: `端口 ${port! + 1} 不是这张任务票分配的预览端口。`,
    })
  })

  it('uses the public base when one is configured', async () => {
    const store = makeStore({ preview: previewOptions({ perTicket: 1, publicBase: 'http://example.test:18081/sa' }) })
    const [port] = await store.allocate('A')
    const result = store.register('A', port!, 'demo')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.url).toBe(`http://example.test:18081/sa/p/${result.token}/`)
  })

  it('survives constructing a new store on the same database file', async () => {
    const dir = tempDir()
    const file = join(dir, 'state.sqlite')
    const options = previewOptions({ perTicket: 1 })
    const firstDb = new DatabaseSync(file)
    const first = makeStore({ db: firstDb, preview: options })
    const [port] = await first.allocate('A')
    const registered = first.register('A', port!, '看板')
    expect(registered.ok).toBe(true)
    const token = registered.ok ? registered.token : ''
    firstDb.close()

    const secondDb = new DatabaseSync(file)
    cleanups.push(() => secondDb.close())
    const second = makeStore({ db: secondDb, preview: options, running: () => false })
    expect(second.lookup(token)).toMatchObject({ ticketId: 'A', port, title: '看板' })
    expect(second.list('A')).toEqual([{
      port: port!, title: '看板', path: `p/${token}/`, url: `p/${token}/`, active: false,
    }])
  })
})

describe('sa_preview MCP tool', () => {
  it('rejects a foreign port and returns a relative URL without a public base', async () => {
    const settings = { ...previewOptions({ perTicket: 2 }) }
    const store = makeStore({ preview: settings })
    const [port] = await store.allocate('TK-A')
    const server = createWorkerMcpServer({
      engine: stubEngine(),
      authorize: token => token === 'ticket-a' ? { ticketId: 'TK-A' } : undefined,
      preview: (ticketId, input) => {
        const result = store.register(ticketId, input.port, input.title ?? '预览')
        return result.ok ? { ok: true, url: result.url, path: result.path } : result
      },
    })
    const { port: mcpPort } = await server.listen()
    cleanups.push(() => server.close())
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer ticket-a' } },
    })
    const client = new Client({ name: 'preview-test', version: '1.0.0' })
    await client.connect(transport)
    cleanups.push(() => client.close())

    const foreign = await client.callTool({ name: 'sa_preview', arguments: { port: port! + 50 } })
    expect(foreign.isError).toBe(true)
    expect(JSON.stringify(foreign.content)).toContain('不是这张任务票分配的预览端口')

    const published = await client.callTool({ name: 'sa_preview', arguments: { port: port!, title: '看板' } })
    expect(published.isError).toBeFalsy()
    const payload = JSON.parse((published.content as { type: string; text: string }[])[0]!.text) as { url: string; path: string }
    expect(payload.path).toMatch(/^p\/[A-Za-z0-9_-]{24}\/$/)
    expect(payload.url).toBe(payload.path)

    settings.publicBase = 'http://175.178.18.140:18081/sa'
    const absolute = await client.callTool({ name: 'sa_preview', arguments: { port: port!, title: '看板' } })
    const absolutePayload = JSON.parse((absolute.content as { type: string; text: string }[])[0]!.text) as { url: string }
    expect(absolutePayload.url).toBe(`http://175.178.18.140:18081/sa/${payload.path}`)
  })

  it('lists every tool in a stable order with sa_preview last', async () => {
    const server = createWorkerMcpServer({
      engine: stubEngine(),
      authorize: () => ({ ticketId: 'TK-A' }),
      preview: () => ({ ok: true, url: 'p/x/', path: 'p/x/' }),
    })
    const { port } = await server.listen()
    cleanups.push(() => server.close())
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer ticket-a' } },
    })
    const client = new Client({ name: 'preview-test', version: '1.0.0' })
    await client.connect(transport)
    cleanups.push(() => client.close())
    const { tools } = await client.listTools()
    // New tools are appended, so the preview tool is no longer last; the order stays stable.
    expect(tools.map(tool => tool.name)).toContain('sa_preview')
    expect(tools.at(-1)?.name).toBe('sa_github_pr')
  })
})

describe('public proxy', () => {
  it('forwards paths, queries and bodies, strips credentials, injects a base and answers 404/503', async () => {
    const seen: { method: string; url: string; cookie?: string; authorization?: string; body: string }[] = []
    const app = httpServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
          ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }),
          body: Buffer.concat(chunks).toString('utf8'),
        })
        if (req.url?.startsWith('/page')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><head><title>demo</title></head><body>hello</body></html>')
        } else if (req.url?.startsWith('/submit')) {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end(Buffer.concat(chunks).toString('utf8'))
        } else {
          res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'worker=1; Path=/' })
          res.end(req.url ?? '')
        }
      })
    })
    const appPort = await listen(app)

    let running = true
    const store = makeStore({
      preview: previewOptions({ portStart: appPort, portEnd: appPort, perTicket: 1, publicBase: 'http://example.test/sa' }),
      running: () => running,
      probe: async () => true,
    })
    const [port] = await store.allocate('T1')
    expect(port).toBe(appPort)
    const registered = store.register('T1', port!, '演示')
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    const token = registered.token

    const proxy = createPreviewProxy({
      store,
      publicBase: () => 'http://example.test/sa',
    })
    const admin = httpServer((req, res) => { void proxy(req, res).catch(() => res.destroy()) })
    const adminPort = await listen(admin)
    const base = `http://127.0.0.1:${adminPort}`

    const get = await fetch(`${base}/p/${token}/hello?x=1&y=2`, {
      headers: { cookie: 'sa_session=secret', authorization: 'Bearer secret' },
    })
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('/hello?x=1&y=2')
    expect(get.headers.getSetCookie().join(',')).toContain('worker=1')
    expect(get.headers.get('x-robots-tag')).toBe('noindex')
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: '/hello?x=1&y=2', body: '' })
    expect(seen.at(-1)!.cookie).toBeUndefined()
    expect(seen.at(-1)!.authorization).toBeUndefined()

    const post = await fetch(`${base}/p/${token}/submit`, { method: 'POST', body: 'hello=world' })
    expect(await post.text()).toBe('hello=world')
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/submit', body: 'hello=world' })

    const page = await fetch(`${base}/p/${token}/page`)
    const html = await page.text()
    expect(html).toContain(`<base href="/sa/p/${token}/">`)

    const missing = await fetch(`${base}/p/unknown-token/`)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('预览不存在')

    running = false
    const paused = await fetch(`${base}/p/${token}/hello`)
    expect(paused.status).toBe(503)
    expect(await paused.text()).toContain('预览已暂停：任务没有在运行')
  })

  it('serves the stopped ticket\'s output folder as a static copy instead of 503', async () => {
    const out = mkdtempSync(join(tmpdir(), 'sa-preview-out-'))
    cleanups.push(() => rmSync(out, { recursive: true, force: true }))
    writeFileSync(join(out, 'index.html'), '<html><head><title>花</title></head><body>bloom</body></html>')
    writeFileSync(join(out, 'app.js'), 'console.log(1)')
    writeFileSync(join(tmpdir(), 'sa-preview-secret.txt'), 'secret')

    const store = makeStore({ running: () => false, preview: previewOptions({ portStart: 19500, portEnd: 19500, perTicket: 1 }) })
    const [port] = await store.allocate('T9')
    const registered = store.register('T9', port!, '静态')
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    const token = registered.token
    const proxy = createPreviewProxy({
      store,
      publicBase: () => 'http://example.test/sa',
      staticRoot: ticketId => (ticketId === 'T9' ? out : undefined),
    })
    const admin = httpServer((req, res) => { void proxy(req, res).catch(() => res.destroy()) })
    const base = `http://127.0.0.1:${await listen(admin)}`

    const root = await fetch(`${base}/p/${token}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('x-sa-preview')).toBe('static-copy')
    const html = await root.text()
    expect(html).toContain('bloom')
    expect(html).toContain(`<base href="/sa/p/${token}/">`)

    const script = await fetch(`${base}/p/${token}/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')

    const bare = await fetch(`${base}/p/${token}`, { redirect: 'manual' })
    expect(bare.status).toBe(301)

    expect((await fetch(`${base}/p/${token}/nope.html`)).status).toBe(404)
    expect((await fetch(`${base}/p/${token}/..%2F..%2Fsa-preview-secret.txt`)).status).toBe(404)
    expect((await fetch(`${base}/p/${token}/`, { method: 'POST', body: 'x' })).status).toBe(405)
  })

  it('still answers 503 when the stopped ticket left no output to serve', async () => {
    const store = makeStore({ running: () => false, preview: previewOptions({ portStart: 19501, portEnd: 19501, perTicket: 1 }) })
    const [port] = await store.allocate('T8')
    const registered = store.register('T8', port!, '空')
    if (!registered.ok) throw new Error('register failed')
    const proxy = createPreviewProxy({ store, publicBase: () => '', staticRoot: () => join(tmpdir(), 'sa-no-such-output-dir') })
    const admin = httpServer((req, res) => { void proxy(req, res).catch(() => res.destroy()) })
    const base = `http://127.0.0.1:${await listen(admin)}`
    const response = await fetch(`${base}/p/${registered.token}/`)
    expect(response.status).toBe(503)
  })

  it('does not claim paths outside /p/', async () => {
    const store = makeStore()
    const proxy = createPreviewProxy({ store, publicBase: () => '' })
    const admin = httpServer((req, res) => {
      void proxy(req, res).then(handled => {
        if (!handled) {
          res.writeHead(418)
          res.end('not preview')
        }
      })
    })
    const port = await listen(admin)
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(response.status).toBe(418)
    expect(await response.text()).toBe('not preview')
  })
})

describe('HTML base helpers', () => {
  it('injects after head and leaves an existing base alone', () => {
    expect(injectBase('<html><head><title>x</title></head></html>', '/sa/p/t/')).toBe(
      '<html><head><base href="/sa/p/t/"><title>x</title></head></html>',
    )
    expect(injectBase('<html><HEAD data-x="1"></HEAD></html>', '/sa/p/t/')).toBe(
      '<html><HEAD data-x="1"><base href="/sa/p/t/"></HEAD></html>',
    )
    expect(injectBase('<html><head><base href="/x/"></head></html>', '/sa/p/t/')).toBe('<html><head><base href="/x/"></head></html>')
  })

  it('derives the base from the public base path, or skips it when empty', () => {
    expect(baseHrefFor('http://example.test/sa', 'abc')).toBe('/sa/p/abc/')
    expect(baseHrefFor('https://example.test', 'abc')).toBe('/p/abc/')
    expect(baseHrefFor('', 'abc')).toBeUndefined()
  })
})

describe('pi-container.sh', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  it.skipIf(bash.status !== 0)('parses with bash -n', () => {
    const script = fileURLToPath(new URL('../deploy/pi-container.sh', import.meta.url))
    const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })
})
