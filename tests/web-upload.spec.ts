/**
 * The browser upload module (`src/admin/web/lib/upload.js`) against the real admin API.
 *
 * The server is real (login, cookie, CSRF, chunk staging, extraction); the browser module is loaded
 * with a dynamic import so the TypeScript project never type-checks plain ES modules. `fetch`, the
 * base address, the chunk size and the poll/retry timings are injected.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAdminApi } from '../src/admin/api.ts'
import { AdminAuth } from '../src/admin/auth.ts'
import type { AdminHost, TicketDetailView } from '../src/admin/host.ts'
import { defaultOptions, OptionsStore } from '../src/admin/options.ts'
import { createAdminServer, type AdminServer } from '../src/admin/server.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { ProjectService } from '../src/projects/service.ts'
import { writeZip } from './helpers/zip.ts'

const MIB = 1024 * 1024
const dirs: string[] = []
const servers: AdminServer[] = []
let upload: any

beforeAll(async () => {
  upload = await import(pathToFileURL(resolve('src/admin/web/lib/upload.js')).href)
})

afterEach(async () => {
  try { await upload?.cancel?.() } catch { /* no upload in flight */ }
  vi.unstubAllGlobals()
  while (servers.length) {
    try { await servers.pop()!.close() } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-web-upload-'))
  dirs.push(dir)
  return dir
}

interface Harness {
  base: string
  cookie: string
  dir: string
}

async function harness(): Promise<Harness> {
  const dir = tempDir()
  const db = new DatabaseSync(':memory:')
  const store = new OptionsStore(join(dir, 'options.json'), defaultOptions({}))
  const auth = new AdminAuth({ stateDir: dir })
  const init = auth.init()
  const password = init.plaintext ?? ''
  const ledger = new Ledger(db)
  const events = new EventLog(db)
  const projectsRoot = join(dir, 'projects')
  const workspaceRoot = join(dir, 'workspaces')
  mkdirSync(projectsRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  const service = new ProjectService({
    db,
    root: projectsRoot,
    workspaceRoot,
    limits: () => store.get().projects,
  })

  const host = new Proxy({} as AdminHost, {
    get(_target, property) {
      if (property === 'workspaceRoot') return () => undefined
      if (property === 'ticket') return (): TicketDetailView | undefined => undefined
      if (property === 'deliverables') return () => []
      if (property === 'createTicket') return async () => ({ triggerId: 'tr', threadId: 'th', threadKey: 'cli:th' })
      return () => {
        throw new Error(`unexpected host call ${String(property)}`)
      }
    },
  })

  const api = createAdminApi({ host, auth, options: store, ledger, events, cliToken: 'cli-upload-test', projects: service })
  const server = createAdminServer({ api, staticHandler: () => false, port: 0 })
  servers.push(server)
  const { port } = await server.listen()
  const base = `http://127.0.0.1:${port}`

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sa-request': '1' },
    body: JSON.stringify({ password }),
  })
  expect(login.status).toBe(200)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { base, cookie, dir }
}

function zipBytes(dir: string, name: string, extraBytes: number): Buffer {
  const path = join(dir, name)
  writeZip(path, [
    { name: 'demo/', mode: 0o040755 },
    { name: 'demo/README.md', data: '# hello\n' },
    { name: 'demo/src/a.ts', data: 'export {}\n' },
    { name: 'demo/data.bin', data: Buffer.alloc(extraBytes, 7) },
  ])
  return readFileSync(path)
}

function makeFile(bytes: Buffer, name: string, lastModified = 1_700_000_000_000): File {
  return new File([bytes], name, { lastModified })
}

/** A fetch that adds the session cookie, like the browser does for same-origin requests. */
function browserFetch(h: Harness, onRequest?: (url: string, init: RequestInit) => void) {
  return async (url: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {})
    headers.set('cookie', h.cookie)
    onRequest?.(String(url), init)
    return fetch(url, { ...init, headers })
  }
}

function configure(h: Harness, overrides: Record<string, unknown> = {}) {
  upload.configure({
    fetch: browserFetch(h),
    base: h.base,
    chunkSize: MIB,
    pollInterval: 20,
    retryDelays: [5, 5, 5, 5, 5],
    sleep: (ms: number) => new Promise((done) => setTimeout(done, Math.min(ms, 20))),
    ...overrides,
  })
}

async function projectDetail(h: Harness, id: string): Promise<any> {
  const response = await fetch(`${h.base}/api/projects/${id}`, { headers: { cookie: h.cookie } })
  return response.json()
}

describe('web upload module', () => {
  it('uploads several chunks, extracts, and fires onReady once', async () => {
    const h = await harness()
    configure(h)
    const bytes = zipBytes(h.dir, 'demo.zip', Math.round(2.4 * MIB))
    let readyCalls = 0
    let readyProject = ''
    upload.onReady((projectId: string) => {
      readyCalls += 1
      readyProject = projectId
    })

    await upload.start(makeFile(bytes, 'demo.zip'), {})
    const state = upload.state()
    expect(state.phase).toBe('done')
    expect(state.done).toBe(true)
    expect(state.percent).toBe(100)
    expect(state.projectId).toMatch(/^p_/)
    expect(state.sent).toBe(bytes.length)
    expect(readyCalls).toBe(1)
    expect(readyProject).toBe(state.projectId)

    const detail = await projectDetail(h, state.projectId)
    expect(detail.status).toBe('ready')
    expect(detail.archiveBytes).toBe(bytes.length)
    expect(detail.profile.readme).toContain('# hello')
  })

  it('pauses after a chunk and resumes from the server offset', async () => {
    const h = await harness()
    configure(h)
    const bytes = zipBytes(h.dir, 'resume.zip', Math.round(5.2 * MIB))
    let receivedDuringPause = 0
    let paused = false

    const unsubscribe = upload.subscribe((state: any) => {
      if (!paused && state.phase === 'uploading' && state.sent >= MIB) {
        paused = true
        receivedDuringPause = state.sent
        upload.pause()
      }
    })
    await upload.start(makeFile(bytes, 'resume.zip'), {})
    unsubscribe()
    expect(paused).toBe(true)
    expect(upload.state().phase).toBe('paused')
    expect(receivedDuringPause).toBeGreaterThan(0)
    expect(receivedDuringPause).toBeLessThan(bytes.length)

    const uploadId = upload.state().uploadId
    const infoResponse = await fetch(`${h.base}/api/uploads/${uploadId}`, { headers: { cookie: h.cookie } })
    const info = await infoResponse.json() as { received: number }
    expect(info.received).toBe(receivedDuringPause)

    await upload.resume()
    const state = upload.state()
    expect(state.phase).toBe('done')
    expect(state.sent).toBe(bytes.length)
    const detail = await projectDetail(h, state.projectId)
    expect(detail.status).toBe('ready')
  })

  it('aligns to the server when a chunk returns 409', async () => {
    const h = await harness()
    const bytes = zipBytes(h.dir, 'conflict.zip', Math.round(3.3 * MIB))
    const baseFetch = browserFetch(h)
    let puts = 0
    upload.configure({
      fetch: async (url: string | URL | Request, init: RequestInit = {}) => {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'PUT') {
          puts += 1
          // The first attempt of the second chunk reaches the server twice: the server moves ahead and
          // the client's original request is answered with 409 { received }.
          if (puts === 2) await baseFetch(url, init)
        }
        return baseFetch(url, init)
      },
      base: h.base,
      chunkSize: MIB,
      pollInterval: 20,
      retryDelays: [5, 5, 5, 5, 5],
      sleep: (ms: number) => new Promise((done) => setTimeout(done, Math.min(ms, 20))),
    })

    await upload.start(makeFile(bytes, 'conflict.zip'), {})
    const state = upload.state()
    expect(state.phase).toBe('done')
    expect(puts).toBeGreaterThan(3)
    const detail = await projectDetail(h, state.projectId)
    expect(detail.status).toBe('ready')
    expect(detail.archiveBytes).toBe(bytes.length)
  })

  it('still uploads when crypto.subtle is unavailable and sends no checksum header', async () => {
    const h = await harness()
    const headersSeen: string[] = []
    const fetcher = browserFetch(h, (_url, init) => {
      if (String(init.method ?? '').toUpperCase() === 'PUT') {
        const headers = new Headers(init.headers ?? {})
        headersSeen.push(headers.get('x-chunk-sha256') ?? '')
      }
    })
    configure(h, { fetch: fetcher })

    const fakeCrypto = Object.create(globalThis.crypto)
    Object.defineProperty(fakeCrypto, 'subtle', { value: undefined, configurable: true })
    vi.stubGlobal('crypto', fakeCrypto)
    try {
      const bytes = zipBytes(h.dir, 'plain.zip', Math.round(2.2 * MIB))
      await upload.start(makeFile(bytes, 'plain.zip'), {})
      expect(upload.state().phase).toBe('done')
      expect(headersSeen.length).toBeGreaterThan(1)
      expect(headersSeen.every((value) => value === '')).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('marks a non-zip archive failed during extraction and never fires onReady', async () => {
    const h = await harness()
    configure(h)
    let readyCalls = 0
    upload.onReady(() => { readyCalls += 1 })

    const notAZip = Buffer.alloc(Math.round(2.1 * MIB), 3)
    await upload.start(makeFile(notAZip, 'broken.zip'), {})
    const state = upload.state()
    expect(state.phase).toBe('failed')
    expect(state.error).toBeTruthy()
    expect(state.done).toBe(false)
    expect(readyCalls).toBe(0)
  })
})
