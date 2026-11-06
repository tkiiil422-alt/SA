/**
 * End-to-end tests of the assembled daemon: the CLI Source, direct assessor, SQLite outbox, Pi executor, worker MCP
 * endpoint, model gateway, control interface, restart recovery, and the single-instance lock.
 *
 * Every test uses a temporary state directory and the fake Pi (`tests/fixtures/fake-pi.mjs`); nothing touches the network.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, type Config } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const runtimes: Runtime[] = []
const directories: string[] = []
/** Keep the daemon's startup backups inside the OS temp directory, never the operator's home. */
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-e2e-backups-'))

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-e2e-'))
  directories.push(directory)
  return directory
}

function configFor(stateDir: string, env: Record<string, string> = {}, maxSlots = 3): Config {
  return parseConfig({
    stateDir,
    maxSlots,
    operatorId: 'operator',
    launcher: { command: process.execPath, args: [FAKE_PI], env },
    policy: {
      policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } },
      eval: { mode: 'auto' },
    },
  })
}

async function start(config: Config): Promise<Runtime> {
  const runtime = await createRuntime(config)
  runtimes.push(runtime)
  return runtime
}

async function until(check: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolveSleep => setTimeout(resolveSleep, 10))
  }
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) {
    try { await runtime.stop() } catch { /* already stopped */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function collect(child: ChildProcess): Promise<RunResult> {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  return new Promise(resolveRun => {
    child.once('error', () => resolveRun({ code: null, signal: null, stdout, stderr }))
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
  })
}

describe('superagentd end to end', () => {
  it('runs the M1 loop: ask -> ticket -> fake Pi reports ready -> outbox result', async () => {
    const runtime = await start(configFor(tempDir(), { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' }))
    const asked = await runtime.ask('写个 hello.py')

    expect(asked.ticketId).toBeDefined()
    await until(() => runtime.ticket(asked.ticketId!)?.status === 'ended', 'the ticket to end')

    const view = runtime.ticket(asked.ticketId!)!
    expect(view.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(view.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'acknowledgement', text: '收到，开始处理。' }),
      expect.objectContaining({ kind: 'reply', text: expect.stringContaining('done:') }),
    ]))
    expect(runtime.repo.tickets.get(asked.ticketId!)!.assignments).toHaveLength(1)
  }, 15_000)

  it('rejects a wrong token at both the worker MCP endpoint and the model gateway', async () => {
    const runtime = await start(configFor(tempDir()))

    const mcp = await fetch(`${runtime.mcpUrl}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-ticket' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(mcp.status).toBe(401)

    const gateway = await fetch(`${runtime.gatewayUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-ticket' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [] }),
    })
    expect(gateway.status).toBe(401)
  }, 10_000)

  it('recovers an interrupted assignment after a restart', async () => {
    const directory = tempDir()
    const first = await start(configFor(directory, { FAKE_PI_HANG: '1' }))
    const asked = await first.ask('写个 hello.py')
    const ticketId = asked.ticketId!

    await until(() => first.repo.tickets.get(ticketId)?.assignments[0]?.state === 'running', 'the first assignment to run')
    await first.stop()

    const second = await start(configFor(directory, { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' }))
    await until(() => second.ticket(ticketId)?.status === 'ended', 'the recovered ticket to end', 10_000)

    const ticket = second.repo.tickets.get(ticketId)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'hostRestarted' })
    expect(ticket.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  }, 20_000)

  it('refuses a second runtime on the same state directory', async () => {
    const directory = tempDir()
    await start(configFor(directory))

    await expect(createRuntime(configFor(directory))).rejects.toThrow(/already running|state directory lock/i)
  }, 10_000)

  it('runs the daemon and the sa CLI as subprocesses', async () => {
    const directory = tempDir()
    const configPath = join(directory, 'config.json')
    writeFileSync(configPath, JSON.stringify(configFor(directory, { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' }), null, 2))
    const env = { ...process.env, SA_STATE_DIR: directory }
    let daemon: ChildProcess | undefined
    try {
      daemon = spawn(process.execPath, ['--experimental-transform-types', 'src/daemon.ts', '--config', configPath], {
        cwd: PROJECT_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const controlFile = join(directory, 'control.json')
      await until(() => existsSync(controlFile), 'the daemon control file', 10_000)

      const cli = spawn(process.execPath, ['--experimental-transform-types', 'src/cli/sa.ts', 'ask', '写个 hello.py', '--wait'], {
        cwd: PROJECT_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const result = await collect(cli)

      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('ack: 收到，开始处理。')
      expect(result.stdout).toContain('done:')
    } finally {
      if (daemon && daemon.exitCode === null) {
        daemon.kill()
        await Promise.race([once(daemon, 'exit'), new Promise(resolveSleep => setTimeout(resolveSleep, 3_000))])
        if (daemon.exitCode === null) daemon.kill('SIGKILL')
      }
    }
  }, 25_000)
})
