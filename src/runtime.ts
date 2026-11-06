/**
 * Composition root of superagentd.
 *
 * Startup order: state-directory lock, SQLite, effect queue, Engine (with the CLI Source, direct assessor, outbox and
 * the executor proxy), model gateway and worker MCP endpoint on ephemeral loopback ports, PiExecutor, interrupted
 * assignment recovery, the two-second pass, and finally the effect queue. `stop()` walks that order backwards.
 *
 * Each launch gets a random ticket token. The launcher writes a per-ticket Pi configuration directory whose models.json
 * points the built-in `deepseek` provider at the gateway and whose mcp.json points at the worker MCP endpoint; both
 * authenticate with the token. The gateway and MCP endpoint resolve tokens through the same table, so a token dies with
 * its assignment.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createBackup, listBackups } from './admin/backup.ts'
import { fileURLToPath } from 'node:url'
import { Engine, UserError, canRetry, key, latestReport, threadKey, ticketStage, waitsForPerson } from './core/index.ts'
import { Ledger } from './ledger/ledger.ts'
import { EventLog, describeDomainEvent } from './ledger/events.ts'
import { AdminAuth, createCliToken } from './admin/auth.ts'
import { OptionsStore, defaultOptions, findModel, formatRef, parseRef, type ModelRef } from './admin/options.ts'
import { Vault, VaultError } from './admin/vault.ts'
import { GithubClient } from './admin/github.ts'
import { TicketLinks } from './admin/links.ts'
import { PreviewStore, createPreviewProxy } from './admin/preview.ts'
import { ProjectService } from './projects/service.ts'
import { CouncilService } from './council/service.ts'
import { readProjectProfile } from './council/profile.ts'
import { createAdminApi } from './admin/api.ts'
import { createAdminServer, type AdminServer } from './admin/server.ts'
import { createStaticHandler } from './admin/static.ts'
import { createRuntimeAdminHost } from './admin/runtime-host.ts'
import type { DomainEvent, Executor } from './core/index.ts'
import type { Trigger } from './core/model.ts'
import { allowedSender, assessmentOutcome, settingsPolicy } from './policy.ts'
import { SqliteRepositories } from './store/sqlite.ts'
import { Effects } from './effects/effects.ts'
import { PiExecutor } from './executor/pi-executor.ts'
import { ActivityLog } from './executor/activity.ts'
import { createGateway, type Gateway } from './gateway/gateway.ts'
import { createWorkerMcpServer, type WorkerMcpServer } from './mcp/worker-server.ts'
import { CliSource } from './sources/cli.ts'
import { FEISHU_SOURCE, FeishuSource } from './sources/feishu.ts'
import { EmailSource, type EmailConfig, type EmailEvent } from './sources/email.ts'
import { continuationIntent, pickContinuation, FEISHU_CONTINUE_WINDOW_MS, type ContinuationCandidate } from './sources/feishu-continue.ts'
import { FeishuWs } from './sources/feishu-ws.ts'
import { CompositeScope } from './sources/composite.ts'
import { ModelAssessor, type AssessorConfig } from './assessor/model.ts'
import { callModel, type ModelTarget } from './assessor/model-call.ts'
import { discoverModels as discoverProviderModels } from './admin/model-discovery.ts'
import type { DiscoverInput, DiscoverResult } from './admin/host.ts'
import { ModelChoices } from './ledger/choices.ts'
import { costOf } from './gateway/pricing.ts'
import { buildPiModels, launchArgs, InvalidModelError } from './executor/pi-models.ts'
import { Outbox } from './outbox/outbox.ts'
import { createControlServer, type AskResult, type ControlServer, type Overview, type TicketSummary, type TicketView } from './control/server.ts'
import { loadSettings, saveSettings, type Config } from './config.ts'

interface TokenEntry {
  ticketId: string
  assignmentId: string
  role: string
}

/** Version reported to the console and written into the start event. */
export const VERSION = '0.1.0'

/**
 * Make a launcher script executable again.
 *
 * Copying a file (scp, unzip, an editor's "save as") rewrites it with the umask's mode, so the executable bit a deploy
 * script depends on silently disappears and the next spawn fails with EACCES. Repairing the mode is safe: the file is
 * the operator's own launcher. A bare command name (`pi`) is resolved through PATH and left alone.
 */
function ensureLauncherExecutable(command: string): 'ok' | 'fixed' | 'missing' | 'skipped' {
  if (!command.includes('/') && !command.includes('\\')) return 'skipped'
  try {
    const mode = statSync(command).mode
    if ((mode & 0o111) !== 0) return 'ok'
    chmodSync(command, mode | 0o755)
    return 'fixed'
  } catch {
    return 'missing'
  }
}

export interface Runtime {
  readonly config: Config
  readonly stateDir: string
  readonly engine: Engine
  readonly repo: SqliteRepositories
  readonly effects: Effects
  readonly executor: PiExecutor
  readonly outbox: Outbox
  readonly source: CliSource
  readonly gateway: Gateway
  readonly mcp: WorkerMcpServer
  readonly control: ControlServer
  readonly gatewayUrl: string
  readonly mcpUrl: string
  readonly controlUrl: string
  readonly adminUrl: string
  ask(text: string, opts?: { model?: string }): Promise<AskResult>
  /** The intake both Feishu transports use, exposed so tests exercise the same continuation path. */
  feishuIntake(trigger: Trigger): void
  ticket(id: string): TicketView | undefined
  tickets(): TicketSummary[]
  /** Stop in reverse startup order; `reason` (a signal name) is recorded in the event log. */
  stop(reason?: string): Promise<void>
}

const LOCK_FILE = 'superagentd.lock'
const CONTROL_FILE = 'control.json'
/** How stale the newest state backup may become before the hourly check writes another one. */
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const BACKUP_CHECK_MS = 60 * 60 * 1000

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Take the state-directory lock, clearing a lock whose process is gone. */
function acquireStateLock(stateDir: string): () => void {
  const file = join(stateDir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      } finally {
        closeSync(fd)
      }
      return () => { try { rmSync(file, { force: true }) } catch { /* already gone */ } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let pid: number | undefined
      try {
        const value = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
        if (typeof value.pid === 'number' && Number.isInteger(value.pid)) pid = value.pid
      } catch { /* unreadable lock: treat as stale */ }
      if (pid !== undefined && pid !== process.pid && alive(pid)) {
        throw new Error(`Another superagentd is already running for ${stateDir} (pid ${pid})`)
      }
      // Same pid means this process already holds the lock; two runtimes in one process still must not share a state dir.
      if (pid === process.pid) throw new Error(`Another superagentd is already running for ${stateDir} (pid ${pid})`)
      rmSync(file, { force: true })
    }
  }
  throw new Error(`Could not acquire the state directory lock: ${file}`)
}

export async function createRuntime(config: Config): Promise<Runtime> {
  const stateDir = resolve(config.stateDir)
  /** Where each ticket's workspace lives; the launcher mounts `<workspaceRoot>/<ticketId>` as `/workspace`. */
  const workspaceRoot = process.env.SA_WORKSPACE_ROOT ?? join(process.env.HOME ?? stateDir, 'superagent-workspaces')
  /**
   * The project library deliberately lives outside `state/`: daily state backups must never include multi-gigabyte
   * project trees.
   */
  const projectsRoot = process.env.SA_PROJECTS_ROOT ?? join(process.env.HOME ?? stateDir, 'superagent-projects')
  /** Email attachments are staged here by trigger id, then copied into the ticket's `inbox/` at launch. */
  const emailInbox = join(stateDir, 'inbox')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const releaseLock = acquireStateLock(stateDir)
  const cleanup: (() => unknown)[] = []

  try {
    const repo = new SqliteRepositories(join(stateDir, 'state.sqlite'))
    cleanup.push(() => { if (repo.db.isOpen) repo.close() })
    // Pull-request links are durable beside the tickets; deleting a ticket removes its rows in the repository.
    const links = new TicketLinks({ db: repo.db })
    /**
     * Copy staged email attachments for every trigger of this ticket into `<workspace>/inbox/`.
     * Staging is per message (`state/inbox/<triggerId>`), so follow-up mail lands in the same ticket directory.
     */
    const copyEmailAttachments = (ticketId: string, triggerIds: readonly string[]): void => {
      const inbox = join(workspaceRoot, ticketId, 'inbox')
      for (const triggerId of new Set(triggerIds)) {
        let entries
        try {
          entries = readdirSync(join(emailInbox, triggerId), { withFileTypes: true })
        } catch {
          continue
        }
        try {
          mkdirSync(inbox, { recursive: true, mode: 0o700 })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const target = join(inbox, entry.name)
          if (existsSync(target)) continue
          try {
            copyFileSync(join(emailInbox, triggerId, entry.name), target)
          } catch {
            // A single file that cannot be copied must not stop the launch.
          }
        }
      }
    }

    const effects = new Effects(repo.db, {
      pollMs: 50,
      onError: error => console.error(`superagentd: effect failed: ${error instanceof Error ? error.message : String(error)}`),
    })
    cleanup.push(() => effects.drain())

    // Policy settings are persisted canonically; a later start reads the same bytes back.
    const settingsPath = join(stateDir, 'settings.json')
    // `let`: the admin console replaces the policy at run time; `policy()` below reads the current value on every call.
    let settings = existsSync(settingsPath) ? loadSettings(settingsPath) : config.policy
    if (!existsSync(settingsPath)) saveSettings(settingsPath, settings)

    const ledger = new Ledger(repo.db)
    const events = new EventLog(repo.db)
    // The vault owns encrypted values, per-ticket grants and AI requests; events carry names only.
    const vault = new Vault(join(stateDir, 'vault.json'), {
      env: process.env,
      onEvent: event => {
        try {
          events.add(event)
        } catch {
          // A log failure must not undo a vault operation that already happened.
        }
      },
    })
    // options.json is the single source of run-time configuration; config.maxSlots and the environment only seed it.
    const defaults = defaultOptions(process.env)
    defaults.executor.maxWorkers = Math.min(8, Math.max(1, config.maxSlots))
    const seededKey = process.env[config.deepseekApiKeyEnv]
    if (seededKey) defaults.models.providers[0]!.apiKey = seededKey
    // Per-ticket model choices, keyed by trigger id; they share the runtime database.
    const choices = new ModelChoices(repo.db)
    /** Secrets requested with a new ticket, keyed by its trigger id until the first launch grants them. */
    const pendingSecrets = new Map<string, string[]>()
    const optionsStore = new OptionsStore(join(stateDir, 'options.json'), defaults)
    // Projects live on the runtime database; construction also recovers an interrupted extraction and stale uploads.
    const projects = new ProjectService({
      db: repo.db,
      root: projectsRoot,
      workspaceRoot,
      limits: () => optionsStore.get().projects,
    })
    cleanup.push(() => projects.close())
    const auth = new AdminAuth({ stateDir })
    const cliToken = createCliToken(stateDir)
    const cliTokenFile = join(stateDir, 'cli-token')
    cleanup.push(() => rmSync(cliTokenFile, { force: true }))
    const adminInit = auth.init()
    if (adminInit.generated) {
      console.log(`superagentd: admin console password (shown once, change it in the console): ${adminInit.plaintext}`)
    }
    // The log must never look empty after a restart: the first row is always this start, with what it started with.
    try {
      events.add({
        kind: 'system.start', level: 'info', text: '服务已启动',
        data: { version: VERSION, stateDir, adminPort: config.adminPort, maxSlots: config.maxSlots },
      })
    } catch (error) {
      console.error(`superagentd: event log failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // State backups: one at startup and then daily, checked hourly. The archive holds a consistent SQLite snapshot and
    // the small configuration files; a failure is logged and never stops the daemon from starting.
    const backupDir = process.env.SA_BACKUP_DIR ?? join(homedir(), 'superagent-backups')
    const runBackup = async (why: string): Promise<void> => {
      try {
        const item = await createBackup({ stateDir, backupDir, db: repo.db })
        try {
          events.add({
            kind: 'system.backup', level: 'info', text: `已备份状态：${item.name}`,
            data: { name: item.name, bytes: item.bytes, why },
          })
        } catch { /* the archive exists; the log line is best effort */ }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          events.add({ kind: 'system.backup', level: 'warn', text: `状态备份失败：${message}`, data: { why } })
        } catch { /* best effort */ }
        console.error(`superagentd: state backup failed: ${message}`)
      }
    }
    await runBackup('startup')

    // A launcher that lost its executable bit (any plain file copy does that) only fails once a ticket starts, as an
    // opaque EACCES from spawn. Repair it at startup and report what happened, so a redeploy never leaves it broken.
    const launcherRepair = ensureLauncherExecutable(config.launcher.command)
    if (launcherRepair === 'fixed' || launcherRepair === 'missing') {
      const text = launcherRepair === 'fixed'
        ? '启动脚本缺少可执行权限，已自动修复'
        : '启动脚本不存在，任务会无法启动'
      try {
        events.add({ kind: 'system.launcher', level: launcherRepair === 'fixed' ? 'warn' : 'error', text, data: { command: config.launcher.command } })
      } catch { /* the log is best effort */ }
      console.error(`superagentd: ${text}: ${config.launcher.command}`)
    }

    const source = new CliSource({ operatorId: config.operatorId })
    // Every outbound line is redacted on the way in, so a secret value never reaches a channel or the console.
    const outbox = new Outbox({ db: repo.db, effects, redact: text => vault.redactSecrets(text) })
    /** Feishu events go to the log best effort; the callback has already answered, so a log failure changes nothing. */
    const recordFeishu = (event: { kind: string; level: 'info' | 'warn' | 'error'; text: string; data?: Record<string, unknown> }): void => {
      try {
        events.add({ kind: event.kind, level: event.level, text: event.text, ...(event.data === undefined ? {} : { data: event.data }) })
      } catch { /* best effort */ }
    }
    /**
     * A private-chat message joins the newest ticket of the same chat within the window, unless it starts with a command
     * that asks for a new task. Only listed senders continue: an unlisted sender keeps its fresh thread and the Policy
     * decides it as before. Mutates the Trigger's thread and returns what it joined.
     */
    const continueFeishu = (trigger: Trigger): { ticketId: string; title: string } | undefined => {
      if (trigger.source !== FEISHU_SOURCE || trigger.meta.chatType !== 'p2p') return undefined
      const intent = continuationIntent(trigger.text)
      trigger.text = intent.text
      if (intent.kind === 'new' || !allowedSender(settings, trigger.actor)) return undefined
      const chatId = typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : trigger.channel?.address.chatId ?? ''
      if (chatId === '') return undefined
      const prefix = `${chatId}:`
      const candidates: ContinuationCandidate[] = []
      const titles = new Map<string, string>()
      for (const ticket of repo.tickets.list()) {
        const threads = new Set<string>()
        for (const channel of ticket.channels) {
          if (channel.source === FEISHU_SOURCE && channel.thread.startsWith(prefix)) threads.add(channel.thread)
        }
        for (const ref of repo.triggers.get(ticket.origin.triggerId)?.threads ?? []) {
          if (ref.source === FEISHU_SOURCE && ref.id.startsWith(prefix)) threads.add(ref.id)
        }
        for (const input of ticket.inputs) {
          if (input.kind !== 'trigger') continue
          for (const ref of repo.triggers.get(input.triggerId)?.threads ?? []) {
            if (ref.source === FEISHU_SOURCE && ref.id.startsWith(prefix)) threads.add(ref.id)
          }
        }
        let threadId: string | undefined
        let threadAt = ''
        for (const id of threads) {
          const thread = repo.threads.get(threadKey({ source: FEISHU_SOURCE, id }))
          // Only a thread the ticket is still subscribed to can hand it the message.
          if (!thread?.subscriptions.includes(ticket.id)) continue
          const at = thread.lastAt ?? ''
          if (threadId === undefined || at > threadAt) {
            threadId = id
            threadAt = at
          }
        }
        if (threadId === undefined) continue
        candidates.push({
          ticketId: ticket.id,
          threadId,
          lastActivityAt: ticket.updatedAt > threadAt ? ticket.updatedAt : threadAt,
          endedByHuman: ticket.ended?.by === 'human',
        })
        titles.set(ticket.id, ticket.title)
      }
      const picked = pickContinuation({
        chatId, chatType: 'p2p', now: new Date(), windowMs: FEISHU_CONTINUE_WINDOW_MS, candidates,
      })
      if (!picked) return undefined
      trigger.threads = [{ source: FEISHU_SOURCE, id: picked.threadId }]
      // Replies still go under the new message, which is what the person sees; only the thread (and so the ticket) changes.
      if (trigger.channel) trigger.channel.thread = picked.threadId
      return { ticketId: picked.ticketId, title: titles.get(picked.ticketId) ?? '' }
    }
    /** The intake both Feishu transports share: store the Trigger, then let the engine and the effect queue run. */
    const feishuIntake = (trigger: Trigger): void => {
      let continued: { ticketId: string; title: string } | undefined
      try {
        continued = continueFeishu(trigger)
        const receive = engine.receive(trigger)
        if (receive === 'stored') {
          engine.evaluateDue()
          effects.kick()
        } else {
          continued = undefined
        }
      } catch (error) {
        console.error(`superagentd: feishu intake failed: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      recordFeishu({
        kind: 'feishu.received',
        level: 'info',
        text: '收到飞书消息',
        data: { chatType: trigger.meta.chatType, threadId: trigger.threads[0]?.id, triggerId: trigger.id },
      })
      if (!continued) return
      const title = Array.from(continued.title).slice(0, 20).join('')
      recordFeishu({
        kind: 'feishu.continued',
        level: 'info',
        text: `并入任务「${title}」`,
        data: { ticketId: continued.ticketId },
      })
      // A stopped or non-resumable ticket kept its state; do not tell the person the message merged then.
      const ticket = repo.tickets.get(continued.ticketId)
      if (!ticket || ticket.ended || !trigger.channel) return
      outbox.send({
        id: key('feishu-continued', trigger.id),
        channel: trigger.channel,
        text: `已并入任务「${title}」。要另开新任务，请以「新任务：」开头。`,
        kind: 'notice',
      })
    }
    const feishu = new FeishuSource({
      config: () => optionsStore.get().feishu,
      onTrigger: feishuIntake,
      onEvent: event => recordFeishu(event),
    })
    // The long connection is the alternative transport for apps whose event subscription is not an HTTP callback.
    const feishuWs = new FeishuWs({
      config: () => {
        const cfg = optionsStore.get().feishu
        return {
          appId: cfg.appId,
          appSecret: cfg.appSecret,
          verificationToken: cfg.verificationToken,
          encryptKey: cfg.encryptKey,
          groupMode: cfg.groupMode,
        }
      },
      botOpenId: () => feishu.botOpenId(),
      onTrigger: feishuIntake,
      onEvent: event => recordFeishu(event),
      onError: error => console.error(`superagentd: feishu ws: ${error.message}`),
    })
    /** Email events go to the log best effort; text and data never carry a body or the app password. */
    const recordEmail = (event: EmailEvent): void => {
      try {
        events.add({ kind: event.kind, level: event.level, text: event.text, ...(event.data === undefined ? {} : { data: event.data }) })
      } catch { /* best effort */ }
    }
    /** Gmail's intake mirrors Feishu's: store the Trigger, then let the engine and the effect queue run. */
    const emailIntake = (trigger: Trigger): void => {
      try {
        const receive = engine.receive(trigger)
        if (receive === 'stored') {
          engine.evaluateDue()
          effects.kick()
        }
      } catch (error) {
        console.error(`superagentd: email intake failed: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      recordEmail({
        kind: 'email.received',
        level: 'info',
        text: '收到邮件',
        data: { triggerId: trigger.id, threadId: trigger.threads[0]?.id },
      })
    }
    /** The email options plus the vault password; read on every poll and delivery. */
    const emailConfig = (): EmailConfig => {
      const cfg = optionsStore.get().email
      let password = ''
      try {
        if (vault.has('GMAIL_APP_PASSWORD')) password = vault.reveal('GMAIL_APP_PASSWORD')
      } catch {
        // An undecryptable password is treated as missing; the connection test reports the failure.
      }
      return { ...cfg, password }
    }
    const email = new EmailSource({
      config: emailConfig,
      onTrigger: emailIntake,
      onEvent: recordEmail,
      attachmentRoot: emailInbox,
    })
    const composite = new CompositeScope([source, feishu, email])
    outbox.registerChannel('feishu', message => feishu.deliver(message))
    outbox.registerChannel('email', message => email.deliver(message))
    const tokens = new Map<string, TokenEntry>()
    const invalidateTicket = (ticketId: string): void => {
      for (const [token, entry] of tokens) if (entry.ticketId === ticketId) tokens.delete(token)
    }
    const invalidateAssignment = (assignmentId: string): void => {
      for (const [token, entry] of tokens) if (entry.assignmentId === assignmentId) tokens.delete(token)
    }
    const pruneTokens = (): void => {
      for (const [token, entry] of tokens) {
        const ticket = repo.tickets.get(entry.ticketId)
        const assignment = ticket?.assignments.find(item => item.id === entry.assignmentId)
        if (!ticket || ticket.ended || !assignment || assignment.state === 'ended') tokens.delete(token)
      }
    }

    let engine!: Engine
    let executor!: PiExecutor
    // Preview links and their host ports live beside the tickets; `isRunning` reads the executor once it exists.
    const previews = new PreviewStore({
      db: repo.db,
      options: () => optionsStore.get().preview,
      isRunning: ticketId => executor?.isRunning(ticketId) ?? false,
    })
    // The Engine needs an Executor at construction; the real PiExecutor is built after the gateway and MCP ports exist.
    // Nothing calls these methods before `effects.start()`, which is the last startup step.
    const executorPort: Executor = {
      start: (ticket, assignment) => executor.start(ticket, assignment),
      deliver: (ticket, assignment) => executor.deliver(ticket, assignment),
      stop: (ticket, assignment, reason) => executor.stop(ticket, assignment, reason),
    }
    /** The price of a model at a provider, read live from the console's options. */
    const priceOf = (providerId: string, modelId: string) =>
      findModel(optionsStore.get().models, { provider: providerId, model: modelId })?.model.price

    /** The analysis configuration, read on every decision so a console change applies at once. */
    const assessorConfig = (): AssessorConfig => {
      const models = optionsStore.get().models
      const { assessor: routed, autoSelect } = models.routing
      const provider = models.providers.find(p => p.id === routed.provider)
      return {
        enabled: routed.enabled,
        autoSelect,
        timeoutSec: routed.timeoutSec,
        ...(provider && provider.enabled
          ? {
            target: {
              api: provider.api,
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              ...(provider.sessionHeader ? { sessionHeader: provider.sessionHeader } : {}),
            },
          }
          : {}),
        model: routed.model,
        provider: routed.provider,
        candidates: models.providers.filter(p => p.enabled).flatMap(p => p.models.filter(m => m.autoPick).map(m => ({
          ref: formatRef({ provider: p.id, model: m.id }),
          label: m.label || m.id,
          description: m.description,
        }))),
      }
    }

    /** The model a ticket runs on: the person's or auto choice while it is still valid, else the default worker model. */
    const resolveTicketModel = (ticket: { origin: { triggerId: string } }): {
      ref: ModelRef
      label: string
      providerName: string
      source: 'person' | 'auto' | 'default'
      reason?: string
    } => {
      const models = optionsStore.get().models
      const choice = choices.get(ticket.origin.triggerId)
      if (choice) {
        const ref = { provider: choice.provider, model: choice.model }
        const found = findModel(models, ref, { enabledOnly: true })
        if (found) {
          return {
            ref,
            label: found.model.label || found.model.id,
            providerName: found.provider.name,
            source: choice.source,
            ...(choice.reason ? { reason: choice.reason } : {}),
          }
        }
      }
      const ref = { ...models.routing.worker }
      const found = findModel(models, ref, { enabledOnly: true })
      return {
        ref,
        label: found ? (found.model.label || found.model.id) : ref.model,
        providerName: found?.provider.name ?? ref.provider,
        source: 'default',
      }
    }

    const assessor = new ModelAssessor({
      engine: () => engine,
      config: assessorConfig,
      choices,
      // Non-explicit messages (e.g. unaddressed Feishu group chat) are judged against the enabled admission rules; the
      // policy's own `assessmentOutcome` enforces rule coverage, settled direction and observe mode.
      rules: () => ({
        rules: settings.policy.rules.filter(rule => rule.enabled).map(({ id, name, instruction }) => ({ id, name, instruction })),
        mode: settings.eval.mode,
      }),
      assess: (assessment, strength) => assessmentOutcome(assessment, settings, strength),
      record: entry => {
        try {
          const price = priceOf(entry.provider, entry.model)
          ledger.record({
            at: new Date().toISOString(),
            ticketId: '',
            provider: entry.provider,
            model: entry.model,
            status: entry.status,
            promptHit: entry.usage?.prompt_cache_hit_tokens ?? 0,
            promptMiss: entry.usage?.prompt_cache_miss_tokens ?? 0,
            completion: entry.usage?.completion_tokens ?? 0,
            costUsd: entry.usage && price ? costOf(price, entry.usage) : 0,
            latencyMs: entry.latencyMs,
          })
        } catch (error) {
          console.error(`superagentd: ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      event: input => {
        try {
          events.add({ kind: input.kind, level: input.level, text: input.text, ...(input.data === undefined ? {} : { data: input.data }) })
        } catch { /* the decision itself already happened; the log line is best effort */ }
      },
      onError: error => console.error(`superagentd: assessment failed: ${error instanceof Error ? error.message : String(error)}`),
    })
    const policy = () => settingsPolicy(settings, composite)
    const emit = (event: DomainEvent): void => {
      const described = describeDomainEvent(event)
      if (described) {
        try { events.add(described) } catch (error) {
          console.error(`superagentd: event log failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (event.type === 'ticket.ended') {
        invalidateTicket(event.data.ticketId)
        // The container is gone; its links answer 503 until a relaunch reuses the same ports.
        previews.release(event.data.ticketId)
        // M1 has no main Session to relay results: when a ticket ends, queue its last report to the ticket's channel.
        repo.afterCommit(() => {
          const ticket = repo.tickets.get(event.data.ticketId)
          if (!ticket?.ended) return
          const summary = latestReport(ticket)?.summary ?? ticket.ended.reason ?? ticket.ended.outcome
          try {
            engine.reply({ purpose: 'result', ticketId: ticket.id, text: summary })
          } catch { /* a stopped ticket has no deliverable result */ }
        })
      } else if (event.type === 'assignment.ended') {
        invalidateAssignment(event.data.assignmentId)
      }
    }
    engine = new Engine({ repo, scope: composite, policy, assessor, executor: executorPort, outbox, emit })

    // OpenCode Go routes a request to a backend by this header and rejects calls without it. The ticket id is stable for
    // one conversation, so every turn of a ticket lands on the same backend and keeps its prompt cache.
    // Upstream address, key, model and session header all come from options.json, so the console changes them live.
    const budgetNotified = new Set<string>()
    const checkBudget = (ticketId: string): boolean => {
      const budget = optionsStore.get().budget
      if (!budget.enabled) return true
      const spent = ledger.ticketTotals(ticketId).usd
      const today = ledger.dayUsd()
      const ticketOver = budget.perTicketUsd > 0 && spent >= budget.perTicketUsd
      const dayOver = budget.dailyUsd > 0 && today >= budget.dailyUsd
      if (!ticketOver && !dayOver) return true
      if (!budgetNotified.has(ticketId)) {
        budgetNotified.add(ticketId)
        const why = ticketOver
          ? `这张票已花 $${spent.toFixed(4)}，达到单票上限 $${budget.perTicketUsd}`
          : `今天已花 $${today.toFixed(4)}，达到每日上限 $${budget.dailyUsd}`
        try { events.add({ kind: 'budget.blocked', level: 'warn', ticketId, text: why }) } catch { /* best effort */ }
        // Tell the person through the ticket itself; a ticket that cannot take a report just stays blocked at the gateway.
        try {
          engine.report(ticketId, { state: 'blocked', summary: `已达到预算上限：${why}`, question: `${why}。要提高上限后重试吗？在后台“预算”页调高后点“重试”即可。` })
        } catch { /* the ticket may have ended */ }
      }
      return false
    }
    const gateway = createGateway({
      resolveProvider: id => {
        const provider = optionsStore.get().models.providers.find(p => p.id === id)
        if (!provider || !provider.enabled) return undefined
        return { api: provider.api, baseUrl: provider.baseUrl, apiKey: provider.apiKey, models: provider.models.map(m => m.id) }
      },
      upstreamHeaders: (auth: { ticketId: string }, providerId: string) => {
        const provider = optionsStore.get().models.providers.find(p => p.id === providerId)
        return provider?.sessionHeader ? { [provider.sessionHeader]: auth.ticketId } : {}
      },
      price: (providerId, model) => priceOf(providerId, model),
      authorize: token => {
        const entry = tokens.get(token)
        if (!entry) return { denied: 'unknown' }
        if (!checkBudget(entry.ticketId)) return { denied: 'budget' }
        return { ticketId: entry.ticketId, role: entry.role }
      },
      record: entry => {
        const usage = entry.usage
        try {
          ledger.record({
            at: entry.at, ticketId: entry.ticketId, provider: entry.provider, model: entry.model || '(none)', status: entry.status,
            promptHit: usage?.prompt_cache_hit_tokens ?? 0, promptMiss: usage?.prompt_cache_miss_tokens ?? 0,
            completion: usage?.completion_tokens ?? 0, costUsd: entry.costUsd, latencyMs: entry.latencyMs,
          })
        } catch (error) {
          console.error(`superagentd: ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        const detail = usage
          ? `hit=${usage.prompt_cache_hit_tokens} miss=${usage.prompt_cache_miss_tokens} out=${usage.completion_tokens}`
          : 'usage=unknown'
        console.log(`superagentd: upstream ${entry.status} ${entry.model || '(no model)'} ${detail} $${entry.costUsd.toFixed(6)} ${entry.latencyMs}ms ticket=${entry.ticketId}`)
      },
    })
    cleanup.push(() => gateway.close())
    const gatewayPort = (await gateway.listen()).port
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`

    const mcp = createWorkerMcpServer({
      engine,
      authorize: token => {
        const entry = tokens.get(token)
        return entry ? { ticketId: entry.ticketId } : undefined
      },
      // A report is redacted before the Engine stores it, so the value never reaches the ticket detail or a channel.
      redact: text => vault.redactSecrets(text),
      secretStore: (ticketId, input) => {
        try {
          vault.create(input.name, input.value, input.description ?? '', 'ai')
          vault.grant(ticketId, input.name)
          return { ok: true, name: input.name }
        } catch (error) {
          if (error instanceof VaultError) return { ok: false, message: error.message }
          throw error
        }
      },
      secretRequest: (ticketId, input) => {
        try {
          vault.addRequest({ ticketId, name: input.name, why: input.why })
          return { ok: true }
        } catch (error) {
          if (error instanceof VaultError) return { ok: false, message: error.message }
          throw error
        }
      },
      preview: (ticketId, input) => {
        const ticket = repo.tickets.get(ticketId)
        if (!ticket) return { ok: false, message: '找不到这张任务票。' }
        const title = input.title ?? ticket.title
        const result = previews.register(ticketId, input.port, title)
        if (!result.ok) return result
        try {
          events.add({
            kind: 'preview.registered', level: 'info', ticketId, text: `发布预览「${title}」`,
            data: { ticketId, port: input.port },
          })
        } catch { /* the registration exists; the log line is best effort */ }
        // Tell the ticket's conversation where the preview is. The id is stable per ticket and port, so a repeated
        // registration does not send the same link twice.
        const origin = repo.triggers.get(ticket.origin.triggerId)
        const channel = origin?.channel ?? ticket.channels[0]
        if (channel) {
          try {
            outbox.send({
              id: key('preview', ticketId, String(input.port)), channel,
              text: `预览链接：${result.url}`, kind: 'notice', ticketId,
            })
          } catch { /* the link is in the tool result; a channel failure must not undo the registration */ }
        }
        return { ok: true, url: result.url, path: result.path }
      },
      githubPr: async (ticketId, input) => {
        const ticket = repo.tickets.get(ticketId)
        if (!ticket) return { ok: false, message: '找不到这张任务票。' }
        const cfg = optionsStore.get().github
        if (!cfg.enabled) return { ok: false, message: 'GitHub 未启用，请先在后台打开。' }
        if (!vault.has('GITHUB_TOKEN')) return { ok: false, message: '还没有配置 GitHub 令牌。' }
        let token = ''
        try {
          token = vault.reveal('GITHUB_TOKEN')
        } catch {
          return { ok: false, message: '无法读取 GitHub 令牌，请重新填写。' }
        }
        const client = new GithubClient({ apiBase: cfg.apiBase, token, repos: cfg.repos })
        const result = await client.createPullRequest({
          repo: input.repo,
          head: input.head,
          base: input.base ?? cfg.defaultBase,
          title: input.title,
          body: input.body,
        })
        if (!result.ok) return result
        links.add(ticketId, { kind: 'pr', url: result.url, title: input.title })
        try {
          events.add({
            kind: 'github.pr', level: 'info', ticketId,
            text: `已创建 PR：${result.url}`, data: { ticketId, number: result.number },
          })
        } catch { /* the link is stored; the log line is best effort */ }
        // Tell the ticket's conversation where the PR is, the same way the preview tool does.
        const origin = repo.triggers.get(ticket.origin.triggerId)
        const channel = origin?.channel ?? ticket.channels[0]
        if (channel) {
          try {
            outbox.send({
              id: key('github-pr', ticketId, result.url), channel,
              text: `PR：${result.url}`, kind: 'notice', ticketId,
            })
          } catch { /* the link is in the tool result; a channel failure must not undo the PR */ }
        }
        return result
      },
      onError: error => console.error(`superagentd: MCP tool failed: ${error instanceof Error ? error.message : String(error)}`),
    })
    cleanup.push(() => mcp.close())
    const mcpPort = (await mcp.listen()).port
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`

    // Each worker's recent steps (tool calls, output tails, what it says), kept in memory for the task detail page.
    const activity = new ActivityLog()
    executor = new PiExecutor({
      effects,
      engine: () => engine,
      launcher: async (ticket, assignment, context) => {
        // A redeploy between launches can drop the mode again; fixing it here costs one stat per launch.
        ensureLauncherExecutable(config.launcher.command)
        invalidateAssignment(assignment.id)
        const token = randomBytes(32).toString('base64url')
        tokens.set(token, { ticketId: ticket.id, assignmentId: assignment.id, role: 'worker' })
        const directory = join(stateDir, 'pi-config', ticket.id)
        mkdirSync(directory, { recursive: true })
        // One Pi provider per enabled superagent provider, keyed `sa-<id>`; the apiKey is the ticket token, never a real key.
        const models = {
          $schema: 'https://pi.dev/schemas/models.schema.json',
          providers: buildPiModels(optionsStore.get().models.providers, gatewayUrl),
        }
        const mcpConfig = {
          mcpServers: {
            superagent: { url: mcpUrl, headers: { Authorization: 'Bearer ${SA_TICKET_TOKEN}' }, exposure: 'direct' },
          },
        }
        writeFileSync(join(directory, 'models.json'), `${JSON.stringify(models, null, 2)}\n`)
        writeFileSync(join(directory, 'mcp.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`)
        // Pi writes its session under PI_CODING_AGENT_DIR (mounted per ticket), so `--continue` picks the same
        // conversation up again after the worker exited when idle.
        const picked = resolveTicketModel(ticket)
        // Secrets requested when the ticket was created are granted here, before the environment is built.
        const pending = pendingSecrets.get(ticket.origin.triggerId)
        if (pending) {
          pendingSecrets.delete(ticket.origin.triggerId)
          try {
            vault.setGrants(ticket.id, [...new Set([...vault.grants(ticket.id), ...pending.filter(name => vault.has(name))])])
          } catch (error) {
            console.error(`superagentd: secret grant failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        // Enabling GitHub grants its token to every new launch; the container's git helper reads `GITHUB_TOKEN`.
        if (optionsStore.get().github.enabled && vault.has('GITHUB_TOKEN')) {
          try {
            vault.grant(ticket.id, 'GITHUB_TOKEN')
          } catch (error) {
            console.error(`superagentd: github grant failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        // Email attachments staged under state/inbox/<triggerId> reach the worker as <workspace>/inbox/.
        copyEmailAttachments(ticket.id, [ticket.origin.triggerId, ...ticket.inputs.flatMap(item => item.kind === 'trigger' ? [item.triggerId] : [])])
        // A project ticket gets `AGENTS.md` and (once) a copy of `tree/` as `<workspace>/project/` before the container
        // starts. The copy can take a minute on a 2 GB tree; the ticket view shows `project.preparing` meanwhile.
        await projects.prepareWorkspace(ticket.id, [
          ticket.origin.triggerId,
          ...ticket.inputs.flatMap(item => item.kind === 'trigger' ? [item.triggerId] : []),
        ])
        // Granted secrets ride in the launch environment only: not in the workspace, Pi config, logs or events.
        const secretEnv = vault.launchEnv(ticket.id)
        const usedAt = new Date().toISOString()
        for (const name of secretEnv.names) vault.markUsed(name, usedAt, ticket.id)
        // Preview ports are allocated before the container starts; pasta forwards them from the host's loopback.
        const previewOptions = optionsStore.get().preview
        const previewPorts = previewOptions.enabled ? await previews.allocate(ticket.id) : []
        return {
          command: config.launcher.command,
          args: launchArgs(config.launcher.args, picked.ref, context.resume),
          env: {
            ...config.launcher.env,
            ...secretEnv.env,
            SA_TICKET_TOKEN: token,
            SA_MCP_URL: mcpUrl,
            SA_GATEWAY_URL: gatewayUrl,
            PI_CODING_AGENT_DIR: directory,
            ...(previewOptions.enabled ? { SA_PREVIEW_PORTS: previewPorts.join(',') } : {}),
          },
        }
      },
      maxSlots: optionsStore.get().executor.maxWorkers,
      graceMs: 500,
      atomic: work => repo.atomic(work),
      afterCommit: fn => repo.afterCommit(fn),
      tickets: repo.tickets,
      triggers: repo.triggers,
      activity,
    })
    cleanup.push(() => executor.close())
    // The worker limit follows the console at once; running workers are not interrupted.
    const offOptions = optionsStore.onChange((section, next) => {
      if (section === 'executor') executor.setMaxSlots(next.executor.maxWorkers)
    })
    cleanup.push(offOptions)

    executor.resume()
    engine.evaluateDue()

    const passTimer = setInterval(() => {
      try {
        effects.kick()
        engine.evaluateDue()
        pruneTokens()
      } catch (error) {
        console.error(`superagentd: pass failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 2_000)
    passTimer.unref()
    cleanup.push(() => clearInterval(passTimer))

    const backupTimer = setInterval(() => {
      const newest = listBackups(backupDir)[0]
      if (newest === undefined || Date.now() - Date.parse(newest.at) >= BACKUP_INTERVAL_MS) void runBackup('daily')
    }, BACKUP_CHECK_MS)
    backupTimer.unref()
    cleanup.push(() => clearInterval(backupTimer))

    effects.start()

    // The Feishu long connection follows the console live; the HTTP callback route stays served regardless of mode.
    // A settings save restarts a running connection so changed credentials apply; a first start is not a restart.
    const syncFeishuWs = (restart = false): void => {
      const cfg = optionsStore.get().feishu
      if (!cfg.enabled || cfg.mode !== 'ws') {
        feishuWs.stop()
        return
      }
      if (restart) void feishuWs.restart()
      else void feishuWs.start()
    }
    const offFeishu = optionsStore.onChange(section => {
      if (section === 'feishu') syncFeishuWs(true)
    })
    cleanup.push(offFeishu)
    cleanup.push(() => feishuWs.stop())
    syncFeishuWs()

    // The Gmail poll loop follows the console live: a save restarts it so changed credentials, interval or whitelist apply.
    const syncEmail = (restart = false): void => {
      if (!optionsStore.get().email.enabled) {
        email.stop()
        return
      }
      if (restart) void email.restart()
      else email.start()
    }
    const offEmail = optionsStore.onChange(section => {
      if (section === 'email') syncEmail(true)
    })
    cleanup.push(offEmail)
    cleanup.push(() => email.stop())
    syncEmail()

    const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
    const ask = async (text: string, opts: { model?: string; secrets?: string[]; projectId?: string } = {}): Promise<AskResult> => {
      let personRef: ModelRef | undefined
      if (opts.model !== undefined) {
        const parsedRef = parseRef(opts.model)
        if (!parsedRef || !findModel(optionsStore.get().models, parsedRef, { enabledOnly: true })) throw new InvalidModelError()
        personRef = parsedRef
      }
      const trigger = source.ask(text)
      // A person's choice is written before the message is received, so the assessor never overrides it.
      if (personRef) choices.set(trigger.id, { ...personRef, source: 'person' })
      // Secrets chosen at creation must be in place before the first launch, which can run before `ask` returns.
      if (opts.secrets && opts.secrets.length > 0) pendingSecrets.set(trigger.id, [...new Set(opts.secrets)])
      // The project is keyed by trigger id for the same reason: the launch can happen before the ticket id is known.
      if (opts.projectId !== undefined) projects.setPending(trigger.id, opts.projectId)
      const receive = engine.receive(trigger)
      if (receive === 'stored') {
        engine.evaluateDue()
        effects.kick()
      }
      // Wait for the decision (an analysis call may take up to its timeout), then answer with whatever exists by then.
      const deadline = Date.now() + (optionsStore.get().models.routing.assessor.timeoutSec + 5) * 1000
      let decisionId = repo.triggers.disposition(trigger.id)?.decisionId
      while (decisionId === undefined && Date.now() < deadline) {
        await sleep(100)
        engine.evaluateDue()
        decisionId = repo.triggers.disposition(trigger.id)?.decisionId
      }
      const decision = decisionId ? repo.decisions.get(decisionId) : undefined
      const ref = trigger.threads[0]!
      const result: AskResult = {
        triggerId: trigger.id,
        threadId: ref.id,
        threadKey: threadKey(ref),
        ...(decision?.ticketId ? { ticketId: decision.ticketId } : {}),
        ...(decision ? { decision: decision.kind } : {}),
      }
      if (opts.projectId !== undefined) {
        if (result.ticketId !== undefined) projects.bindTicket(result.ticketId, opts.projectId)
        else projects.clearPendingTrigger(trigger.id)
      }
      return result
    }
    /** A person's message on the ticket's original thread (answers a worker's question, or adds a follow-up). */
    const replyOnTicket = (ticketId: string, text: string): void => {
      const value = repo.tickets.get(ticketId)
      if (!value) throw new UserError('unknownTicket')
      const origin = repo.triggers.get(value.origin.triggerId)
      const ref = origin?.threads[0]
      if (!ref) throw new Error('这张票没有可回复的线程')
      const result = engine.receive(source.followup(ref.id, text))
      if (result === 'stored') {
        engine.evaluateDue()
        effects.kick()
      }
    }
    const ticket = (id: string): TicketView | undefined => {
      const value = repo.tickets.get(id)
      if (!value) return undefined
      const report = latestReport(value)
      return {
        id: value.id,
        title: value.title,
        status: value.ended ? 'ended' : 'open',
        ...(value.ended ? { ended: value.ended } : {}),
        stage: ticketStage(value),
        ...(report ? { latestReport: report } : {}),
        ...(value.attention ? { attention: { question: value.attention.question } } : {}),
        canRetry: canRetry(value),
        ...(value.delivery ? { delivery: value.delivery } : {}),
        messages: outbox.messagesForTicket(value.id),
      }
    }
    const tickets = (): TicketSummary[] => repo.tickets.list().map(value => ({
      id: value.id,
      title: value.title,
      status: value.ended ? 'ended' : 'open',
      stage: ticketStage(value),
      updatedAt: value.updatedAt,
    }))

    const overview = (): Overview => {
      const open = repo.tickets.open()
      const needsPerson = open
        .filter(value => waitsForPerson(value) || !!value.attention || !!value.delivery)
        .map(value => ({
          id: value.id,
          title: value.title,
          stage: ticketStage(value),
          ...(value.attention ? { question: value.attention.question } : {}),
        }))
      return { needsPerson, open: open.length }
    }

    // --- Admin console ---------------------------------------------------------------------------------------------
    const startedAt = new Date()
    /** One tiny request to a provider's model. Never returns the key; errors are redacted by `callModel`. */
    const modelTest = async (providerId: string, modelId: string): Promise<{ ok: boolean; status?: number; latencyMs: number; message: string }> => {
      const found = findModel(optionsStore.get().models, { provider: providerId, model: modelId })
      if (!found) return { ok: false, latencyMs: 0, message: '找不到这个服务商或模型。' }
      const { provider, model } = found
      const target: ModelTarget = {
        api: provider.api,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(provider.sessionHeader ? { sessionHeader: provider.sessionHeader } : {}),
      }
      const result = await callModel(target, { model: model.id, system: 'Reply with ok.', user: 'ok', maxTokens: 8 }, {
        timeoutMs: 15_000,
        sessionId: 'admin-probe',
      })
      if (result.ok) return { ok: true, status: result.status, latencyMs: result.latencyMs, message: '连接正常，模型可以调用。' }
      if (result.status !== undefined) {
        return { ok: false, status: result.status, latencyMs: result.latencyMs, message: `上游返回了 ${result.status}，请检查地址、密钥和模型名。` }
      }
      return { ok: false, latencyMs: result.latencyMs, message: `连不上上游或请求超时：${result.error ?? '未知错误'}` }
    }
    /** Lists a provider's models. A typed key wins; otherwise the saved provider's key (when `provider` names one). */
    const discoverModels = async (input: DiscoverInput): Promise<DiscoverResult> => {
      const saved = input.provider ? optionsStore.get().models.providers.find(p => p.id === input.provider) : undefined
      // The stored key goes only to the address and protocol it was saved for. An edited address needs the key typed
      // again, so a changed URL can never carry the saved key to another host.
      const sameTarget = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase()
      const savedKeyApplies = !!saved && saved.api === input.api && sameTarget(saved.baseUrl) === sameTarget(input.baseUrl)
      if (!input.apiKey && saved && !savedKeyApplies && saved.apiKey) {
        return { ok: false, message: '服务地址或协议改过了，请在密钥栏重新填写密钥后再获取。', models: [] }
      }
      const apiKey = input.apiKey ? input.apiKey : (savedKeyApplies ? saved!.apiKey : '')
      return discoverProviderModels({
        api: input.api,
        baseUrl: input.baseUrl,
        apiKey,
        ...(input.sessionHeader ? { sessionHeader: input.sessionHeader } : {}),
      }, { timeoutMs: 15_000 })
    }
    // Councils live on the same database as the tickets and the ledger. They call models directly (never through the
    // gateway) and their cost rows use an empty ticket id, exactly like the assessor's analysis calls.
    const councils = new CouncilService({
      db: repo.db,
      options: () => optionsStore.get(),
      dayUsd: () => ledger.dayTotals().usd,
      record: entry => {
        try {
          const price = priceOf(entry.provider, entry.model)
          const cost = entry.usage && price ? costOf(price, entry.usage) : 0
          ledger.record({
            at: new Date().toISOString(),
            ticketId: '',
            provider: entry.provider,
            model: entry.model,
            status: entry.status,
            promptHit: entry.usage?.prompt_cache_hit_tokens ?? 0,
            promptMiss: entry.usage?.prompt_cache_miss_tokens ?? 0,
            completion: entry.usage?.completion_tokens ?? 0,
            costUsd: cost,
            latencyMs: entry.latencyMs,
          })
          return cost
        } catch (error) {
          console.error(`superagentd: council ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
          return 0
        }
      },
      event: input => {
        try {
          events.add(input)
        } catch { /* the speech is already stored; the log line is best effort */ }
      },
      requireProject: id => { projects.requireReady(id) },
      projectProfile: id => readProjectProfile(projectsRoot, id),
      // The decision topic always comes from the ticket itself: original task, latest report, current question.
      decisionTopic: ticketId => {
        const ticket = repo.tickets.get(ticketId)
        if (!ticket) return undefined
        const trigger = repo.triggers.get(ticket.origin.triggerId)
        const summary = latestReport(ticket)?.summary
        const question = ticket.attention?.question
        return [
          `工单：${ticket.title}`,
          trigger?.text ? `原始任务：${trigger.text}` : '',
          summary ? `最新报告摘要：${summary}` : '',
          question ? `当前问题：${question}` : '',
        ].filter(line => line !== '').join('\n\n')
      },
      // `adminHost` is declared below; this only runs after a council finishes, long after startup.
      startTicket: ({ brief, projectId }) => adminHost.createTicket(brief, undefined, undefined, projectId),
      onError: error => console.error(`superagentd: council failed: ${error instanceof Error ? error.message : String(error)}`),
    })
    cleanup.push(() => councils.close())

    const settingsHolder = {
      get: () => settings,
      set: (next: typeof settings) => { saveSettings(settingsPath, next); settings = next },
    }
    const adminHost = createRuntimeAdminHost({
      repo, engine, outbox, ledger, events, options: optionsStore, vault, previews, links, projects,
      settings: settingsHolder,
      source: composite,
      testFeishu: () => feishu.test(),
      feishuStatus: () => feishuWs.status(),
      testEmail: () => email.test(),
      emailStatus: () => email.status(),
      reconnectFeishu: async () => {
        const cfg = optionsStore.get().feishu
        if (cfg.enabled && cfg.mode === 'ws') await feishuWs.restart()
        else feishuWs.stop()
      },
      ask: (text, model, secrets, projectId) => ask(text, {
        ...(model === undefined ? {} : { model }),
        ...(secrets === undefined ? {} : { secrets }),
        ...(projectId === undefined ? {} : { projectId }),
      }),
      reply: replyOnTicket,
      slots: () => executor.slots(),
      startedAt,
      version: VERSION,
      stateDir,
      workspaceRoot,
      piConfigRoot: join(stateDir, 'pi-config'),
      backupDir,
      configPath: process.env.SA_CONFIG_PATH ?? '',
      gatewayUrl,
      mcpUrl,
      modelTest,
      discoverModels,
      ticketModel: ticket => {
        const info = resolveTicketModel(ticket)
        return { ...info, ref: formatRef(info.ref) }
      },
    })
    const adminApi = createAdminApi({ host: adminHost, auth, options: optionsStore, ledger, events, cliToken, projects, councils, activity })
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), 'admin', 'web')
    // Public preview links sit outside `/api` too: the token is the credential, and the worker app has no session.
    const previewProxy = createPreviewProxy({
      store: previews,
      publicBase: () => optionsStore.get().preview.publicBase,
      // Once the container stopped, the link shows what the worker left in /workspace/output.
      staticRoot: ticketId => join(workspaceRoot, ticketId, 'output'),
    })
    const adminServer = createAdminServer({
      api: adminApi,
      staticHandler: createStaticHandler(webRoot),
      // The Feishu event callback sits outside `/api`: no login, its own signature and token checks.
      callbacks: async (req, res) => {
        if (await previewProxy(req, res)) return true
        const url = new URL(req.url ?? '/', 'http://admin.invalid')
        if (url.pathname !== '/feishu/events') return false
        await feishu.handleHttp(req, res)
        return true
      },
      host: '127.0.0.1',
      port: config.adminPort,
    })
    cleanup.push(() => adminServer.close())
    const adminPort = (await adminServer.listen()).port
    const adminUrl = `http://127.0.0.1:${adminPort}`

    // Workers share the host network namespace, so the control port requires the CLI token, which they never see.
    const control = createControlServer({
      ask,
      ticket,
      tickets,
      stop: (id, reason) => { engine.stopTicket(id, reason) },
      retry: id => { engine.retryTicket(id) },
      reply: replyOnTicket,
      delete: (id, options) => ({ freedBytes: adminHost.deleteTicket(id, options).freedBytes }),
      overview,
    }, { token: cliToken })
    cleanup.push(() => control.close())
    const controlPort = (await control.listen()).port
    const controlUrl = `http://127.0.0.1:${controlPort}`
    const controlFile = join(stateDir, CONTROL_FILE)
    writeFileSync(controlFile, `${JSON.stringify({
      pid: process.pid, port: controlPort, url: controlUrl, adminUrl, stateDir, startedAt: startedAt.toISOString(),
    }, null, 2)}\n`)
    cleanup.push(() => rmSync(controlFile, { force: true }))

    let stopping: Promise<void> | undefined
    const stop = (reason = ''): Promise<void> => stopping ??= (async () => {
      // The log has to explain a gap after the fact, so the last row says why the process went away.
      try {
        events.add({ kind: 'system.stop', level: 'info', text: reason ? `服务已停止（${reason}）` : '服务已停止' })
      } catch (error) {
        console.error(`superagentd: event log failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Reverse startup order: stop accepting asks and stop the loops first, then the workers, the durable queue, the
      // database, and finally the lock.
      for (const close of [...cleanup].reverse()) {
        try {
          await close()
        } catch (error) {
          console.error(`superagentd: shutdown step failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      tokens.clear()
      releaseLock()
    })()

    return {
      config,
      stateDir,
      engine,
      repo,
      effects,
      executor,
      outbox,
      source,
      gateway,
      mcp,
      control,
      gatewayUrl,
      mcpUrl,
      controlUrl,
      adminUrl,
      ask,
      feishuIntake,
      ticket,
      tickets,
      stop,
    }
  } catch (error) {
    for (const close of [...cleanup].reverse()) {
      try { await close() } catch { /* best effort */ }
    }
    releaseLock()
    throw error
  }
}
