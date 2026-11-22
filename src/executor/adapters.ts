/**
 * 外部编码代理 CLI 适配器：Claude Code CLI (`claude-code`) 与 OpenCode (`opencode`)。
 *
 * 与 `RegisteredScriptRunner` 和 `PiExecutor` 共用同一套 `RunnerAdapter` 契约：
 * - 统一超时（`timeoutMs`）、取消（`AbortSignal`）、恢复标识（`recoveryId`）、费用解析（`costUsd`）与产物目录扫描；
 * - 支持通过构造参数注入自定义 `command` / `extraArgs` 以便在任何机器上进行可重复的契约测试。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  scanArtifacts,
  type RunnerAdapter,
  type RunnerExecutionInput,
  type RunnerExecutionResult,
} from './runner.ts'

export interface CliRunnerOptions {
  command?: string
  extraArgs?: string[]
}

function commandExists(cmd: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const res = spawnSync(probe, [cmd], { stdio: 'ignore', windowsHide: true, timeout: 3000 })
    return res.status === 0
  } catch {
    return false
  }
}

/** 从 CLI 的 JSON 或文本输出中提取已上报费用（USD）。 */
function parseCostUsd(stdout: string): number {
  const trimmed = stdout.trim()
  if (!trimmed) return 0
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    for (const k of ['total_cost_usd', 'cost_usd', 'costUsd']) {
      if (typeof parsed[k] === 'number' && Number.isFinite(parsed[k])) return Number(parsed[k])
    }
  } catch {
    // 尝试逐行 JSONL
    for (const line of trimmed.split(/\r?\n/).reverse()) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        for (const k of ['total_cost_usd', 'cost_usd', 'costUsd']) {
          if (typeof obj[k] === 'number' && Number.isFinite(obj[k])) return Number(obj[k])
        }
      } catch { /* ignore */ }
    }
  }
  return 0
}

function spawnWithContract(opts: {
  runnerId: string
  command: string
  args: string[]
  input: RunnerExecutionInput
}): Promise<RunnerExecutionResult> {
  const started = Date.now()
  const artifactsDir = opts.input.artifactsDir ?? join(opts.input.cwd, 'output', opts.runnerId, opts.input.id)
  mkdirSync(artifactsDir, { recursive: true })

  if (opts.input.signal?.aborted) {
    return Promise.resolve({
      ok: false,
      runnerId: opts.runnerId,
      exitCode: 130,
      stdout: '',
      stderr: '执行器在启动前已被取消',
      durationMs: Date.now() - started,
      costUsd: 0,
      artifacts: [],
      cancelled: true,
      ...(opts.input.recoveryId ? { recoveryId: opts.input.recoveryId } : {}),
    })
  }

  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let settled = false

    const child = spawn(opts.command, opts.args, {
      cwd: opts.input.cwd,
      env: {
        ...process.env,
        ...(opts.input.env ?? {}),
        SA_ARTIFACTS_DIR: artifactsDir,
        ...(opts.input.recoveryId ? { SA_RECOVERY_ID: opts.input.recoveryId } : {}),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.input.signal?.removeEventListener('abort', onAbort)
      resolve({
        ok: exitCode === 0 && !timedOut && !cancelled,
        runnerId: opts.runnerId,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        costUsd: parseCostUsd(stdout),
        artifacts: scanArtifacts(artifactsDir),
        ...(cancelled ? { cancelled: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(opts.input.recoveryId ? { recoveryId: opts.input.recoveryId } : {}),
      })
    }

    const killChild = (): void => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 1500).unref?.()
    }

    const onAbort = (): void => {
      cancelled = true
      killChild()
    }
    opts.input.signal?.addEventListener('abort', onAbort, { once: true })

    const timeoutMs = Math.max(200, Math.min(3_600_000, opts.input.timeoutMs ?? 300_000))
    const timer = setTimeout(() => {
      timedOut = true
      killChild()
    }, timeoutMs)

    child.stdout?.on('data', chunk => {
      if (stdout.length < 2 * 1024 * 1024) stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < 1024 * 1024) stderr += String(chunk)
    })
    child.on('error', err => {
      stderr += err.message
      finish(127)
    })
    child.on('close', code => {
      finish(timedOut ? 124 : cancelled ? 130 : (code ?? 1))
    })
  })
}

/** Claude Code CLI 执行器适配器（`claude -p <prompt> --output-format json`）。 */
export class ClaudeCodeRunner implements RunnerAdapter {
  readonly id = 'claude-code'
  readonly name = 'Claude Code CLI'
  readonly kind = 'agent' as const
  private readonly cmd: string
  private readonly extraArgs: string[]

  constructor(opts: CliRunnerOptions = {}) {
    this.cmd = opts.command ?? 'claude'
    this.extraArgs = opts.extraArgs ?? []
  }

  available(): boolean {
    return this.cmd.includes('/') || this.cmd.includes('\\') || commandExists(this.cmd)
  }

  detail(): string {
    return this.available() ? `已检测到 ${this.cmd} CLI` : `未在 PATH 中检测到 ${this.cmd}`
  }

  runOnce(input: RunnerExecutionInput): Promise<RunnerExecutionResult> {
    const prompt = (input.prompt ?? '').trim()
    const args = this.extraArgs.length > 0
      ? [...this.extraArgs, prompt]
      : ['-p', prompt, '--output-format', 'json']
    return spawnWithContract({ runnerId: this.id, command: this.cmd, args, input })
  }
}

/** OpenCode CLI 执行器适配器（`opencode run <prompt> --format json`）。 */
export class OpenCodeRunner implements RunnerAdapter {
  readonly id = 'opencode'
  readonly name = 'OpenCode CLI'
  readonly kind = 'agent' as const
  private readonly cmd: string
  private readonly extraArgs: string[]

  constructor(opts: CliRunnerOptions = {}) {
    this.cmd = opts.command ?? 'opencode'
    this.extraArgs = opts.extraArgs ?? []
  }

  available(): boolean {
    return this.cmd.includes('/') || this.cmd.includes('\\') || commandExists(this.cmd)
  }

  detail(): string {
    return this.available() ? `已检测到 ${this.cmd} CLI` : `未在 PATH 中检测到 ${this.cmd}`
  }

  runOnce(input: RunnerExecutionInput): Promise<RunnerExecutionResult> {
    const prompt = (input.prompt ?? '').trim()
    const args = this.extraArgs.length > 0
      ? [...this.extraArgs, prompt]
      : ['run', prompt, '--format', 'json']
    return spawnWithContract({ runnerId: this.id, command: this.cmd, args, input })
  }
}
