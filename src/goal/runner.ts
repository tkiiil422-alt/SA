/**
 * Where a goal's acceptance commands run. In the container deployment: inside the worker's own container
 * (`podman exec sa-<ticket>`), with the worker's rights and its `/workspace`, so a test the worker could run is the test
 * the host runs. Elsewhere (the fake Pi in tests, a local launcher): through the shell in the ticket's workspace.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { CommandResult, CommandRunner } from './service.ts'

const TICKET = /^[A-Za-z0-9_-]{1,128}$/
const OUT_CHARS = 20_000
const TAIL_CHARS = 2_000

interface Ran { code: number; out: string; ms: number; timedOut: boolean }

/** Kills a process and everything it started: the process group on POSIX, `taskkill /T` on Windows. */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'))
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** Runs to completion and never rejects. Without `args` the file is a shell command line. */
function runProcess(file: string, args: string[] | undefined, opts: { cwd?: string; timeoutMs: number }): Promise<Ran> {
  const started = Date.now()
  return new Promise(resolve => {
    let out = ''
    let timedOut = false
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (code: number): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ code, out, ms: Date.now() - started, timedOut })
    }
    let child: ChildProcess
    // Its own process group on POSIX, so a timeout can kill what the shell started, not only the shell.
    const detached = process.platform !== 'win32'
    try {
      child = args === undefined
        ? spawn(file, { cwd: opts.cwd, shell: true, detached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(file, args, { cwd: opts.cwd, detached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      out = error instanceof Error ? error.message : String(error)
      finish(127)
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // A grandchild can hold the pipes open for a moment after the kill; answer now instead of waiting for it.
      finish(124)
    }, opts.timeoutMs)
    const feed = (chunk: Buffer): void => {
      out += chunk.toString('utf8')
      if (out.length > OUT_CHARS) out = out.slice(-OUT_CHARS)
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', error => {
      out += error.message
      finish(127)
    })
    child.on('close', code => finish(timedOut ? 124 : code ?? 1))
  })
}

const tailOf = (text: string): string => {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed.length <= TAIL_CHARS ? trimmed : `…${trimmed.slice(-TAIL_CHARS)}`
}

/** Runs the command through the shell in the ticket's workspace directory on this machine. */
export function localRunner(workspace: (ticketId: string) => string): CommandRunner {
  return async (ticketId, command, timeoutSec): Promise<CommandResult> => {
    const cwd = workspace(ticketId)
    try {
      mkdirSync(cwd, { recursive: true })
    } catch { /* the command reports it */ }
    const ran = await runProcess(command, undefined, { cwd, timeoutMs: timeoutSec * 1000 })
    const note = ran.timedOut ? `\n（超过 ${timeoutSec} 秒，已停止）` : ''
    return { command, code: ran.code, ms: ran.ms, tail: tailOf(`${ran.out}${note}`) }
  }
}

/** Runs the command inside the worker's running container, in `/workspace`, bounded by `timeout` there and here. */
export function containerRunner(podman = 'podman'): CommandRunner {
  return async (ticketId, command, timeoutSec): Promise<CommandResult> => {
    if (!TICKET.test(ticketId)) return { command, code: -1, ms: 0, tail: '任务编号不合法' }
    const ran = await runProcess(podman, [
      'exec', '--workdir', '/workspace', '--env', 'HOME=/tmp', `sa-${ticketId}`,
      'timeout', '-k', '5', String(timeoutSec), 'sh', '-c', command,
    ], { timeoutMs: (timeoutSec + 30) * 1000 })
    let note = ''
    if (ran.code === 124) note = `\n（超过 ${timeoutSec} 秒，已停止）`
    if (ran.code === 125 && /no such container|no container with name/i.test(ran.out)) note = '\n（执行者的容器已经不在了，没能运行）'
    return { command, code: ran.code, ms: ran.ms, tail: tailOf(`${ran.out}${note}`) }
  }
}

const CONTEXT_SCRIPT = [
  'cd /workspace 2>/dev/null || exit 0',
  "echo '文件（最多 80 个）：'",
  "find . -maxdepth 3 -type f -not -path './.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' 2>/dev/null | head -80",
  "if git rev-parse --git-dir >/dev/null 2>&1; then echo; echo 'git status：'; git status --short 2>/dev/null | head -40; echo; echo 'git diff --stat：'; git diff --stat 2>/dev/null | tail -20; fi",
].join('\n')

/** Files and git state of the worker's workspace, for the judge; empty when it cannot be read. */
export function containerContext(podman = 'podman'): (ticketId: string) => Promise<string> {
  return async ticketId => {
    if (!TICKET.test(ticketId)) return ''
    const ran = await runProcess(podman, ['exec', '--workdir', '/workspace', '--env', 'HOME=/tmp', `sa-${ticketId}`, 'sh', '-c', CONTEXT_SCRIPT], { timeoutMs: 60_000 })
    return ran.code === 0 ? ran.out.slice(0, 6000) : ''
  }
}
