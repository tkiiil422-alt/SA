/**
 * SuperAgent 2.0 一等能力插件装配模块：
 * - 长期记忆与可进化技能库（`MemoryStore` + `SkillStore` + `memory-skills` 插件）
 * - 统一任务约定与版本修订（`ContractStore` + `contracts` 插件）
 * - 主动定时与巡检调度引擎（`SchedulerStore` + `SchedulerService` + `scheduler` 插件）
 */
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AdminHost } from '../admin/host.ts'
import type { DirectorService } from '../director/service.ts'
import type { EventLog } from '../ledger/events.ts'
import type { GoalService } from '../goal/service.ts'
import type { ProjectService } from '../projects/service.ts'
import type { PluginRegistry } from '../plugins/registry.ts'
import { MemoryStore } from '../memory/store.ts'
import { SkillStore } from '../skills/store.ts'
import { createMemoryAndSkillsPlugin } from '../memory/plugin.ts'
import { ContractStore } from '../contracts/store.ts'
import { createContractsPlugin } from '../contracts/plugin.ts'
import { SchedulerStore } from '../scheduler/store.ts'
import { SchedulerService } from '../scheduler/service.ts'
import { createSchedulerPlugin } from '../scheduler/plugin.ts'
import { PiRunnerDescriptor, RegisteredScriptRunner, RunnerRegistry } from '../executor/runner.ts'
import { ClaudeCodeRunner, OpenCodeRunner } from '../executor/adapters.ts'
import { createEngineeringFactoryPlugin } from '../verify/factory-plugin.ts'

export interface WireCorePluginsOptions {
  db: DatabaseSync
  stateDir: string
  workspaceRoot: string
  plugins: PluginRegistry
  events: EventLog
  redact: (text: string) => string
  isPaused: () => boolean
  getAdminHost: () => AdminHost | undefined
  getDirector: () => DirectorService | undefined
  getProjects?: () => ProjectService | undefined
  getGoals?: () => Pick<GoalService, 'view' | 'set' | 'recordEvidence'> | undefined
  getGoalDefaults?: () => { maxRounds: number; maxUsd: number; maxHours: number }
  notifyTicket?: (ticketId: string, text: string) => void
  createTicketPr?: (ticketId: string, input: { repo: string; head: string; base?: string; title: string; body: string }) => Promise<{ ok: true; url: string; number: number } | { ok: false; message: string }>
  getTicketSummary: (ticketId: string) => {
    title: string
    outcome?: string
    acceptanceStatus?: 'met' | 'unmet' | 'not_checked'
    summary?: string
    projectId?: string
  } | undefined
  afterCommit: (fn: () => void) => void
  notifyAlert?: (input: { title: string; text: string }) => Promise<void>
}

export interface CorePluginsBundle {
  readonly memories: MemoryStore
  readonly skills: SkillStore
  readonly contracts: ContractStore
  readonly scheduler: SchedulerService
  readonly runners: RunnerRegistry
  readonly scriptRunner: RegisteredScriptRunner
}

export function wireCorePlugins(opts: WireCorePluginsOptions): CorePluginsBundle {
  const memories = new MemoryStore(opts.db)
  const skills = new SkillStore(opts.db, join(opts.stateDir, 'skills'))
  const contracts = new ContractStore(opts.db)
  const schedulerStore = new SchedulerStore(opts.db)
  const scriptRunner = new RegisteredScriptRunner()
  const runners = new RunnerRegistry()
    .register(new PiRunnerDescriptor())
    .register(scriptRunner)
    .register(new ClaudeCodeRunner())
    .register(new OpenCodeRunner())

  const scheduler = new SchedulerService({
    store: schedulerStore,
    events: opts.events,
    isPaused: opts.isPaused,
    contracts,
    dispatchTicket: async input => {
      const host = opts.getAdminHost()
      if (!host) throw new Error('控制台宿主尚未就绪')
      return host.createTicket(input.text, input.model, undefined, input.projectId, input.collab, input.goal, input.projectMode)
    },
    runDirectorPrompt: async input => {
      const director = opts.getDirector()
      if (!director) throw new Error('总控助手尚未就绪')
      const res = await director.chat({
        text: input.prompt,
        channel: input.channel,
        userId: input.userId,
        deliverToWechat: input.deliverToWechat,
      })
      return { reply: res.reply, sessionId: res.sessionId }
    },
    ...(opts.notifyAlert ? { notifyAlert: opts.notifyAlert } : {}),
    onError: error => console.error(`superagentd: scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`),
  })

  opts.plugins.register(createMemoryAndSkillsPlugin({
    memories,
    skills,
    redact: opts.redact,
    getTicketSummary: opts.getTicketSummary,
    afterCommit: opts.afterCommit,
  }))

  opts.plugins.register(createContractsPlugin({
    contracts,
    memories,
    redact: opts.redact,
    ...(opts.getGoals ? { getGoals: opts.getGoals } : {}),
    ...(opts.getGoalDefaults ? { getGoalDefaults: opts.getGoalDefaults } : {}),
    ...(opts.notifyTicket ? { notifyTicket: opts.notifyTicket } : {}),
  }))

  opts.plugins.register(createSchedulerPlugin(scheduler, {
    getTicketSummary: opts.getTicketSummary,
    afterCommit: opts.afterCommit,
  }))

  opts.plugins.register(createEngineeringFactoryPlugin({
    runners,
    scriptRunner,
    workspaceRoot: opts.workspaceRoot,
    getProjects: () => opts.getProjects?.(),
    getGoals: () => opts.getGoals?.(),
    getAdminHost: opts.getAdminHost,
    ...(opts.createTicketPr ? { createTicketPr: opts.createTicketPr } : {}),
  }))

  return { memories, skills, contracts, scheduler, runners, scriptRunner }
}
