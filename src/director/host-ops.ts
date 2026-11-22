/**
 * 总控助手（Director）的宿主机管理服务：
 * - 只读巡检（主机资源、磁盘/目录占用、Podman 容器与镜像、systemd 服务状态、服务日志、非敏感文件浏览与读取）
 * - 受 L3 二次确认保护的宿主机运维动作（执行 shell 命令、服务启停重启、Podman 容器/镜像清理）
 *
 * 所有命令输出与文件内容均经密钥脱敏、长度截断，敏感凭据文件路径默认拒绝读取。
 */
import { spawn } from 'node:child_process'
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from 'node:os'
import { basename, join, resolve } from 'node:path'

export interface HostCmdResult {
  code: number
  out: string
  timedOut?: boolean
}

export type HostCmdRunner = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string },
) => Promise<HostCmdResult>

const MAX_CMD_OUT_BYTES = 64 * 1024
const MAX_READ_BYTES = 128 * 1024
const UNIT_RE = /^[A-Za-z0-9@._-]{1,120}$/
const PODMAN_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,160}$/

export const defaultHostRunner: HostCmdRunner = (file, args, { timeoutMs, cwd }) => new Promise(resolvePromise => {
  let out = ''
  let settled = false
  let timedOut = false
  const finish = (res: HostCmdResult): void => {
    if (!settled) {
      settled = true
      resolvePromise(res)
    }
  }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(file, args, {
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    finish({ code: 127, out: error instanceof Error ? error.message : String(error) })
    return
  }
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 2000).unref?.()
  }, timeoutMs)
  const feed = (chunk: Buffer): void => {
    if (out.length < MAX_CMD_OUT_BYTES) {
      out += chunk.toString('utf8')
    }
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', feed)
  child.on('error', err => {
    clearTimeout(timer)
    finish({ code: 127, out: `${out}${err.message}` })
  })
  child.on('close', code => {
    clearTimeout(timer)
    finish({ code: code ?? (timedOut ? 124 : 1), out, ...(timedOut ? { timedOut: true } : {}) })
  })
})

const SENSITIVE_BASENAMES = new Set([
  'vault.key',
  'vault.json',
  'admin.json',
  'cli-token',
  'shadow',
  'gshadow',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.env',
  '.env.local',
  '.env.production',
])

/** 拒绝直接读取常见密钥/口令文件，避免通过只读文件工具泄露明文凭据。 */
export function isSensitiveHostPath(targetPath: string): boolean {
  const norm = targetPath.replace(/\\/g, '/').toLowerCase()
  const base = basename(norm)
  if (SENSITIVE_BASENAMES.has(base)) return true
  if (/\.(pem|key|p12|pfx|jks)$/.test(base)) return true
  if (norm.includes('/.config/superagent/env') || norm.endsWith('/superagent/env')) return true
  if (norm.includes('/.ssh/') && !base.endsWith('.pub') && base !== 'config' && base !== 'known_hosts') return true
  if (norm === '/etc/shadow' || norm === '/etc/gshadow') return true
  return false
}

export interface HostOpsOptions {
  homeDir?: string
  stateDir?: string
  workspaceRoot?: string
  projectsRoot?: string
  runner?: HostCmdRunner
}

export class HostOpsService {
  private readonly runner: HostCmdRunner
  private readonly homeDir: string

  constructor(private readonly opts: HostOpsOptions = {}) {
    this.runner = opts.runner ?? defaultHostRunner
    this.homeDir = opts.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
  }

  private expandPath(raw: string): string {
    const trimmed = raw.trim()
    if (!trimmed) return this.homeDir
    if (trimmed === '~') return this.homeDir
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(this.homeDir, trimmed.slice(2))
    return resolve(trimmed)
  }

  /** 主机综合巡检：系统资源、磁盘挂载、关键目录大小、Podman 容器与镜像、Top 进程、superagent 服务状态。 */
  async inspect(): Promise<Record<string, unknown>> {
    const totalMb = Math.round(totalmem() / 1024 / 1024)
    const freeMb = Math.round(freemem() / 1024 / 1024)
    const usedMb = totalMb - freeMb
    const keyDirs = [
      this.opts.stateDir,
      this.opts.workspaceRoot,
      this.opts.projectsRoot,
      join(this.homeDir, 'superagent-cache'),
      join(this.homeDir, 'superagent-tools'),
    ].filter((d): d is string => Boolean(d))

    const [df, du, psTop, containers, images, svc] = await Promise.all([
      this.runner('df', ['-h', '--output=source,size,used,avail,pcent,target'], { timeoutMs: 8_000 }),
      keyDirs.length > 0
        ? this.runner('du', ['-sh', ...keyDirs], { timeoutMs: 12_000 })
        : Promise.resolve({ code: 0, out: '' }),
      this.runner('ps', ['-eo', 'pid,ppid,user,%cpu,%mem,etime,comm', '--sort=-%cpu'], { timeoutMs: 8_000 }),
      this.runner('podman', ['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'], { timeoutMs: 10_000 }),
      this.runner('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}'], { timeoutMs: 10_000 }),
      this.runner('systemctl', ['--user', 'show', 'superagent.service', '-p', 'ActiveState,SubState,MainPID,MemoryCurrent,ExecMainStartTimestamp'], { timeoutMs: 8_000 }),
    ])

    return {
      host: {
        hostname: hostname(),
        platform: `${platform()} ${release()}`,
        uptimeHours: Number((uptime() / 3600).toFixed(1)),
        cpuCount: cpus().length,
        loadAvg: loadavg().map(n => Number(n.toFixed(2))),
        memoryMb: { total: totalMb, used: usedMb, free: freeMb, usedPct: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0 },
      },
      superagentService: svc.code === 0 ? svc.out.trim() : svc.out.trim() || 'unavailable',
      diskUsage: df.code === 0 ? df.out.trim().split(/\r?\n/).slice(0, 20) : [df.out.trim()],
      directorySizes: du.out.trim() ? du.out.trim().split(/\r?\n/).slice(0, 20) : [],
      topProcesses: psTop.code === 0 ? psTop.out.trim().split(/\r?\n/).slice(0, 16) : [],
      podmanContainers: containers.code === 0 ? containers.out.trim().split(/\r?\n/).filter(Boolean).slice(0, 30) : [],
      podmanImages: images.code === 0 ? images.out.trim().split(/\r?\n/).filter(Boolean).slice(0, 30) : [],
    }
  }

  /** 查看宿主机 systemd 日志（默认 superagent.service）。 */
  async logs(input: { unit?: string; lines?: number; priority?: string; grep?: string; scope?: 'user' | 'system' } = {}): Promise<{ ok: boolean; unit: string; lines: string[]; error?: string }> {
    const unit = (input.unit?.trim() || 'superagent.service')
    if (!UNIT_RE.test(unit)) return { ok: false, unit, lines: [], error: '服务名称不合法' }
    const count = Math.max(10, Math.min(300, Math.trunc(input.lines ?? 80)))
    const args = [
      ...(input.scope === 'system' ? [] : ['--user']),
      '-u', unit,
      '-n', String(count),
      '--no-pager',
    ]
    if (input.priority && /^(emerg|alert|crit|err|warning|notice|info|debug|[0-7])$/i.test(input.priority.trim())) {
      args.push('-p', input.priority.trim())
    }
    const r = await this.runner('journalctl', args, { timeoutMs: 12_000 })
    if (r.code !== 0) return { ok: false, unit, lines: [], error: r.out.trim() || `journalctl 退出码 ${r.code}` }
    let lines = r.out.split(/\r?\n/).filter(Boolean)
    if (input.grep && input.grep.trim()) {
      const needle = input.grep.trim().toLowerCase()
      lines = lines.filter(l => l.toLowerCase().includes(needle))
    }
    return { ok: true, unit, lines: lines.slice(-count) }
  }

  /** 浏览宿主机目录。 */
  listDir(rawPath: string): { ok: true; path: string; entries: Array<{ name: string; kind: 'dir' | 'file' | 'link'; size?: number }> } | { ok: false; error: string } {
    const target = this.expandPath(rawPath)
    let real: string
    try {
      real = realpathSync(target)
    } catch {
      return { ok: false, error: `目录不存在：${target}` }
    }
    try {
      const dirents = readdirSync(real, { withFileTypes: true }).slice(0, 150)
      const entries = dirents.map(d => {
        if (d.isDirectory()) return { name: d.name, kind: 'dir' as const }
        if (d.isSymbolicLink()) return { name: d.name, kind: 'link' as const }
        let size: number | undefined
        try { size = statSync(join(real, d.name)).size } catch { /* ignore */ }
        return { name: d.name, kind: 'file' as const, ...(size !== undefined ? { size } : {}) }
      })
      return { ok: true, path: real, entries }
    } catch (error) {
      return { ok: false, error: `无法读取目录：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 读取宿主机文本文件（自动拒绝敏感密钥文件与二进制文件）。 */
  readFile(rawPath: string, startLine = 1, maxLines = 120): { ok: true; path: string; text: string; totalLines: number; truncated: boolean } | { ok: false; error: string } {
    const target = this.expandPath(rawPath)
    let real: string
    try {
      real = realpathSync(target)
    } catch {
      return { ok: false, error: `文件不存在：${target}` }
    }
    if (isSensitiveHostPath(target) || isSensitiveHostPath(real)) {
      return { ok: false, error: '该路径属于敏感凭据/密钥文件，安全策略禁止直接读取。' }
    }
    let st
    try {
      st = lstatSync(real)
    } catch {
      return { ok: false, error: '无法读取文件信息' }
    }
    if (!st.isFile()) return { ok: false, error: '目标不是普通文件' }
    const readSize = Math.min(st.size, MAX_READ_BYTES)
    const buf = Buffer.alloc(readSize)
    const fd = openSync(real, 'r')
    try {
      readSync(fd, buf, 0, readSize, 0)
    } finally {
      closeSync(fd)
    }
    if (buf.subarray(0, Math.min(buf.length, 4096)).includes(0)) {
      return { ok: false, error: `目标为二进制文件（${st.size} 字节），不适合文本读取` }
    }
    const lines = buf.toString('utf8').split(/\r?\n/)
    const from = Math.max(1, Math.trunc(startLine))
    const take = Math.max(1, Math.min(250, Math.trunc(maxLines)))
    const slice = lines.slice(from - 1, from - 1 + take)
    const text = slice.map((l, idx) => `${from + idx}: ${l}`).join('\n')
    return {
      ok: true,
      path: real,
      text,
      totalLines: lines.length,
      truncated: st.size > MAX_READ_BYTES || from - 1 + take < lines.length,
    }
  }

  /** 查看 Podman 容器列表。 */
  async podmanPs(all = true): Promise<HostCmdResult> {
    const args = ['ps', ...(all ? ['-a'] : []), '--format', 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']
    return this.runner('podman', args, { timeoutMs: 12_000 })
  }

  /** 查看 Podman 镜像列表。 */
  async podmanImages(): Promise<HostCmdResult> {
    return this.runner('podman', ['images', '--format', 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}'], { timeoutMs: 12_000 })
  }

  /** 查看指定容器的日志尾部。 */
  async podmanLogs(container: string, tail = 100): Promise<HostCmdResult> {
    const name = container.trim()
    if (!PODMAN_TARGET_RE.test(name)) return { code: 1, out: '容器名称或 ID 不合法' }
    const n = Math.max(10, Math.min(400, Math.trunc(tail)))
    return this.runner('podman', ['logs', '--tail', String(n), name], { timeoutMs: 12_000 })
  }

  /** 执行 Podman 维护动作（仅在经 L3 二次确认后由调用方调用）。 */
  async podmanAction(action: 'stop' | 'rm' | 'prune_images' | 'prune_containers', target?: string): Promise<HostCmdResult> {
    if (action === 'prune_images') return this.runner('podman', ['image', 'prune', '-f'], { timeoutMs: 60_000 })
    if (action === 'prune_containers') return this.runner('podman', ['container', 'prune', '-f'], { timeoutMs: 60_000 })
    const clean = (target ?? '').trim()
    if (!PODMAN_TARGET_RE.test(clean)) return { code: 1, out: '缺少合法的容器名称或 ID' }
    if (action === 'stop') return this.runner('podman', ['stop', '-t', '10', clean], { timeoutMs: 25_000 })
    return this.runner('podman', ['rm', '-f', clean], { timeoutMs: 25_000 })
  }

  /** 查询 systemd 服务状态。 */
  async serviceStatus(unit: string, scope: 'user' | 'system' = 'user'): Promise<HostCmdResult> {
    const clean = unit.trim() || 'superagent.service'
    if (!UNIT_RE.test(clean)) return { code: 1, out: '服务名称不合法' }
    const args = [...(scope === 'system' ? [] : ['--user']), 'status', '--no-pager', '-n', '20', clean]
    return this.runner('systemctl', args, { timeoutMs: 10_000 })
  }

  /** 启停或重启 systemd 服务（仅在经 L3 二次确认后调用；重启 superagent 自身时延迟触发以确保回复送达）。 */
  async serviceControl(unit: string, action: 'start' | 'stop' | 'restart', scope: 'user' | 'system' = 'user'): Promise<{ ok: boolean; scheduled?: boolean; out: string }> {
    const clean = unit.trim()
    if (!UNIT_RE.test(clean)) return { ok: false, out: '服务名称不合法' }
    const isSelfRestart = scope === 'user' && action === 'restart' && (clean === 'superagent' || clean === 'superagent.service')
    if (isSelfRestart) {
      const timer = setTimeout(() => {
        void this.runner('systemctl', ['--user', 'restart', clean], { timeoutMs: 30_000 })
      }, 1500)
      timer.unref?.()
      return { ok: true, scheduled: true, out: `已安排 1.5 秒后重启 ${clean}，请稍候 3~5 秒再查询状态。` }
    }
    const args = [...(scope === 'system' ? [] : ['--user']), action, clean]
    const r = await this.runner('systemctl', args, { timeoutMs: 30_000 })
    return { ok: r.code === 0, out: r.out.trim() || (r.code === 0 ? `${action} ${clean} 已执行` : `systemctl 退出码 ${r.code}`) }
  }

  /** 在宿主机执行运维命令（仅在经 L3 二次确认后调用）。 */
  async exec(command: string, opts: { cwd?: string; timeoutSec?: number } = {}): Promise<HostCmdResult> {
    const cmd = command.trim()
    if (!cmd) return { code: 1, out: '命令不能为空' }
    const timeoutMs = Math.max(5, Math.min(300, Math.trunc(opts.timeoutSec ?? 60))) * 1000
    const cwd = opts.cwd ? this.expandPath(opts.cwd) : this.homeDir
    if (process.platform === 'win32') {
      return this.runner('powershell', ['-NoProfile', '-Command', cmd], { timeoutMs, cwd })
    }
    return this.runner('bash', ['-lc', cmd], { timeoutMs, cwd })
  }
}
