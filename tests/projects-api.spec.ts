/**
 * HTTP contract of the project library: login + CSRF, chunked uploads, project views, downloads, deliverables,
 * archive path validation and the projects settings section.
 *
 * The server is real (login, cookie, CSRF headers); only the admin host is a narrow fake for workspace lookups.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/admin/api.ts'
import { AdminAuth } from '../src/admin/auth.ts'
import type { AdminHost, TicketDetailView } from '../src/admin/host.ts'
import { defaultOptions, OptionsStore } from '../src/admin/options.ts'
import { createAdminServer, type AdminServer } from '../src/admin/server.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { listDeliverables } from '../src/projects/deliverables.ts'
import { ProjectService } from '../src/projects/service.ts'
import { writeZip } from './helpers/zip.ts'

const CLI_TOKEN = 'cli-project-test'
const dirs: string[] = []
const servers: AdminServer[] = []

afterEach(async () => {
  while (servers.length) {
    try { await servers.pop()!.close() } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-projects-api-'))
  dirs.push(dir)
  return dir
}

const canSymlink = (() => {
  const base = mkdtempSync(join(tmpdir(), 'sa-symlink-check-'))
  try {
    symlinkSync(join(base, 'missing'), join(base, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})()

interface Harness {
  base: string
  cookie: string
  service: ProjectService
  store: OptionsStore
  workspaces: Map<string, string>
  created: (string | undefined)[]
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

  const workspaces = new Map<string, string>()
  const created: (string | undefined)[] = []
  const known: Record<string, unknown> = {
    workspaceRoot: (id: string) => workspaces.get(id),
    ticket: (id: string): TicketDetailView | undefined => workspaces.has(id) ? ({ id } as TicketDetailView) : undefined,
    deliverables: (id: string) => {
      const root = workspaces.get(id)
      return root === undefined ? [] : listDeliverables(root)
    },
    createTicket: async (_text: string, _model?: string, _secrets?: string[], projectId?: string) => {
      created.push(projectId)
      return { triggerId: 'tr', threadId: 'th', threadKey: 'cli:th' }
    },
  }
  const host = new Proxy({} as AdminHost, {
    get(_target, property) {
      const value = known[String(property)]
      if (value !== undefined) return value
      return () => {
        throw new Error(`unexpected host call ${String(property)}`)
      }
    },
  })

  const api = createAdminApi({ host, auth, options: store, ledger, events, cliToken: CLI_TOKEN, projects: service })
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
  const setCookie = login.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0] ?? ''

  return { base, cookie, service, store, workspaces, created, dir }
}

interface RequestOptions {
  method?: string
  body?: string | Buffer
  headers?: Record<string, string>
  csrf?: boolean
  cookie?: string | null
  bearer?: string
}

async function request(h: Harness, path: string, options: RequestOptions = {}) {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { ...options.headers }
  if (options.cookie !== null) headers.cookie = options.cookie ?? h.cookie
  if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`
  if (method !== 'GET' && method !== 'HEAD' && options.csrf !== false) {
    headers['x-sa-request'] = headers['x-sa-request'] ?? '1'
    headers['content-type'] = headers['content-type'] ?? 'application/json'
  }
  const response = await fetch(`${h.base}/api${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  const text = buffer.toString('utf8')
  let json: any = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, headers: response.headers, text, json, buffer }
}

async function waitReady(h: Harness, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await request(h, `/projects/${projectId}`)
    if (detail.json.status === 'ready' || detail.json.status === 'failed') return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('project did not settle')
}

describe('projects API security', () => {
  it('returns 401 without a session for project and upload routes', async () => {
    const h = await harness()
    for (const path of ['/projects', '/uploads', '/settings/projects']) {
      const result = await request(h, path, { cookie: null })
      expect(result.status, path).toBe(401)
    }
    const put = await request(h, '/uploads/u_whatever?offset=0', {
      method: 'PUT',
      cookie: null,
      body: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(put.status).toBe(401)
  })

  it('returns 403 when a raw chunk has no X-SA-Request header', async () => {
    const h = await harness()
    const create = await request(h, '/uploads', { method: 'POST', body: JSON.stringify({ name: 'a.zip', size: 4 }) })
    const uploadId = create.json.uploadId as string
    const result = await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: Buffer.from('abcd'),
      csrf: false,
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(result.status).toBe(403)
  })

  it('accepts the CLI bearer token without CSRF for a chunk', async () => {
    const h = await harness()
    const create = await request(h, '/uploads', { method: 'POST', body: JSON.stringify({ name: 'a.zip', size: 4 }) })
    const uploadId = create.json.uploadId as string
    const result = await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: Buffer.from('abcd'),
      cookie: null,
      bearer: CLI_TOKEN,
      csrf: false,
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(result.status).toBe(200)
    expect(result.json.received).toBe(4)
  })
})

describe('upload routes', () => {
  it('uploads in chunks, reports progress, finishes and serves the project', async () => {
    const h = await harness()
    const zip = join(h.dir, 'demo.zip')
    writeZip(zip, [
      { name: 'demo/', mode: 0o040755 },
      { name: 'demo/README.md', data: '# hello' },
      { name: 'demo/src/a.ts', data: 'export {}\n' },
    ])
    const data = readFileSync(zip)
    const create = await request(h, '/uploads', { method: 'POST', body: JSON.stringify({ name: 'demo.zip', size: data.length }) })
    expect(create.json.chunkSize).toBe(8 * 1024 * 1024)
    const uploadId = create.json.uploadId as string

    const half = Math.floor(data.length / 2)
    const first = await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: data.subarray(0, half),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(first.json.received).toBe(half)
    const state = await request(h, `/uploads/${uploadId}`)
    expect(state.json).toMatchObject({ name: 'demo.zip', size: data.length, received: half, state: 'uploading' })

    const second = await request(h, `/uploads/${uploadId}?offset=${half}`, {
      method: 'PUT',
      body: data.subarray(half),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(second.json.received).toBe(data.length)

    const finish = await request(h, `/uploads/${uploadId}/finish`, {
      method: 'POST',
      body: JSON.stringify({ projectName: '演示' }),
    })
    expect(finish.status).toBe(200)
    const projectId = finish.json.projectId as string
    await waitReady(h, projectId)

    const detail = await request(h, `/projects/${projectId}`)
    expect(detail.json).toMatchObject({ id: projectId, name: '演示', status: 'ready', files: 2 })
    expect(detail.json.profile.readme).toContain('# hello')
    expect(detail.json.progress).toEqual({ done: 2, total: 2 })

    const list = await request(h, '/projects')
    expect(list.json.items.map((item: { id: string }) => item.id)).toContain(projectId)

    const root = await request(h, `/projects/${projectId}/files?path=`)
    expect(root.json.entries.map((entry: { name: string }) => entry.name)).toContain('README.md')
    const file = await request(h, `/projects/${projectId}/files?path=README.md`)
    expect(file.json.text).toBe('# hello')

    const download = await request(h, `/projects/${projectId}/files?path=README.md&download=1`)
    expect(download.status).toBe(200)
    expect(download.text).toBe('# hello')
    expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''README.md")
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')

    const removed = await request(h, `/projects/${projectId}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(existsSync(h.service.projectDir(projectId))).toBe(false)
  })

  it('refuses a chunk past the declared size and a premature finish', async () => {
    const h = await harness()
    const create = await request(h, '/uploads', { method: 'POST', body: JSON.stringify({ name: 'a.zip', size: 3 }) })
    const uploadId = create.json.uploadId as string
    const tooBig = await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: Buffer.from('abcde'),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(tooBig.status).toBe(400)

    const partial = await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: Buffer.from('ab'),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(partial.status).toBe(200)
    const finish = await request(h, `/uploads/${uploadId}/finish`, { method: 'POST', body: '{}' })
    expect(finish.status).toBe(400)
    expect(finish.json.message).toContain('上传还没完成')
  })

  it('returns 409 with the committed offset and accepts the correct retry', async () => {
    const h = await harness()
    const create = await request(h, '/uploads', { method: 'POST', body: JSON.stringify({ name: 'a.zip', size: 4 }) })
    const uploadId = create.json.uploadId as string
    await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: Buffer.from('ab'),
      headers: { 'content-type': 'application/octet-stream' },
    })
    const wrong = await request(h, `/uploads/${uploadId}?offset=9`, {
      method: 'PUT',
      body: Buffer.from('cd'),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(wrong.status).toBe(409)
    expect(wrong.json.received).toBe(2)
    const right = await request(h, `/uploads/${uploadId}?offset=2`, {
      method: 'PUT',
      body: Buffer.from('cd'),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(right.status).toBe(200)
    expect(right.json.received).toBe(4)
  })

  it('rejects a mismatched x-chunk-sha256 and leaves received untouched', async () => {
    const h = await harness()
    const create = await request(h, '/uploads', { method: 'POST', body: JSON.stringify({ name: 'a.zip', size: 4 }) })
    const uploadId = create.json.uploadId as string
    const bad = await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: Buffer.from('abcd'),
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': 'deadbeef' },
    })
    expect(bad.status).toBe(400)
    const state = await request(h, `/uploads/${uploadId}`)
    expect(state.json.received).toBe(0)
    const good = await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: Buffer.from('abcd'),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(good.status).toBe(200)
  })

  it('cancels an upload', async () => {
    const h = await harness()
    const create = await request(h, '/uploads', { method: 'POST', body: JSON.stringify({ name: 'a.zip', size: 4 }) })
    const uploadId = create.json.uploadId as string
    expect((await request(h, `/uploads/${uploadId}`, { method: 'DELETE' })).status).toBe(200)
    expect((await request(h, `/uploads/${uploadId}`)).status).toBe(404)
  })
})

describe('ticket integration routes', () => {
  it('passes projectId to the host when creating a ticket', async () => {
    const h = await harness()
    const result = await request(h, '/tickets', {
      method: 'POST',
      body: JSON.stringify({ text: '分析项目', projectId: 'p_abcdef123456' }),
    })
    expect(result.status).toBe(200)
    expect(h.created).toEqual(['p_abcdef123456'])
  })

  it('lists only reader-friendly deliverables from the workspace', async () => {
    const h = await harness()
    const workspace = join(h.dir, 'work-t1')
    mkdirSync(join(workspace, 'output'), { recursive: true })
    mkdirSync(join(workspace, 'project'), { recursive: true })
    writeFileSync(join(workspace, 'output', 'summary.md'), '# done')
    writeFileSync(join(workspace, 'notes.txt'), 'note')
    writeFileSync(join(workspace, 'tool.exe'), 'MZ')
    writeFileSync(join(workspace, 'project', 'README.md'), 'project')
    h.workspaces.set('t1', workspace)

    const result = await request(h, '/tickets/t1/deliverables')
    expect(result.status).toBe(200)
    expect(result.json.items.map((item: { path: string }) => item.path).sort()).toEqual(['notes.txt', 'output/summary.md'])
    expect((await request(h, '/tickets/unknown/deliverables')).status).toBe(404)
  })

  it('refuses archive paths other than the two literals', async () => {
    const h = await harness()
    const workspace = join(h.dir, 'work-t2')
    mkdirSync(join(workspace, 'project'), { recursive: true })
    h.workspaces.set('t2', workspace)
    for (const path of ['../x', 'workspace', '', '/etc']) {
      const result = await request(h, `/tickets/t2/archive?path=${encodeURIComponent(path)}`)
      expect(result.status, path).toBe(400)
    }
    expect((await request(h, '/tickets/t2/archive?path=output')).status).toBe(404)
  })

  it('refuses to download a symbolic link', async () => {
    if (!canSymlink) return
    const h = await harness()
    const zip = join(h.dir, 'demo.zip')
    writeZip(zip, [{ name: 'demo/a.txt', data: 'a' }])
    const data = readFileSync(zip)
    const create = await request(h, '/uploads', { method: 'POST', body: JSON.stringify({ name: 'demo.zip', size: data.length }) })
    const uploadId = create.json.uploadId as string
    await request(h, `/uploads/${uploadId}?offset=0`, {
      method: 'PUT',
      body: data,
      headers: { 'content-type': 'application/octet-stream' },
    })
    const finish = await request(h, `/uploads/${uploadId}/finish`, { method: 'POST', body: '{}' })
    const projectId = finish.json.projectId as string
    await waitReady(h, projectId)
    const tree = join(h.service.projectDir(projectId), 'tree')
    symlinkSync(join(tree, 'a.txt'), join(tree, 'link.md'))

    const result = await request(h, `/projects/${projectId}/files?path=link.md&download=1`)
    expect(result.status).toBe(400)
    expect(result.json.error).toBe('invalid_path')
  })
})

describe('projects settings', () => {
  it('reads defaults and persists a new section', async () => {
    const h = await harness()
    const initial = await request(h, '/settings/projects')
    expect(initial.json).toEqual({ maxUploadMb: 4096, maxExtractMb: 12288, maxFiles: 300000 })

    const updated = await request(h, '/settings/projects', {
      method: 'PUT',
      body: JSON.stringify({ maxUploadMb: 6144, maxExtractMb: 20480, maxFiles: 400000 }),
    })
    expect(updated.status).toBe(200)
    expect(updated.json.changed).toContain('projects.maxUploadMb')
    const after = await request(h, '/settings/projects')
    expect(after.json).toEqual({ maxUploadMb: 6144, maxExtractMb: 20480, maxFiles: 400000 })

    const invalid = await request(h, '/settings/projects', {
      method: 'PUT',
      body: JSON.stringify({ maxUploadMb: 0, maxExtractMb: 20480, maxFiles: 400000 }),
    })
    expect(invalid.status).toBe(400)
  })

  it('enforces maxUploadMb on create and free space is checked softly', async () => {
    const h = await harness()
    h.store.update('projects', { maxUploadMb: 1, maxExtractMb: 12288, maxFiles: 300000 })
    const result = await request(h, '/uploads', {
      method: 'POST',
      body: JSON.stringify({ name: 'big.zip', size: 2 * 1024 * 1024 }),
    })
    expect(result.status).toBe(413)
  })
})
