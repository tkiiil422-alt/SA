import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdminAuth } from '../src/admin/auth.ts'
import { createAdminApi } from '../src/admin/api.ts'
import {
  AdminError,
  type AdminHost,
  type AdminSettingsChange,
  type BackupItemView,
  type BackupsResult,
  type BatchDeleteResult,
  type CleanupInput,
  type CleanupResult,
  type DeleteTicketInput,
  type DeleteTicketResult,
  type OrphanCleanupResult,
  type OrphanItem,
  type OrphansResult,
  type CreateTicketResult,
  type DecisionView,
  type FeishuStatusView,
  type OverviewFacts,
  type PolicyInput,
  type PolicyView,
  type SettingsSection,
  type SystemExtras,
  type SystemInfo,
  type TicketDetailView,
  type TicketListQuery,
  type TicketListResult,
  type TicketPreviewView,
  type TicketStatusFilter,
  type DiscoverInput,
  type DiscoverResult,
  type UpstreamTestResult,
} from '../src/admin/host.ts'
import { decisionKindLabel, reasonLabel, ticketStatusLabel } from '../src/admin/labels.ts'
import { defaultOptions, OptionsStore } from '../src/admin/options.ts'
import { Vault, VaultError } from '../src/admin/vault.ts'
import { createAdminServer, type AdminServer } from '../src/admin/server.ts'
import { REASONS } from '../src/core/reasons.ts'
import { EventLog } from '../src/ledger/events.ts'
import { Ledger } from '../src/ledger/ledger.ts'

const PASSWORD = 'correct-horse-battery'
const CLI_TOKEN = 'cli-test-token-value'
const NOW = new Date()
const NOW_ISO = NOW.toISOString()

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-api-'))
  dirs.push(dir)
  return dir
}

// --- A tiny in-memory host ----------------------------------------------------------------------------------------

function ticket(input: Partial<TicketDetailView> & Pick<TicketDetailView, 'id' | 'title' | 'status' | 'stage' | 'needsPerson'>): TicketDetailView {
  return {
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    costUsd: 0,
    secrets: [],
    mandate: { strength: 'explicit', actor: { source: 'cli', id: 'operator' }, scope: 'cli', policyVersion: 'v1' },
    assignments: [],
    reports: [],
    canRetry: false,
    inputs: [],
    messages: [],
    workspace: { path: '', exists: false, fileCount: 0 },
    model: { ref: "default/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", providerName: "默认服务", source: "default" },
    ...input,
  }
}

class FakeHost implements AdminHost {
  constructor(readonly vault: Vault) {}

  policy: PolicyView = {
    paused: false,
    acceptMode: 'auto',
    evalTimeoutSeconds: 120,
    rules: [{ id: 'copy', name: '文字修正', enabled: true, instruction: '修正明显的错别字' }],
    allowedOperators: [{ id: 'operator', name: '操作员' }],
    feishuOperators: [],
  }

  readonly tickets = new Map<string, TicketDetailView>()
  readonly decisionsList: DecisionView[] = []
  readonly workspaceRoots = new Map<string, string>()
  readonly stopped: { id: string; reason?: string }[] = []
  readonly notes: { id: string; text: string }[] = []
  readonly replies: { id: string; text: string }[] = []
  readonly deleted: { id: string; input: DeleteTicketInput }[] = []
  orphanItems: OrphanItem[] = []
  backupItems: BackupItemView[] = []
  readonly backupDir = '/backups'
  lastText = ''
  created = 0

  info(): SystemInfo {
    return {
      version: '0.1.0',
      uptimeSec: 123,
      startedAt: NOW_ISO,
      node: process.version,
      platform: process.platform,
      stateDir: '/state',
      configPath: '/state/dist/config.json',
      gatewayUrl: 'http://127.0.0.1:1',
      mcpUrl: 'http://127.0.0.1:2/mcp',
    }
  }

  overview(): OverviewFacts {
    return {
      paused: this.policy.paused,
      acceptMode: this.policy.acceptMode,
      slots: { used: 1, max: 2, reservedForPerson: 1 },
      tickets: { open: 3, running: 1, needsPerson: 2, endedToday: 1 },
      attentionTickets: [{ id: 't4', title: '失败的重构', kind: 'failed' }],
      host: { load1: 0.4, cpuCount: 4, memUsedPct: 18, diskFreeGb: 849 },
      upstream: { ok: true, checkedAt: NOW_ISO, model: "deepseek-v4.1-flash", provider: "默认服务" },
    }
  }

  listTickets(query: TicketListQuery): TicketListResult {
    const all = [...this.tickets.values()].filter(item => {
      if (query.status === 'open') return item.status === 'open'
      if (query.status === 'ended') return item.status === 'ended'
      if (query.status === 'needs-person') return item.needsPerson
      return true
    }).filter(item => !query.q || item.title.toLowerCase().includes(query.q.toLowerCase()))
    return { total: all.length, items: all.slice(query.offset, query.offset + query.limit) }
  }

  ticket(id: string): TicketDetailView | undefined {
    return this.tickets.get(id)
  }

  ticketPreviews(_id: string): TicketPreviewView[] {
    return []
  }

  async createTicket(text: string, model?: string, secrets?: string[]): Promise<CreateTicketResult> {
    this.lastText = text
    this.created += 1
    const missing = (secrets ?? []).filter(name => !this.vault.has(name))
    if (missing.length > 0) throw new AdminError('invalid', '提交的内容有误，请检查标出来的字段。', 400, { issues: [{ path: 'secrets', message: missing.join('、') }] })
    const result = { ticketId: `t-new-${this.created}`, triggerId: 'tr-new', threadId: 'th-new', threadKey: 'cli:th-new', decision: 'accept' }
    if (secrets !== undefined) this.vault.setGrants(result.ticketId, secrets)
    return result
  }

  listSecrets() {
    return this.vault.list()
  }

  createSecret(input: { name: string; value: string; description?: string }): { ok: true } {
    this.vaultOp(() => this.vault.create(input.name, input.value, input.description ?? '', 'operator'))
    return { ok: true }
  }

  updateSecret(name: string, input: { value?: string; description?: string }): { ok: true } {
    this.vaultOp(() => this.vault.update(name, input))
    return { ok: true }
  }

  deleteSecret(name: string): { ok: true } {
    this.vaultOp(() => this.vault.remove(name))
    return { ok: true }
  }

  secretRequests() {
    return this.vault.requests().map(request => ({
      ...request,
      ticketTitle: this.tickets.get(request.ticketId)?.title ?? '',
    }))
  }

  decideSecretRequest(id: string, decision: 'grant' | 'deny'): { ok: true } {
    this.vaultOp(() => this.vault.decide(id, decision))
    return { ok: true }
  }

  ticketSecrets(id: string): string[] {
    this.require(id)
    return this.vault.grants(id)
  }

  setTicketSecrets(id: string, names: readonly string[]): { ok: true; names: string[] } {
    this.require(id)
    try {
      return { ok: true, names: this.vault.setGrants(id, names) }
    } catch (error) {
      if (error instanceof VaultError && error.code === 'not_found') {
        throw new AdminError('invalid', error.message, 400, { issues: [{ path: 'names', message: error.message }] })
      }
      throw error
    }
  }

  private vaultOp(work: () => void): void {
    try {
      work()
    } catch (error) {
      if (!(error instanceof VaultError)) throw error
      const status = error.code === 'exists' ? 409 : error.code === 'not_found' ? 404 : 400
      throw new AdminError(error.code, error.message, status, status === 400 ? { issues: [{ path: error.code === 'invalid_value' ? 'value' : 'name', message: error.message }] } : {})
    }
  }

  stopTicket(id: string, reason?: string): void {
    this.require(id)
    this.stopped.push({ id, ...(reason === undefined ? {} : { reason }) })
  }

  retryTicket(id: string): void {
    if (id === 't-notretry') throw new AdminError('not_retryable', '这张票现在不能重试。', 409)
    this.require(id)
  }

  noteTicket(id: string, text: string): void {
    this.require(id)
    this.notes.push({ id, text })
  }

  replyTicket(id: string, text: string): void {
    this.require(id)
    this.replies.push({ id, text })
  }

  decisions(limit: number, offset = 0, kind?: string): DecisionView[] {
    const items = kind === undefined ? this.decisionsList : this.decisionsList.filter((item) => item.kind === kind)
    return items.slice(offset, offset + limit)
  }

  testFeishu(): Promise<{ ok: boolean; message: string; botName?: string }> {
    return Promise.resolve({ ok: false, message: '飞书来源未启用。' })
  }

  feishuStatus(): FeishuStatusView {
    return { mode: 'webhook', state: 'off' }
  }

  reconnectFeishu(): Promise<FeishuStatusView> {
    return Promise.resolve(this.feishuStatus())
  }

  githubTokenSet(): boolean {
    return this.vault.has('GITHUB_TOKEN')
  }

  setGithubToken(token: string): void {
    this.vaultOp(() => {
      if (this.vault.has('GITHUB_TOKEN')) this.vault.update('GITHUB_TOKEN', { value: token })
      else this.vault.create('GITHUB_TOKEN', token, 'GitHub 访问令牌', 'operator')
    })
  }

  async testGithub() {
    return { ok: true, message: '连接正常', login: 'operator', repos: [] }
  }

  emailPasswordSet(): boolean {
    return this.vault.has('GMAIL_APP_PASSWORD')
  }

  setEmailPassword(password: string): void {
    this.vaultOp(() => {
      if (this.vault.has('GMAIL_APP_PASSWORD')) this.vault.update('GMAIL_APP_PASSWORD', { value: password })
      else this.vault.create('GMAIL_APP_PASSWORD', password, 'Gmail 应用专用密码', 'operator')
    })
  }

  async testEmail() {
    return { ok: true, message: '连接正常', imap: { ok: true, message: 'ok' }, smtp: { ok: true, message: 'ok' } }
  }

  emailStatus() {
    return { state: 'off' as const, processed: 0 }
  }

  setEmailAllowedSenders(_senders: readonly string[]): { changed: boolean } {
    return { changed: false }
  }

  ticketLinks(_id: string) {
    return []
  }

  getPolicy(): PolicyView {
    return structuredClone(this.policy)
  }

  updatePolicy(input: PolicyInput): { changed: string[] } {
    const changed: string[] = []
    if (this.policy.paused !== input.paused) changed.push('paused')
    if (this.policy.acceptMode !== input.acceptMode) changed.push('acceptMode')
    if (this.policy.evalTimeoutSeconds !== input.evalTimeoutSeconds) changed.push('evalTimeoutSeconds')
    if (JSON.stringify(this.policy.rules) !== JSON.stringify(input.rules)) changed.push('rules')
    if (JSON.stringify(this.policy.allowedOperators) !== JSON.stringify(input.allowedOperators)) changed.push('allowedOperators')
    this.policy = structuredClone(input)
    return { changed }
  }

  setPaused(paused: boolean): { paused: boolean; changed: boolean } {
    const changed = this.policy.paused !== paused
    this.policy.paused = paused
    return { paused, changed }
  }

  async system(): Promise<SystemExtras> {
    return {
      containers: [{ name: 'superagent-pi-t1', ticketId: 't1', status: 'running', runningFor: '2m' }],
      disk: { workspacesMb: 12, piConfigMb: 1, dbMb: 2, freeGb: 100 },
      limits: { maxWorkers: 2 },
    }
  }

  async cleanup(input: CleanupInput): Promise<CleanupResult> {
    const entry = {
      ticketId: 't3',
      title: '已完成的翻译',
      endedAt: NOW_ISO,
      ageDays: 5,
      workspacePath: '/workspaces/t3',
      piConfigPath: '/state/pi-config/t3',
      bytes: 1024,
    }
    return {
      dryRun: input.dryRun,
      olderThanDays: input.olderThanDays,
      entries: input.dryRun ? [entry] : [],
      deleted: input.dryRun ? [] : ['t3'],
      freedBytes: input.dryRun ? 0 : 1024,
    }
  }

  async modelTest(provider: string, model: string): Promise<UpstreamTestResult> {
    return { ok: true, status: 200, latencyMs: 42, message: '连接正常' }
  }

  async discoverModels(input: DiscoverInput): Promise<DiscoverResult> {
    return { ok: true, message: '找到 1 个模型。', models: [{ id: 'echo-model' }] }
  }

  workspaceRoot(id: string): string | undefined {
    return this.workspaceRoots.get(id)
  }

  ticketTitles(ids: readonly string[]): Record<string, string> {
    const titles: Record<string, string> = {}
    for (const id of ids) {
      const item = this.tickets.get(id)
      if (item) titles[id] = item.title
    }
    return titles
  }

  deliverables(): { path: string; size: number; mtime: string; kind: string }[] {
    return []
  }

  deleteTicket(id: string, input: DeleteTicketInput): DeleteTicketResult {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AdminError('invalid_path', '任务票编号不合法。', 400)
    const item = this.tickets.get(id)
    if (!item) throw new AdminError('not_found', '找不到这张任务票。', 404)
    if (item.status === 'open' && !input.force) throw new AdminError('running', '任务还在进行，请先停止再删除。', 409)
    this.tickets.delete(id)
    this.deleted.push({ id, input })
    return { ok: true, freedBytes: 1024 }
  }

  deleteTickets(ids: readonly string[], input: DeleteTicketInput): BatchDeleteResult {
    const deleted: string[] = []
    const skipped: { id: string; reason: string }[] = []
    let freedBytes = 0
    for (const id of ids) {
      try {
        freedBytes += this.deleteTicket(id, input).freedBytes
        deleted.push(id)
      } catch (error) {
        if (!(error instanceof AdminError)) throw error
        skipped.push({ id, reason: error.code })
      }
    }
    return { deleted, skipped, freedBytes }
  }

  orphans(): OrphansResult {
    return { items: this.orphanItems, totalBytes: this.orphanItems.reduce((total, item) => total + item.bytes, 0) }
  }

  cleanupOrphans(ids: readonly string[]): OrphanCleanupResult {
    const requested = new Set(ids)
    const deleted = this.orphanItems.filter(item => requested.has(item.id)).map(item => item.id)
    this.orphanItems = this.orphanItems.filter(item => !requested.has(item.id))
    return { deleted: [...new Set(deleted)], freedBytes: 512 }
  }

  backups(): BackupsResult {
    return { dir: this.backupDir, items: this.backupItems }
  }

  async createBackup(): Promise<{ ok: true; item: BackupItemView }> {
    const item = { name: 'state-20260102-030405.tgz', at: NOW_ISO, bytes: 2048 }
    this.backupItems = [item, ...this.backupItems]
    return { ok: true, item }
  }

  private require(id: string): void {
    if (!this.tickets.has(id)) throw new AdminError('not_found', '找不到这张任务票。', 404)
  }
}

// --- Harness ------------------------------------------------------------------------------------------------------

interface RequestOptions {
  method?: string
  body?: unknown
  /** `null` sends no cookie; omitted uses the harness cookie. */
  cookie?: string | null
  bearer?: string
  csrf?: boolean
  headers?: Record<string, string>
}

interface ApiResult {
  status: number
  text: string
  json: any
  headers: Headers
}

interface Harness {
  base: string
  cookie: string
  host: FakeHost
  auth: AdminAuth
  store: OptionsStore
  ledger: Ledger
  events: EventLog
  clock: { now: number }
  changes: AdminSettingsChange[]
  stateDir: string
  workspace: string
  outside: string
  generatedPassword?: string
  server: AdminServer
  db: DatabaseSync
  api: (path: string, options?: RequestOptions) => Promise<ApiResult>
  login: (password: string) => Promise<{ status: number; json: any; text: string; cookie: string; setCookie: string; headers: Headers }>
  close: () => Promise<void>
}

function setCookieOf(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const list = headers.getSetCookie?.() ?? []
  return list[0] ?? response.headers.get('set-cookie') ?? ''
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0] ?? ''
}

async function setup(options: { autoLogin?: boolean; generated?: boolean } = {}): Promise<Harness> {
  const stateDir = tempDir()
  const clock = { now: Date.now() }
  const auth = new AdminAuth({
    stateDir,
    env: options.generated ? {} : { SA_ADMIN_PASSWORD: PASSWORD },
    now: () => clock.now,
  })
  const init = auth.init()
  const store = new OptionsStore(join(stateDir, 'options.json'), defaultOptions({}))
  const db = new DatabaseSync(':memory:')
  const ledger = new Ledger(db)
  const events = new EventLog(db)

  const wsBase = tempDir()
  const workspace = join(wsBase, 'ws')
  const outside = join(wsBase, 'outside')
  mkdirSync(join(workspace, 'sub'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(workspace, 'hello.txt'), '你好，世界')
  writeFileSync(join(workspace, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]))
  writeFileSync(join(workspace, 'big.txt'), 'x'.repeat(250 * 1024))
  writeFileSync(join(workspace, 'sub', 'nested.txt'), 'nested')
  writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-WORKSPACE')

  const host = new FakeHost(new Vault(join(stateDir, 'vault.json'), { env: {}, now: () => NOW }))
  host.tickets.set('t1', ticket({
    id: 't1',
    title: '修一个错别字',
    status: 'open',
    stage: { stage: 'working' },
    needsPerson: false,
    costUsd: 0.12,
    assignments: [{ id: 'a1', state: 'running', createdAt: NOW_ISO, startedAt: NOW_ISO, report: { state: 'progress', summary: '正在修改', at: NOW_ISO } }],
    reports: [{ id: 'a1', assignmentId: 'a1', state: 'progress', summary: '正在修改', at: NOW_ISO }],
    inputs: [{ id: 'i1', kind: 'trigger', at: NOW_ISO, text: '修一个错别字', human: true, triggerId: 'tr1' }],
    messages: [{ id: 'm1', at: NOW_ISO, text: '收到', kind: 'acknowledgement', status: 'sent', sentAt: NOW_ISO }],
    workspace: { path: workspace, exists: true, fileCount: 3 },
  }))
  host.tickets.set('t2', ticket({
    id: 't2',
    title: '需要你确认方向',
    status: 'open',
    stage: { stage: 'person', action: 'answer' },
    needsPerson: true,
    question: '要保留原文吗？',
    costUsd: 0.3,
    attention: { id: 'att1', question: '要保留原文吗？', triggerId: 'tr2' },
  }))
  host.tickets.set('t3', ticket({
    id: 't3',
    title: '已完成的翻译',
    status: 'ended',
    stage: { stage: 'ended' },
    needsPerson: false,
    outcome: 'completed',
    costUsd: 0.5,
  }))
  host.tickets.set('t4', ticket({
    id: 't4',
    title: '失败的重构',
    status: 'open',
    stage: { stage: 'person', action: 'failed' },
    needsPerson: true,
    costUsd: 0.08,
    canRetry: true,
  }))
  host.workspaceRoots.set('t1', workspace)
  host.workspaceRoots.set('t2', join(wsBase, 'missing-dir'))
  host.decisionsList.push(
    {
      id: 'd1',
      at: NOW_ISO,
      kind: 'accept',
      threadKey: 'cli:th1',
      ticketId: 't1',
      triggerText: '修一个错别字',
      reasons: [{ code: 'explicitRouted' }],
      strength: 'explicit',
    },
    {
      id: 'd2',
      at: NOW_ISO,
      kind: 'ignore',
      threadKey: 'cli:th2',
      triggerText: '???',
      reasons: [{ code: 'sourceSpecificCode', values: { detail: 'x' } }],
      strength: 'inferred',
    },
  )

  const changes: AdminSettingsChange[] = []
  const apiHandler = createAdminApi({
    host,
    auth,
    options: store,
    ledger,
    events,
    cliToken: CLI_TOKEN,
    onPolicyOrSettingsChange: change => { changes.push(change) },
  })
  const server = createAdminServer({ api: apiHandler, staticHandler: () => false, port: 0 })
  const { port } = await server.listen()
  const base = `http://127.0.0.1:${port}`

  async function api(path: string, request: RequestOptions = {}): Promise<ApiResult> {
    const method = request.method ?? 'GET'
    const headers: Record<string, string> = { ...request.headers }
    const cookie = request.cookie === undefined ? undefined : request.cookie
    if (cookie) headers.cookie = cookie
    if (request.bearer !== undefined) headers.authorization = `Bearer ${request.bearer}`
    let body: string | undefined
    if (request.body !== undefined) body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
    if (method !== 'GET' && method !== 'HEAD') {
      if (request.csrf !== false) {
        headers['content-type'] = headers['content-type'] ?? 'application/json'
        headers['x-sa-request'] = headers['x-sa-request'] ?? '1'
      }
      if (body === undefined) body = ''
    }
    const response = await fetch(`${base}/api${path}`, { method, headers, ...(body === undefined ? {} : { body }) })
    const text = await response.text()
    let json: any = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      json = text
    }
    return { status: response.status, text, json, headers: response.headers }
  }

  async function login(password: string): Promise<{ status: number; json: any; text: string; cookie: string; setCookie: string; headers: Headers }> {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sa-request': '1' },
      body: JSON.stringify({ password }),
    })
    const text = await response.text()
    let json: any = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      json = text
    }
    const setCookie = setCookieOf(response)
    return { status: response.status, json, text, cookie: cookiePair(setCookie), setCookie, headers: response.headers }
  }

  // api() defaults to the harness cookie; login must not depend on that default, so expose it explicitly.
  const password = options.generated ? init.plaintext ?? '' : PASSWORD
  let cookie = ''
  if (options.autoLogin !== false) {
    const result = await login(password)
    if (result.status !== 200) throw new Error(`auto login failed: ${result.status} ${result.text}`)
    cookie = result.cookie
  }

  const harnessApi = (path: string, request: RequestOptions = {}): Promise<ApiResult> => {
    const effective = request.cookie === undefined ? { ...request, cookie } : request
    return api(path, effective)
  }

  return {
    base,
    get cookie() { return cookie },
    host,
    auth,
    store,
    ledger,
    events,
    clock,
    changes,
    stateDir,
    workspace,
    outside,
    generatedPassword: init.plaintext,
    server,
    db,
    api: harnessApi,
    login,
    close: async () => {
      await server.close()
      try {
        db.close()
      } catch {
        // Already closed; closing twice is harmless for the test.
      }
    },
  }
}

afterEach(async () => {
  // Harnesses are closed by each test through try/finally where they own a server; directories are always removed.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function recordCall(harness: Harness, overrides: Partial<Parameters<Ledger['record']>[0]> = {}): void {
  harness.ledger.record({
    at: new Date().toISOString(),
    ticketId: 't1',
    model: 'deepseek-v4.1-flash',
    status: 200,
    promptHit: 30,
    promptMiss: 70,
    completion: 5,
    costUsd: 0.25,
    latencyMs: 100,
    ...overrides,
  })
}

// --- Tests --------------------------------------------------------------------------------------------------------

describe('labels', () => {
  it('has Chinese wording for every core reason code and hides unknown codes in data', () => {
    for (const code of Object.keys(REASONS)) {
      const label = reasonLabel({ code })
      expect(label.text.length, code).toBeGreaterThan(0)
      expect(label.text, code).not.toBe('未识别的原因')
      expect(label.data, code).toBeUndefined()
    }
    const unknown = reasonLabel({ code: 'sourceSpecificCode', values: { detail: 'x' } })
    expect(unknown.text).toBe('未识别的原因')
    expect(unknown.data).toEqual({ code: 'sourceSpecificCode', values: { detail: 'x' } })
  })

  it('translates a legacy reason stored as a plain English sentence', () => {
    const legacy = reasonLabel({ code: 'said', values: { text: 'Direct request from the configured operator' } })
    expect(legacy.text).toBe('你在控制台或命令行直接下达的指令')
    expect(legacy.data).toBeUndefined()
    // A person's own words still pass through unchanged.
    expect(reasonLabel({ code: 'said', values: { text: '把价格页改成人民币' } }).text).toBe('把价格页改成人民币')
  })

  it('maps ticket stages and decision kinds to the seven human statuses', () => {
    expect(ticketStatusLabel({ stage: { stage: 'working' } })).toMatchObject({ label: '运行中' })
    expect(ticketStatusLabel({ stage: { stage: 'working', action: 'queued' } }).label).toBe('排队中')
    expect(ticketStatusLabel({ stage: { stage: 'person', action: 'answer' } }).label).toBe('等你回复')
    expect(ticketStatusLabel({ stage: { stage: 'person', action: 'failed' } }).label).toBe('需要你处理')
    expect(ticketStatusLabel({ stage: { stage: 'ended' }, status: 'ended', outcome: 'completed' }).label).toBe('已完成')
    expect(ticketStatusLabel({ stage: { stage: 'ended' }, status: 'ended', outcome: 'stopped' }).label).toBe('已停止')
    expect(ticketStatusLabel({ stage: { stage: 'ended' }, status: 'ended', outcome: 'dropped' }).label).toBe('已放弃')
    expect(decisionKindLabel('accept')).toBe('受理')
    expect(decisionKindLabel('unknownKind')).toBe('未识别的判断')
  })
})

describe('admin API authentication', () => {
  it('lets only health and login through without a session', async () => {
    const harness = await setup({ autoLogin: false })
    try {
      const health = await harness.api('/health', { cookie: null })
      expect(health.status).toBe(200)
      expect(health.json).toEqual({ ok: true, uptimeSec: 123 })

      for (const route of ['/me', '/overview', '/tickets', '/settings/policy', '/system']) {
        const response = await harness.api(route, { cookie: null })
        expect(response.status, route).toBe(401)
        expect(response.json.error, route).toBe('unauthorized')
      }

      const login = await harness.login(PASSWORD)
      expect(login.status).toBe(200)
      expect(login.json).toEqual({ ok: true })
      expect(login.setCookie).toContain('sa_session=')
      expect(login.setCookie).toContain('HttpOnly')
      expect(login.setCookie).toContain('SameSite=Strict')
      expect(login.setCookie).toContain('Path=/')
      expect(login.setCookie).toContain('Max-Age=43200')
      expect(login.setCookie).not.toContain('Secure')
    } finally {
      await harness.close()
    }
  })

  it('reports /me, logs out, and refuses an expired session', async () => {
    const harness = await setup()
    try {
      const me = await harness.api('/me')
      expect(me.status).toBe(200)
      expect(me.json).toEqual({ authenticated: true, usingGeneratedPassword: false })

      const logout = await harness.api('/logout', { method: 'POST', body: {} })
      expect(logout.status).toBe(200)
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
      expect((await harness.api('/me')).status).toBe(401)

      const again = await harness.login(PASSWORD)
      expect(again.status).toBe(200)
      harness.clock.now += 12 * 60 * 60 * 1000 + 1000
      const expired = await harness.api('/me', { cookie: again.cookie })
      expect(expired.status).toBe(401)
    } finally {
      await harness.close()
    }
  })

  it('rejects wrong passwords and locks the source after five failures', async () => {
    const harness = await setup({ autoLogin: false })
    try {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const result = await harness.login('wrong-password')
        expect(result.status).toBe(401)
        expect(result.json.error).toBe('bad_password')
      }
      const locked = await harness.login('wrong-password')
      expect(locked.status).toBe(429)
      expect(locked.json.error).toBe('locked')
      expect(locked.json.retryAfterSec).toBe(900)
      expect(locked.headers.get('retry-after')).toBe('900')

      const rightWhileLocked = await harness.login(PASSWORD)
      expect(rightWhileLocked.status).toBe(429)
      expect(rightWhileLocked.json.retryAfterSec).toBeGreaterThan(0)
    } finally {
      await harness.close()
    }
  })

  it('requires the CSRF header and JSON type on writes, but the CLI bearer token bypasses both', async () => {
    const harness = await setup()
    try {
      const noHeader = await harness.api('/pause', { method: 'POST', body: { paused: true }, csrf: false })
      expect(noHeader.status).toBe(403)
      expect(noHeader.json.error).toBe('csrf')

      const wrongType = await harness.api('/pause', {
        method: 'POST',
        body: { paused: true },
        headers: { 'content-type': 'text/plain' },
      })
      expect(wrongType.status).toBe(403)

      const bearer = await harness.api('/pause', {
        method: 'POST',
        body: { paused: true },
        cookie: null,
        bearer: CLI_TOKEN,
        csrf: false,
      })
      expect(bearer.status).toBe(200)
      expect(bearer.json).toMatchObject({ ok: true, paused: true, changed: true })

      const policy = await harness.api('/settings/policy', { cookie: null, bearer: CLI_TOKEN })
      expect(policy.status).toBe(200)
      expect(policy.json.paused).toBe(true)

      const badToken = await harness.api('/overview', { cookie: null, bearer: 'not-the-token' })
      expect(badToken.status).toBe(401)
    } finally {
      await harness.close()
    }
  })

  it('changes the password only with the right old one and forces a re-login', async () => {
    const harness = await setup()
    try {
      const wrongOld = await harness.api('/password', { method: 'POST', body: { old: 'nope', new: 'a-brand-new-password' } })
      expect(wrongOld.status).toBe(400)
      expect(wrongOld.json.error).toBe('bad_password')

      const tooShort = await harness.api('/password', { method: 'POST', body: { old: PASSWORD, new: '123456789' } })
      expect(tooShort.status).toBe(400)
      expect(tooShort.json.error).toBe('too_short')

      const changed = await harness.api('/password', { method: 'POST', body: { old: PASSWORD, new: 'a-brand-new-password' } })
      expect(changed.status).toBe(200)
      expect(changed.json).toEqual({ ok: true, relogin: true })
      expect(changed.headers.get('set-cookie')).toContain('Max-Age=0')
      expect((await harness.api('/me')).status).toBe(401)

      expect((await harness.login(PASSWORD)).status).toBe(401)
      expect((await harness.login('a-brand-new-password')).status).toBe(200)
    } finally {
      await harness.close()
    }
  })
})

describe('admin API reads', () => {
  it('returns the overview shape with usage, alerts and recent events', async () => {
    const harness = await setup()
    try {
      recordCall(harness)
      harness.events.add({ kind: 'ticket.created', text: '新任务已受理', ticketId: 't1', level: 'info' })

      const overview = await harness.api('/overview')
      expect(overview.status).toBe(200)
      expect(overview.json).toMatchObject({
        version: '0.1.0',
        uptimeSec: 123,
        paused: false,
        acceptMode: 'auto',
        slots: { used: 1, max: 2, reservedForPerson: 1 },
        tickets: { open: 3, running: 1, needsPerson: 2, endedToday: 1 },
        usage: { todayCalls: 1, dailyBudgetUsd: 5 },
        host: { load1: 0.4, cpuCount: 4, memUsedPct: 18, diskFreeGb: 849 },
      })
      expect(overview.json.usage.todayUsd).toBeCloseTo(0.25)
      expect(overview.json.usage.cacheHitRate).toBeCloseTo(0.3)
      expect(overview.json.usage.budgetUsedPct).toBeCloseTo(0.05)
      expect(overview.json.now).toBeTypeOf('string')
      expect(overview.json.recent[0]).toMatchObject({ kind: 'ticket.created' })
      expect(overview.json.alerts.some((alert: any) => alert.code === 'ticket.failed')).toBe(true)

      await harness.api('/pause', { method: 'POST', body: { paused: true } })
      const paused = await harness.api('/overview')
      expect(paused.json.paused).toBe(true)
      expect(paused.json.alerts.some((alert: any) => alert.code === 'policy.paused')).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('lists and filters tickets with Chinese stage labels', async () => {
    const harness = await setup()
    try {
      const all = await harness.api('/tickets?status=all&limit=2&offset=0')
      expect(all.status).toBe(200)
      expect(all.json.total).toBe(4)
      expect(all.json.items).toHaveLength(2)
      expect(all.json.items[0]).toMatchObject({ id: 't1', status: 'open', stageLabel: '运行中' })
      expect(all.json.items[0].stageHint).toContain('AI')
      expect(all.json.items[1]).toMatchObject({ id: 't2', stageLabel: '等你回复', needsPerson: true })

      const needs = await harness.api('/tickets?status=needs-person')
      expect(needs.json.total).toBe(2)
      expect(needs.json.items.map((item: any) => item.id).sort()).toEqual(['t2', 't4'])

      const ended = await harness.api('/tickets?status=ended')
      expect(ended.json.total).toBe(1)
      expect(ended.json.items[0]).toMatchObject({ id: 't3', stageLabel: '已完成', outcome: 'completed' })

      const search = await harness.api('/tickets?q=翻译')
      expect(search.json.items.map((item: any) => item.id)).toEqual(['t3'])

      const invalid = await harness.api('/tickets?status=sideways')
      expect(invalid.status).toBe(400)
    } finally {
      await harness.close()
    }
  })

  it('returns a ticket detail enriched with usage, calls and events', async () => {
    const harness = await setup()
    try {
      recordCall(harness, { ticketId: 't1', costUsd: 0.25 })
      harness.events.add({ kind: 'assignment.started', text: '开始执行', ticketId: 't1', level: 'info' })

      const detail = await harness.api('/tickets/t1')
      expect(detail.status).toBe(200)
      expect(detail.json).toMatchObject({
        id: 't1',
        title: '修一个错别字',
        stageLabel: '运行中',
        mandate: { strength: 'explicit', actor: { source: 'cli', id: 'operator' } },
        workspace: { path: harness.workspace, exists: true, fileCount: 3 },
      })
      expect(detail.json.assignments[0]).toMatchObject({ id: 'a1', state: 'running' })
      expect(detail.json.reports[0]).toMatchObject({ id: 'a1', state: 'progress' })
      expect(detail.json.inputs[0]).toMatchObject({ id: 'i1', kind: 'trigger' })
      expect(detail.json.messages[0]).toMatchObject({ id: 'm1', kind: 'acknowledgement' })
      expect(detail.json.usage).toMatchObject({ calls: 1 })
      expect(detail.json.usage.totalUsd).toBeCloseTo(0.25)
      expect(detail.json.calls).toHaveLength(1)
      expect(detail.json.events[0]).toMatchObject({ kind: 'assignment.started' })
      expect(detail.json.stageHint).toBeTypeOf('string')

      expect((await harness.api('/tickets/unknown')).status).toBe(404)
    } finally {
      await harness.close()
    }
  })

  it('creates tickets and rejects empty text and invalid JSON', async () => {
    const harness = await setup()
    try {
      const created = await harness.api('/tickets', { method: 'POST', body: { text: '  新任务  ' } })
      expect(created.status).toBe(200)
      expect(created.json).toMatchObject({ ok: true, ticketId: 't-new-1', triggerId: 'tr-new' })
      expect(harness.host.lastText).toBe('新任务')

      const empty = await harness.api('/tickets', { method: 'POST', body: { text: '   ' } })
      expect(empty.status).toBe(400)
      expect(empty.json.error).toBe('invalid')
      expect(empty.json.issues).toEqual([{ path: 'text', message: expect.stringContaining('任务内容') }])

      const broken = await harness.api('/tickets', { method: 'POST', body: '{not json' })
      expect(broken.status).toBe(400)
      expect(broken.json.error).toBe('invalid_json')
    } finally {
      await harness.close()
    }
  })

  it('stops, retries, notes and replies, mapping domain errors to statuses', async () => {
    const harness = await setup()
    try {
      const stop = await harness.api('/tickets/t1/stop', { method: 'POST', body: { reason: '方向不对' } })
      expect(stop.status).toBe(200)
      expect(harness.host.stopped).toEqual([{ id: 't1', reason: '方向不对' }])

      const missing = await harness.api('/tickets/unknown/stop', { method: 'POST', body: {} })
      expect(missing.status).toBe(404)
      expect(missing.json.error).toBe('not_found')

      expect((await harness.api('/tickets/t1/retry', { method: 'POST', body: {} })).status).toBe(200)
      const notRetryable = await harness.api('/tickets/t-notretry/retry', { method: 'POST', body: {} })
      expect(notRetryable.status).toBe(409)
      expect(notRetryable.json.error).toBe('not_retryable')

      expect((await harness.api('/tickets/t1/note', { method: 'POST', body: { text: '补充背景' } })).status).toBe(200)
      expect(harness.host.notes).toEqual([{ id: 't1', text: '补充背景' }])
      expect((await harness.api('/tickets/t1/note', { method: 'POST', body: { text: '' } })).status).toBe(400)

      expect((await harness.api('/tickets/t1/reply', { method: 'POST', body: { text: '按原文保留' } })).status).toBe(200)
      expect(harness.host.replies).toEqual([{ id: 't1', text: '按原文保留' }])
      expect((await harness.api('/tickets/t1/reply', { method: 'POST', body: { text: '' } })).status).toBe(400)
    } finally {
      await harness.close()
    }
  })

  it('returns decisions with Chinese labels and unknown reasons in data', async () => {
    const harness = await setup()
    try {
      const decisions = await harness.api('/decisions?limit=10')
      expect(decisions.status).toBe(200)
      expect(decisions.json.items).toHaveLength(2)
      expect(decisions.json.items[0]).toMatchObject({ kind: 'accept', kindLabel: '受理', ticketId: 't1' })
      expect(decisions.json.items[0].reasonText).toEqual(['允许的发送者明确请求，已经由调度器转交'])
      expect(decisions.json.items[1]).toMatchObject({ kindLabel: '忽略' })
      expect(decisions.json.items[1].reasonText).toEqual(['未识别的原因'])
      expect(decisions.json.items[1].data).toEqual({ reasons: [{ code: 'sourceSpecificCode', values: { detail: 'x' } }] })
    } finally {
      await harness.close()
    }
  })

  it('returns usage summaries, calls and events', async () => {
    const harness = await setup()
    try {
      recordCall(harness, { ticketId: 't1', costUsd: 0.25, promptHit: 30, promptMiss: 70 })
      recordCall(harness, { ticketId: 't1', costUsd: 0.5, promptHit: 0, promptMiss: 100, model: 'other-model' })
      recordCall(harness, { ticketId: 't2', costUsd: 0.1 })
      harness.events.add({ kind: 'policy.changed', text: '受理规则已更新', level: 'info' })
      harness.events.add({ kind: 'assignment.ended', text: '执行结束：failed', level: 'warn' })

      const usage = await harness.api('/usage?range=today')
      expect(usage.status).toBe(200)
      expect(usage.json.totals).toMatchObject({ calls: 3 })
      expect(usage.json.totals.usd).toBeCloseTo(0.85)
      expect(usage.json.byDay).toHaveLength(1)
      expect(usage.json.byModel.length).toBeGreaterThan(0)
      expect(usage.json.topTickets[0]).toMatchObject({ ticketId: 't1', title: '修一个错别字' })

      const calls = await harness.api('/usage/calls?ticketId=t1&limit=1')
      expect(calls.status).toBe(200)
      expect(calls.json.items).toHaveLength(1)
      expect(calls.json.items[0]).toMatchObject({ ticketId: 't1', costUsd: 0.5 })

      const warnings = await harness.api('/events?level=warn')
      expect(warnings.status).toBe(200)
      expect(warnings.json.items).toHaveLength(1)
      expect(warnings.json.items[0]).toMatchObject({ kind: 'assignment.ended', level: 'warn' })

      expect((await harness.api('/usage?range=year')).status).toBe(400)
      expect((await harness.api('/events?level=fatal')).status).toBe(400)
    } finally {
      await harness.close()
    }
  })

  it('reports generated passwords', async () => {
    const harness = await setup({ generated: true })
    try {
      const me = await harness.api('/me')
      expect(me.json.usingGeneratedPassword).toBe(true)
      const overview = await harness.api('/overview')
      expect(overview.json.alerts.some((alert: any) => alert.code === 'auth.generated')).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('returns system information and can preview or perform cleanup', async () => {
    const harness = await setup()
    try {
      const system = await harness.api('/system')
      expect(system.status).toBe(200)
      expect(system.json).toMatchObject({
        version: '0.1.0',
        uptimeSec: 123,
        node: process.version,
        platform: process.platform,
        stateDir: '/state',
        configPath: '/state/dist/config.json',
        gatewayUrl: 'http://127.0.0.1:1',
        mcpUrl: 'http://127.0.0.1:2/mcp',
        limits: { maxWorkers: 2 },
      })
      expect(system.json.containers).toHaveLength(1)
      expect(system.json.disk).toMatchObject({ freeGb: 100 })

      const preview = await harness.api('/system/cleanup', { method: 'POST', body: { olderThanDays: 30, dryRun: true } })
      expect(preview.status).toBe(200)
      expect(preview.json).toMatchObject({ dryRun: true, olderThanDays: 30, deleted: [], freedBytes: 0 })
      expect(preview.json.entries).toHaveLength(1)

      const perform = await harness.api('/system/cleanup', { method: 'POST', body: { olderThanDays: 30, dryRun: false } })
      expect(perform.json).toMatchObject({ dryRun: false, deleted: ['t3'], freedBytes: 1024 })

      const invalid = await harness.api('/system/cleanup', { method: 'POST', body: { olderThanDays: -1, dryRun: true } })
      expect(invalid.status).toBe(400)
      expect(invalid.json.issues[0].path).toBe('olderThanDays')

      const events = await harness.api('/events?limit=10')
      expect(events.json.items.some((event: any) => event.kind === 'admin.cleanup')).toBe(true)
    } finally {
      await harness.close()
    }
  })
})

describe('admin API secrets', () => {
  it('creates, lists without values, rotates and deletes a secret', async () => {
    const harness = await setup()
    try {
      const created = await harness.api('/secrets', { method: 'POST', body: { name: 'API_TOKEN', value: 'super-secret-value', description: '接口密钥' } })
      expect(created.status).toBe(200)
      expect(created.json).toEqual({ ok: true })

      const list = await harness.api('/secrets')
      expect(list.status).toBe(200)
      expect(list.json.items).toEqual([{
        name: 'API_TOKEN', description: '接口密钥', origin: 'operator', createdAt: NOW_ISO, grantedTickets: 0,
      }])
      expect(list.text).not.toContain('super-secret-value')

      const duplicate = await harness.api('/secrets', { method: 'POST', body: { name: 'API_TOKEN', value: 'other' } })
      expect(duplicate.status).toBe(409)
      expect(duplicate.json.error).toBe('exists')

      const invalid = await harness.api('/secrets', { method: 'POST', body: { name: 'api_token', value: 'x' } })
      expect(invalid.status).toBe(400)
      expect(invalid.json.issues[0].path).toBe('name')

      const reserved = await harness.api('/secrets', { method: 'POST', body: { name: 'SA_TICKET_TOKEN', value: 'x' } })
      expect(reserved.status).toBe(400)

      const rotated = await harness.api('/secrets/API_TOKEN', { method: 'PUT', body: { value: 'rotated-value' } })
      expect(rotated.status).toBe(200)
      expect(harness.host.vault.reveal('API_TOKEN')).toBe('rotated-value')

      const removed = await harness.api('/secrets/API_TOKEN', { method: 'DELETE' })
      expect(removed.status).toBe(200)
      expect(harness.host.vault.has('API_TOKEN')).toBe(false)
    } finally {
      await harness.close()
    }
  })

  it('lists AI requests with the ticket title and decides one', async () => {
    const harness = await setup()
    try {
      harness.host.vault.create('API_TOKEN', 'super-secret-value', '', 'operator')
      const request = harness.host.vault.addRequest({ ticketId: 't1', name: 'API_TOKEN', why: '调用接口' })

      const listed = await harness.api('/secrets/requests')
      expect(listed.status).toBe(200)
      expect(listed.json.items).toEqual([{
        id: request.id, ticketId: 't1', ticketTitle: '修一个错别字', name: 'API_TOKEN', why: '调用接口', at: NOW_ISO, status: 'pending',
      }])
      expect(listed.text).not.toContain('super-secret-value')

      const decided = await harness.api(`/secrets/requests/${request.id}`, { method: 'POST', body: { decision: 'grant' } })
      expect(decided.status).toBe(200)
      expect(harness.host.vault.grants('t1')).toEqual(['API_TOKEN'])

      const invalid = await harness.api(`/secrets/requests/${request.id}`, { method: 'POST', body: { decision: 'maybe' } })
      expect(invalid.status).toBe(400)
    } finally {
      await harness.close()
    }
  })

  it('shows and replaces a ticket\'s granted secrets, and grants at ticket creation', async () => {
    const harness = await setup()
    try {
      harness.host.vault.create('API_TOKEN', 'super-secret-value', '', 'operator')
      harness.host.vault.create('OTHER', 'other-value', '', 'operator')

      const granted = await harness.api('/tickets/t1/secrets', { method: 'PUT', body: { names: ['API_TOKEN'] } })
      expect(granted.status).toBe(200)
      expect(granted.json).toEqual({ ok: true, names: ['API_TOKEN'] })

      const detail = await harness.api('/tickets/t1')
      expect(detail.json.secrets).toEqual(['API_TOKEN'])
      expect(detail.text).not.toContain('super-secret-value')

      const missing = await harness.api('/tickets/t1/secrets', { method: 'PUT', body: { names: ['NOPE'] } })
      expect(missing.status).toBe(400)

      const created = await harness.api('/tickets', { method: 'POST', body: { text: '新任务', secrets: ['OTHER'] } })
      expect(created.status).toBe(200)
      expect(harness.host.vault.grants('t-new-1')).toEqual(['OTHER'])

      const unknownAtCreate = await harness.api('/tickets', { method: 'POST', body: { text: '新任务', secrets: ['NOPE'] } })
      expect(unknownAtCreate.status).toBe(400)
      expect(unknownAtCreate.json.issues[0].path).toBe('secrets')
    } finally {
      await harness.close()
    }
  })
})

describe('admin API deletion and system maintenance', () => {
  it('deletes an ended ticket, refuses an open one, and validates the id', async () => {
    const harness = await setup()
    try {
      const open = await harness.api('/tickets/t1', { method: 'DELETE', body: {} })
      expect(open.status).toBe(409)
      expect(open.json).toMatchObject({ error: 'running', message: '任务还在进行，请先停止再删除。' })

      const ended = await harness.api('/tickets/t3', { method: 'DELETE', body: {} })
      expect(ended.status).toBe(200)
      expect(ended.json).toEqual({ ok: true, freedBytes: 1024 })
      expect(harness.host.deleted[0]).toEqual({ id: 't3', input: { deleteWorkspace: true, force: false } })

      const missing = await harness.api('/tickets/nope', { method: 'DELETE', body: {} })
      expect(missing.status).toBe(404)

      const unsafe = await harness.api('/tickets/bad%20id', { method: 'DELETE', body: {} })
      expect(unsafe.status).toBe(400)
      expect(unsafe.json.error).toBe('invalid_path')

      const forced = await harness.api('/tickets/t1', { method: 'DELETE', body: { force: true, deleteWorkspace: false } })
      expect(forced.status).toBe(200)
      expect(harness.host.deleted.at(-1)).toEqual({ id: 't1', input: { deleteWorkspace: false, force: true } })
    } finally {
      await harness.close()
    }
  })

  it('deletes a batch and reports each id it could not remove', async () => {
    const harness = await setup()
    try {
      const empty = await harness.api('/tickets/delete', { method: 'POST', body: { ids: [] } })
      expect(empty.status).toBe(400)

      const batch = await harness.api('/tickets/delete', {
        method: 'POST', body: { ids: ['t3', 'missing', 'bad/id'], force: true },
      })
      expect(batch.status).toBe(200)
      expect(batch.json).toEqual({
        deleted: ['t3'],
        skipped: [{ id: 'missing', reason: 'not_found' }, { id: 'bad/id', reason: 'invalid_path' }],
        freedBytes: 1024,
      })
    } finally {
      await harness.close()
    }
  })

  it('lists orphans, cleans the chosen ones, and records the cleanup', async () => {
    const harness = await setup()
    try {
      harness.host.orphanItems = [
        { id: 'o1', kind: 'workspace', path: '/ws/o1', bytes: 100 },
        { id: 'o2', kind: 'pi-config', path: '/state/pi-config/o2', bytes: 50 },
      ]
      const listed = await harness.api('/system/orphans')
      expect(listed.status).toBe(200)
      expect(listed.json.totalBytes).toBe(150)
      expect(listed.json.items).toHaveLength(2)

      const cleanup = await harness.api('/system/orphans/cleanup', { method: 'POST', body: { ids: ['o1'] } })
      expect(cleanup.status).toBe(200)
      expect(cleanup.json).toEqual({ deleted: ['o1'], freedBytes: 512 })

      const events = await harness.api('/events?limit=10')
      expect(events.json.items.some((event: any) => event.kind === 'admin.cleanup')).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('lists backups and can create one', async () => {
    const harness = await setup()
    try {
      const before = await harness.api('/system/backups')
      expect(before.status).toBe(200)
      expect(before.json).toEqual({ dir: '/backups', items: [] })

      const created = await harness.api('/system/backups', { method: 'POST', body: {} })
      expect(created.status).toBe(200)
      expect(created.json).toMatchObject({ ok: true, item: { name: 'state-20260102-030405.tgz', bytes: 2048 } })

      const after = await harness.api('/system/backups')
      expect(after.json.items.map((item: any) => item.name)).toEqual(['state-20260102-030405.tgz'])
    } finally {
      await harness.close()
    }
  })
})

describe('admin API settings', () => {
  it('accepts every settings view echoed back unchanged', async () => {
    // The page saves the draft it was given; a read-only field in a GET view must never make that save fail.
    const harness = await setup()
    try {
      for (const section of ['policy', 'executor', 'models', 'budget', 'feishu', 'github', 'email']) {
        const view = await harness.api(`/settings/${section}`)
        expect(view.status, section).toBe(200)
        const back = await harness.api(`/settings/${section}`, { method: 'PUT', body: view.json })
        expect(back.status, `${section}: ${back.text}`).toBe(200)
      }
    } finally {
      await harness.close()
    }
  })

  it('reads and writes policy with validation issues and change notes', async () => {
    const harness = await setup()
    try {
      const initial = await harness.api('/settings/policy')
      expect(initial.status).toBe(200)
      expect(initial.json).toMatchObject({ paused: false, acceptMode: 'auto', evalTimeoutSeconds: 120 })
      expect(initial.json.rules[0]).toMatchObject({ id: 'copy', enabled: true })
      expect(initial.json.allowedOperators[0]).toMatchObject({ id: 'operator' })

      const valid = {
        paused: false,
        acceptMode: 'observe',
        evalTimeoutSeconds: 180,
        rules: [{ id: 'copy', name: '文字修正', enabled: true, instruction: '修正明显的错别字' }],
        allowedOperators: [{ id: 'operator', name: '操作员' }],
      }
      const saved = await harness.api('/settings/policy', { method: 'PUT', body: valid })
      expect(saved.status).toBe(200)
      expect(saved.json).toMatchObject({ ok: true, changed: ['acceptMode', 'evalTimeoutSeconds'] })
      expect(saved.json.note).toContain('受理规则')

      const after = await harness.api('/settings/policy')
      expect(after.json.acceptMode).toBe('observe')

      const badMode = await harness.api('/settings/policy', { method: 'PUT', body: { ...valid, acceptMode: 'sometimes' } })
      expect(badMode.status).toBe(400)
      expect(badMode.json.issues[0].path).toBe('acceptMode')

      const badTimeout = await harness.api('/settings/policy', { method: 'PUT', body: { ...valid, evalTimeoutSeconds: 1 } })
      expect(badTimeout.status).toBe(400)
      expect(badTimeout.json.issues[0]).toMatchObject({ path: 'evalTimeoutSeconds' })

      const duplicateRules = await harness.api('/settings/policy', {
        method: 'PUT',
        body: { ...valid, rules: [valid.rules[0], valid.rules[0]] },
      })
      expect(duplicateRules.status).toBe(400)
      expect(duplicateRules.json.issues[0].path).toBe('rules')

      expect(harness.changes.some(change => change.section === 'policy' && change.policy?.acceptMode === 'observe')).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('reads and writes executor, budget and the pause switch', async () => {
    const harness = await setup()
    try {
      const executor = await harness.api('/settings/executor')
      expect(executor.json).toEqual({ maxWorkers: 2, cpus: '2', memory: '6g', image: 'localhost/superagent-pi:1.5.0' })

      const saved = await harness.api('/settings/executor', {
        method: 'PUT',
        body: { maxWorkers: 3, cpus: '1.5', memory: '2g', image: 'localhost/superagent-pi:1.5.0' },
      })
      expect(saved.status).toBe(200)
      expect(saved.json.changed).toEqual(['executor.maxWorkers', 'executor.cpus', 'executor.memory'])
      expect(saved.json.note).toContain('并发上限')
      expect((await harness.api('/settings/executor')).json.maxWorkers).toBe(3)

      const invalidExecutor = await harness.api('/settings/executor', {
        method: 'PUT',
        body: { maxWorkers: 0, cpus: 'many', memory: '6gb', image: '' },
      })
      expect(invalidExecutor.status).toBe(400)
      expect(invalidExecutor.json.error).toBe('invalid')
      // Section endpoints report field paths relative to the section, matching the settings form's `data-field` names.
      expect(invalidExecutor.json.issues.map((issue: any) => issue.path)).toEqual(
        expect.arrayContaining(['maxWorkers', 'cpus', 'memory', 'image']),
      )
      for (const issue of invalidExecutor.json.issues) expect(issue.message).toMatch(/[一-龥]/)

      const budget = await harness.api('/settings/budget')
      expect(budget.json).toEqual({ enabled: true, perTicketUsd: 0.5, dailyUsd: 5 })
      const savedBudget = await harness.api('/settings/budget', { method: 'PUT', body: { enabled: true, perTicketUsd: 0.5, dailyUsd: 9 } })
      expect(savedBudget.json.changed).toEqual(['budget.dailyUsd'])
      expect(savedBudget.json.note).toContain('预算')
      expect((await harness.api('/settings/budget')).json.dailyUsd).toBe(9)
      expect((await harness.api('/settings/budget', { method: 'PUT', body: { enabled: true, perTicketUsd: 0.5, dailyUsd: -1 } })).status).toBe(400)

      const paused = await harness.api('/pause', { method: 'POST', body: { paused: true } })
      expect(paused.json).toMatchObject({ ok: true, paused: true, changed: true })
      expect(paused.json.note).toContain('暂停')
      expect((await harness.api('/settings/policy')).json.paused).toBe(true)
      const resumed = await harness.api('/pause', { method: 'POST', body: { paused: false } })
      expect(resumed.json).toMatchObject({ paused: false, changed: true })
      expect((await harness.api('/settings/policy')).json.paused).toBe(false)

      expect(harness.changes.map(change => change.section)).toEqual(expect.arrayContaining(['executor', 'budget', 'pause']))
    } finally {
      await harness.close()
    }
  })

  it('never exposes the provider key in any response or event, and keeps it when omitted', async () => {
    const harness = await setup()
    const secret = 'sk-UNIQUE-SECRET-9f3a'
    const routing = {
      worker: { provider: 'default', model: 'deepseek-v4.1-flash' },
      assessor: { enabled: false, provider: 'default', model: 'deepseek-v4.1-flash', timeoutSec: 30 },
      autoSelect: false,
    }
    const providers = [{
      id: 'default', name: '默认服务', api: 'openai-completions', baseUrl: 'https://api.deepseek.com',
      apiKey: secret, sessionHeader: '', enabled: true,
      models: [{ id: 'deepseek-v4.1-flash', price: { input: 0.3, cacheRead: 0.006, output: 1.2 } }],
    }]
    try {
      const saved = await harness.api('/settings/models', { method: 'PUT', body: { providers, routing } })
      expect(saved.status).toBe(200)
      expect(saved.text).not.toContain(secret)
      expect(saved.json.changed).toContain('models.providers.0.apiKey')

      const models = await harness.api('/settings/models')
      expect(models.status).toBe(200)
      expect(models.text).not.toContain(secret)
      expect(models.json.providers[0]).toMatchObject({ apiKeySet: true, apiKeyTail: '9f3a' })
      expect('apiKey' in models.json.providers[0]).toBe(false)

      // Omitting apiKey keeps the stored key of the same provider id.
      const kept = structuredClone(providers) as Array<Record<string, unknown>>
      delete kept[0]!.apiKey
      kept[0]!.name = '改名后的服务'
      const renamed = await harness.api('/settings/models', { method: 'PUT', body: { providers: kept, routing } })
      expect(renamed.status).toBe(200)
      expect(renamed.json.changed).toContain('models.providers.0.name')
      const after = (await harness.api('/settings/models')).json
      expect(after.providers[0]).toMatchObject({ apiKeySet: true, name: '改名后的服务' })

      // A routing pointer to a missing model is a 400 on the models.-prefixed path.
      const bad = await harness.api('/settings/models', {
        method: 'PUT',
        body: { providers: kept, routing: { ...routing, worker: { provider: 'nope', model: 'x' } } },
      })
      expect(bad.status).toBe(400)
      expect(bad.json.issues[0]).toMatchObject({ path: 'models.routing.worker' })

      const routes = [
        '/me', '/overview', '/tickets', '/tickets/t1', '/tickets/t1/files', '/decisions', '/usage', '/usage/calls', '/events',
        '/settings/policy', '/settings/executor', '/settings/models', '/settings/budget', '/models', '/system',
      ]
      for (const route of routes) {
        const response = await harness.api(route)
        expect(response.text, route).not.toContain(secret)
      }
      expect((await harness.api('/events?limit=50')).text).not.toContain(secret)

      // A page that echoes the GET view back must not be rejected for its read-only markers.
      const view = (await harness.api('/settings/models')).json
      const echoed = await harness.api('/settings/models', { method: 'PUT', body: view })
      expect(echoed.status, echoed.text).toBe(200)

      const test = await harness.api('/settings/models/test', { method: 'POST', body: { provider: 'default', model: 'deepseek-v4.1-flash' } })
      expect(test.status).toBe(200)
      expect(test.json).toEqual({ ok: true, status: 200, latencyMs: 42, message: '连接正常' })
    } finally {
      await harness.close()
    }
  })

  it('discovers models: 400 on a bad body, 200 passes the host result through, the typed key is never echoed', async () => {
    const harness = await setup()
    try {
      const typed = 'sk-typed-discover-key-777'
      const bad = await harness.api('/settings/models/discover', { method: 'POST', body: { api: 'nope', baseUrl: 'ftp://example.test' } })
      expect(bad.status).toBe(400)
      expect(bad.json.issues).toEqual(expect.any(Array))
      const extra = await harness.api('/settings/models/discover', { method: 'POST', body: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', unexpected: true } })
      expect(extra.status).toBe(400)

      const ok = await harness.api('/settings/models/discover', { method: 'POST', body: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: typed } })
      expect(ok.status).toBe(200)
      expect(ok.json).toEqual({ ok: true, message: '找到 1 个模型。', models: [{ id: 'echo-model' }] })
      expect(ok.text).not.toContain(typed)
    } finally {
      await harness.close()
    }
  })
})

describe('admin API workspace files', () => {
  it('lists, reads and confines workspace files', async () => {
    const harness = await setup()
    try {
      const root = await harness.api('/tickets/t1/files?path=')
      expect(root.status).toBe(200)
      expect(root.json).toMatchObject({ exists: true, type: 'dir', path: '' })
      const names = root.json.entries.map((entry: any) => entry.name)
      expect(names).toEqual(expect.arrayContaining(['hello.txt', 'sub', 'blob.bin']))
      expect(root.json.entries.find((entry: any) => entry.name === 'sub').type).toBe('dir')

      const text = await harness.api(`/tickets/t1/files?path=${encodeURIComponent('hello.txt')}`)
      expect(text.status).toBe(200)
      expect(text.json).toMatchObject({ exists: true, type: 'file', name: 'hello.txt', text: '你好，世界', truncated: false })

      const nested = await harness.api(`/tickets/t1/files?path=${encodeURIComponent('sub/nested.txt')}`)
      expect(nested.json.text).toBe('nested')

      const directory = await harness.api(`/tickets/t1/files?path=${encodeURIComponent('sub')}`)
      expect(directory.json.entries.map((entry: any) => entry.name)).toContain('nested.txt')

      const binary = await harness.api(`/tickets/t1/files?path=${encodeURIComponent('blob.bin')}`)
      expect(binary.json).toMatchObject({ exists: true, type: 'file', binary: true })
      expect(binary.json.text).toBeUndefined()

      const large = await harness.api(`/tickets/t1/files?path=${encodeURIComponent('big.txt')}`)
      expect(large.json.truncated).toBe(true)
      expect((large.json.text as string).length).toBe(200 * 1024)

      const escapes = [
        '../outside/secret.txt',
        'sub/../../outside/secret.txt',
        '/etc/passwd',
        'C:/Windows/win.ini',
        '..\\outside\\secret.txt',
        'hello.txt\u0000',
      ]
      for (const path of escapes) {
        const response = await harness.api(`/tickets/t1/files?path=${encodeURIComponent(path)}`)
        expect(response.status, path).toBe(400)
        expect(response.text, path).not.toContain('TOP-SECRET-WORKSPACE')
      }

      // Double encoding decodes once to a literal file name under the root; it must not reach the outside file.
      const doubleEncoded = await harness.api('/tickets/t1/files?path=%252e%252e%252foutside%252fsecret.txt')
      expect(doubleEncoded.text).not.toContain('TOP-SECRET-WORKSPACE')

      expect((await harness.api('/tickets/unknown/files?path=')).status).toBe(404)

      const missingWorkspace = await harness.api('/tickets/t2/files?path=')
      expect(missingWorkspace.status).toBe(200)
      expect(missingWorkspace.json.exists).toBe(false)

      const link = join(harness.workspace, 'escape.txt')
      let created = false
      try {
        symlinkSync(join(harness.outside, 'secret.txt'), link, 'file')
        created = true
      } catch {
        // Windows often denies symlink creation without Developer Mode or elevation; the case is skipped there.
      }
      if (created) {
        const escaped = await harness.api(`/tickets/t1/files?path=${encodeURIComponent('escape.txt')}`)
        expect([400, 403]).toContain(escaped.status)
        expect(escaped.text).not.toContain('TOP-SECRET-WORKSPACE')
      }
    } finally {
      await harness.close()
    }
  })
})

describe('admin API limits', () => {
  it('rejects request bodies over 1MB', async () => {
    const harness = await setup()
    try {
      const huge = JSON.stringify({ text: 'a'.repeat(1_050_000) })
      const response = await harness.api('/tickets', { method: 'POST', body: huge })
      expect(response.status).toBe(413)
      expect(response.json.error).toBe('body_too_large')
    } finally {
      await harness.close()
    }
  })

  it('returns 404 for unknown /api routes but falls through for other paths', async () => {
    const harness = await setup()
    try {
      const unknown = await harness.api('/does-not-exist')
      expect(unknown.status).toBe(404)
      expect(unknown.json.error).toBe('not_found')

      // The API handler must not claim a non-/api path; the server then falls through to the static handler / its own 404.
      const response = await fetch(`${harness.base}/index.html`)
      expect(response.status).toBe(404)
    } finally {
      await harness.close()
    }
  })
})
