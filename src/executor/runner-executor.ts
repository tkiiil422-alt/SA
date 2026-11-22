/**
 * 单机多执行器统一工单 `Executor` 适配器（MultiRunnerExecutor）。
 *
 * 将 `RegisteredScriptRunner`（0 Token 确定性脚本）、`ClaudeCodeRunner`、`OpenCodeRunner`
 * 完整接入核心 `Engine` 的工单生命周期（`start` / `deliver` / `stop`），实现：
 * - 按工单（`runnerId`）或命中技能偏好自动分流执行，保留 `PiExecutor` 为默认；
 * - 统一处理超时、取消（`AbortController`）、产物目录落盘、费用入账、目标门禁（`GoalService.gate`）与工单结算。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Assignment, EngineForExecutor, Executor, Ticket, Trigger, WorkerReport } from '../core/index.ts'
import type { RunnerRegistry } from './runner.ts'
import type { Ledger } from '../ledger/ledger.ts'
import type { EventLog } from '../ledger/events.ts'
import type { ActivityLog } from './activity.ts'
import type { GoalService } from '../goal/service.ts'

export interface TicketRunnerSelection {
  runnerId: string
  scriptId?: string
  scriptParams?: Record<string, unknown>
}

export interface MultiRunnerExecutorDeps {
  db: DatabaseSync
  engine: () => EngineForExecutor
  runners: RunnerRegistry
  ledger: Ledger
  events: EventLog
  activity?: ActivityLog
  goals?: () => Pick<GoalService, 'gate' | 'recordEvidence'> | undefined
  afterCommit?: (fn: () => void) => void
  workspaceRoot: string
  prepareProject?: (ticketId: string, triggerIds: readonly string[]) => Promise<unknown>
  getTrigger?: (triggerId: string) => Trigger | undefined
  onError?: (error: unknown) => void
}

interface RunnerRow {
  trigger_id: string
  runner_id: string
  script_id: string | null
  script_params_json: string
}

export class MultiRunnerExecutor implements Executor {
  private readonly running = new Map<string, { abort: AbortController }>()

  constructor(private readonly deps: MultiRunnerExecutorDeps) {
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_runners (
        trigger_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        script_id TEXT,
        script_params_json TEXT NOT NULL DEFAULT '{}'
      );
    `)
  }

  /** 为新提交的触发器绑定非默认执行器（`script` / `claude-code` / `opencode`）。 */
  setSelection(triggerId: string, sel: TicketRunnerSelection): void {
    const runnerId = sel.runnerId.trim()
    if (!runnerId || runnerId === 'pi') return
    this.deps.db.prepare(`
      INSERT OR REPLACE INTO ticket_runners (trigger_id, runner_id, script_id, script_params_json)
      VALUES (?, ?, ?, ?)
    `).run(
      triggerId,
      runnerId,
      sel.scriptId?.trim() || null,
      JSON.stringify(sel.scriptParams ?? {}),
    )
  }

  getSelection(triggerId: string): TicketRunnerSelection | undefined {
    const row = this.deps.db.prepare('SELECT trigger_id, runner_id, script_id, script_params_json FROM ticket_runners WHERE trigger_id = ?')
      .get(triggerId) as RunnerRow | undefined
    if (!row) return undefined
    let scriptParams: Record<string, unknown> = {}
    try { scriptParams = JSON.parse(row.script_params_json) } catch { /* ignore */ }
    return {
      runnerId: row.runner_id,
      ...(row.script_id ? { scriptId: row.script_id } : {}),
      ...(Object.keys(scriptParams).length > 0 ? { scriptParams } : {}),
    }
  }

  handles(ticket: { origin: { triggerId: string } }): boolean {
    const sel = this.getSelection(ticket.origin.triggerId)
    return sel !== undefined && sel.runnerId !== 'pi'
  }

  start(ticket: Ticket, assignment: Assignment): void {
    const sel = this.getSelection(ticket.origin.triggerId)
    if (!sel) return
    const launch = (): void => {
      if (this.running.has(ticket.id)) return
      const abort = new AbortController()
      this.running.set(ticket.id, { abort })
      void this.runTicket(ticket, assignment, sel, abort).catch(err => {
        this.deps.onError?.(err)
        this.reportSafely(ticket.id, {
          state: 'failed',
          summary: `执行器 ${sel.runnerId} 运行异常：${err instanceof Error ? err.message : String(err)}`,
        })
      }).finally(() => {
        this.running.delete(ticket.id)
      })
    }
    if (this.deps.afterCommit) this.deps.afterCommit(launch)
    else setImmediate(launch)
  }

  deliver(ticket: Ticket, assignment: Assignment): void {
    const resume = (): void => {
      if (ticket.undelivered.length > 0) {
        try {
          this.deps.engine().inputsDelivered(ticket.id, assignment.id, [...ticket.undelivered])
          this.deps.engine().inputsRead(ticket.id, [...ticket.undelivered])
        } catch { /* ignore */ }
      }
      if (!this.running.has(ticket.id)) {
        this.start(ticket, assignment)
      }
    }
    if (this.deps.afterCommit) this.deps.afterCommit(resume)
    else setImmediate(resume)
  }

  stop(ticket: Ticket, _assignment: Assignment, _reason?: string): void {
    const active = this.running.get(ticket.id)
    if (active) {
      active.abort.abort()
      this.running.delete(ticket.id)
    }
  }

  close(): void {
    for (const [, active] of this.running) active.abort.abort()
    this.running.clear()
  }

  private async runTicket(
    ticket: Ticket,
    assignment: Assignment,
    sel: TicketRunnerSelection,
    abort: AbortController,
  ): Promise<void> {
    try {
      this.deps.engine().assignmentStarted(ticket.id, assignment.id)
      if (ticket.undelivered.length > 0) {
        this.deps.engine().inputsDelivered(ticket.id, assignment.id, [...ticket.undelivered])
        this.deps.engine().inputsRead(ticket.id, [...ticket.undelivered])
      }
    } catch {
      // 若工单已被提前停止或已完成则直接退出
      return
    }

    const ws = join(this.deps.workspaceRoot, ticket.id)
    const outDir = join(ws, 'output')
    mkdirSync(outDir, { recursive: true })

    if (this.deps.prepareProject) {
      const triggerIds = [
        ticket.origin.triggerId,
        ...ticket.inputs.flatMap(i => i.kind === 'trigger' ? [i.triggerId] : []),
      ]
      await this.deps.prepareProject(ticket.id, triggerIds).catch(() => undefined)
    }

    const prompt = this.deps.getTrigger?.(ticket.origin.triggerId)?.text ?? ticket.title
    this.deps.activity?.note(ticket.id, `多执行器分流：由 [${sel.runnerId}] 接管执行`)

    const adapter = this.deps.runners.get(sel.runnerId)
    if (!adapter || !adapter.runOnce) {
      this.reportSafely(ticket.id, { state: 'failed', summary: `找不到支持一次性运行的执行器：${sel.runnerId}` })
      return
    }

    const recoveryId = `exec_${ticket.id}_${assignment.id}`
    const result = await adapter.runOnce({
      id: assignment.id,
      cwd: ws,
      prompt,
      ...(sel.scriptId ? { scriptId: sel.scriptId } : {}),
      ...(sel.scriptParams ? { scriptParams: sel.scriptParams } : {}),
      artifactsDir: outDir,
      signal: abort.signal,
      recoveryId,
    })

    if (result.costUsd > 0) {
      try {
        this.deps.ledger.record({
          at: new Date().toISOString(),
          ticketId: ticket.id,
          agent: `runner:${sel.runnerId}`,
          provider: sel.runnerId,
          model: sel.scriptId || sel.runnerId,
          status: result.ok ? 200 : 500,
          promptHit: 0,
          promptMiss: 0,
          completion: 0,
          costUsd: result.costUsd,
          latencyMs: result.durationMs,
        })
      } catch { /* best effort */ }
    }

    this.deps.goals?.()?.recordEvidence(ticket.id, {
      kind: adapter.kind === 'script' ? 'data' : 'command',
      runId: recoveryId,
      artifactVersion: result.artifacts[0] || `runner:${sel.runnerId}`,
      passed: result.ok,
      summary: `[${sel.runnerId}${sel.scriptId ? `:${sel.scriptId}` : ''}] ${(result.stdout || result.stderr || (result.ok ? '执行通过' : '执行失败')).slice(0, 320)}`,
    })

    if (result.cancelled) {
      this.reportSafely(ticket.id, { state: 'dropped', summary: `执行器 ${sel.runnerId} 已被中止取消。` })
      return
    }

    const summaryText = [
      `[${sel.runnerId}${sel.scriptId ? `:${sel.scriptId}` : ''}] ${result.ok ? '执行完成' : '执行失败'}（耗时 ${result.durationMs}ms，费用 $${result.costUsd.toFixed(4)}）`,
      result.stdout ? result.stdout.slice(0, 1200) : '',
      !result.ok && result.stderr ? `错误输出：${result.stderr.slice(0, 600)}` : '',
      result.artifacts.length > 0 ? `生成产物：${result.artifacts.join('、')}` : '',
    ].filter(Boolean).join('\n')

    await this.finishWithGoal(ticket.id, {
      state: result.ok ? 'ready' : 'failed',
      summary: summaryText,
    })
  }

  private async finishWithGoal(ticketId: string, report: WorkerReport): Promise<void> {
    const goals = this.deps.goals?.()
    if (!goals) {
      this.reportSafely(ticketId, report)
      return
    }
    const decision = await goals.gate(ticketId, report)
    if (decision.action === 'pass') {
      this.reportSafely(ticketId, report)
    } else if (decision.action === 'replace') {
      this.reportSafely(ticketId, decision.report)
    }
  }

  private reportSafely(ticketId: string, report: WorkerReport): void {
    try {
      this.deps.engine().report(ticketId, report)
    } catch {
      // 工单可能已结束或被人工停止
    }
  }
}
