/**
 * 可插拔多执行器抽象层（RunnerAdapter）与零 Token 脚本执行器（ScriptRunner）。
 *
 * 为未来混用 Pi / Claude Code CLI / Codex / OpenCode / 纯确定性脚本管道提供统一接口边界，
 * 不破坏现有 `PiExecutor` 的任何调用契约。
 */
import { execFile } from 'node:child_process'

export interface RunnerExecutionInput {
  id: string
  cwd: string
  prompt: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface RunnerExecutionResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

/** 通用执行器适配器接口。 */
export interface RunnerAdapter {
  readonly id: string
  readonly name: string
  readonly kind: 'agent' | 'script'
  /** 返回执行器是否可用于当前环境。 */
  available(): boolean
  /** 一次性无状态运行（用于脚本管道、离线评测或批处理节点）。 */
  runOnce?(input: RunnerExecutionInput): Promise<RunnerExecutionResult>
}

/** 零 Token 确定性脚本执行器：在受控工作目录执行固定命令，不消耗任何 LLM 费用。 */
export class ScriptRunner implements RunnerAdapter {
  readonly id = 'script'
  readonly name = '确定性脚本执行器（0 Token）'
  readonly kind = 'script' as const

  constructor(private readonly shell: string = process.platform === 'win32' ? 'powershell.exe' : 'bash') {}

  available(): boolean {
    return true
  }

  runOnce(input: RunnerExecutionInput): Promise<RunnerExecutionResult> {
    const started = Date.now()
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', input.prompt]
      : ['-lc', input.prompt]

    return new Promise(resolve => {
      execFile(
        this.shell,
        args,
        {
          cwd: input.cwd,
          env: { ...process.env, ...(input.env ?? {}) },
          timeout: Math.max(1000, input.timeoutMs ?? 60_000),
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - started
          if (!error) {
            resolve({ ok: true, exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), durationMs })
            return
          }
          const exitCode = typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : 1
          resolve({ ok: false, exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message), durationMs })
        },
      )
    })
  }
}

/** 执行器注册表：按 ID 管理所有可用 Runner。 */
export class RunnerRegistry {
  private readonly runners = new Map<string, RunnerAdapter>()

  register(runner: RunnerAdapter): this {
    this.runners.set(runner.id, runner)
    return this
  }

  get(id: string): RunnerAdapter | undefined {
    return this.runners.get(id)
  }

  list(): { id: string; name: string; kind: RunnerAdapter['kind']; available: boolean }[] {
    return [...this.runners.values()].map(r => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      available: r.available(),
    }))
  }
}
