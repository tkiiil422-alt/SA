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
import type { Ledger } from '../ledger/ledger.ts'
import type { GoalService, GoalSpec } from '../goal/service.ts'
import type { ProjectService } from '../projects/service.ts'
import type { CouncilService } from '../council/service.ts'
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
import { MissionStore } from '../missions/store.ts'
import { MissionService, type TicketHandoffInfo } from '../missions/service.ts'
import { createMissionsPlugin } from '../missions/plugin.ts'
import { RemoteStore } from '../remote/store.ts'
import { RemoteNodeService } from '../remote/service.ts'
import { createRemoteNodesPlugin } from '../remote/plugin.ts'
import { SkillEvolutionService } from '../skills/evolution.ts'
import { PluginEvolutionService } from '../plugins/evolution.ts'
import { BenchmarkStore } from '../eval/benchmarks.ts'
import { createEvolutionPlugin } from '../eval/plugin.ts'

export interface WireCorePluginsOptions {
  db: DatabaseSync
  stateDir: string
  workspaceRoot: string
  plugins: PluginRegistry
  ledger: Ledger
  events: EventLog
  redact: (text: string) => string
  isPaused: () => boolean
  getAdminHost: () => AdminHost | undefined
  getDirector: () => DirectorService | undefined
  getProjects?: () => ProjectService | undefined
  getCouncils?: () => CouncilService | undefined
  getGoals?: () => Pick<GoalService, 'view' | 'set' | 'recordEvidence'> | undefined
  getGoalDefaults?: () => { maxRounds: number; maxUsd: number; maxHours: number }
  resolveGoalInput?: (raw: Record<string, unknown>) => GoalSpec | undefined
  getGatewayUrl?: () => string
  notifyTicket?: (ticketId: string, text: string) => void
  createTicketPr?: (ticketId: string, input: { repo: string; head: string; base?: string; title: string; body: string }) => Promise<{ ok: true; url: string; number: number } | { ok: false; message: string }>
  reconcileTicketByExecutionId?: (executionId: string) => TicketHandoffInfo | undefined
  getTicketHandoff?: (ticketId: string) => TicketHandoffInfo | undefined
  getTicketSummary: (ticketId: string) => {
    title: string
    outcome?: string
    acceptanceStatus?: 'met' | 'unmet' | 'not_checked'
    summary?: string
    projectId?: string
    artifacts?: string[]
    commitSha?: string
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
  readonly missions: MissionService
  readonly remoteNodes: RemoteNodeService
  readonly skillEvolution: SkillEvolutionService
  readonly pluginEvolution: PluginEvolutionService
  readonly benchmarks: BenchmarkStore
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
  const missionStore = new MissionStore(opts.db)
  const missions = new MissionService({
    store: missionStore,
    events: opts.events,
    dispatchTicket: async input => {
      const host = opts.getAdminHost()
      if (!host) throw new Error('控制台宿主尚未就绪')
      return host.createTicket(input.text, input.model, undefined, input.projectId, input.collab, input.goal, input.projectMode)
    },
    ...(opts.reconcileTicketByExecutionId ? { reconcileTicketByExecutionId: opts.reconcileTicketByExecutionId } : {}),
    ...(opts.getTicketHandoff ? { getTicketHandoff: opts.getTicketHandoff } : {}),
    startCouncil: async input => {
      const councils = opts.getCouncils?.()
      if (!councils) throw new Error('会商模块未启用')
      const created = councils.create({
        mode: 'brief',
        text: input.text,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.rounds ? { rounds: input.rounds } : {}),
      })
      return { id: created.id }
    },
    getCouncilStatus: councilId => {
      const rec = opts.getCouncils?.()?.get(councilId)
      if (!rec) return undefined
      return { status: rec.status, ...(rec.brief ? { brief: rec.brief } : {}) }
    },
    runDirectorNode: async input => {
      const director = opts.getDirector()
      if (!director) throw new Error('总控助手尚未就绪')
      const res = await director.chat({
        text: input.prompt,
        channel: 'web',
        userId: 'mission-orchestrator',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      })
      return { reply: res.reply }
    },
    ...(opts.resolveGoalInput ? { resolveGoalInput: opts.resolveGoalInput } : {}),
    onError: error => console.error(`superagentd: mission error: ${error instanceof Error ? error.message : String(error)}`),
  })
  const remoteStore = new RemoteStore(opts.db)
  const remoteNodes = new RemoteNodeService({
    store: remoteStore,
    ledger: opts.ledger,
    events: opts.events,
    stateDir: opts.stateDir,
    workspaceRoot: opts.workspaceRoot,
    ...(opts.getGatewayUrl ? { gatewayUrl: opts.getGatewayUrl } : {}),
  })
  const skillEvolution = new SkillEvolutionService(skills)
  const pluginEvolution = new PluginEvolutionService({
    db: opts.db,
    missions,
  })
  const benchmarks = new BenchmarkStore(opts.db)

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

  opts.plugins.register(createMissionsPlugin({
    missions,
    getTicketResult: ticketId => {
      const info = opts.getTicketSummary(ticketId)
      if (!info) return undefined
      return {
        outcome: info.outcome ?? 'closed',
        summary: info.summary ?? '',
        ...(info.artifacts ? { artifacts: info.artifacts } : {}),
        ...(info.commitSha ? { commitSha: info.commitSha } : {}),
      }
    },
    afterCommit: opts.afterCommit,
  }))

  opts.plugins.register(createRemoteNodesPlugin(remoteNodes))
  opts.plugins.register(createEvolutionPlugin({
    skills,
    skillEvolution,
    pluginEvolution,
    benchmarks,
  }))

  return { memories, skills, contracts, scheduler, runners, scriptRunner, missions, remoteNodes, skillEvolution, pluginEvolution, benchmarks }
}
