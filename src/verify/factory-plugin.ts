/**
 * 研发工厂子系统插件（Engineering Factory Plugin）。
 *
 * 通过 `SubsystemPlugin` 协议统一装配 V2.1 能力（停用后工具、路由与提示词同步退出）：
 * - Worker MCP 工具：`sa_browser_verify`（运行端到端浏览器/表单断言，记录截图/trace 并喂给 GoalService）
 * - HTTP API：`/api/runners`（列出可用执行器与已登记脚本）、`/api/runners/run`（运行注册脚本或 CLI 适配器）
 * - Director 工具：`ticket_diff`、`ticket_review`、`ticket_merge`、`browser_verify`、`runners_list`、`runner_script_run`
 */
import { join } from 'node:path'
import { z } from 'zod'
import type { SubsystemPlugin } from '../plugins/types.ts'
import type { ProjectService } from '../projects/service.ts'
import type { GoalService } from '../goal/service.ts'
import type { AdminHost } from '../admin/host.ts'
import type { RegisteredScriptRunner, RunnerRegistry } from '../executor/runner.ts'
import { runBrowserVerify } from './browser.ts'
import { issuesOf } from '../admin/http.ts'

export interface EngineeringFactoryPluginDeps {
  runners: RunnerRegistry
  scriptRunner: RegisteredScriptRunner
  workspaceRoot: string
  getProjects: () => ProjectService | undefined
  getGoals: () => Pick<GoalService, 'recordEvidence' | 'view'> | undefined
  getAdminHost: () => AdminHost | undefined
  createTicketPr?: (ticketId: string, input: { repo: string; head: string; base?: string; title: string; body: string }) => Promise<{ ok: true; url: string; number: number } | { ok: false; message: string }>
}

const BrowserStepSchema = z.object({
  action: z.enum(['goto', 'fill', 'click', 'submit', 'reload', 'wait', 'assertText', 'assertNotText', 'assertVisible', 'assertValue', 'assertStatus']),
  url: z.string().max(1000).optional(),
  selector: z.string().max(300).optional(),
  name: z.string().max(200).optional(),
  value: z.string().max(4000).optional(),
  text: z.string().max(1000).optional(),
  status: z.number().int().min(100).max(599).optional(),
  ms: z.number().int().min(10).max(10_000).optional(),
}).strict()

const RunnerRunSchema = z.object({
  runnerId: z.string().trim().min(1).max(60).default('script'),
  ticketId: z.string().trim().max(64).optional(),
  scriptId: z.string().trim().max(80).optional(),
  scriptParams: z.record(z.string(), z.unknown()).optional(),
  prompt: z.string().max(20_000).optional(),
  timeoutMs: z.number().int().min(500).max(600_000).optional(),
  criterionId: z.string().trim().max(40).optional(),
  recoveryId: z.string().trim().max(80).optional(),
}).strict()

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function createEngineeringFactoryPlugin(deps: EngineeringFactoryPluginDeps): SubsystemPlugin {
  return {
    id: 'engineering-factory',
    name: '研发工厂（并发分支审查 · 浏览器自检 · 多执行器）',
    description: '提供 Git Worktree Diff/批注/返工/合并、browser_verify 端到端断言与多执行器（Pi / 注册脚本 / Claude Code / OpenCode）',
    version: '2.1.0',
    routesPrefix: '/runners',

    handleRoute: async ctx => {
      const { req, res, method, route, sendJson, parseJsonBody, invalid } = ctx
      if (!route.startsWith('/runners')) return false

      if (route === '/runners' && method === 'GET') {
        sendJson(res, 200, {
          items: deps.runners.list(),
          scripts: deps.scriptRunner.listScripts(),
        })
        return true
      }

      if (route === '/runners/run' && method === 'POST') {
        const parsed = RunnerRunSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        const runner = deps.runners.get(parsed.data.runnerId)
        if (!runner) {
          sendJson(res, 404, { error: 'not_found', message: `找不到执行器 ${parsed.data.runnerId}` })
          return true
        }
        if (!runner.runOnce) {
          sendJson(res, 400, { error: 'unsupported', message: `执行器 ${runner.id} 仅支持常驻工单模式，不支持一次性调用` })
          return true
        }
        const cwd = parsed.data.ticketId
          ? join(deps.workspaceRoot, parsed.data.ticketId)
          : deps.workspaceRoot
        const result = await runner.runOnce({
          id: `run_${Date.now().toString(36)}`,
          cwd,
          ...(parsed.data.scriptId ? { scriptId: parsed.data.scriptId } : {}),
          ...(parsed.data.scriptParams ? { scriptParams: parsed.data.scriptParams } : {}),
          ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}),
          ...(parsed.data.timeoutMs ? { timeoutMs: parsed.data.timeoutMs } : {}),
          ...(parsed.data.recoveryId ? { recoveryId: parsed.data.recoveryId } : {}),
        })
        if (parsed.data.ticketId) {
          deps.getGoals()?.recordEvidence(parsed.data.ticketId, {
            kind: runner.kind === 'script' ? 'data' : 'command',
            ...(parsed.data.criterionId ? { criterionId: parsed.data.criterionId } : {}),
            runId: parsed.data.recoveryId || `runner_${Date.now().toString(36)}`,
            artifactVersion: result.artifacts[0] || 'working-tree',
            passed: result.ok,
            summary: `[${runner.id}${parsed.data.scriptId ? `:${parsed.data.scriptId}` : ''}] ${(result.stdout || result.stderr || (result.ok ? '成功' : '失败')).slice(0, 300)}`,
          })
        }
        sendJson(res, 200, { ok: result.ok, result })
        return true
      }

      return false
    },

    directorQueries: {
      runners_list: () => ({
        items: deps.runners.list(),
        scripts: deps.scriptRunner.listScripts(),
      }),
      ticket_diff: async args => {
        const ticketId = str(args.ticketId) || str(args.id)
        if (!ticketId) return { ok: false, error: '请提供 ticketId' }
        const projects = deps.getProjects()
        if (!projects) return { ok: false, error: '项目服务未启用' }
        const diff = await projects.ticketDiff(ticketId)
        return { ok: true, ...diff }
      },
    },

    directorActions: {
      ticket_review: async args => {
        const ticketId = str(args.ticketId) || str(args.id)
        const action = str(args.action) || 'comment'
        if (!ticketId) throw new Error('ticket_review 需要 ticketId')
        const projects = deps.getProjects()
        const host = deps.getAdminHost()
        if (!projects) throw new Error('项目服务未启用')

        if (action === 'approve') {
          const state = await projects.approveReview(ticketId, str(args.note))
          return { ok: true, state }
        }
        if (action === 'rework') {
          if (str(args.file) && str(args.comment)) {
            await projects.addReviewComment(ticketId, {
              file: str(args.file),
              line: Number(args.line) || 1,
              comment: str(args.comment),
            })
          }
          const rw = await projects.requestRework(ticketId, str(args.note))
          if (host) host.replyTicket(ticketId, rw.prompt)
          return { ok: true, ...rw }
        }
        const item = await projects.addReviewComment(ticketId, {
          file: str(args.file),
          line: Number(args.line) || 1,
          comment: str(args.comment),
        })
        return { ok: true, item }
      },

      ticket_merge: async args => {
        const ticketId = str(args.ticketId) || str(args.id)
        if (!ticketId) throw new Error('ticket_merge 需要 ticketId')
        const projects = deps.getProjects()
        const host = deps.getAdminHost()
        if (!projects) throw new Error('项目服务未启用')

        const mode = str(args.mode) === 'pr' ? 'pr' : 'merge'
        if (mode === 'pr') {
          if (!deps.createTicketPr) throw new Error('未配置 GitHub PR 创建能力')
          const committed = await projects.commitTicketBranch(ticketId, str(args.commitMessage) || undefined)
          if (!committed.ok) return committed
          const repo = str(args.repo)
          if (!repo) throw new Error('创建 PR 模式必须提供 repo（例如 owner/name）')
          return deps.createTicketPr(ticketId, {
            repo,
            head: committed.branch,
            ...(str(args.base) ? { base: str(args.base) } : {}),
            title: str(args.title) || `feat: ticket ${ticketId}`,
            body: str(args.body) || `来自工单 ${ticketId}（commit ${committed.headSha.slice(0, 10)}）`,
          })
        }
        const isOpen = (id: string): boolean => host?.ticket(id)?.status === 'open'
        return projects.mergeTicketWorktree(ticketId, isOpen, { force: Boolean(args.force) })
      },

      browser_verify: async args => {
        const url = str(args.url)
        if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('browser_verify 需要合法的 http/https url')
        const ticketId = str(args.ticketId) || undefined
        const outputDir = ticketId
          ? join(deps.workspaceRoot, ticketId, 'output', 'browser-verify')
          : join(deps.workspaceRoot, '_browser-verify')
        const steps = Array.isArray(args.steps)
          ? z.array(BrowserStepSchema).parse(args.steps)
          : []
        const res = await runBrowserVerify({
          url,
          steps,
          outputDir,
          ...(ticketId ? { ticketId } : {}),
          ...(str(args.criterionId) ? { criterionId: str(args.criterionId) } : {}),
          ...(str(args.artifactVersion) ? { artifactVersion: str(args.artifactVersion) } : {}),
          ...(deps.getGoals() ? { goals: deps.getGoals()! } : {}),
        })
        return { ok: res.ok, result: res }
      },

      runner_script_run: async args => {
        const scriptId = str(args.scriptId)
        if (!scriptId) throw new Error('runner_script_run 需要已登记的 scriptId')
        const ticketId = str(args.ticketId) || undefined
        const cwd = ticketId ? join(deps.workspaceRoot, ticketId) : deps.workspaceRoot
        const result = await deps.scriptRunner.runOnce({
          id: `scr_${Date.now().toString(36)}`,
          cwd,
          scriptId,
          scriptParams: (typeof args.scriptParams === 'object' && args.scriptParams !== null && !Array.isArray(args.scriptParams))
            ? args.scriptParams as Record<string, unknown>
            : {},
        })
        if (ticketId) {
          deps.getGoals()?.recordEvidence(ticketId, {
            kind: 'data',
            ...(str(args.criterionId) ? { criterionId: str(args.criterionId) } : {}),
            runId: `scr_${Date.now().toString(36)}`,
            artifactVersion: result.artifacts[0] || 'working-tree',
            passed: result.ok,
            summary: `[script:${scriptId}] ${(result.stdout || result.stderr).slice(0, 300)}`,
          })
        }
        return { ok: result.ok, result }
      },
    },

    directorPromptSection: () => [
      '## 研发工厂（Git 并发审查 · 浏览器自检 · 多执行器）',
      '- 查询动作（`platform_query`）：`ticket_diff({ticketId})`、`runners_list`',
      '- 管理动作（`subsystem_action`）：`ticket_review({ticketId,action:"comment"|"approve"|"rework",file?,line?,comment?,note?})`、`ticket_merge({ticketId,mode?:"merge"|"pr",repo?,base?,title?,body?,force?})`、`browser_verify({url,steps,ticketId?,criterionId?})`、`runner_script_run({scriptId,scriptParams,ticketId?,criterionId?})`',
      '- 对同一 Git 仓库并发派单时，优先使用 `projectMode: "worktree"`，每张工单在独立分支 `sa/<ticketId>` 工作，审查通过后再一键合并或建 PR。',
    ].join('\n'),

    registerWorkerMcpTools: (server, ctx) => {
      server.registerTool('sa_browser_verify', {
        description: 'Run an end-to-end browser verification scenario (goto, fill, click/submit, reload, assertText, assertVisible, assertValue, assertStatus). Records screenshots, console errors, failure trace, and feeds objective evidence straight into GoalService.',
        inputSchema: z.strictObject({
          url: z.string().url().describe('Target HTTP/HTTPS URL (e.g. preview URL or local server).'),
          steps: z.array(BrowserStepSchema).max(40).default([]),
          criterion_id: z.string().trim().max(40).optional().describe('Optional contract criterion ID this check verifies.'),
          artifact_version: z.string().trim().max(80).optional(),
        }),
      }, async args => {
        const res = await runBrowserVerify({
          url: args.url,
          steps: args.steps,
          outputDir: join(deps.workspaceRoot, ctx.ticketId, 'output', 'browser-verify'),
          ticketId: ctx.ticketId,
          ...(args.criterion_id ? { criterionId: args.criterion_id } : {}),
          ...(args.artifact_version ? { artifactVersion: args.artifact_version } : {}),
          ...(deps.getGoals() ? { goals: deps.getGoals()! } : {}),
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(res) }],
          ...(res.ok ? {} : { isError: true }),
        }
      })
    },
  }
}
