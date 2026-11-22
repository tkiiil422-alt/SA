/**
 * Where a goal's acceptance commands run. In the container deployment: inside the worker's own container
 * (`podman exec sa-<ticket>`), with the worker's rights and its `/workspace`, so a test the worker could run is the test
 * the host runs. Elsewhere (the fake Pi in tests, a local launcher): through the shell in the ticket's workspace.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { CommandResult, CommandRunner, GoalFile } from './service.ts'

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

/** Bytes of one named file the judge sees, and of all of them together. */
export const FILE_BYTES = 12_000
export const FILES_BYTES = 40_000
/** A bare name (`README.md`) matches files this deep, at most this many per name. */
const NAME_DEPTH = 4
const PER_NAME = 3
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv'])

/** Turns what was read into the judge's files, within the per-file and total byte limits. */
export function goalFiles(read: { path: string; size: number; head: Buffer }[]): GoalFile[] {
  const files: GoalFile[] = []
  let total = 0
  for (const item of read) {
    if (files.some(file => file.path === item.path)) continue
    const room = Math.min(FILE_BYTES, FILES_BYTES - total)
    if (room <= 0) break
    const head = item.head.subarray(0, room)
    total += head.length
    if (head.includes(0)) {
      files.push({ path: item.path, size: item.size, text: '', truncated: false, binary: true })
      continue
    }
    files.push({ path: item.path, size: item.size, text: head.toString('utf8'), truncated: item.size > head.length })
  }
  return files
}

const FILES_SCRIPT = [
  'cd /workspace 2>/dev/null || exit 0',
  'for n in "$@"; do',
  `  case "$n" in */*) printf '%s\\n' "./$n" ;; *) find . -maxdepth ${NAME_DEPTH} -type f -name "$n" -not -path './.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' 2>/dev/null | head -${PER_NAME} ;; esac`,
  'done | while IFS= read -r f; do',
  '  [ -f "$f" ] && [ ! -L "$f" ] || continue',
  `  printf 'F\\t%s\\t%s\\t' "$f" "$(wc -c < "$f" | tr -d ' ')"`,
  `  head -c ${FILE_BYTES} "$f" | base64 | tr -d '\\n'`,
  '  echo',
  'done',
].join('\n')

/**
 * Reads the named files inside the worker's container: what the judge sees is what the worker left in `/workspace`,
 * and a symbolic link cannot reach anything on the host. The names go to the script as arguments, never into its text.
 */
export function containerFiles(podman = 'podman'): (ticketId: string, names: string[]) => Promise<GoalFile[]> {
  return async (ticketId, names) => {
    if (!TICKET.test(ticketId) || names.length === 0) return []
    const ran = await runProcess(podman, [
      'exec', '--workdir', '/workspace', '--env', 'HOME=/tmp', `sa-${ticketId}`, 'sh', '-c', FILES_SCRIPT, 'sh', ...names,
    ], { timeoutMs: 60_000 })
    if (ran.code !== 0) return []
    const read: { path: string; size: number; head: Buffer }[] = []
    for (const line of ran.out.split('\n')) {
      const [tag, path, size, data] = line.split('\t')
      if (tag !== 'F' || path === undefined || size === undefined || data === undefined) continue
      read.push({ path: path.replace(/^\.\//, ''), size: Number(size) || 0, head: Buffer.from(data, 'base64') })
    }
    return goalFiles(read)
  }
}

/** Reads the named files from the ticket's workspace on this machine; links are skipped and nothing outside it is read. */
export function localFiles(workspace: (ticketId: string) => string): (ticketId: string, names: string[]) => Promise<GoalFile[]> {
  return async (ticketId, names) => {
    let root: string
    try {
      root = realpathSync(workspace(ticketId))
    } catch {
      return []
    }
    const inside = (path: string): boolean => path === root || path.startsWith(root + sep)
    const found: string[] = []
    const regular = (full: string): boolean => {
      try {
        return lstatSync(full).isFile() && inside(realpathSync(full))
      } catch {
        return false
      }
    }
    const search = (dir: string, name: string, depth: number, hits: string[]): void => {
      if (hits.length >= PER_NAME) return
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (hits.length >= PER_NAME) return
        const full = join(dir, entry.name)
        if (entry.isFile() && entry.name === name) hits.push(full)
        else if (entry.isDirectory() && depth < NAME_DEPTH && !SKIP_DIRS.has(entry.name)) search(full, name, depth + 1, hits)
      }
    }
    for (const name of names) {
      if (name.includes('/')) {
        const full = resolve(root, name)
        if (inside(full) && regular(full)) found.push(full)
        continue
      }
      const hits: string[] = []
      search(root, name, 1, hits)
      found.push(...hits.filter(regular))
    }
    const read: { path: string; size: number; head: Buffer }[] = []
    for (const full of found) {
      try {
        const size = statSync(full).size
        const fd = openSync(full, 'r')
        try {
          const head = Buffer.alloc(Math.min(size, FILE_BYTES))
          const n = readSync(fd, head, 0, head.length, 0)
          read.push({ path: relative(root, full).split(sep).join('/'), size, head: head.subarray(0, n) })
        } finally {
          closeSync(fd)
        }
      } catch { /* gone meanwhile */ }
    }
    return goalFiles(read)
  }
}
