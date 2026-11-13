/**
 * The real `AdminHost`: the runtime's domain, ledger, events and options mapped onto the console's views.
 *
 * Nothing here starts a process or talks to the network on a sync path. Ticket commands run through the `Engine`'s
 * transactions; the async methods (`system`, `cleanup`, `upstreamTest`) do bounded I/O and never throw for a soft failure
 * such as podman being absent. The upstream API key is never read, logged or returned.
 */
import { execFile } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync, rmSync, statfsSync, statSync, unlinkSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { UserError } from '../core/errors.ts'
import { latestAssignment, runningAssignment, ticketOutcome, waitsForPerson } from '../core/model.ts'
import type { Decision, Ticket, TicketInput } from '../core/model.ts'
import type { SourceScope } from '../core/ports.ts'
import { canRetry, ticketStage } from '../core/stage.ts'
import type { Engine } from '../core/engine.ts'
import { LIMITS } from '../limits.ts'
import { plainTitle } from '../infra/text.ts'
import type { EventLog } from '../ledger/events.ts'
import type { Ledger } from '../ledger/ledger.ts'
import type { Outbox } from '../outbox/outbox.ts'
import type { SqliteRepositories } from '../store/sqlite.ts'
import { findModel, type OptionsStore } from './options.ts'
import { InvalidModelError } from '../executor/pi-models.ts'
import type { GoalSpec } from '../goal/service.ts'
import { SettingsSchema, policyEffects, policyVersion } from '../policy.ts'
import type { Settings } from '../policy.ts'
import { createBackup as writeBackup, listBackups } from './backup.ts'
import { Vault, VaultError } from './vault.ts'
import { GithubClient } from './github.ts'
import type { TicketLinks } from './links.ts'
import type { PreviewStore } from './preview.ts'
import type { ProjectService } from '../projects/service.ts'
import { listDeliverables } from '../projects/deliverables.ts'
import {
  AdminError,
  type AdminHost,
  type AttentionTicket,
  type RunningStep,
  type BackupItemView,
  type BackupsResult,
  type BatchDeleteResult,
  type CleanupEntry,
  type CleanupInput,
  type CleanupResult,
  type ContainerInfo,
  type DeleteTicketInput,
  type DeleteTicketResult,
  type DeliverableView,
  type OrphanCleanupResult,
  type OrphanItem,
  type OrphansResult,
  type CreateTicketResult,
  type DecisionView,
  type DiscoverInput,
  type DiscoverResult,
  type DiskUsage,
  type EmailStatusView,
  type EmailTestResultView,
  type FeishuStatusView,
  type GithubTestResultView,
  type HostMetrics,
  type PolicyInput,
  type PolicyView,
  type SecretListItemView,
  type SecretRequestView,
  type SystemExtras,
  type SystemInfo,
  type TicketDetailView,
  type TicketListQuery,
  type TicketLinkView,
  type TicketListResult,
  type TicketMessageView,
  type TicketModelView,
  type TicketPreviewView,
  type TicketReportView,
  type TicketSummaryView,
  type UpstreamStatus,
  type UpstreamTestResult,
  type WorkspaceInfo,
} from './host.ts'
import type { Reason } from '../core/reasons.ts'

/** What the runtime hands the host. Every dependency is injected so the host can be tested without a daemon. */
export interface RuntimeAdminDeps {
  /** Step log; when present the overview reports each running ticket's latest step. */
  activity?: { list(ticketId: string, after?: number, limit?: number): { items: Array<{ summary: string; kind: string; at: string; tool?: string; status?: string; model?: string; agents?: { role: string; name?: string; model?: string; state: string }[] }> } }
  repo: SqliteRepositories
  engine: Engine
  outbox: Outbox
  ledger: Ledger
  events: EventLog
  options: OptionsStore
  /** The secret vault; grants and requests live beside the encrypted values. */
  vault: Vault
  /** Preview registrations and allocations; absent when previews are not wired (tests). */
  previews?: PreviewStore
  /** Ticket links (pull requests); absent in tests that do not exercise them. */
  links?: TicketLinks
  /** The project library; absent in tests that do not exercise projects. */
  projects?: ProjectService
  /** The live settings the runtime holds: `set` persists and swaps the object the engine's `policy()` reads. */
  settings: { get(): Settings; set(next: Settings): void }
  /** The Source scope used when a policy change revalidates open mandates. */
  source: SourceScope
  /** Accept a sentence as a ticket, exactly like `sa ask`; `model` is an optional "provider/model" person choice. */
  ask(text: string, model?: string, secrets?: string[], projectId?: string, collab?: boolean, goal?: GoalSpec): Promise<CreateTicketResult>
  /** Answer on the ticket's original thread as a person. */
  reply(ticketId: string, text: string): void
  /** Feishu connection test; absent when the runtime has no Feishu source. */
  testFeishu?: () => Promise<{ ok: boolean; message: string; botName?: string }>
  /** The live long-connection state; absent when the runtime has no WS transport. */
  feishuStatus?: () => { state: 'off' | 'connecting' | 'connected' | 'error'; since?: string; lastEventAt?: string; lastError?: string }
  /** Restart the long connection when the current settings select it; the runtime decides whether it applies. */
  reconnectFeishu?: () => void | Promise<void>
  /** Gmail connection test; absent when the runtime has no email source. */
  testEmail?: () => Promise<{ ok: boolean; message: string; imap: { ok: boolean; message: string }; smtp: { ok: boolean; message: string } }>
  /** The live Gmail poller state; absent when the runtime has no email source. */
  emailStatus?: () => { state: 'off' | 'connecting' | 'connected' | 'error'; lastPollAt?: string; lastError?: string; processed: number }
  slots(): { used: number; max: number }
  startedAt: Date
  version: string
  stateDir: string
  /** Base directory of ticket workspaces; the ticket's own root is `<workspaceRoot>/<id>`. */
  workspaceRoot: string
  piConfigRoot: string
  /** Where state backups are written; the runtime schedules them, the console lists and triggers them. */
  backupDir: string
  configPath: string
  gatewayUrl: string
  mcpUrl: string
  modelTest(provider: string, model: string): Promise<{ ok: boolean; status?: number; latencyMs: number; message: string }>
  /** Ask a provider for its model list; the runtime resolves the key (typed, or the saved provider's) and sets the timeout. */
  discoverModels(input: DiscoverInput): Promise<DiscoverResult>
  /** The model a ticket runs on and how it was chosen; resolved by the runtime from choices and routing. */
  ticketModel(ticket: Ticket): TicketModelView
  /** Make "provider/model" the ticket's model from its next launch on; throws `InvalidModelError` when not enabled. */
  chooseModel?(ticket: Ticket, ref: string): void
  /** A person wrote on the ticket (reply or retry): a ticket goal stopped at a cap goes on with another batch. */
  goalReplied?(ticketId: string): void
  now?: () => Date
  /** Runs `podman ps`; injectable for tests. Rejects on failure; `system` turns that into a warning. */
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string>
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_WORKSPACE_FILES = 1_000
const MAX_SCAN_ENTRIES = 20_000
const PODMAN_TIMEOUT_MS = 3_000
const TRIGGER_INPUT_CHARS = 500
const DECISION_TRIGGER_CHARS = 200
const TICKET_ID = /^[A-Za-z0-9_-]+$/
/** The extra slot `PiExecutor` reserves for waking an idle worker with a person's follow-up. */
const RESERVED_FOR_PERSON = 1

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** camelCase domain codes become the snake_case codes the HTTP layer exposes (`notRetryable` -> `not_retryable`). */
const snake = (code: string): string => code.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

const USER_MESSAGES: Partial<Record<string, string>> = {
  unknownTicket: '找不到这张任务票。',
  ticketEnded: '这张任务票已经结束。',
  ticketStopped: '这张任务票已被停止。',
  processingPaused: '接单已暂停，先在设置里恢复，任务才能接着干。',
  notRetryable: '这张票现在不能重试。',
  mandateRevoked: '当前受理规则不再允许这张票继续工作。',
  unknownAssignment: '找不到对应的执行记录。',
  assignmentEnded: '这次执行已经结束。',
}

/** Turn a domain `UserError` into the business error the API returns; everything else propagates. */
function mapUserError(error: unknown): never {
  if (error instanceof UserError) {
    throw new AdminError(error.missing ? 'not_found' : snake(error.code), USER_MESSAGES[error.code] ?? error.message, error.missing ? 404 : 409)
  }
  throw error
}

/** Turn a vault failure into the business error the API returns. */
function mapVaultError(error: unknown): never {
  if (error instanceof VaultError) {
    const status = error.code === 'exists' ? 409 : error.code === 'not_found' ? 404 : 400
    const path = error.code === 'invalid_value' ? 'value' : 'name'
    throw new AdminError(error.code, error.message, status, status === 400 ? { issues: [{ path, message: error.message }] } : {})
  }
  throw error
}

const PolicyInputSchema = z.object({
  paused: z.boolean(),
  acceptMode: z.enum(['off', 'observe', 'auto']),
  evalTimeoutSeconds: z.number().int('必须是整数')
    .min(LIMITS.evalTimeoutSeconds.min, `不能小于 ${LIMITS.evalTimeoutSeconds.min} 秒`)
    .max(LIMITS.evalTimeoutSeconds.max, `不能大于 ${LIMITS.evalTimeoutSeconds.max} 秒`),
  rules: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/, '只能包含字母、数字、下划线和短横线，长度 1–80'),
    name: z.string().trim().min(1, '规则名称不能为空').max(LIMITS.ruleName, `不能超过 ${LIMITS.ruleName} 个字`),
    enabled: z.boolean(),
    instruction: z.string().trim().min(1, '规则说明不能为空').max(LIMITS.ruleInstruction, `不能超过 ${LIMITS.ruleInstruction} 个字`),
  }).strict()).max(50, '最多 50 条规则'),
  allowedOperators: z.array(z.object({
    id: z.string().trim().min(1, '操作员 ID 不能为空').max(200, '操作员 ID 不能超过 200 个字'),
    name: z.string().trim().max(100, '名字不能超过 100 个字').default(''),
  }).strict()).max(100, '最多 100 个操作员'),
  feishuOperators: z.array(z.object({
    id: z.string().trim().min(1, '操作员 ID 不能为空').max(200, '操作员 ID 不能超过 200 个字'),
    name: z.string().trim().max(100, '名字不能超过 100 个字').default(''),
  }).strict()).max(100, '最多 100 个飞书操作员').default([]),
}).strict()

/** Validate an admin policy write; a zod failure becomes the API's field-level 400. */
function parsePolicy(input: PolicyInput): z.infer<typeof PolicyInputSchema> {
  const parsed = PolicyInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new AdminError('invalid', '提交的内容有误，请检查标出来的字段。', 400, {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    })
  }
  return parsed.data
}

const canonical = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

/** Whether `target` is `root` itself or lies below it. */
function inside(root: string, target: string): boolean {
  const base = canonical(root)
  const value = canonical(target)
  return value === base || value.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

const truncate = (text: string, limit: number): string => text.length <= limit ? text : text.slice(0, limit)

function lstatSafe(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** Files below `root`, recursive, never following a symbolic link and stopping at `max`. */
function countFiles(root: string, max: number): number {
  let count = 0
  const stack = [root]
  while (stack.length > 0 && count < max) {
    const directory = stack.pop()!
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (count >= max) break
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(join(directory, entry.name))
      else if (entry.isFile()) count += 1
    }
  }
  return count
}

interface Measured { bytes: number; approximate: boolean }

/** Bytes under a path, capped at `MAX_SCAN_ENTRIES` entries; never follows symbolic links. */
function measurePath(target: string): Measured {
  const info = lstatSafe(target)
  if (!info) return { bytes: 0, approximate: false }
  if (!info.isDirectory() || info.isSymbolicLink()) return { bytes: Number(info.size), approximate: false }
  let bytes = 0
  let seen = 0
  let approximate = false
  const stack = [target]
  while (stack.length > 0) {
    const directory = stack.pop()!
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (seen > MAX_SCAN_ENTRIES) return { bytes, approximate: true }
      const full = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const link = lstatSafe(full)
        if (link) bytes += Number(link.size)
        continue
      }
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          bytes += statSync(full).size
        } catch {
          // A file that vanished between readdir and stat adds nothing.
        }
      }
    }
  }
  return { bytes, approximate }
}

const megabytes = (bytes: number): number => bytes / (1024 * 1024)

/** Free space on the filesystem holding `path`, in GB, or 0 when it cannot be read. */
function freeGb(path: string): number {
  try {
    const stats = statfsSync(path)
    return Math.round(((Number(stats.bavail) * Number(stats.bsize)) / 1e9) * 10) / 10
  } catch {
    return 0
  }
}

function fileBytes(path: string): number {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats.size : 0
  } catch {
    return 0
  }
}

/**
 * Delete one cleanup target, confined to `root`.
 *
 * A symbolic link is unlinked itself, never followed. A real path is resolved (`realpath`) and must still be inside the
 * root and must not be the root itself before it is removed recursively.
 */
function removeTarget(target: string, root: string): boolean {
  const info = lstatSafe(target)
  if (!info) return false
  if (info.isSymbolicLink()) {
    // By construction the name is `<root>/<valid ticket id>`; unlink the link without resolving what it points at.
    if (!inside(root, target)) return false
    try {
      unlinkSync(target)
      return true
    } catch {
      return false
    }
  }
  if (!inside(root, target)) return false
  let rootReal: string
  let real: string
  try {
    rootReal = realpathSync(root)
    real = realpathSync(target)
  } catch {
    return false
  }
  if (!inside(rootReal, real)) return false
  if (canonical(real) === canonical(rootReal)) return false
  try {
    rmSync(real, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** The default `run`: `execFile` bounded by `timeoutMs`; it rejects on a missing binary or a timeout. */
function defaultRun(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1_000_000 }, (error, stdout) => {
      if (error) rejectRun(error)
      else resolveRun(stdout)
    })
  })
}

function parseContainers(output: string): ContainerInfo[] {
  const containers: ContainerInfo[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const tab = line.indexOf('\t')
    const name = (tab === -1 ? line : line.slice(0, tab)).trim()
    if (!name.startsWith('sa-')) continue
    containers.push({
      name,
      ticketId: name.slice(3),
      status: tab === -1 ? '' : line.slice(tab + 1).trim(),
      runningFor: '',
    })
  }
  return containers
}

/** Build the real admin host from the runtime's components. */
export function createRuntimeAdminHost(deps: RuntimeAdminDeps): AdminHost {
  const now = (): Date => deps.now?.() ?? new Date()
  const run = deps.run ?? defaultRun
  let lastUpstream: { ok: boolean; checkedAt: string } | undefined

  const isNeedsPerson = (ticket: Ticket): boolean =>
    !ticket.ended && (waitsForPerson(ticket) || ticket.attention !== undefined || ticket.delivery !== undefined)

  const summary = (ticket: Ticket): TicketSummaryView => {
    const outcome = ticketOutcome(ticket)
    const question = ticket.attention?.question
    return {
      id: ticket.id,
      title: plainTitle(ticket.title),
      status: ticket.ended ? 'ended' : 'open',
      stage: ticketStage(ticket),
      needsPerson: isNeedsPerson(ticket),
      ...(question === undefined ? {} : { question }),
      ...(outcome === undefined ? {} : { outcome }),
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      costUsd: deps.ledger.ticketTotals(ticket.id).usd,
    }
  }

  const workspacePath = (ticketId: string): string | undefined => {
    if (!TICKET_ID.test(ticketId)) return undefined
    if (!deps.repo.tickets.get(ticketId)) return undefined
    return resolve(deps.workspaceRoot, ticketId)
  }

  /** Measure and remove one directory below `root`; bytes count only when the directory was actually removed. */
  const removeMeasured = (target: string, root: string): number => {
    const info = lstatSafe(target)
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return 0
    const bytes = measurePath(target).bytes
    return removeTarget(target, root) ? bytes : 0
  }

  /**
   * Delete one ticket. The workspace directory is removed only when asked; the pi-config directory always is. The
   * ledger and event log are untouched, so billing and audit survive the ticket.
   */
  const deleteOne = (id: string, input: DeleteTicketInput): DeleteTicketResult => {
    if (!TICKET_ID.test(id)) throw new AdminError('invalid_path', '任务票编号不合法。', 400)
    const ticket = deps.repo.tickets.get(id)
    if (!ticket) throw new AdminError('not_found', '找不到这张任务票。', 404)
    if (!ticket.ended && !input.force) throw new AdminError('running', '任务还在进行，请先停止再删除。', 409)
    if (!ticket.ended) {
      try {
        deps.engine.stopTicket(id)
      } catch (error) {
        mapUserError(error)
      }
    }

    let freedBytes = 0
    if (input.deleteWorkspace) {
      freedBytes += removeMeasured(resolve(deps.workspaceRoot, id), resolve(deps.workspaceRoot))
    }
    freedBytes += removeMeasured(resolve(deps.piConfigRoot, id), resolve(deps.piConfigRoot))
    deps.repo.deleteTicket(id)
    // Preview links and their reserved ports belong to the ticket; nothing should keep answering for it.
    deps.previews?.removeTicket(id)
    // A deleted ticket's grants go with it, so a future ticket with the same id never inherits secrets.
    try {
      deps.vault.setGrants(id, [])
    } catch {
      // The ticket is already gone; a vault write failure must not turn the deletion into an error.
    }
    try {
      deps.events.add({
        kind: 'ticket.deleted',
        level: 'info',
        ticketId: id,
        text: `已删除任务「${truncate(plainTitle(ticket.title), 20)}」`,
        data: { ticketId: id, freedBytes },
      })
    } catch {
      // The deletion already happened; a log failure must not turn it into an error.
    }
    return { ok: true, freedBytes }
  }

  /** Directory names below a root that look like ticket ids but have no ticket; symlinks are never followed. */
  const scanOrphans = (root: string, kind: OrphanItem['kind'], items: OrphanItem[]): void => {
    let entries
    try {
      entries = readdirSync(resolve(root), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const id = entry.name
      if (!TICKET_ID.test(id) || deps.repo.tickets.get(id)) continue
      const path = resolve(root, id)
      items.push({ id, kind, path, bytes: measurePath(path).bytes })
    }
  }

  /** Map one stored `TicketInput` onto the console's view, resolving and truncating a trigger's text. */
  const inputView = (input: TicketInput): TicketDetailView['inputs'][number] => {
    switch (input.kind) {
      case 'trigger': {
        const trigger = deps.repo.triggers.get(input.triggerId)
        return {
          id: input.id,
          kind: input.kind,
          at: input.at,
          ...(trigger === undefined ? {} : { text: truncate(trigger.text, TRIGGER_INPUT_CHARS) }),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.human ? { human: true } : {}),
          triggerId: input.triggerId,
        }
      }
      case 'text':
      case 'note':
        return { id: input.id, kind: input.kind, at: input.at, text: truncate(input.text, TRIGGER_INPUT_CHARS) }
      case 'resumed':
        return { id: input.id, kind: input.kind, at: input.at, triggerId: input.triggerId }
      default:
        return { id: input.id, kind: input.kind, at: input.at }
    }
  }

  const hostMetrics = (): HostMetrics => {
    const total = totalmem()
    return {
      load1: loadavg()[0] ?? 0,
      cpuCount: cpus().length,
      memUsedPct: total === 0 ? 0 : Math.round((1 - freemem() / total) * 1000) / 10,
      diskFreeGb: freeGb(deps.stateDir),
    }
  }

  const attentionTickets = (open: readonly Ticket[]): AttentionTicket[] => {
    const items: AttentionTicket[] = []
    for (const ticket of open) {
      if (ticket.delivery) {
        items.push({ id: ticket.id, title: plainTitle(ticket.title), kind: 'delivery' })
        continue
      }
      if (!waitsForPerson(ticket)) continue
      const state = latestAssignment(ticket)?.report?.state
      if (state === 'failed' || state === 'blocked') items.push({ id: ticket.id, title: plainTitle(ticket.title), kind: state })
    }
    return items
  }

  const runningSteps = (open: readonly Ticket[]): RunningStep[] => {
    const items: RunningStep[] = []
    for (const ticket of open) {
      const run = runningAssignment(ticket)
      if (run === undefined) continue
      const since = run.startedAt ?? run.createdAt
      try {
        const last = deps.activity?.list(ticket.id, 0, 1).items.at(-1)
        if (last) {
          items.push({
            id: ticket.id, summary: last.summary, kind: last.kind, at: last.at,
            ...(last.tool ? { tool: last.tool } : {}), status: last.status, since,
            ...(last.model ? { model: last.model } : {}), ...(last.agents ? { agents: last.agents } : {}),
          })
        } else {
          items.push({ id: ticket.id, summary: '', kind: 'none', at: since, since })
        }
      } catch { /* best effort */ }
    }
    return items
  }

  const upstream = (): UpstreamStatus => {
    const models = deps.options.get().models
    const found = findModel(models, models.routing.worker)
    return {
      ok: lastUpstream?.ok ?? true,
      ...(lastUpstream ? { checkedAt: lastUpstream.checkedAt } : {}),
      model: found ? (found.model.label || found.model.id) : models.routing.worker.model,
      provider: found?.provider.name ?? models.routing.worker.provider,
    }
  }

  /** The transport is chosen in the options; the connection state comes from the runtime, which may not have one. */
  const feishuStatus = (): FeishuStatusView => {
    const mode = deps.options.get().feishu.mode
    const live = deps.feishuStatus?.() ?? { state: 'off' as const }
    return {
      mode,
      state: live.state,
      ...(live.since === undefined ? {} : { since: live.since }),
      ...(live.lastEventAt === undefined ? {} : { lastEventAt: live.lastEventAt }),
      ...(live.lastError === undefined ? {} : { lastError: live.lastError }),
    }
  }

  return {
    info(): SystemInfo {
      const moment = now()
      const startedAt = deps.startedAt.getTime()
      return {
        version: deps.version,
        uptimeSec: Number.isFinite(startedAt) ? Math.max(0, Math.floor((moment.getTime() - startedAt) / 1000)) : 0,
        startedAt: deps.startedAt.toISOString(),
        node: process.version,
        platform: process.platform,
        stateDir: deps.stateDir,
        configPath: deps.configPath,
        gatewayUrl: deps.gatewayUrl,
        mcpUrl: deps.mcpUrl,
      }
    },

    overview() {
      const settings = deps.settings.get()
      const moment = now()
      const tickets = deps.repo.tickets.list()
      const open = tickets.filter(ticket => !ticket.ended)
      const slots = deps.slots()
      const sameDay = (value: string): boolean => {
        const ended = new Date(value)
        return Number.isFinite(ended.getTime())
          && ended.getFullYear() === moment.getFullYear()
          && ended.getMonth() === moment.getMonth()
          && ended.getDate() === moment.getDate()
      }
      return {
        paused: settings.paused,
        acceptMode: settings.eval.mode,
        slots: { used: slots.used, max: slots.max, reservedForPerson: RESERVED_FOR_PERSON },
        tickets: {
          open: open.length,
          running: open.filter(ticket => runningAssignment(ticket) !== undefined).length,
          needsPerson: open.filter(ticket => isNeedsPerson(ticket)).length,
          endedToday: tickets.filter(ticket => ticket.ended !== undefined && sameDay(ticket.ended.at)).length,
        },
        attentionTickets: attentionTickets(open),
        ...(deps.activity ? { runningSteps: runningSteps(open) } : {}),
        host: hostMetrics(),
        upstream: upstream(),
      }
    },

    listTickets(query: TicketListQuery): TicketListResult {
      const needle = query.q?.trim().toLowerCase()
      const matches = (ticket: Ticket): boolean => {
        switch (query.status) {
          case 'open': return !ticket.ended
          case 'ended': return !!ticket.ended
          case 'needs-person': return isNeedsPerson(ticket)
          case 'all': return true
        }
      }
      const filtered = deps.repo.tickets.list()
        .filter(matches)
        .filter(ticket => needle === undefined || needle === ''
          || ticket.title.toLowerCase().includes(needle)
          || ticket.id.toLowerCase().includes(needle))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const offset = Math.max(0, query.offset)
      return {
        total: filtered.length,
        items: filtered.slice(offset, offset + Math.max(0, query.limit)).map(summary),
      }
    },

    ticket(id: string): TicketDetailView | undefined {
      const ticket = deps.repo.tickets.get(id)
      if (!ticket) return undefined
      const base = summary(ticket)

      const assignments = ticket.assignments.map(assignment => ({
        id: assignment.id,
        state: assignment.state,
        createdAt: assignment.createdAt,
        ...(assignment.startedAt === undefined ? {} : { startedAt: assignment.startedAt }),
        ...(assignment.endedAt === undefined ? {} : { endedAt: assignment.endedAt }),
        ...(assignment.endedReason === undefined ? {} : { endedReason: assignment.endedReason }),
        ...(assignment.report === undefined ? {} : { report: { ...assignment.report } }),
      }))

      // Reports oldest first, as their assignments were created; the current question is attached to the report that raised it.
      const reports: TicketReportView[] = ticket.assignments.flatMap(assignment => assignment.report === undefined ? [] : [{
        id: assignment.id,
        assignmentId: assignment.id,
        state: assignment.report.state,
        summary: assignment.report.summary,
        at: assignment.report.at,
      }])
      if (ticket.attention) {
        let target: TicketReportView | undefined
        for (let index = reports.length - 1; index >= 0; index -= 1) {
          const report = reports[index]!
          if (report.state === 'blocked' || report.state === 'failed') { target = report; break }
        }
        target ??= reports.at(-1)
        if (target) target.question = ticket.attention.question
      }

      const inputs = ticket.inputs.map(inputView)
      const messages: TicketMessageView[] = deps.outbox.messagesForTicket(ticket.id).map(message => ({
        id: message.id,
        at: message.createdAt,
        text: message.text,
        kind: message.kind,
        status: message.status,
        ...(message.sentAt === undefined ? {} : { sentAt: message.sentAt }),
      }))

      const path = workspacePath(ticket.id) ?? ''
      const workspace: WorkspaceInfo = { path, exists: false, fileCount: 0 }
      if (path !== '') {
        const info = lstatSafe(path)
        if (info?.isDirectory() && !info.isSymbolicLink()) {
          workspace.exists = true
          workspace.fileCount = countFiles(path, MAX_WORKSPACE_FILES)
        }
      }

      const project = deps.projects?.ticketProject(ticket.id, ticket.origin.triggerId)
      return {
        ...base,
        model: deps.ticketModel(ticket),
        ...(project === undefined ? {} : { project }),
        secrets: deps.vault.grants(ticket.id),
        mandate: {
          strength: ticket.mandate.strength,
          actor: ticket.mandate.actor,
          scope: ticket.mandate.scope,
          policyVersion: ticket.mandate.policyVersion,
        },
        assignments,
        reports,
        ...(ticket.attention === undefined ? {} : { attention: { ...ticket.attention } }),
        ...(ticket.delivery === undefined ? {} : { delivery: { ...ticket.delivery } }),
        canRetry: canRetry(ticket),
        inputs,
        messages,
        workspace,
      }
    },

    ticketPreviews(id: string): TicketPreviewView[] {
      return deps.previews?.list(id) ?? []
    },

    async createTicket(text: string, model?: string, secrets?: string[], projectId?: string, collab?: boolean, goal?: GoalSpec): Promise<CreateTicketResult> {
      // Validate before accepting: a bad name or an unready project must not leave a ticket behind.
      if (secrets !== undefined) {
        const missing = [...new Set(secrets)].filter(name => !deps.vault.has(name))
        if (missing.length > 0) {
          throw new AdminError('invalid', '提交的内容有误，请检查标出来的字段。', 400, {
            issues: [{ path: 'secrets', message: `找不到这些密钥：${missing.join('、')}` }],
          })
        }
      }
      if (projectId !== undefined) {
        if (deps.projects === undefined) throw new AdminError('invalid', '这台服务器没有启用项目库。', 400)
        deps.projects.requireReady(projectId)
      }
      let result: CreateTicketResult
      try {
        // Secrets and the project go in with the message so the first launch already has them.
        result = await deps.ask(text, model, secrets, projectId, collab, goal)
      } catch (error) {
        if (error instanceof InvalidModelError) throw new AdminError('invalid', error.message, 400, { issues: error.issues })
        mapUserError(error)
      }
      if (secrets !== undefined && result.ticketId !== undefined) {
        try {
          deps.vault.setGrants(result.ticketId, secrets)
        } catch (error) {
          mapVaultError(error)
        }
      }
      return result
    },

    listSecrets(): SecretListItemView[] {
      return deps.vault.list()
    },

    createSecret(input: { name: string; value: string; description?: string }): { ok: true } {
      try {
        deps.vault.create(input.name, input.value, input.description ?? '', 'operator')
      } catch (error) {
        mapVaultError(error)
      }
      return { ok: true }
    },

    updateSecret(name: string, input: { value?: string; description?: string }): { ok: true } {
      try {
        deps.vault.update(name, input)
      } catch (error) {
        mapVaultError(error)
      }
      return { ok: true }
    },

    deleteSecret(name: string): { ok: true } {
      try {
        deps.vault.remove(name)
      } catch (error) {
        mapVaultError(error)
      }
      return { ok: true }
    },

    secretRequests(): SecretRequestView[] {
      return deps.vault.requests().map(request => ({
        ...request,
        ticketTitle: deps.repo.tickets.get(request.ticketId)?.title ?? '',
      }))
    },

    decideSecretRequest(id: string, decision: 'grant' | 'deny'): { ok: true } {
      try {
        deps.vault.decide(id, decision)
      } catch (error) {
        mapVaultError(error)
      }
      return { ok: true }
    },

    ticketSecrets(id: string): string[] {
      if (!deps.repo.tickets.get(id)) throw new AdminError('not_found', '找不到这张任务票。', 404)
      return deps.vault.grants(id)
    },

    setTicketSecrets(id: string, names: readonly string[]): { ok: true; names: string[] } {
      if (!deps.repo.tickets.get(id)) throw new AdminError('not_found', '找不到这张任务票。', 404)
      try {
        return { ok: true, names: deps.vault.setGrants(id, names) }
      } catch (error) {
        // An unknown name in the grant list is a bad request, not a missing ticket.
        if (error instanceof VaultError && error.code === 'not_found') {
          throw new AdminError('invalid', error.message, 400, { issues: [{ path: 'names', message: error.message }] })
        }
        mapVaultError(error)
      }
    },

    stopTicket(id: string, reason?: string): void {
      try {
        deps.engine.stopTicket(id, reason)
      } catch (error) {
        mapUserError(error)
      }
    },

    retryTicket(id: string): void {
      try {
        deps.engine.retryTicket(id)
      } catch (error) {
        mapUserError(error)
      }
      deps.goalReplied?.(id)
    },

    noteTicket(id: string, text: string): void {
      try {
        deps.engine.note(id, text)
      } catch (error) {
        mapUserError(error)
      }
    },

    replyTicket(id: string, text: string, model?: string): void {
      const current = deps.repo.tickets.get(id)
      if (!current) throw new AdminError('not_found', '找不到这张任务票。', 404)
      // A different model chosen with the instruction applies from this round on; the same model changes nothing.
      let switched = false
      if (model !== undefined && model !== '' && model !== deps.ticketModel(current).ref) {
        if (deps.chooseModel === undefined) throw new AdminError('invalid', '这台服务器不支持给任务换模型。', 400)
        try {
          deps.chooseModel(current, model)
        } catch (error) {
          if (error instanceof InvalidModelError) throw new AdminError('invalid', error.message, 400, { issues: error.issues })
          throw error
        }
        switched = true
      }
      // Whatever its state, a message written on the ticket page is an instruction for this ticket. Sending it down the
      // ticket's thread instead lets Eval read it as a new request and open an unrelated ticket (seen on the host).
      try {
        deps.engine.instruct(id, text, { restart: switched })
      } catch (error) {
        mapUserError(error)
      }
      deps.goalReplied?.(id)
    },

    decisions(limit: number, offset = 0, kind?: string): DecisionView[] {
      const all: Decision[] = deps.repo.threads.list().flatMap(thread => deps.repo.decisions.byThread(thread.key))
      return all
        .filter(decision => kind === undefined || decision.kind === kind)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit))
        .map(decision => {
          const trigger = decision.triggerIds[0] === undefined ? undefined : deps.repo.triggers.get(decision.triggerIds[0])
          return {
            id: decision.id,
            at: decision.at,
            kind: decision.kind,
            threadKey: decision.threadKey,
            ...(decision.ticketId === undefined ? {} : { ticketId: decision.ticketId }),
            triggerText: truncate(trigger?.text ?? '', DECISION_TRIGGER_CHARS),
            reasons: decision.reason.map(reason => ({ ...reason }) as Reason),
            strength: decision.strength,
          }
        })
    },

    testFeishu(): Promise<{ ok: boolean; message: string; botName?: string }> {
      return deps.testFeishu ? deps.testFeishu() : Promise.resolve({ ok: false, message: '飞书来源未启用。' })
    },

    feishuStatus,

    async reconnectFeishu(): Promise<FeishuStatusView> {
      try {
        await deps.reconnectFeishu?.()
      } catch {
        // The transport records its own failure; the status below reports it.
      }
      return feishuStatus()
    },

    githubTokenSet(): boolean {
      return deps.vault.has('GITHUB_TOKEN')
    },

    setGithubToken(token: string): void {
      try {
        if (deps.vault.has('GITHUB_TOKEN')) deps.vault.update('GITHUB_TOKEN', { value: token, origin: 'operator' })
        else deps.vault.create('GITHUB_TOKEN', token, 'GitHub 访问令牌', 'operator')
      } catch (error) {
        mapVaultError(error)
      }
    },

    async testGithub(): Promise<GithubTestResultView> {
      const config = deps.options.get().github
      let token = ''
      try {
        token = deps.vault.has('GITHUB_TOKEN') ? deps.vault.reveal('GITHUB_TOKEN') : ''
      } catch {
        // A value that cannot be decrypted is treated as missing; the message says to fill the token again.
      }
      if (token === '') return { ok: false, message: '请先填写 GitHub 令牌。' }
      return new GithubClient({ apiBase: config.apiBase, token, repos: config.repos }).testConnection()
    },

    emailPasswordSet(): boolean {
      return deps.vault.has('GMAIL_APP_PASSWORD')
    },

    setEmailPassword(password: string): void {
      try {
        if (deps.vault.has('GMAIL_APP_PASSWORD')) deps.vault.update('GMAIL_APP_PASSWORD', { value: password, origin: 'operator' })
        else deps.vault.create('GMAIL_APP_PASSWORD', password, 'Gmail 应用专用密码', 'operator')
      } catch (error) {
        mapVaultError(error)
      }
    },

    testEmail(): Promise<EmailTestResultView> {
      return deps.testEmail
        ? deps.testEmail()
        : Promise.resolve({
          ok: false,
          message: '邮箱来源未启用。',
          imap: { ok: false, message: '邮箱来源未启用。' },
          smtp: { ok: false, message: '邮箱来源未启用。' },
        })
    },

    emailStatus(): EmailStatusView {
      return deps.emailStatus?.() ?? { state: 'off', processed: 0 }
    },

    setEmailAllowedSenders(senders: readonly string[]): { changed: boolean } {
      const old = deps.settings.get()
      const allowed = [...new Set(senders.map(sender => sender.trim().toLowerCase()).filter(sender => sender !== ''))]
        .map(id => ({ id }))
      const existing = old.policy.sources.email
      if (JSON.stringify(existing?.allowed ?? []) === JSON.stringify(allowed)) return { changed: false }
      const next = SettingsSchema.parse({
        ...old,
        policy: {
          ...old.policy,
          sources: {
            ...old.policy.sources,
            email: { ...(existing ?? { allowed: [], admission: {} }), allowed },
          },
        },
      })
      deps.settings.set(next)
      const from = policyVersion(old)
      const to = policyVersion(next)
      if (from !== to) {
        const effects = policyEffects(deps.repo.tickets.open(), old, next, () => deps.source)
        deps.engine.policyChanged(from, to, effects)
      }
      return { changed: true }
    },

    ticketLinks(id: string): TicketLinkView[] {
      return deps.links?.list(id) ?? []
    },

    getPolicy(): PolicyView {
      const settings = deps.settings.get()
      return {
        paused: settings.paused,
        acceptMode: settings.eval.mode,
        evalTimeoutSeconds: settings.eval.timeoutSeconds,
        rules: settings.policy.rules.map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled, instruction: rule.instruction })),
        allowedOperators: (settings.policy.sources.cli?.allowed ?? []).map(operator => ({ id: operator.id, name: operator.name ?? '' })),
        feishuOperators: (settings.policy.sources.feishu?.allowed ?? []).map(operator => ({ id: operator.id, name: operator.name ?? '' })),
      }
    },

    updatePolicy(input: PolicyInput): { changed: string[] } {
      const policy = parsePolicy(input)
      if (policy.allowedOperators.length === 0) throw new AdminError('invalid', '至少要保留一个允许下指令的人', 400)
      const old = deps.settings.get()
      const cli = old.policy.sources.cli ?? { allowed: [], admission: {} }
      const feishu = old.policy.sources.feishu
      const feishuAllowed = policy.feishuOperators.map(operator => ({ id: operator.id, name: operator.name }))
      // The Feishu entry is written only when it exists or names someone, so an unused source leaves settings untouched.
      const feishuSource: Settings['policy']['sources'] = feishu || feishuAllowed.length > 0
        ? { feishu: { ...(feishu ?? { allowed: [], admission: {} }), allowed: feishuAllowed } }
        : {}
      const candidate: Settings = {
        ...old,
        paused: policy.paused,
        eval: { ...old.eval, mode: policy.acceptMode, timeoutSeconds: policy.evalTimeoutSeconds },
        policy: {
          ...old.policy,
          rules: policy.rules.map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled, instruction: rule.instruction })),
          sources: {
            ...old.policy.sources,
            cli: { ...cli, allowed: policy.allowedOperators.map(operator => ({ id: operator.id, name: operator.name })) },
            ...feishuSource,
          },
        },
      }

      let next: Settings
      try {
        next = SettingsSchema.parse(candidate)
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AdminError('invalid', '提交的内容有误，请检查标出来的字段。', 400, {
            issues: error.issues.map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message })),
          })
        }
        throw error
      }

      const changed: string[] = []
      if (old.paused !== next.paused) changed.push('paused')
      if (old.eval.mode !== next.eval.mode) changed.push('acceptMode')
      if (old.eval.timeoutSeconds !== next.eval.timeoutSeconds) changed.push('evalTimeoutSeconds')
      if (JSON.stringify(old.policy.rules) !== JSON.stringify(next.policy.rules)) changed.push('rules')
      if (JSON.stringify(old.policy.sources.cli?.allowed ?? []) !== JSON.stringify(next.policy.sources.cli?.allowed ?? [])) changed.push('allowedOperators')
      if (JSON.stringify(old.policy.sources.feishu?.allowed ?? []) !== JSON.stringify(next.policy.sources.feishu?.allowed ?? [])) changed.push('feishuOperators')
      if (changed.length === 0) return { changed }

      deps.settings.set(next)
      const from = policyVersion(old)
      const to = policyVersion(next)
      if (from !== to) {
        const effects = policyEffects(deps.repo.tickets.open(), old, next, () => deps.source)
        deps.engine.policyChanged(from, to, effects)
      }
      return { changed }
    },

    setPaused(paused: boolean): { paused: boolean; changed: boolean } {
      const old = deps.settings.get()
      if (old.paused === paused) return { paused, changed: false }
      deps.settings.set(SettingsSchema.parse({ ...old, paused }))
      return { paused, changed: true }
    },

    async system(): Promise<SystemExtras> {
      const warnings: string[] = []
      let containers: ContainerInfo[] = []
      try {
        containers = parseContainers(await run('podman', ['ps', '--format', '{{.Names}}\t{{.Status}}'], PODMAN_TIMEOUT_MS))
      } catch (error) {
        warnings.push(`无法读取容器状态：${truncate(describe(error), 200)}`)
      }

      const workspaces = measurePath(resolve(deps.workspaceRoot))
      const piConfig = measurePath(resolve(deps.piConfigRoot))
      if (workspaces.approximate || piConfig.approximate) warnings.push('目录内容过多，磁盘占用是近似值。')
      const disk: DiskUsage = {
        workspacesMb: megabytes(workspaces.bytes),
        piConfigMb: megabytes(piConfig.bytes),
        dbMb: megabytes(fileBytes(join(deps.stateDir, 'state.sqlite'))),
        freeGb: freeGb(deps.stateDir),
      }
      return {
        containers,
        disk,
        limits: { maxWorkers: deps.options.get().executor.maxWorkers },
        ...(warnings.length === 0 ? {} : { warning: warnings.join(' ') }),
      }
    },

    async cleanup(input: CleanupInput): Promise<CleanupResult> {
      const moment = now().getTime()
      const entries: CleanupEntry[] = []
      const deleted: string[] = []
      let freedBytes = 0

      for (const ticket of deps.repo.tickets.list()) {
        if (!ticket.ended) continue
        if (!TICKET_ID.test(ticket.id)) continue
        const endedAt = Date.parse(ticket.ended.at)
        if (!Number.isFinite(endedAt)) continue
        const ageMs = moment - endedAt
        if (!(ageMs > input.olderThanDays * DAY_MS)) continue

        const workspace = resolve(deps.workspaceRoot, ticket.id)
        const piConfig = resolve(deps.piConfigRoot, ticket.id)
        const hasWorkspace = lstatSafe(workspace) !== undefined
        const hasPiConfig = lstatSafe(piConfig) !== undefined
        if (!hasWorkspace && !hasPiConfig) continue

        const workspaceSize = hasWorkspace ? measurePath(workspace) : { bytes: 0, approximate: false }
        const piConfigSize = hasPiConfig ? measurePath(piConfig) : { bytes: 0, approximate: false }
        entries.push({
          ticketId: ticket.id,
          title: plainTitle(ticket.title),
          endedAt: ticket.ended.at,
          ageDays: Math.floor(ageMs / DAY_MS),
          ...(hasWorkspace ? { workspacePath: workspace } : {}),
          ...(hasPiConfig ? { piConfigPath: piConfig } : {}),
          bytes: workspaceSize.bytes + piConfigSize.bytes,
        })
        if (input.dryRun) continue

        let removed = false
        if (hasWorkspace && removeTarget(workspace, resolve(deps.workspaceRoot))) {
          removed = true
          freedBytes += workspaceSize.bytes
        }
        if (hasPiConfig && removeTarget(piConfig, resolve(deps.piConfigRoot))) {
          removed = true
          freedBytes += piConfigSize.bytes
        }
        if (removed) deleted.push(ticket.id)
      }

      return {
        dryRun: input.dryRun,
        olderThanDays: input.olderThanDays,
        entries,
        deleted,
        freedBytes: input.dryRun ? 0 : freedBytes,
      }
    },

    deleteTicket(id: string, input: DeleteTicketInput): DeleteTicketResult {
      return deleteOne(id, input)
    },

    deleteTickets(ids: readonly string[], input: DeleteTicketInput): BatchDeleteResult {
      const deleted: string[] = []
      const skipped: { id: string; reason: string }[] = []
      let freedBytes = 0
      for (const id of ids) {
        try {
          freedBytes += deleteOne(id, input).freedBytes
          deleted.push(id)
        } catch (error) {
          if (!(error instanceof AdminError)) throw error
          skipped.push({ id, reason: error.code })
        }
      }
      return { deleted, skipped, freedBytes }
    },

    orphans(): OrphansResult {
      const items: OrphanItem[] = []
      scanOrphans(deps.workspaceRoot, 'workspace', items)
      scanOrphans(deps.piConfigRoot, 'pi-config', items)
      items.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)))
      return { items, totalBytes: items.reduce((total, item) => total + item.bytes, 0) }
    },

    cleanupOrphans(ids: readonly string[]): OrphanCleanupResult {
      const deleted: string[] = []
      let freedBytes = 0
      for (const id of new Set(ids)) {
        if (!TICKET_ID.test(id)) continue
        // Re-check: a directory whose ticket came back (or whose name is not a ticket id) is not an orphan any more.
        if (deps.repo.tickets.get(id)) continue
        let removed = false
        for (const root of [deps.workspaceRoot, deps.piConfigRoot]) {
          const target = resolve(root, id)
          const info = lstatSafe(target)
          if (!info?.isDirectory() || info.isSymbolicLink()) continue
          const bytes = measurePath(target).bytes
          if (removeTarget(target, resolve(root))) {
            freedBytes += bytes
            removed = true
          }
        }
        if (removed) deleted.push(id)
      }
      return { deleted, freedBytes }
    },

    backups(): BackupsResult {
      return { dir: deps.backupDir, items: listBackups(deps.backupDir) }
    },

    async createBackup(): Promise<{ ok: true; item: BackupItemView }> {
      const item = await writeBackup({ stateDir: deps.stateDir, backupDir: deps.backupDir, db: deps.repo.db, now })
      try {
        deps.events.add({ kind: 'system.backup', level: 'info', text: `已备份状态：${item.name}`, data: { name: item.name, bytes: item.bytes } })
      } catch {
        // The archive exists; the log line is best effort.
      }
      return { ok: true, item }
    },

    async modelTest(provider: string, model: string): Promise<UpstreamTestResult> {
      try {
        const result = await deps.modelTest(provider, model)
        const worker = deps.options.get().models.routing.worker
        // The overview's health light follows the default worker model only.
        if (worker.provider === provider && worker.model === model) {
          lastUpstream = { ok: result.ok, checkedAt: now().toISOString() }
        }
        return {
          ok: result.ok,
          ...(result.status === undefined ? {} : { status: result.status }),
          latencyMs: result.latencyMs,
          message: result.message,
        }
      } catch (error) {
        return { ok: false, latencyMs: 0, message: `无法连接上游服务：${truncate(describe(error), 200)}` }
      }
    },

    async discoverModels(input: DiscoverInput): Promise<DiscoverResult> {
      try {
        return await deps.discoverModels(input)
      } catch {
        return { ok: false, message: '获取模型列表失败。', models: [] }
      }
    },

    workspaceRoot(id: string): string | undefined {
      return workspacePath(id)
    },

    ticketTitles(ids: readonly string[]): Record<string, string> {
      const titles: Record<string, string> = {}
      for (const id of ids) {
        const ticket = deps.repo.tickets.get(id)
        if (ticket) titles[id] = plainTitle(ticket.title)
      }
      return titles
    },

    deliverables(id: string): DeliverableView[] {
      const root = workspacePath(id)
      if (root === undefined) return []
      try {
        return listDeliverables(root)
      } catch {
        return []
      }
    },
  }
}
