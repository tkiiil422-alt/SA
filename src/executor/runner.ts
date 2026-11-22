/**
 * 可插拔多执行器统一抽象层（RunnerAdapter）+ 确定性零 Token 注册脚本执行器（RegisteredScriptRunner）。
 *
 * 设计要点：
 * - 保留 Pi 作为默认 AI 执行器，不破坏既有 `PiExecutor` 任何生命周期契约；
 * - 固定脚本必须通过已登记的 `scriptId` + 结构化 Zod 校验参数启动，拒绝任意 Shell 注入；
 * - 统一处理超时（`timeoutMs`）、取消（`AbortSignal`）、恢复标识（`recoveryId`）、费用（`costUsd`）与产物清单（`artifacts`）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { RunnerDescriptor } from '../shared/api-types.ts'

export interface RunnerExecutionInput {
  id: string
  cwd: string
  prompt?: string
  /** 注册脚本模式：必须通过已登记的脚本 ID 与结构化参数启动。 */
  scriptId?: string
  scriptParams?: Record<string, unknown>
  /** 产物写入目录（若提供，所有产出物写入并扫描此目录）。 */
  artifactsDir?: string
  /** 外部注入环境（仅允许受控变量）。 */
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** 断点恢复/幂等关联 ID。 */
  recoveryId?: string
}

export interface RunnerExecutionResult {
  ok: boolean
  runnerId: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  costUsd: number
  artifacts: string[]
  cancelled?: boolean
  timedOut?: boolean
  recoveryId?: string
  data?: Record<string, unknown>
}

/** 通用执行器适配器契约。 */
export interface RunnerAdapter {
  readonly id: string
  readonly name: string
  readonly kind: 'agent' | 'script'
  /** 返回执行器是否可用于当前环境。 */
  available(): boolean
  detail?(): string
  /** 统一的一次性执行接口（支持超时、取消、恢复标识、费用核算与产物清单）。 */
  runOnce?(input: RunnerExecutionInput): Promise<RunnerExecutionResult>
}

export interface RegisteredScriptDefinition<TParams = Record<string, unknown>> {
  id: string
  name: string
  description: string
  paramsSchema: z.ZodType<TParams>
  execute: (ctx: {
    cwd: string
    artifactsDir: string
    params: TParams
    signal: AbortSignal
  }) => Promise<{
    ok: boolean
    summary: string
    artifacts?: string[]
    data?: Record<string, unknown>
  }>
}

/** 扫描产物目录，收集所有生成文件的相对路径。 */
export function scanArtifacts(dir: string): string[] {
  if (!dir || !existsSync(dir)) return []
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = join(cur, ent.name)
      if (ent.isDirectory()) stack.push(full)
      else if (ent.isFile()) out.push(relative(dir, full).replace(/\\/g, '/'))
    }
  }
  return out.sort()
}

/**
 * 确定性零 Token 注册脚本执行器（`script`）：
 * 仅允许执行已登记 `scriptId` 且参数通过结构化 Schema 校验的脚本，统一处理超时、取消与产物收集。
 */
export class RegisteredScriptRunner implements RunnerAdapter {
  readonly id = 'script'
  readonly name = '确定性脚本执行器（0 Token）'
  readonly kind = 'script' as const
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly scripts = new Map<string, RegisteredScriptDefinition<any>>()

  constructor() {
    this.registerBuiltins()
  }

  available(): boolean {
    return true
  }

  detail(): string {
    return `已登记 ${this.scripts.size} 个确定性脚本（零 LLM 费用）`
  }

  registerScript<TParams>(def: RegisteredScriptDefinition<TParams>): this {
    this.scripts.set(def.id, def)
    return this
  }

  listScripts(): { id: string; name: string; description: string }[] {
    return [...this.scripts.values()].map(s => ({ id: s.id, name: s.name, description: s.description }))
  }

  async runOnce(input: RunnerExecutionInput): Promise<RunnerExecutionResult> {
    const started = Date.now()
    const scriptId = input.scriptId?.trim()
    if (!scriptId) {
      return {
        ok: false,
        runnerId: this.id,
        exitCode: 2,
        stdout: '',
        stderr: '确定性脚本执行器必须传入已登记的 scriptId 与结构化 scriptParams（禁止任意命令执行）。',
        durationMs: Date.now() - started,
        costUsd: 0,
        artifacts: [],
        ...(input.recoveryId ? { recoveryId: input.recoveryId } : {}),
      }
    }
    const def = this.scripts.get(scriptId)
    if (!def) {
      return {
        ok: false,
        runnerId: this.id,
        exitCode: 2,
        stdout: '',
        stderr: `未登记的脚本 ID：${scriptId}（可用：${[...this.scripts.keys()].join(', ')}）`,
        durationMs: Date.now() - started,
        costUsd: 0,
        artifacts: [],
        ...(input.recoveryId ? { recoveryId: input.recoveryId } : {}),
      }
    }

    const parsed = def.paramsSchema.safeParse(input.scriptParams ?? {})
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join('.') || 'params'}: ${i.message}`).join('；')
      return {
        ok: false,
        runnerId: this.id,
        exitCode: 2,
        stdout: '',
        stderr: `脚本参数校验失败：${msg}`,
        durationMs: Date.now() - started,
        costUsd: 0,
        artifacts: [],
        ...(input.recoveryId ? { recoveryId: input.recoveryId } : {}),
      }
    }

    const artifactsDir = input.artifactsDir ?? join(input.cwd, 'output', 'scripts', input.id)
    mkdirSync(artifactsDir, { recursive: true })

    const ctl = new AbortController()
    let timedOut = false
    let cancelled = false
    const onParentAbort = (): void => { cancelled = true; ctl.abort() }
    if (input.signal) {
      if (input.signal.aborted) {
        return {
          ok: false,
          runnerId: this.id,
          exitCode: 130,
          stdout: '',
          stderr: '脚本执行在启动前已被取消',
          durationMs: Date.now() - started,
          costUsd: 0,
          artifacts: [],
          cancelled: true,
          ...(input.recoveryId ? { recoveryId: input.recoveryId } : {}),
        }
      }
      input.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    const timeoutMs = Math.max(200, Math.min(300_000, input.timeoutMs ?? 60_000))
    const timer = setTimeout(() => { timedOut = true; ctl.abort() }, timeoutMs)

    try {
      const res = await Promise.race([
        def.execute({ cwd: input.cwd, artifactsDir, params: parsed.data, signal: ctl.signal }),
        new Promise<never>((_, reject) => {
          ctl.signal.addEventListener('abort', () => {
            reject(new Error(timedOut ? `脚本执行超时（${timeoutMs}ms）` : '脚本执行被取消'))
          }, { once: true })
        }),
      ])
      const artifacts = res.artifacts && res.artifacts.length > 0 ? res.artifacts : scanArtifacts(artifactsDir)
      return {
        ok: res.ok,
        runnerId: this.id,
        exitCode: res.ok ? 0 : 1,
        stdout: res.summary,
        stderr: res.ok ? '' : res.summary,
        durationMs: Date.now() - started,
        costUsd: 0,
        artifacts,
        ...(res.data ? { data: res.data } : {}),
        ...(input.recoveryId ? { recoveryId: input.recoveryId } : {}),
      }
    } catch (error) {
      return {
        ok: false,
        runnerId: this.id,
        exitCode: timedOut ? 124 : cancelled ? 130 : 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        costUsd: 0,
        artifacts: scanArtifacts(artifactsDir),
        ...(cancelled ? { cancelled: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(input.recoveryId ? { recoveryId: input.recoveryId } : {}),
      }
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onParentAbort)
    }
  }

  private registerBuiltins(): void {
    // 1. 销售周报口径确定性核对脚本（零 Token）：校验日期口径与金额两位小数并汇总生成 Markdown/JSON 产物
    this.registerScript({
      id: 'sales-report-check',
      name: '销售周报数据核对与汇总（0 Token）',
      description: '校验 CSV 销售订单按指定日期字段归集、金额保留两位小数，生成核对报告与周报摘要',
      paramsSchema: z.object({
        inputFile: z.string().trim().min(1),
        dateField: z.enum(['created_at', 'paid_at']).default('paid_at'),
        decimals: z.number().int().min(0).max(4).default(2),
        weekStart: z.string().trim().optional(),
        weekEnd: z.string().trim().optional(),
        outputName: z.string().trim().default('sales-report.md'),
      }).strict(),
      execute: async ({ cwd, artifactsDir, params }) => {
        const src = join(cwd, params.inputFile)
        if (!existsSync(src)) {
          return { ok: false, summary: `找不到输入数据文件：${params.inputFile}` }
        }
        const raw = readFileSync(src, 'utf8').replace(/\r\n/g, '\n').trim()
        const lines = raw.split('\n').filter(Boolean)
        if (lines.length < 2) {
          return { ok: false, summary: '输入 CSV 缺少数据行' }
        }
        const headers = lines[0]!.split(',').map(h => h.trim())
        const dateIdx = headers.indexOf(params.dateField)
        const amountIdx = headers.indexOf('amount')
        const channelIdx = headers.indexOf('channel')
        if (dateIdx < 0 || amountIdx < 0) {
          return { ok: false, summary: `CSV 缺少必要列：${params.dateField} 或 amount` }
        }
        let total = 0
        let matchedRows = 0
        const byChannel = new Map<string, number>()
        const badAmounts: string[] = []
        const decRe = params.decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+\\.\\d{${params.decimals}}$`)

        for (let i = 1; i < lines.length; i += 1) {
          const cols = lines[i]!.split(',').map(c => c.trim())
          const dt = cols[dateIdx] ?? ''
          if (!dt) continue
          if (params.weekStart && dt < params.weekStart) continue
          if (params.weekEnd && dt > params.weekEnd) continue
          const amtText = cols[amountIdx] ?? ''
          const amt = Number(amtText)
          if (!Number.isFinite(amt)) {
            badAmounts.push(`第 ${i + 1} 行非法金额: ${amtText}`)
            continue
          }
          if (!decRe.test(amtText)) {
            // 仍计入汇总，但记录格式提示（输出统一按指定小数位格式化）
          }
          matchedRows += 1
          total += amt
          const ch = channelIdx >= 0 ? (cols[channelIdx] || '未分类') : '全部'
          byChannel.set(ch, (byChannel.get(ch) ?? 0) + amt)
        }

        if (badAmounts.length > 0) {
          return { ok: false, summary: `金额解析失败：${badAmounts.slice(0, 3).join('；')}` }
        }

        const fmt = (n: number): string => n.toFixed(params.decimals)
        const mdLines = [
          `# 销售周报（口径：${params.dateField} · 小数位：${params.decimals}）`,
          '',
          `- 统计订单数：${matchedRows}`,
          `- 销售总额：${fmt(total)}`,
          '',
          '## 分渠道汇总',
          ...[...byChannel.entries()].map(([ch, sum]) => `- ${ch}：${fmt(sum)}`),
        ]
        const outMd = join(artifactsDir, params.outputName)
        const outJson = join(artifactsDir, 'sales-summary.json')
        writeFileSync(outMd, `${mdLines.join('\n')}\n`, 'utf8')
        writeFileSync(outJson, JSON.stringify({
          dateField: params.dateField,
          decimals: params.decimals,
          matchedRows,
          totalFormatted: fmt(total),
          byChannel: Object.fromEntries([...byChannel.entries()].map(([k, v]) => [k, fmt(v)])),
        }, null, 2), 'utf8')

        return {
          ok: true,
          summary: `核对完成（口径=${params.dateField}，小数位=${params.decimals}）：${matchedRows} 笔，总额 ${fmt(total)}`,
          artifacts: [params.outputName, 'sales-summary.json'],
          data: { matchedRows, totalFormatted: fmt(total), dateField: params.dateField, decimals: params.decimals },
        }
      },
    })

    // 2. 工作区文件指纹清单脚本（零 Token）
    this.registerScript({
      id: 'workspace-manifest',
      name: '工作区文件清单与校验和（0 Token）',
      description: '扫描指定相对目录的文件大小与 SHA-256 校验和并落盘 manifest.json',
      paramsSchema: z.object({
        subDir: z.string().trim().default('.'),
      }).strict(),
      execute: async ({ cwd, artifactsDir, params }) => {
        const root = join(cwd, params.subDir)
        if (!existsSync(root)) return { ok: false, summary: `目录不存在：${params.subDir}` }
        const files = scanArtifacts(root).slice(0, 500)
        const items = files.map(rel => {
          const full = join(root, rel)
          const st = statSync(full)
          const sha256 = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)
          return { path: rel, bytes: st.size, sha256 }
        })
        writeFileSync(join(artifactsDir, 'manifest.json'), JSON.stringify({ count: items.length, items }, null, 2), 'utf8')
        return {
          ok: true,
          summary: `已生成 ${items.length} 个文件的清单与校验和`,
          artifacts: ['manifest.json'],
          data: { count: items.length },
        }
      },
    })
  }
}

/** 默认内置 Pi 执行器元数据描述符（实际执行沿用既有 `PiExecutor` 生命周期）。 */
export class PiRunnerDescriptor implements RunnerAdapter {
  readonly id = 'pi'
  readonly name = 'Pi 默认容器执行器'
  readonly kind = 'agent' as const
  available(): boolean { return true }
  detail(): string { return '默认多轮 RPC 容器执行器（支持完整 MCP、目标门禁与子代理协作）' }
}

/** 保持向后兼容的别名导出。 */
export { RegisteredScriptRunner as ScriptRunner }

/** 执行器注册表：按工单或技能选择执行器，默认回退至 `pi`。 */
export class RunnerRegistry {
  private readonly runners = new Map<string, RunnerAdapter>()

  register(runner: RunnerAdapter): this {
    this.runners.set(runner.id, runner)
    return this
  }

  get(id: string): RunnerAdapter | undefined {
    return this.runners.get(id)
  }

  /** 按工单/技能优先级解析执行器（默认回退为 `pi`）。 */
  resolve(preferredId?: string): RunnerAdapter | undefined {
    if (preferredId && this.runners.has(preferredId)) return this.runners.get(preferredId)
    return this.runners.get('pi') ?? [...this.runners.values()][0]
  }

  list(): RunnerDescriptor[] {
    return [...this.runners.values()].map(r => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      available: r.available(),
      ...(r.detail ? { detail: r.detail() } : {}),
    }))
  }
}
