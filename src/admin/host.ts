/**
 * The single boundary between the admin HTTP layer and the domain/runtime.
 *
 * The API layer never reads tickets, policy files, the filesystem or podman directly: it asks the host. The host owns the
 * engine transactions, persistence and runtime measurements, and returns views that are already shaped for the console.
 * Every synchronous method is a fast in-memory/domain read or a transaction; the asynchronous ones touch the filesystem,
 * podman or the network and may take noticeable time.
 */
import type { AcceptMode, ActorRef, AssignmentState, DecisionKind, ReportState, Strength, TicketInput, TicketOutcome } from '../core/model.ts'
import type { Reason } from '../core/reasons.ts'
import type { TicketStage } from '../core/stage.ts'

/** A field-level problem attached to a rejected admin request. */
export interface AdminIssue {
  path: string
  message: string
}

/**
 * A business error the API layer turns into `{ error: code, message }`.
 * `status` is the HTTP status (400/401/403/404/409/429/500) and `issues` (optional) carries field paths for validation.
 */
export class AdminError extends Error {
  readonly issues: AdminIssue[] | undefined

  constructor(readonly code: string, message: string, readonly status: number, options: { issues?: AdminIssue[] } = {}) {
    super(message)
    this.name = 'AdminError'
    this.issues = options.issues
  }
}

export interface HostMetrics {
  load1: number
  cpuCount: number
  memUsedPct: number
  diskFreeGb: number
}

export interface UpstreamStatus {
  ok: boolean
  checkedAt?: string
  /** Display name of the default worker model. */
  model: string
  /** Display name of the provider that serves the default worker model. */
  provider: string
}

export interface SlotsInfo {
  used: number
  max: number
  reservedForPerson: number
}

/** One open ticket that waits on a person because its worker failed, is blocked, or its input delivery failed. */
export interface AttentionTicket {
  id: string
  title: string
  kind: 'failed' | 'blocked' | 'delivery'
}

/** Everything the overview needs that comes from the runtime rather than the ledger or event log. */
export interface OverviewFacts {
  paused: boolean
  acceptMode: AcceptMode
  slots: SlotsInfo
  tickets: { open: number; running: number; needsPerson: number; endedToday: number }
  attentionTickets: AttentionTicket[]
  host: HostMetrics
  upstream: UpstreamStatus
}

export type TicketStatusFilter = 'open' | 'ended' | 'needs-person' | 'all'

export interface TicketListQuery {
  status: TicketStatusFilter
  q?: string
  limit: number
  offset: number
}

/** The list row: what the ticket list and the top bar need, without the heavy detail. */
export interface TicketSummaryView {
  id: string
  title: string
  status: 'open' | 'ended'
  stage: TicketStage
  needsPerson: boolean
  question?: string
  outcome?: TicketOutcome
  createdAt: string
  updatedAt: string
  costUsd: number
}

export interface TicketListResult {
  total: number
  items: TicketSummaryView[]
}

export interface TicketMandateView {
  strength: Strength
  actor: ActorRef
  scope: string
  policyVersion: string
}

export interface TicketAssignmentView {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state: ReportState; summary: string; at: string }
}

export interface TicketReportView {
  /** The id of the assignment that made the report. */
  id: string
  assignmentId: string
  state: ReportState
  summary: string
  at: string
  question?: string
}

export interface TicketInputView {
  id: string
  kind: TicketInput['kind']
  at: string
  text?: string
  note?: string
  human?: boolean
  triggerId?: string
}

/** One message the ticket queued for its channel, as the console shows it. */
export interface TicketMessageView {
  id: string
  at: string
  text: string
  kind: string
  status: string
  sentAt?: string
}

export interface WorkspaceInfo {
  /** Absolute workspace root of the ticket; empty when the ticket has none. */
  path: string
  exists: boolean
  fileCount: number
}

/** One published preview of a ticket, as the detail page shows it. */
export interface TicketPreviewView {
  port: number
  title: string
  /** Public path below the admin prefix, without a leading slash: `p/<token>/`. */
  path: string
  /** Absolute URL when a public base is configured, otherwise the relative path. */
  url: string
  /** Whether the ticket's container is running now. */
  active: boolean
}

/** The domain part of a ticket detail. The API adds usage, calls, ticket events and the Chinese stage label. */
/** The model a ticket runs on. `source` says how it was chosen: by the person, by the analysis model, or the default. */
export interface TicketModelView {
  ref: string
  label: string
  providerName: string
  source: 'person' | 'auto' | 'default'
  reason?: string
}

/** The project a ticket was started from; `preparing` is true while its tree is being copied into the workspace. */
export interface TicketProjectView {
  id: string
  name: string
  preparing: boolean
}

/** One file under the ticket's workspace that the reader can show. */
export interface DeliverableView {
  /** Relative to the ticket workspace, `/` separators. */
  path: string
  size: number
  mtime: string
  /** Extension without the dot, such as `md` or `png`. */
  kind: string
}

export interface TicketDetailView extends TicketSummaryView {
  model: TicketModelView
  mandate: TicketMandateView
  /** Names of the secrets granted to this ticket; never their values. */
  secrets: string[]
  assignments: TicketAssignmentView[]
  /** Every assignment report, oldest first. */
  reports: TicketReportView[]
  attention?: { id: string; question: string; triggerId?: string }
  delivery?: { error: string; at: string }
  canRetry: boolean
  inputs: TicketInputView[]
  messages: TicketMessageView[]
  workspace: WorkspaceInfo
  /** Present when the ticket was started from a project in the library. */
  project?: TicketProjectView
}

/** What `POST /tickets` reports back, mirroring `sa ask`. */
export interface CreateTicketResult {
  ticketId?: string
  triggerId: string
  threadId: string
  threadKey: string
  decision?: string
}

export interface DecisionView {
  id: string
  at: string
  kind: DecisionKind
  threadKey: string
  ticketId?: string
  triggerText: string
  reasons: Reason[]
  strength: Strength
}

export interface PolicyRuleView {
  id: string
  name: string
  enabled: boolean
  instruction: string
}

export interface PolicyOperatorView {
  id: string
  name: string
}

/** The policy block as the settings page reads and writes it. */
export interface PolicyView {
  paused: boolean
  acceptMode: AcceptMode
  evalTimeoutSeconds: number
  rules: PolicyRuleView[]
  allowedOperators: PolicyOperatorView[]
  /** People allowed to give instructions through Feishu; may be empty. */
  feishuOperators: PolicyOperatorView[]
}

export type PolicyInput = PolicyView

/** Result of the Feishu connection test; the message never carries credentials. */
export interface FeishuTestResult {
  ok: boolean
  message: string
  botName?: string
}

/** One link attached to a ticket, such as a pull request its worker opened. */
export interface TicketLinkView {
  kind: string
  url: string
  title: string
}

/** One repository the GitHub token can see, and whether it may push. */
export interface GithubRepoAccessView {
  fullName: string
  push: boolean
}

/** Result of the GitHub connection test; the message never carries the token. */
export interface GithubTestResultView {
  ok: boolean
  message: string
  login?: string
  repos?: GithubRepoAccessView[]
}

/** The Gmail poller's live state; never carries the password. */
export interface EmailStatusView {
  state: 'off' | 'connecting' | 'connected' | 'error'
  lastPollAt?: string
  lastError?: string
  processed: number
}

/** Result of the Gmail connection test; each side reports its own outcome and never carries the password. */
export interface EmailTestResultView {
  ok: boolean
  message: string
  imap: { ok: boolean; message: string }
  smtp: { ok: boolean; message: string }
}

/** The Feishu transport's mode and live connection state; never carries secrets. */
export interface FeishuStatusView {
  mode: 'webhook' | 'ws'
  state: 'off' | 'connecting' | 'connected' | 'error'
  since?: string
  lastEventAt?: string
  lastError?: string
}

export interface ContainerInfo {
  name: string
  ticketId?: string
  status: string
  runningFor: string
}

export interface DiskUsage {
  workspacesMb: number
  piConfigMb: number
  dbMb: number
  freeGb: number
}

/** Process-level facts; cheap and safe to read on every health check. */
export interface SystemInfo {
  version: string
  uptimeSec: number
  startedAt: string
  node: string
  platform: string
  stateDir: string
  configPath: string
  gatewayUrl: string
  mcpUrl: string
}

/** The parts of `GET /system` that need I/O and may fail softly. */
export interface SystemExtras {
  containers: ContainerInfo[]
  disk: DiskUsage
  limits: { maxWorkers: number }
  /** Set when podman or the disk probe failed; the corresponding values are then empty or zero. */
  warning?: string
}

export interface UpstreamTestResult {
  ok: boolean
  status?: number
  latencyMs: number
  message: string
}

/** One model a provider says it offers; only `id` is certain, the rest is included only when the provider reports it. */
export interface DiscoveredModel {
  id: string
  label?: string
  contextWindow?: number
  maxTokens?: number
  vision?: boolean
  reasoning?: boolean
  price?: { input: number; cacheRead: number; output: number }
}

export interface DiscoverResult {
  ok: boolean
  status?: number
  message: string
  models: DiscoveredModel[]
}

/** What the console sends to discover models; `apiKey` empty or missing falls back to the saved provider's key. */
export interface DiscoverInput {
  provider?: string
  api: 'openai-completions' | 'anthropic-messages'
  baseUrl: string
  apiKey?: string
  sessionHeader?: string
}

export interface CleanupInput {
  olderThanDays: number
  dryRun: boolean
}

export interface CleanupEntry {
  ticketId: string
  title: string
  endedAt?: string
  ageDays: number
  workspacePath?: string
  piConfigPath?: string
  bytes: number
}

export interface CleanupResult {
  dryRun: boolean
  olderThanDays: number
  entries: CleanupEntry[]
  deleted: string[]
  freedBytes: number
}

/** How a ticket deletion treats a ticket that is still open, and its workspace directory. */
export interface DeleteTicketInput {
  /** Remove `<workspaceRoot>/<id>`; the pi-config directory is always removed. Default true. */
  deleteWorkspace: boolean
  /** Stop an open ticket first instead of refusing the deletion. Default false. */
  force: boolean
}

export interface DeleteTicketResult {
  ok: true
  freedBytes: number
}

/** One id a batch delete could not remove, with the business code saying why. */
export interface SkippedDelete {
  id: string
  reason: string
}

export interface BatchDeleteResult {
  deleted: string[]
  skipped: SkippedDelete[]
  freedBytes: number
}

/** A directory left behind under the workspace root or `state/pi-config` whose name has no ticket. */
export interface OrphanItem {
  /** Directory name, which for a real ticket would be the ticket id. */
  id: string
  kind: 'workspace' | 'pi-config'
  path: string
  bytes: number
}

export interface OrphansResult {
  items: OrphanItem[]
  totalBytes: number
}

export interface OrphanCleanupResult {
  deleted: string[]
  freedBytes: number
}

/** One secret as the console lists it: metadata only, never a value. */
export interface SecretListItemView {
  name: string
  description: string
  origin: 'operator' | 'ai'
  createdAt: string
  rotatedAt?: string
  lastUsedAt?: string
  grantedTickets: number
}

/** One AI request for a secret. */
export interface SecretRequestView {
  id: string
  ticketId: string
  ticketTitle: string
  name: string
  why: string
  at: string
  status: 'pending' | 'granted' | 'denied'
}

export interface BackupItemView {
  name: string
  at: string
  bytes: number
}

export interface BackupsResult {
  dir: string
  items: BackupItemView[]
}

export type SettingsSection = 'policy' | 'executor' | 'models' | 'budget' | 'pause' | 'feishu' | 'preview' | 'projects' | 'github' | 'email' | 'council'

/** Extra notification after a settings write succeeded and was persisted. */
export interface AdminSettingsChange {
  section: SettingsSection
  changed: string[]
  /** The resulting policy, present for `policy` and `pause` changes. */
  policy?: PolicyView
}

/**
 * The host the admin API talks to. Implemented by the runtime wiring; the API layer is complete without it.
 *
 * Sync methods run inside the daemon's event loop and must not block on subprocesses or the network.
 * Async methods may do I/O and are given a bounded amount of time by their callers where relevant.
 */
export interface AdminHost {
  /** Version, uptime and the fixed paths/URLs; cheap enough for `GET /health` and merged into `GET /system`. */
  info(): SystemInfo

  /** Live counts and measurements for the overview: pause state, slots, ticket counts, host metrics and upstream health. */
  overview(): OverviewFacts

  /** Filter, search and paginate tickets, with each ticket's cost already summed from the ledger. */
  listTickets(query: TicketListQuery): TicketListResult

  /** One ticket's domain detail (mandate, assignments, reports, inputs, messages, workspace), or undefined if unknown. */
  ticket(id: string): TicketDetailView | undefined

  /** The ticket's published preview links; empty when it never published one or has none. */
  ticketPreviews(id: string): TicketPreviewView[]

  /**
   * Accept a sentence as a new ticket, exactly like `sa ask`; returns the trigger/thread/ticket identifiers.
   * `secrets` grants existing secret names to the new ticket when one was created; an unknown name is a 400.
   * `projectId` must name a `ready` project: its tree is copied into the ticket workspace before the worker starts.
   */
  createTicket(text: string, model?: string, secrets?: string[], projectId?: string): Promise<CreateTicketResult>

  /** Every stored secret, metadata only, sorted by name. */
  listSecrets(): SecretListItemView[]

  /** Create an operator secret. An existing name is a 409 `exists`; an invalid name/value is a 400 with issues. */
  createSecret(input: { name: string; value: string; description?: string }): { ok: true }

  /** Change a secret's value (rotation) and/or description. */
  updateSecret(name: string, input: { value?: string; description?: string }): { ok: true }

  /** Delete a secret and revoke it from every ticket. */
  deleteSecret(name: string): { ok: true }

  /** AI requests, newest first, with the ticket title resolved. */
  secretRequests(): SecretRequestView[]

  /** Grant or deny one pending request. Granting also grants the secret to the requesting ticket. */
  decideSecretRequest(id: string, decision: 'grant' | 'deny'): { ok: true }

  /** Names granted to one ticket. Throws 404 when the ticket is unknown. */
  ticketSecrets(id: string): string[]

  /** Replace a ticket's grants. An unknown secret name is a 400 with issues. */
  setTicketSecrets(id: string, names: readonly string[]): { ok: true; names: string[] }

  /** Stop a ticket as a person would; ends it and stops its worker. Throws `AdminError` when unknown. */
  stopTicket(id: string, reason?: string): void

  /** Retry a ticket whose worker failed, was blocked, or whose input delivery failed. Throws `AdminError` when not retryable. */
  retryTicket(id: string): void

  /** Send the worker extra background as a note input. Throws `AdminError` when unknown or ended. */
  noteTicket(id: string, text: string): void

  /** Answer the worker on the ticket's original thread, as a person. Throws `AdminError` when it has no thread to answer on. */
  replyTicket(id: string, text: string): void

  /** The most recent decisions, newest first, with raw reason codes (the API translates them). */
  decisions(limit: number, offset?: number, kind?: string): DecisionView[]

  /** The policy block as stored in `settings.json`, mapped onto the console's vocabulary. */
  getPolicy(): PolicyView

  /** Replace the whole policy block, persist it, notify the engine of policy effects, and report changed field names. */
  updatePolicy(input: PolicyInput): { changed: string[] }

  /** Check the Feishu credentials by fetching the bot identity; never throws, and never reports the secrets. */
  testFeishu(): Promise<FeishuTestResult>

  /** The Feishu transport's mode and connection state; never reports secrets. */
  feishuStatus(): FeishuStatusView

  /** Restart the Feishu long connection when it is selected, then return the new state; never reports secrets. */
  reconnectFeishu(): Promise<FeishuStatusView>

  /** Whether the vault holds `GITHUB_TOKEN`; the token itself is never returned. */
  githubTokenSet(): boolean

  /** Write or rotate `GITHUB_TOKEN` in the vault with origin `operator`. */
  setGithubToken(token: string): void

  /** Check the GitHub token against `/user` and each whitelisted repository; never throws, never reports the token. */
  testGithub(): Promise<GithubTestResultView>

  /** Whether the vault holds `GMAIL_APP_PASSWORD`; the password itself is never returned. */
  emailPasswordSet(): boolean

  /** Write or rotate `GMAIL_APP_PASSWORD` in the vault with origin `operator`. */
  setEmailPassword(password: string): void

  /** Log in to IMAP and verify SMTP; never throws, never reports the password. */
  testEmail(): Promise<EmailTestResultView>

  /** The Gmail poller's live state; never reports the password. */
  emailStatus(): EmailStatusView

  /** Keep `settings.policy.sources.email.allowed` in step with the console's sender whitelist. */
  setEmailAllowedSenders(senders: readonly string[]): { changed: boolean }

  /** Links attached to one ticket, such as pull requests; empty for an unknown ticket. */
  ticketLinks(id: string): TicketLinkView[]

  /** Toggle `paused` through the same path as `updatePolicy`, without rewriting the rest of the block. */
  setPaused(paused: boolean): { paused: boolean; changed: boolean }

  /** Containers, disk usage and limits for `GET /system`; a podman failure must not throw, only set `warning`. */
  system(): Promise<SystemExtras>

  /** List or delete the workspace and pi-config of tickets that ended more than `olderThanDays` ago. */
  cleanup(input: CleanupInput): Promise<CleanupResult>

  /**
   * Delete one ticket with its files. An open ticket is refused (409 `running`) unless `force`, which stops it first.
   * Unknown ids are 404 and ids outside `/^[A-Za-z0-9_-]+$/` are 400. Ledger and event history are kept.
   */
  deleteTicket(id: string, input: DeleteTicketInput): DeleteTicketResult

  /** Delete many tickets, reporting each id that could not be removed instead of failing the whole batch. */
  deleteTickets(ids: readonly string[], input: DeleteTicketInput): BatchDeleteResult

  /** Directories under the workspace root or `state/pi-config` whose name has no ticket in the database. */
  orphans(): OrphansResult

  /** Delete orphan directories by id; an id that gained a ticket since the listing is left alone. */
  cleanupOrphans(ids: readonly string[]): OrphanCleanupResult

  /** The state backups on disk, newest first. */
  backups(): BackupsResult

  /** Write one state backup now. */
  createBackup(): Promise<{ ok: true; item: BackupItemView }>

  /** Send one tiny request to a provider's model; never throws for a soft failure, and never reports the key. */
  modelTest(provider: string, model: string): Promise<UpstreamTestResult>

  /** Ask a provider which models it offers; read-only, never throws, and never reports the key. */
  discoverModels(input: DiscoverInput): Promise<DiscoverResult>

  /** The resolved absolute workspace root of a ticket, or undefined when the ticket has none; the API confines reads to it. */
  workspaceRoot(id: string): string | undefined

  /** Titles for a set of ticket ids, used to label the usage page's top tickets. */
  ticketTitles(ids: readonly string[]): Record<string, string>

  /** Files the worker left for a person (workspace root, output/, reports/, docs/), newest first. */
  deliverables(id: string): DeliverableView[]
}
