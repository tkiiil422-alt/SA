/**
 * `sa project ...` against a real admin API. The CLI is a module-level script that reads SA_STATE_DIR, so every case runs
 * it as a child process. A forwarding proxy sits in front of the admin API: it records every request path (to catch a
 * `/api/api/` regression) and can answer PUT chunks with canned failures (to exercise the upload retry and 409 logic).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminApi } from '../src/admin/api.ts'
import { AdminAuth } from '../src/admin/auth.ts'
import type { AdminHost } from '../src/admin/host.ts'
import { defaultOptions, OptionsStore } from '../src/admin/options.ts'
import { createAdminServer, type AdminServer } from '../src/admin/server.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { ProjectService } from '../src/projects/service.ts'
import { writeZip } from './helpers/zip.ts'

const CLI_TOKEN = 'cli-project-test'
const CLI_PATH = fileURLToPath(new URL('../src/cli/sa.ts', import.meta.url))
/** Mirrors `UPLOAD_RETRIES` in src/cli/sa.ts. */
const UPLOAD_RETRIES = 5
const UNAVAILABLE = { error: 'unavailable', message: '网关暂时不可用' }

const dirs: string[] = []
const servers: AdminServer[] = []
const proxies: Server[] = []

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    proxy.closeAllConnections()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
  }
  while (servers.length) {
    try { await servers.pop()!.close() } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-cli-project-'))
  dirs.push(dir)
  return dir
}

/** A real admin API with the project service; returns its base URL. */
async function startAdmin(): Promise<{ base: string }> {
  const dir = tempDir()
  const db = new DatabaseSync(':memory:')
  const store = new OptionsStore(join(dir, 'options.json'), defaultOptions({}))
  const auth = new AdminAuth({ stateDir: dir })
  auth.init()
  const projectsRoot = join(dir, 'projects')
  const workspaceRoot = join(dir, 'workspaces')
  mkdirSync(projectsRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  const service = new ProjectService({ db, root: projectsRoot, workspaceRoot, limits: () => store.get().projects })
  // Only project routes are exercised here; any host call is a bug in the CLI path.
  const host = new Proxy({} as AdminHost, {
    get: () => () => {
      throw new Error('unexpected host call')
    },
  })
  const api = createAdminApi({
    host,
    auth,
    options: store,
    ledger: new Ledger(db),
    events: new EventLog(db),
    cliToken: CLI_TOKEN,
    projects: service,
  })
  const server = createAdminServer({ api, staticHandler: () => false, port: 0 })
  servers.push(server)
  const { port } = await server.listen()
  return { base: `http://127.0.0.1:${port}` }
}

interface Fault {
  status: number
  body: unknown
}

interface ProxyState {
  url: string
  /** Every request path the CLI sent, in order. */
  paths: string[]
  /** PUT requests received so far (canned or forwarded). */
  puts: number
  /** Called with the 1-based PUT index; return a canned response, or undefined to forward to the real API. */
  fault: (putIndex: number) => Fault | undefined
}

async function startProxy(target: string, fault: ProxyState['fault'] = () => undefined): Promise<ProxyState> {
  const state: ProxyState = { url: '', paths: [], puts: 0, fault }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'
    state.paths.push(path)
    let canned: Fault | undefined
    if (method === 'PUT') {
      state.puts += 1
      canned = state.fault(state.puts)
    }
    if (canned !== undefined) {
      res.writeHead(canned.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(canned.body))
      return
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name)) {
        headers[name] = value
      }
    }
    const upstream = await fetch(`${target}${path}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    })
    const buffer = Buffer.from(await upstream.arrayBuffer())
    const outHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, name) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(name)) outHeaders[name] = value
    })
    res.writeHead(upstream.status, outHeaders)
    res.end(buffer)
  })
  proxies.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('proxy did not bind')
  state.url = `http://127.0.0.1:${address.port}`
  return state
}

/** A state directory the CLI can find: control.json pointing at `adminUrl`, and the CLI token file. */
function writeState(adminUrl: string): string {
  const stateDir = tempDir()
  writeFileSync(join(stateDir, 'control.json'), JSON.stringify({ url: 'http://127.0.0.1:1', adminUrl }))
  writeFileSync(join(stateDir, 'cli-token'), CLI_TOKEN)
  return stateDir
}

function makeZip(name = 'demo.zip'): string {
  const file = join(tempDir(), name)
  writeZip(file, [
    { name: 'demo/', mode: 0o040755 },
    { name: 'demo/README.md', data: '# hello' },
  ])
  return file
}

interface CliRun {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runCli(args: string[], stateDir: string, timeoutMs = 30_000): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, SA_STATE_DIR: stateDir, SA_RETRY_SCALE: '0.01' }
  delete env.SA_TOKEN
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', CLI_PATH, 'project', ...args], {
      env,
      cwd: tempDir(),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

async function getProject(base: string, id: string): Promise<{ status: string; name: string }> {
  const response = await fetch(`${base}/api/projects/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${CLI_TOKEN}` },
  })
  expect(response.status).toBe(200)
  return await response.json() as { status: string; name: string }
}

function projectIdOf(stdout: string): string {
  const match = /project: (p_\S+)/.exec(stdout)
  if (!match) throw new Error(`no project id in output: ${stdout}`)
  return match[1]!
}

describe('sa project upload', () => {
  it('uploads a zip, waits for extraction, exits 0, and never sends a doubled /api prefix', async () => {
    const admin = await startAdmin()
    const proxy = await startProxy(admin.base)
    const stateDir = writeState(proxy.url)

    const result = await runCli(['upload', makeZip(), '--name', 'demo'], stateDir)
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/project: p_/)
    expect(result.stdout).toContain('ready:')

    const project = await getProject(admin.base, projectIdOf(result.stdout))
    expect(project).toMatchObject({ status: 'ready', name: 'demo' })
    // Regression guard for `/api/api/uploads`: adminRequest already adds `/api`.
    expect(proxy.paths.filter(path => path.startsWith('/api/api/'))).toEqual([])
    expect(proxy.paths).toContain('/api/uploads')
  }, 30_000)

  it('exits 1 with a failed: reason when the file is not a zip', async () => {
    const admin = await startAdmin()
    const proxy = await startProxy(admin.base)
    const stateDir = writeState(proxy.url)
    const file = join(tempDir(), 'notes.zip')
    writeFileSync(file, 'this is not a zip')

    const result = await runCli(['upload', file], stateDir)
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('failed:')
  }, 30_000)

  it('retries a 503 on a chunk and still completes', async () => {
    const admin = await startAdmin()
    const proxy = await startProxy(admin.base, index => index === 1 ? { status: 503, body: UNAVAILABLE } : undefined)
    const stateDir = writeState(proxy.url)

    const result = await runCli(['upload', makeZip()], stateDir)
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('ready:')
    // One refused PUT, then the retry that was forwarded.
    expect(proxy.puts).toBe(2)
  }, 30_000)

  it('gives up after UPLOAD_RETRIES + 1 PUTs on a persistent 503 and prints the server message', async () => {
    const admin = await startAdmin()
    const proxy = await startProxy(admin.base, () => ({ status: 503, body: UNAVAILABLE }))
    const stateDir = writeState(proxy.url)

    const result = await runCli(['upload', makeZip()], stateDir)
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('网关暂时不可用')
    expect(proxy.puts).toBe(UPLOAD_RETRIES + 1)
  }, 30_000)

  it('stops with "上传卡住了" when the server keeps answering 409 at the same offset', async () => {
    const admin = await startAdmin()
    const proxy = await startProxy(admin.base, () => ({ status: 409, body: { error: 'offset_mismatch', received: 0 } }))
    const stateDir = writeState(proxy.url)

    const result = await runCli(['upload', makeZip()], stateDir, 20_000)
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('上传卡住了')
    expect(proxy.puts).toBeGreaterThanOrEqual(5)
    expect(proxy.puts).toBeLessThanOrEqual(7)
  }, 30_000)
})

describe('sa project list, rm, and argument handling', () => {
  it('lists "no projects" when empty, then lists the uploaded project as ready', async () => {
    const admin = await startAdmin()
    const proxy = await startProxy(admin.base)
    const stateDir = writeState(proxy.url)

    const empty = await runCli(['list'], stateDir)
    expect(empty.code, empty.stderr).toBe(0)
    expect(empty.stdout).toContain('no projects')

    const uploaded = await runCli(['upload', makeZip(), '--name', 'demo'], stateDir)
    expect(uploaded.code, uploaded.stderr).toBe(0)
    const id = projectIdOf(uploaded.stdout)

    const list = await runCli(['list'], stateDir)
    expect(list.code, list.stderr).toBe(0)
    expect(list.stdout).toContain(id)
    expect(list.stdout).toContain('ready')
    expect(list.stdout).not.toContain('no projects')
  }, 30_000)

  it('removes a project by id, after which it is no longer listed', async () => {
    const admin = await startAdmin()
    const proxy = await startProxy(admin.base)
    const stateDir = writeState(proxy.url)
    const uploaded = await runCli(['upload', makeZip(), '--name', 'demo'], stateDir)
    expect(uploaded.code, uploaded.stderr).toBe(0)
    const id = projectIdOf(uploaded.stdout)

    const removed = await runCli(['rm', id], stateDir)
    expect(removed.code, removed.stderr).toBe(0)
    expect(removed.stdout).toContain('deleted:')

    const list = await runCli(['list'], stateDir)
    expect(list.code, list.stderr).toBe(0)
    expect(list.stdout).toContain('no projects')
    expect(list.stdout).not.toContain(id)
  }, 30_000)

  it('prints Usage and exits non-zero when no file is given', async () => {
    const result = await runCli(['upload'], tempDir())
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Usage')
  })

  it('reports "not running" when there is no control.json', async () => {
    const result = await runCli(['upload', makeZip()], tempDir())
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('not running')
  })
})
