/**
 * The admin console's JSON API.
 *
 * `createAdminApi` returns a `(req, res) => Promise<boolean>` handler for `/api/*`: it returns true when it handled the
 * request and false for every other path, so the server can fall through to the static files.
 *
 * Security (04-background design §1): every route except `GET /health`, `POST /login` and the static pages needs a
 * session cookie or the CLI Bearer token; every write also needs `X-SA-Request: 1` and a JSON content type, unless it
 * authenticated with the CLI token. Passwords are only ever compared by `AdminAuth`, the upstream key is never echoed,
 * and every API response is `Cache-Control: no-store`.
 */
import { spawn } from 'node:child_process'
import { closeSync, createReadStream, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { checkCliToken, clientIp } from './auth.ts'
import type { AdminAuth } from './auth.ts'
import {
  AdminError,
  type AdminHost,
  type AdminIssue,
  type AdminSettingsChange,
  type PolicyInput,
  type SettingsSection,
  type TicketStatusFilter,
  type TicketSummaryView,
} from './host.ts'
import { decisionKindLabel, reasonLabels, ticketStatusLabel } from './labels.ts'
import { OptionsError, OptionsSchema, SshConnectionSchema as SshConnectionOptionSchema, findModel, formatRef } from './options.ts'
import type { Options, OptionsStore } from './options.ts'
import type { EventLevel, EventLog } from '../ledger/events.ts'
import type { Ledger, UsageRange } from '../ledger/ledger.ts'
import { LIMITS } from '../limits.ts'
import { UploadConflict, type ProjectService } from '../projects/service.ts'
import { MAX_COUNCIL_BRIEF_CHARS, type CouncilService } from '../council/service.ts'
import { NovelError, type NovelService } from '../novel/service.ts'
import type { ActivityLog } from '../executor/activity.ts'
import type { FanqieService } from '../fanqie/service.ts'
import { PiVersionError, type PiVersionService } from '../executor/pi-versions.ts'
import { DevEnvError, type DevEnvService } from '../executor/dev-env.ts'
import { keySecretName, looksLikeKey, scanHostKeys } from '../ssh/connections.ts'
import { GoalError, resolveGoal, type GoalService, type GoalSpec } from '../goal/service.ts'
import { PentestError, type PentestService } from '../pentest/service.ts'
import type { DirectorService } from '../director/service.ts'

export interface CreateAdminApiOptions {
  host: AdminHost
  auth: AdminAuth
  options: OptionsStore
  ledger: Ledger
  events: EventLog
  /** When set, `Authorization: Bearer <cliToken>` is accepted instead of the session cookie and skips the CSRF check. */
  cliToken?: string
  /** Called after a settings write was persisted, so the runtime can refresh what it caches. */
  onPolicyOrSettingsChange?: (change: AdminSettingsChange) => void
  /** The project library. Absent only in tests that do not exercise uploads or projects. */
  projects?: ProjectService
  /** Multi-role councils. Absent only in tests that do not exercise them. */
  councils?: CouncilService
  /** Each worker's recent steps, kept in memory by the executor. Absent in tests that do not exercise it. */
  activity?: Pick<ActivityLog, 'list'>
  /** The book library. Absent in tests that do not exercise it; its routes answer 404 while `novel.enabled` is off. */
  novels?: NovelService
  /** Fanqie publishing; absent in tests that do not exercise it. */
  fanqie?: FanqieService
  /** Pi worker image versions; absent in tests that do not exercise it. */
  piVersions?: PiVersionService
  /** The 开发环境 page: build the worker toolchain image, self-test it, switch new tickets to it. */
  devEnv?: DevEnvService
  /** Ticket goals; absent in tests that do not exercise them. */
  goals?: Pick<GoalService, 'view' | 'set' | 'cancel' | 'brief'>
  /** Internal red-team pentest workbench; absent in tests that do not exercise it. */
  pentest?: PentestService
  /** Platform-wide conversational AI Director assistant. */
  director?: DirectorService
}

export type AdminApi = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

const API_PREFIX = '/api'
const MAX_BODY = 1_000_000
const SESSION_MAX_AGE_SEC = 12 * 60 * 60
const MAX_TEXT_FILE = 200 * 1024
const MAX_LISTED_FILES = 1000
/** Cap for an inline image preview; anything larger is refused rather than streamed. */
const MAX_RAW_FILE = 10 * 1024 * 1024
/** Cap for an attachment download; larger files are refused rather than streamed. */
const MAX_DOWNLOAD_FILE = 200 * 1024 * 1024
/** Extensions served inline with `raw=1`. SVG is deliberately absent: it can carry script. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}
const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
}

interface AdminAlert {
  level: 'info' | 'warn' | 'error'
  code: string
  text: string
  link?: string
}

interface AuthState {
  authenticated: boolean
  via: 'cookie' | 'bearer' | 'none'
  token?: string
}

interface BodyResult {
  ok: boolean
  text?: string
  reason?: 'too_large' | 'read_error'
}

// --- Request helpers ---------------------------------------------------------------------------------------------

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function cookieValue(headerText: string, name: string): string | undefined {
  for (const part of headerText.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    const value = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    let settled = false
    const finish = (result: BodyResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        // Keep draining the request so the response can still be sent, but stop retaining bytes.
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(tooLarge ? { ok: false, reason: 'too_large' } : { ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => finish({ ok: false, reason: 'read_error' }))
    req.on('aborted', () => finish({ ok: false, reason: 'read_error' }))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    ...SECURITY_HEADERS,
    ...headers,
  })
  res.end(payload)
}

/** RFC 5987 value for `filename*`: UTF-8 percent-encoding with the few characters the header grammar needs escaped. */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** `content-disposition` for a download, with an ASCII fallback and the exact UTF-8 name. */
function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 120) || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(name)}`
}

/** Stream one regular file as an attachment; the caller already confirmed it is not a link and is inside the root. */
function serveDownload(res: ServerResponse, file: string, name: string, size: number): void {
  if (size > MAX_DOWNLOAD_FILE) {
    sendJson(res, 413, { error: 'too_large', message: '这个文件超过 200 MB，不能直接下载。' })
    return
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(size),
    'content-disposition': attachmentHeader(name),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  const stream = createReadStream(file)
  stream.on('error', () => {
    if (!res.writableEnded) res.destroy()
  })
  stream.pipe(res)
}

/** Stream `tar -czf - -C <dir> .` as a download. The argument vector never passes through a shell. */
function serveTarArchive(res: ServerResponse, dir: string, name: string): void {
  const child = spawn('tar', ['-czf', '-', '-C', dir, '.'])
  child.stderr.resume()
  child.once('error', () => {
    if (res.headersSent) res.destroy()
    else sendJson(res, 500, { error: 'archive_failed', message: '打包失败，请稍后重试。' })
  })
  child.once('spawn', () => {
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-disposition': attachmentHeader(name),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    child.stdout.pipe(res)
  })
  child.once('close', code => {
    if (code !== 0 && !res.writableEnded) res.destroy()
  })
  res.on('close', () => {
    if (child.exitCode === null && !child.killed) child.kill()
  })
}

function sessionCookie(token: string): string {
  return `sa_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}`
}

function clearSessionCookie(): string {
  return 'sa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

function optionalCursor(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function isWrite(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

// --- Validation ---------------------------------------------------------------------------------------------------

const LoginSchema = z.object({ password: z.string().min(1, '请输入口令') }).strict()
const PasswordSchema = z.object({
  old: z.string().min(1, '请输入当前口令'),
  new: z.string().min(1, '请输入新口令'),
}).strict()
const SecretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, '名称只能是大写字母、数字和下划线，以字母开头，最长 64 位')
/** A goal as a person writes it on a new ticket or a running one; limits left out come from the settings. */
const GoalInputSchema = z.object({
  text: z.string().trim().min(1, '请写清目标').max(4000, '目标不能超过 4000 字'),
  commands: z.array(z.string().trim().min(1, '验收命令不能是空的').max(1000, '一条验收命令不能超过 1000 字')).max(20, '最多 20 条验收命令').optional(),
  mode: z.enum(['commands+ai', 'commands', 'ai']).optional(),
  maxRounds: z.number().int('必须是整数').min(1, '至少 1 轮').max(50, '最多 50 轮').optional(),
  maxUsd: z.number().min(0.01, '至少 $0.01').max(100, '最多 $100').optional(),
  maxHours: z.number().min(0.1, '至少 0.1 小时').max(72, '最多 72 小时').optional(),
}).strict()
const CreateTicketSchema = z.object({
  text: z.string().trim().min(1, '请写一句任务内容').max(10_000, '任务内容不能超过 10000 字'),
  model: z.string().max(200, '模型名过长').optional(),
  secrets: z.array(SecretNameSchema).max(100, '一次最多授权 100 个密钥').optional(),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
  /** `direct` edits the project library's original files instead of a private copy. */
  projectMode: z.enum(['copy', 'direct']).optional(),
  /** False switches multi-model collaboration off for this ticket; absent means the setting decides. */
  collab: z.boolean().optional(),
  /** A goal the ticket must reach before it ends. */
  goal: GoalInputSchema.optional(),
}).strict()
const ProjectImportSchema = z.object({
  path: z.string().trim().min(1, '请填写要导入的目录').max(1000),
  name: z.string().trim().min(1, '请填写项目名').max(120),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
}).strict()
const ProjectRestoreSchema = z.object({
  snapshot: z.string().regex(/^[0-9a-f]{7,40}$/, '快照编号不合法'),
}).strict()
const UploadCreateSchema = z.object({
  name: z.string().trim().min(1, '请填写压缩包文件名').max(255, '文件名不能超过 255 个字符'),
  size: z.number().int('文件大小必须是整数').positive('文件大小必须大于 0').max(Number.MAX_SAFE_INTEGER, '文件太大'),
  kind: z.literal('project').optional(),
}).strict()
const UploadFinishSchema = z.object({
  projectName: z.string().trim().max(120, '项目名不能超过 120 个字').optional(),
}).strict()
const ArchiveQuerySchema = z.enum(['project', 'output'])
const SecretCreateSchema = z.object({
  name: SecretNameSchema,
  value: z.string().min(1, '密钥值不能为空').max(8192, '密钥值不能超过 8192 个字符'),
  description: z.string().trim().max(300, '描述不能超过 300 个字').optional(),
}).strict()
const SecretUpdateSchema = z.object({
  value: z.string().min(1, '密钥值不能为空').max(8192, '密钥值不能超过 8192 个字符').optional(),
  description: z.string().trim().max(300, '描述不能超过 300 个字').optional(),
}).strict()
const TicketSecretsSchema = z.object({
  names: z.array(SecretNameSchema).max(100, '一次最多授权 100 个密钥'),
}).strict()
const SecretDecisionSchema = z.object({ decision: z.enum(['grant', 'deny'], { message: '决定只能是 grant 或 deny' }) }).strict()
const StopSchema = z.object({ reason: z.string().trim().max(2_000, '停止原因不能超过 2000 字').optional() }).strict()
const TextSchema = z.object({
  text: z.string().trim().min(1, '内容不能为空').max(10_000, '内容不能超过 10000 字'),
}).strict()
/** A new instruction on a ticket; `model` ("provider/model") switches the ticket's model from this round on. */
const ReplySchema = z.object({
  text: z.string().trim().min(1, '内容不能为空').max(10_000, '内容不能超过 10000 字'),
  model: z.string().max(200, '模型名过长').optional(),
}).strict()
const PauseSchema = z.object({ paused: z.boolean() }).strict()
const CleanupSchema = z.object({
  olderThanDays: z.number().int('必须是整数').min(0, '不能小于 0').max(3650, '不能超过 3650 天'),
  dryRun: z.boolean(),
}).strict()
const DeleteTicketSchema = z.object({
  deleteWorkspace: z.boolean().optional(),
  force: z.boolean().optional(),
}).strict()
const BatchDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, '至少选择一个任务').max(200, '一次最多删除 200 个任务'),
  deleteWorkspace: z.boolean().optional(),
  force: z.boolean().optional(),
}).strict()
const OrphanCleanupSchema = z.object({
  ids: z.array(z.string().min(1)).max(2_000, '一次最多清理 2000 个目录'),
}).strict()

const CouncilCreateSchema = z.object({
  mode: z.enum(['brief', 'decision'], { message: '会商模式只能是 brief 或 decision' }),
  text: z.string().trim().min(1, '会商话题不能为空').max(10_000, '会商话题不能超过 10000 字，请精简后再召集会商。'),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
  ticketId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '任务票编号不合法').optional(),
  rounds: z.number().int('必须是整数').min(1, '轮数不能小于 1').max(3, '轮数不能大于 3').optional(),
  roles: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, '角色 id 不合法')).max(20, '一次最多选择 20 个角色').optional(),
  autoStart: z.boolean().optional(),
}).strict()
const CouncilCommitSchema = z.object({
  brief: z.string().max(MAX_COUNCIL_BRIEF_CHARS, '会商任务书不能超过 10000 字，请精简后再开票。').optional(),
  model: z.string().max(200, '模型名过长').optional(),
  secrets: z.array(SecretNameSchema).max(100, '一次最多授权 100 个密钥').optional(),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
}).strict()

const ExecutorSchema = OptionsSchema.shape.executor
const PreviewSettingsSchema = OptionsSchema.shape.preview
const ProjectsSettingsSchema = OptionsSchema.shape.projects
const CouncilSettingsSchema = OptionsSchema.shape.council
const NovelSettingsSchema = OptionsSchema.shape.novel
const CollabSettingsSchema = OptionsSchema.shape.collab
const GoalSettingsSchema = OptionsSchema.shape.goal
const WebSettingsSchema = OptionsSchema.shape.web
const SshConnectionSchema = SshConnectionOptionSchema
const BookIdSchema = z.string().regex(/^b_[A-Za-z0-9]{1,32}$/)
const NovelOpenSchema = z.object({
  idea: z.string().trim().min(1, '请写一句灵感').max(4000, '灵感不能超过 4000 字'),
  genre: z.enum(['xianxia', 'xuanhuan'], { message: '题材只能是仙侠或玄幻' }),
  title: z.string().trim().max(60, '书名不能超过 60 个字').optional(),
  chapterChars: z.tuple([z.number().int().min(500), z.number().int().max(20000)]).optional(),
  volumes: z.number().int().min(1).max(50).optional(),
  chaptersPerVolume: z.number().int().min(5).max(1000).optional(),
}).strict()
const NovelImportSchema = z.object({
  title: z.string().trim().min(1, '请写书名').max(60),
  genre: z.enum(['xianxia', 'xuanhuan']),
  idea: z.string().max(4000).optional(),
  chapterChars: z.tuple([z.number().int().min(500), z.number().int().max(20000)]).optional(),
  volumes: z.number().int().min(1).max(50).optional(),
  chaptersPerVolume: z.number().int().min(5).max(1000).optional(),
  setup: z.unknown(),
}).strict()
const NovelArcSchema = z.object({ note: z.string().trim().max(500, '要求不能超过 500 字').optional() }).strict()
const NovelEditSchema = z.object({ note: z.string().trim().min(1, '请写一句要怎么改').max(1000, '修改意见不能超过 1000 字') }).strict()
const ModelTestSchema = z.object({
  provider: z.string().min(1, '请选择服务商'),
  model: z.string().min(1, '请选择模型'),
}).strict()
const ModelDiscoverSchema = z.object({
  provider: z.string().min(1, '请选择服务商').optional(),
  api: z.enum(['openai-completions', 'anthropic-messages'], { message: '请选择接口类型' }),
  baseUrl: z.string().url('请填写完整的地址').refine(url => /^https?:\/\//.test(url), '地址必须以 http:// 或 https:// 开头'),
  apiKey: z.string().optional(),
  sessionHeader: z.string().regex(/^[A-Za-z0-9-]*$/, '只能包含字母、数字和短横线').optional(),
}).strict()
const BudgetSchema = OptionsSchema.shape.budget
// The three Feishu secrets may be omitted on write: an omitted secret keeps its stored value. `mode` is optional too,
// and it is declared without the schema default so an older console that never sends it cannot reset a long connection.
const FeishuSettingsSchema = OptionsSchema.shape.feishu
  .omit({ mode: true })
  .partial({ appSecret: true, verificationToken: true, encryptKey: true })
  .extend({ mode: z.enum(['webhook', 'ws']).optional() })
// `token`/`password` are write-only: an empty or omitted one keeps the vault value. The read-only markers are stripped
// before parsing by `withoutReadOnlySecrets`.
const GithubSettingsSchema = OptionsSchema.shape.github.extend({ token: z.string().max(500).optional() })
// New EmailSchema fields already carry `.default(...)`, so legacy payloads omitting them validate cleanly without `.partial()`.
const EmailSettingsSchema = OptionsSchema.shape.email.extend({ password: z.string().max(500).optional() })
const WechatSettingsSchema = OptionsSchema.shape.wechat.partial({
  mode: true, corpId: true, agentId: true, corpSecret: true, appId: true, appSecret: true,
  callbackToken: true, encodingAesKey: true, webhookUrl: true, bridgeUrl: true, bridgeToken: true,
  ilinkRelayUrl: true, ilinkRelayToken: true,
  apiBase: true, allowedUsers: true, notifyOnComplete: true, routingMode: true,
})
const DirectorSettingsSchema = OptionsSchema.shape.director
const DirectorChatSchema = z.object({
  text: z.string().trim().min(1, '请输入对话内容').max(20_000, '对话内容不能超过 20000 字'),
  channel: z.enum(['web', 'wechat', 'feishu']).default('web'),
  userId: z.string().trim().min(1).max(200).default('console'),
  deliverToWechat: z.boolean().default(true),
}).strict()
const DirectorActionDecideSchema = z.object({
  decision: z.enum(['approve', 'reject']),
}).strict()
const WechatSendSchema = z.object({
  to: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  text: z.string().trim().min(1, '消息内容不能为空').max(20_000, '消息内容过长'),
}).strict()
const EmailSendSchema = z.object({
  to: z.array(z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, '收件人邮箱格式不正确')).min(1, '请至少填写一个收件人').max(20),
  subject: z.string().trim().min(1, '请填写邮件主题').max(200),
  text: z.string().trim().min(1, '请填写邮件内容').max(50_000),
}).strict()
const PentestEngagementCreateSchema = z.object({
  workbench: z.enum(['pentest', 'defense']).default('pentest'),
  name: z.string().trim().min(1, '请填写项目名称').max(120, '项目名称不能超过 120 字'),
  targets: z.array(z.string().trim().min(1).max(300)).max(50, '最多 50 个目标').default([]),
  exclusions: z.array(z.string().trim().min(1).max(300)).max(50, '最多 50 个排除项').default([]),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').optional(),
  defaultModel: z.string().trim().max(200).optional(),
  authorizedBy: z.string().trim().min(1, '请填写负责人或内部授权人').max(100),
  authConfirmed: z.boolean().optional(),
  intensity: z.enum(['passive', 'standard', 'deep']).optional(),
  notes: z.string().max(4000).default(''),
}).strict()
const PentestEngagementUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  targets: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
  exclusions: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
  projectId: z.string().regex(/^p_[A-Za-z0-9]{1,32}$/, '项目编号不合法').nullable().optional(),
  defaultModel: z.string().trim().max(200).nullable().optional(),
  authorizedBy: z.string().trim().min(1).max(100).optional(),
  intensity: z.enum(['passive', 'standard', 'deep']).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  notes: z.string().max(4000).optional(),
}).strict()
const PentestFindingCreateSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  status: z.enum(['open', 'confirmed', 'fixed', 'false_positive', 'accepted']).optional(),
  title: z.string().trim().min(1, '请填写漏洞标题').max(200),
  category: z.string().trim().max(80).optional(),
  cwe: z.string().trim().max(40).optional(),
  owasp: z.string().trim().max(120).optional(),
  target: z.string().trim().max(300).optional(),
  endpoint: z.string().trim().max(500).optional(),
  description: z.string().max(10_000).optional(),
  poc: z.string().max(10_000).optional(),
  evidence: z.string().max(10_000).optional(),
  remediation: z.string().max(10_000).optional(),
}).strict()
const PentestFindingUpdateSchema = PentestFindingCreateSchema.partial().strict()
const PentestWebScanSchema = z.object({
  targetUrl: z.string().trim().min(1, '请填写目标 URL').max(500),
  probePaths: z.boolean().optional(),
}).strict()
const PentestRunCreateSchema = z.object({
  playbookId: z.string().trim().min(1, '请选择执行剧本').max(64),
  model: z.string().max(200).optional(),
  projectMode: z.enum(['copy', 'direct']).optional(),
  extraInstruction: z.string().max(4000).optional(),
  secrets: z.array(SecretNameSchema).max(100).optional(),
}).strict()
const PentestNotifySchema = z.object({
  channel: z.enum(['email', 'wechat']),
  to: z.string().trim().max(320).optional(),
}).strict()
const PentestAssetCreateSchema = z.object({
  name: z.string().trim().min(1, '请填写资产名称').max(120),
  location: z.string().trim().min(1, '请填写资产地址或位置').max(300),
  kind: z.string().trim().max(40).default('web'),
  note: z.string().max(500).default(''),
}).strict()
const PentestProofCreateSchema = z.object({
  note: z.string().trim().min(1, '请填写证物说明').max(300),
  fileName: z.string().trim().min(1, '请填写文件名').max(260),
  bytes: z.number().int().min(0).max(10_000_000_000).default(0),
  sha256: z.string().trim().regex(/^[0-9a-fA-F]{64}$/, 'SHA-256 摘要格式不合法'),
}).strict()
const PentestTaskCreateSchema = z.object({
  kind: z.enum(['web_baseline', 'http_inspect', 'surface_map', 'exposure_check', 'source_scan']),
  args: z.record(z.string(), z.unknown()).default({}),
}).strict()
const PentestDecodeSchema = z.object({
  text: z.string().max(524_288, '文本长度超出上限'),
  mode: z.enum(['base64_decode', 'base64_encode', 'hex_decode', 'hex_encode', 'url_decode', 'url_encode', 'jwt', 'md5', 'sha1', 'sha256', 'sha512']),
}).strict()
const RuleInputSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/, '只能包含字母、数字、下划线和短横线，长度 1–80'),
  name: z.string().trim().min(1, '规则名称不能为空').max(LIMITS.ruleName, `不能超过 ${LIMITS.ruleName} 个字`),
  enabled: z.boolean(),
  instruction: z.string().trim().min(1, '规则说明不能为空').max(LIMITS.ruleInstruction, `不能超过 ${LIMITS.ruleInstruction} 个字`),
}).strict()
const OperatorInputSchema = z.object({
  id: z.string().trim().min(1, '操作员 ID 不能为空').max(200, '操作员 ID 不能超过 200 个字'),
  name: z.string().trim().max(100, '名字不能超过 100 个字').default(''),
}).strict()
const PolicySchema = z.object({
  paused: z.boolean(),
  acceptMode: z.enum(['off', 'observe', 'auto']),
  evalTimeoutSeconds: z.number().int('必须是整数').min(LIMITS.evalTimeoutSeconds.min, `不能小于 ${LIMITS.evalTimeoutSeconds.min} 秒`)
    .max(LIMITS.evalTimeoutSeconds.max, `不能大于 ${LIMITS.evalTimeoutSeconds.max} 秒`),
  rules: z.array(RuleInputSchema).max(50, '最多 50 条规则'),
  allowedOperators: z.array(OperatorInputSchema).max(100, '最多 100 个操作员'),
  feishuOperators: z.array(OperatorInputSchema).max(100, '最多 100 个飞书操作员').default([]),
}).strict()

function describeExpected(expected: string): string {
  switch (expected) {
    case 'int': return '整数'
    case 'number': return '数字'
    case 'string': return '字符串'
    case 'boolean': return '布尔值'
    case 'object': return '对象'
    case 'array': return '数组'
    default: return expected
  }
}

/** Chinese wording for a zod issue; custom Chinese messages written on the schema are preserved. */
function issueMessage(issue: z.ZodIssue): string {
  if (/[一-龥]/.test(issue.message)) return issue.message
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? '缺少必填字段' : `类型不正确：期望${describeExpected(issue.expected)}`
    case 'too_small':
      if (issue.origin === 'string') return issue.inclusive === false ? `长度必须大于 ${issue.minimum}` : `长度不能小于 ${issue.minimum}`
      if (issue.origin === 'array') return `至少需要 ${issue.minimum} 项`
      return issue.inclusive === false ? `必须大于 ${issue.minimum}` : `不能小于 ${issue.minimum}`
    case 'too_big':
      if (issue.origin === 'string') return issue.inclusive === false ? `长度必须小于 ${issue.maximum}` : `长度不能超过 ${issue.maximum}`
      if (issue.origin === 'array') return `最多允许 ${issue.maximum} 项`
      return issue.inclusive === false ? `必须小于 ${issue.maximum}` : `不能超过 ${issue.maximum}`
    case 'invalid_format':
      return issue.format === 'url' ? '必须是有效的地址' : '格式不正确'
    case 'unrecognized_keys':
      return `不支持的字段：${issue.keys.join('、')}`
    case 'custom':
      return '取值不符合要求'
    case 'invalid_union':
      return '取值不符合任何允许的形式'
    case 'not_multiple_of':
      return `必须是 ${String(issue.divisor)} 的倍数`
    default:
      return '格式不正确'
  }
}

/**
 * Read-only markers the settings GET adds so the page can say "already set". A client that echoes the whole view back
 * (a natural thing for a form to do) must not be rejected for them: drop them before validating.
 */
const READ_ONLY_SECRET_FLAGS = [
  'appSecretSet', 'verificationTokenSet', 'encryptKeySet', 'tokenSet', 'passwordSet',
  'corpSecretSet', 'callbackTokenSet', 'encodingAesKeySet', 'webhookUrlSet', 'bridgeTokenSet', 'ilinkRelayTokenSet',
] as const

function withoutReadOnlySecrets(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const flag of READ_ONLY_SECRET_FLAGS) delete copy[flag]
  return copy
}

/** The models view adds the same "already set" markers per provider; drop them the same way. */
const READ_ONLY_MODEL_FLAGS = ['apiKeySet', 'apiKeyTail'] as const

function withoutReadOnlyModelFlags(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  if (Array.isArray(copy.providers)) {
    copy.providers = copy.providers.map(provider => {
      if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return provider
      const clean: Record<string, unknown> = { ...(provider as Record<string, unknown>) }
      for (const flag of READ_ONLY_MODEL_FLAGS) delete clean[flag]
      return clean
    })
  }
  return copy
}

function issuesOf(error: z.ZodError): AdminIssue[] {
  return error.issues.map(issue => ({
    path: issue.path.map(String).join('.'),
    message: issueMessage(issue),
  }))
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

// --- Workspace files ----------------------------------------------------------------------------------------------

/** Split a console-supplied relative path, refusing anything that could leave the workspace by name. */
function relativeSegments(input: string): string[] | undefined {
  if (input === '' || input === '.') return []
  if (input.includes('\0') || input.includes('\\')) return undefined
  if (input.startsWith('/')) return undefined
  if (/^[A-Za-z]:/.test(input)) return undefined
  const segments = input.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) return undefined
  return segments
}

function canonical(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isInside(root: string, target: string): boolean {
  const base = canonical(root)
  const value = canonical(target)
  return value === base || value.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

function readPrefix(file: string, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(file, 'r')
  try {
    const read = readSync(fd, buffer, 0, length, 0)
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  let controls = 0
  for (const byte of buffer) {
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) controls += 1
  }
  return controls / buffer.length > 0.1
}

// --- Overview alerts ----------------------------------------------------------------------------------------------

function buildAlerts(facts: ReturnType<AdminHost['overview']>, budget: Options['budget'], todayUsd: number, generatedPassword: boolean): AdminAlert[] {
  const alerts: AdminAlert[] = []
  for (const ticket of facts.attentionTickets.slice(0, 5)) {
    const what = ticket.kind === 'failed' ? '失败了' : ticket.kind === 'blocked' ? '被卡住了' : '的消息没能送达'
    alerts.push({
      level: 'warn',
      code: `ticket.${ticket.kind}`,
      text: `任务「${ticket.title}」${what}，需要你处理。`,
      link: `#/tickets/${encodeURIComponent(ticket.id)}`,
    })
  }
  if (budget.enabled && budget.dailyUsd > 0) {
    if (todayUsd >= budget.dailyUsd) {
      alerts.push({
        level: 'error',
        code: 'budget.blocked',
        text: `今日费用 $${todayUsd.toFixed(4)} 已达到上限 $${budget.dailyUsd.toFixed(2)}，新的调用会被拦截。`,
        link: '#/settings/budget',
      })
    } else if (todayUsd >= budget.dailyUsd * 0.8) {
      alerts.push({
        level: 'warn',
        code: 'budget.warning',
        text: `今日费用已用掉预算的 ${Math.round((todayUsd / budget.dailyUsd) * 100)}%，接近上限。`,
        link: '#/settings/budget',
      })
    }
  }
  if (facts.upstream.checkedAt !== undefined && !facts.upstream.ok) {
    alerts.push({ level: 'error', code: 'upstream.failed', text: '上游 AI 服务最近一次调用失败，请检查地址、模型或密钥。', link: '#/settings/models' })
  }
  if (facts.host.diskFreeGb < 10) {
    alerts.push({ level: 'warn', code: 'host.disk', text: `磁盘只剩 ${Math.round(facts.host.diskFreeGb)} GB，建议清理旧任务的工作区。`, link: '#/system' })
  }
  if (facts.paused) {
    alerts.push({ level: 'warn', code: 'policy.paused', text: '接单已暂停，新任务不会被受理。', link: '#/settings/policy' })
  }
  if (generatedPassword) {
    alerts.push({ level: 'warn', code: 'auth.generated', text: '你还在使用自动生成的管理口令，请尽快修改成只有你知道的口令。', link: '#/settings/policy' })
  }
  const rank = { error: 0, warn: 1, info: 2 }
  alerts.sort((a, b) => rank[a.level] - rank[b.level])
  return alerts
}

const SECTION_NAMES: Record<SettingsSection, string> = {
  policy: '受理规则',
  executor: '执行配置',
  models: '模型',
  budget: '预算设置',
  pause: '接单开关',
  feishu: '飞书设置',
  preview: '预览设置',
  projects: '项目设置',
  github: 'GitHub 设置',
  email: '邮箱设置',
  wechat: '微信设置',
  council: '会商设置',
  novel: '小说设置',
  collab: '协作设置',
  goal: '目标设置',
  web: '搜索设置',
  ssh: 'SSH 连接',
  director: '总控助手',
}

function noteFor(section: SettingsSection, changed: string[], paused?: boolean): string {
  switch (section) {
    case 'executor':
      return changed.includes('executor.maxWorkers')
        ? '并发上限已经生效：正在运行的任务不受影响，新任务会按新上限排队。'
        : '执行配置已保存；新的参数会在下一次启动任务时生效。'
    case 'models':
      return '模型设置已保存，新的调用立即使用新设置。'
    case 'budget':
      return '预算设置已保存并立即生效。'
    case 'feishu':
      return '飞书设置已保存，新收到的消息立即按新设置处理。'
    case 'preview':
      return '预览设置已保存；已有的预览链接不会变，新启动的任务按新端口池分配。'
    case 'projects':
      return '项目设置已保存；下一次上传和解压按新上限执行，正在进行的任务不受影响。'
    case 'github':
      return 'GitHub 设置已保存；下一次启动任务时，启用的令牌会自动授权给新票。'
    case 'email':
      return '邮箱设置已保存，新收到的邮件立即按新设置处理。'
    case 'wechat':
      return '微信设置已保存，新收到的消息和推送立即按新设置生效。'
    case 'director':
      return '总控助手设置已保存并立即生效。'
    case 'council':
      return '会商设置已保存；之后召集的会商按新角色、轮数和字数执行，正在进行的会商不受影响。'
    case 'novel':
      return '小说设置已保存；正在写的书从下一次模型调用起按新设置执行。'
    case 'collab':
      return '协作设置已保存；任务下一次启动执行者时按新角色和上限执行，正在进行的这一轮不受影响。'
    case 'goal':
      return '目标设置已保存；之后设定的目标按新的默认上限，判定模型和命令超时从下一次检查起生效。'
    case 'ssh':
      return 'SSH 连接已保存；任务下一次启动执行者时生效。'
    case 'web':
      return '搜索设置已保存；后端顺序和额度立即生效，开关从任务下一次启动执行者时生效。'
    case 'policy':
      return '受理规则已保存；新收到的消息按新规则判断，正在运行的任务不受影响。'
    case 'pause':
      return paused ? '已暂停接单；新任务会留在队列里，恢复后才会开始。' : '已恢复接单，新任务会正常受理。'
  }
}

function labelSummary(item: TicketSummaryView): TicketSummaryView & { stageLabel: string; stageHint: string } {
  const label = ticketStatusLabel(item)
  return { ...item, stageLabel: label.label, stageHint: label.hint }
}

// --- The factory --------------------------------------------------------------------------------------------------

export function createAdminApi(options: CreateAdminApiOptions): AdminApi {
  const { host, auth, options: store, ledger, events, cliToken, onPolicyOrSettingsChange, projects, councils, activity, novels, fanqie, piVersions, goals, devEnv, pentest, director } = options

  function requireDirector(): DirectorService {
    if (director === undefined) throw new AdminError('not_found', '这台服务器没有启用总控助手。', 404)
    return director
  }

  function requirePentest(): PentestService {
    if (pentest === undefined) throw new AdminError('not_found', '这台服务器没有启用渗透工作台。', 404)
    return pentest
  }

  async function pentestCall<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof PentestError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'scope_denied' ? 403 : error.code === 'conflict' ? 409 : 400
        throw new AdminError(error.code, error.message, status)
      }
      throw error
    }
  }

  /** Short-TTL shared board snapshot so N concurrent SSE tabs don't multiply DB reads by N. */
  let cachedBoard: { at: number; body: string } | undefined
  const boardSnapshotJson = (): string => {
    const nowMs = Date.now()
    if (cachedBoard && nowMs - cachedBoard.at < 800) return cachedBoard.body
    const facts = host.overview()
    const totals = ledger.dayTotals()
    const budget = store.getPublic().budget
    const open = host.listTickets({ status: 'open', limit: 60, offset: 0 }).items.map(labelSummary).map(item => {
      const goal = goals?.brief(item.id)
      return goal ? { ...item, goal } : item
    })
    const ended = host.listTickets({ status: 'ended', limit: 8, offset: 0 }).items.map(labelSummary)
    const body = JSON.stringify({
      paused: facts.paused,
      slots: facts.slots,
      tickets: facts.tickets,
      usage: { todayUsd: totals.usd, todayCalls: totals.calls, dailyBudgetUsd: budget.dailyUsd },
      upstream: facts.upstream,
      runningSteps: facts.runningSteps ?? [],
      open,
      ended,
      alerts: buildAlerts(facts, budget, totals.usd, auth.usingGeneratedPassword),
    })
    cachedBoard = { at: nowMs, body }
    return body
  }

  function requireNovels(): NovelService {
    if (novels === undefined || !store.get().novel.enabled) throw new AdminError('not_found', '写小说功能没有开启。', 404)
    return novels
  }

  /** Runs a book-library call, mapping its refusals onto the API's error shape. */
  async function novelCall<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof NovelError) {
        const status = error.code === 'not_found' || error.code === 'disabled' ? 404 : error.code === 'conflict' ? 409 : 400
        throw new AdminError(error.code === 'disabled' ? 'not_found' : error.code, error.message, status)
      }
      throw error
    }
  }

  function requireProjects(): ProjectService {
    if (projects === undefined) throw new AdminError('not_found', '这台服务器没有启用项目库。', 404)
    return projects
  }

  function requireCouncils(): CouncilService {
    if (councils === undefined) throw new AdminError('not_found', '这台服务器没有启用会商。', 404)
    return councils
  }

  function authenticate(req: IncomingMessage): AuthState {
    if (checkCliToken(cliToken ?? '', header(req, 'authorization'))) return { authenticated: true, via: 'bearer' }
    const token = cookieValue(header(req, 'cookie'), 'sa_session')
    if (token !== undefined && auth.verify(token)) return { authenticated: true, via: 'cookie', token }
    return { authenticated: false, via: 'none' }
  }

  function csrfOk(req: IncomingMessage, state: AuthState): boolean {
    if (state.via === 'bearer') return true
    const contentType = header(req, 'content-type').toLowerCase()
    // Raw upload chunks are the one write whose body is not JSON; the custom header is still required, and a browser
    // form cannot set it (or send octet-stream without a preflight).
    const simpleBody = /^application\/json(\s*;|$)/.test(contentType) || /^application\/octet-stream(\s*;|$)/.test(contentType)
    return header(req, 'x-sa-request') === '1' && simpleBody
  }

  async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
    const result = await readBody(req)
    if (!result.ok) {
      throw result.reason === 'too_large'
        ? new AdminError('body_too_large', '请求内容太大（上限 1MB）。', 413)
        : new AdminError('body_read_error', '读取请求内容失败，请重试。', 400)
    }
    const text = result.text ?? ''
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new AdminError('invalid_json', '请求内容不是有效的 JSON。', 400)
    }
  }

  function invalid(res: ServerResponse, issues: AdminIssue[]): void {
    sendJson(res, 400, { error: 'invalid', message: '提交的内容有误，请检查标出来的字段。', issues })
  }

  /** Like {@link invalid}, but a too-long topic/brief puts its own actionable sentence at the top level. */
  function invalidWithHint(res: ServerResponse, error: z.ZodError, fields: readonly string[]): void {
    const issues = issuesOf(error)
    const hit = error.issues.find(issue => fields.includes(String(issue.path[0] ?? '')))
    sendJson(res, 400, {
      error: 'invalid',
      message: hit === undefined ? '提交的内容有误，请检查标出来的字段。' : issueMessage(hit),
      issues,
    })
  }

  function recordSettings(section: SettingsSection, changed: string[], text: string): void {
    try {
      events.add({ kind: 'admin.settings', level: 'info', text, data: { section, changed } })
    } catch {
      // The setting is already persisted; an event-log failure must not turn a successful save into an error response.
    }
  }

  function notify(change: AdminSettingsChange): void {
    try {
      onPolicyOrSettingsChange?.(change)
    } catch {
      // A runtime cache refresh must not fail the request that already saved the setting.
    }
  }

  function finishSettings(res: ServerResponse, section: SettingsSection, changed: string[], extra: Record<string, unknown> = {}): void {
    if (changed.length > 0) {
      recordSettings(section, changed, `修改了${SECTION_NAMES[section]}：${changed.join('、')}`)
      notify({ section, changed, ...(section === 'policy' ? { policy: host.getPolicy() } : {}) })
    }
    sendJson(res, 200, {
      ok: true,
      changed,
      ...(changed.length > 0 ? { note: noteFor(section, changed) } : {}),
      ...extra,
    })
  }

  function handleFiles(res: ServerResponse, id: string, requested: string, raw = false, download = false): void {
    const root = host.workspaceRoot(id)
    if (root === undefined) {
      sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' })
      return
    }
    handleFilesInRoot(res, root, requested, raw, download)
  }

  /** File browsing and download for any root, shared by ticket workspaces and project trees. */
  function handleFilesInRoot(res: ServerResponse, root: string, requested: string, raw: boolean, download: boolean): void {
    const segments = relativeSegments(requested)
    if (segments === undefined) {
      sendJson(res, 400, { error: 'invalid_path', message: '路径不合法，只能查看任务工作区里的文件。' })
      return
    }
    const path = segments.join('/')
    const name = segments.at(-1) ?? ''
    const empty = { exists: false, type: 'dir' as const, path, name, entries: [] as unknown[] }
    if (root === '') {
      sendJson(res, 200, empty)
      return
    }

    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      sendJson(res, 200, empty)
      return
    }
    let rootStat
    try {
      rootStat = statSync(realRoot)
    } catch {
      sendJson(res, 200, empty)
      return
    }
    if (!rootStat.isDirectory()) {
      sendJson(res, 200, empty)
      return
    }

    const candidate = segments.length === 0 ? realRoot : resolve(realRoot, ...segments)
    if (!isInside(realRoot, candidate)) {
      sendJson(res, 400, { error: 'invalid_path', message: '路径不合法，只能查看任务工作区里的文件。' })
      return
    }

    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      sendJson(res, 200, empty)
      return
    }
    if (!isInside(realRoot, real)) {
      sendJson(res, 403, { error: 'forbidden', message: '这个路径超出了任务的工作区。' })
      return
    }

    let info
    try {
      info = statSync(real)
    } catch {
      sendJson(res, 200, empty)
      return
    }

    if (info.isDirectory()) {
      let dirents
      try {
        dirents = readdirSync(real, { withFileTypes: true }).slice(0, MAX_LISTED_FILES)
      } catch {
        throw new AdminError('read_failed', '无法读取这个文件夹。', 500)
      }
      const entries = dirents.map(dirent => {
        const full = resolve(real, dirent.name)
        let type: 'dir' | 'file' = dirent.isDirectory() ? 'dir' : 'file'
        let size: number | undefined
        if (dirent.isSymbolicLink()) {
          try {
            const target = statSync(full)
            type = target.isDirectory() ? 'dir' : 'file'
            if (target.isFile()) size = target.size
          } catch {
            type = 'file'
          }
        } else if (dirent.isFile()) {
          try {
            size = statSync(full).size
          } catch {
            size = undefined
          }
        }
        return { name: dirent.name, type, ...(size === undefined ? {} : { size }) }
      })
      entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name, 'zh-CN'))
      sendJson(res, 200, { exists: true, type: 'dir', path, name, entries })
      return
    }

    if (!info.isFile()) {
      sendJson(res, 200, empty)
      return
    }

    if (download) {
      // A symlink can point outside the root after the realpath check above resolved it; only regular files download.
      let link = false
      try {
        link = lstatSync(candidate).isSymbolicLink()
      } catch {
        link = false
      }
      if (link) {
        sendJson(res, 400, { error: 'invalid_path', message: '符号链接不能下载。' })
        return
      }
      serveDownload(res, real, name, info.size)
      return
    }

    const length = Math.min(info.size, MAX_TEXT_FILE)
    let prefix: Buffer
    try {
      prefix = readPrefix(real, length)
    } catch {
      throw new AdminError('read_failed', '无法读取这个文件。', 500)
    }
    const base = {
      exists: true,
      type: 'file',
      path,
      name,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
    if (raw) {
      // Inline preview for images only; the response carries no script-capable types.
      const mime = IMAGE_MIME[extname(name).toLowerCase()]
      if (mime === undefined) {
        sendJson(res, 415, { error: 'not_previewable', message: '只有图片可以直接预览。' })
        return
      }
      if (info.size > MAX_RAW_FILE) {
        sendJson(res, 413, { error: 'too_large', message: '这张图太大，不能在线预览。' })
        return
      }
      let body: Buffer
      try {
        body = readFileSync(real)
      } catch {
        throw new AdminError('read_failed', '无法读取这个文件。', 500)
      }
      res.writeHead(200, {
        'content-type': mime,
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      })
      res.end(body)
      return
    }
    if (looksBinary(prefix)) {
      sendJson(res, 200, { ...base, binary: true })
      return
    }
    sendJson(res, 200, { ...base, text: prefix.toString('utf8'), truncated: info.size > MAX_TEXT_FILE })
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const isHealth = route === '/health' && method === 'GET'
    const isLogin = route === '/login' && method === 'POST'
    const state = authenticate(req)

    if (!isHealth && !isLogin) {
      if (!state.authenticated) {
        sendJson(res, 401, { error: 'unauthorized', message: '请先登录后台。' })
        return
      }
      if (isWrite(method) && !csrfOk(req, state)) {
        sendJson(res, 403, { error: 'csrf', message: '请求缺少防止跨站伪造的标记，请刷新页面后重试。' })
        return
      }
    } else if (isWrite(method) && !csrfOk(req, state)) {
      sendJson(res, 403, { error: 'csrf', message: '请求缺少防止跨站伪造的标记，请刷新页面后重试。' })
      return
    }

    // Public routes.
    if (isHealth) {
      sendJson(res, 200, { ok: true, uptimeSec: host.info().uptimeSec })
      return
    }
    if (isLogin) {
      const body = await parseJsonBody(req)
      const parsed = LoginSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const ip = clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'])
      const result = auth.login(ip, parsed.data.password)
      if (!result.ok) {
        const retry = result.retryAfterSec === undefined ? {} : { retryAfterSec: result.retryAfterSec }
        const headers: Record<string, string> = {}
        if (result.retryAfterSec !== undefined) headers['retry-after'] = String(result.retryAfterSec)
        // Failed logins are security-relevant: an unexpected row here is the operator's first sign of a stranger trying.
        try {
          events.add({
            kind: 'admin.login_failed',
            level: 'warn',
            text: result.reason === 'locked' ? '登录尝试过多，已暂时锁定' : '有登录尝试但口令不正确',
            data: { reason: result.reason, ip },
          })
        } catch { /* recording must not change the answer to the client */ }
        if (result.reason === 'bad_password') {
          sendJson(res, 401, { error: 'bad_password', message: '口令不正确。' }, headers)
        } else {
          sendJson(res, 429, {
            error: result.reason,
            message: result.reason === 'locked' ? '尝试次数过多，请稍后再试。' : '登录尝试太频繁，请稍后再试。',
            ...retry,
          }, headers)
        }
        return
      }
      sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie(result.token) })
      return
    }

    // Session routes.
    if (route === '/logout' && method === 'POST') {
      if (state.token !== undefined) auth.logout(state.token)
      sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() })
      return
    }
    if (route === '/me' && method === 'GET') {
      sendJson(res, 200, { authenticated: true, usingGeneratedPassword: auth.usingGeneratedPassword })
      return
    }
    if (route === '/password' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = PasswordSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const result = auth.changePassword(parsed.data.old, parsed.data.new)
      if (!result.ok) {
        if (result.reason === 'bad_password') {
          sendJson(res, 400, { error: 'bad_password', message: '当前口令不正确。' })
        } else {
          sendJson(res, 400, { error: 'too_short', message: '新口令至少需要 10 位。' })
        }
        return
      }
      try {
        events.add({ kind: 'admin.password', level: 'warn', text: '管理口令已修改，所有登录已失效' })
      } catch { /* the change itself already succeeded */ }
      // changePassword cleared every session, including this one; clear the cookie so the page goes back to login.
      sendJson(res, 200, { ok: true, relogin: true }, { 'set-cookie': clearSessionCookie() })
      return
    }

    // Live board: one SSE stream for the console's home page and nav badges. A snapshot is sent on connect and again
    // only when something on the board changed; otherwise a comment line keeps proxies from closing the connection.
    if (route === '/live/stream' && method === 'GET') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      })
      let previous = ''
      let beat = 0
      let seq = 0
      const push = (): void => {
        if (res.writableEnded || res.destroyed) return
        const body = boardSnapshotJson()
        if (body !== previous) {
          previous = body
          seq += 1
          const withNow = `{"now":${JSON.stringify(new Date().toISOString())},${body.slice(1)}`
          res.write(`id: ${seq}\nevent: board\ndata: ${withNow}\n\n`)
          beat = 0
        } else if (++beat % 15 === 0) {
          res.write(': ping\n\n')
        }
      }
      res.write('retry: 3000\n\n')
      try { push() } catch { /* next tick */ }
      const timer = setInterval(() => { try { push() } catch { /* keep the stream */ } }, 1000)
      timer.unref()
      const stopStream = (): void => clearInterval(timer)
      res.on('close', stopStream)
      res.on('error', stopStream)
      return
    }

    // Overview.
    if (route === '/overview' && method === 'GET') {
      const facts = host.overview()
      const info = host.info()
      const totals = ledger.dayTotals()
      const budget = store.getPublic().budget
      const budgetUsedPct = budget.enabled && budget.dailyUsd > 0 ? totals.usd / budget.dailyUsd : 0
      sendJson(res, 200, {
        now: new Date().toISOString(),
        uptimeSec: info.uptimeSec,
        version: info.version,
        paused: facts.paused,
        acceptMode: facts.acceptMode,
        slots: facts.slots,
        tickets: facts.tickets,
        usage: {
          todayUsd: totals.usd,
          todayCalls: totals.calls,
          cacheHitRate: totals.hitRate,
          dailyBudgetUsd: budget.dailyUsd,
          budgetUsedPct,
        },
        host: facts.host,
        upstream: facts.upstream,
        ...(facts.runningSteps ? { runningSteps: facts.runningSteps } : {}),
        alerts: buildAlerts(facts, budget, totals.usd, auth.usingGeneratedPassword),
        recent: events.recent(15),
      })
      return
    }

    // Uploads. Chunks are raw bodies, so these routes never go through `parseJsonBody`/`readBody` (1 MB).
    if (route === '/uploads' && method === 'POST') {
      const service = requireProjects()
      const body = await parseJsonBody(req)
      const parsed = UploadCreateSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      sendJson(res, 200, service.createUpload({ name: parsed.data.name, size: parsed.data.size }))
      return
    }
    const uploadFinishMatch = /^\/uploads\/([^/]+)\/finish$/.exec(route)
    if (uploadFinishMatch !== null && method === 'POST') {
      const service = requireProjects()
      const uploadId = decodeSegment(uploadFinishMatch[1] ?? '')
      if (uploadId === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '上传编号不合法。' })
        return
      }
      const body = await parseJsonBody(req)
      const parsed = UploadFinishSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      sendJson(res, 200, service.finishUpload(uploadId, parsed.data.projectName))
      return
    }
    const uploadMatch = /^\/uploads\/([^/]+)$/.exec(route)
    if (uploadMatch !== null) {
      const service = requireProjects()
      const uploadId = decodeSegment(uploadMatch[1] ?? '')
      if (uploadId === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '上传编号不合法。' })
        return
      }
      if (method === 'GET') {
        const info = service.uploadInfo(uploadId)
        if (info === undefined) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这个上传任务，请重新开始。' })
          return
        }
        sendJson(res, 200, info)
        return
      }
      if (method === 'PUT') {
        const offsetText = url.searchParams.get('offset') ?? ''
        const offset = Number(offsetText)
        if (offsetText.trim() === '' || !Number.isInteger(offset) || offset < 0) {
          req.resume()
          sendJson(res, 400, { error: 'invalid_offset', message: 'offset 必须是从 0 开始的整数。' })
          return
        }
        try {
          const result = await service.appendChunk(uploadId, offset, req, header(req, 'x-chunk-sha256') || undefined)
          sendJson(res, 200, result)
        } catch (error) {
          if (error instanceof UploadConflict) {
            sendJson(res, 409, {
              error: 'offset_mismatch',
              message: `这一块的位置不对，服务端已收到 ${error.received} 字节，请从这里继续。`,
              received: error.received,
            })
            return
          }
          throw error
        }
        return
      }
      if (method === 'DELETE') {
        if (!service.cancelUpload(uploadId)) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这个上传任务。' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }

    // Projects.
    if (route === '/projects' && method === 'GET') {
      sendJson(res, 200, { items: requireProjects().list() })
      return
    }
    const ticketIsOpen = (id: string): boolean => {
      const ticket = host.ticket(id)
      return ticket !== undefined && ticket.status !== 'ended'
    }
    // Make a directory staged under <projectsRoot>/.imports/ a project, or replace an existing project's tree with it.
    if (route === '/projects/import' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = ProjectImportSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const result = await requireProjects().importDirectory({
        sourceDir: parsed.data.path,
        name: parsed.data.name,
        ...(parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
      }, ticketIsOpen)
      sendJson(res, 200, { ok: true, ...result })
      return
    }
    const projectSnapshotsMatch = /^\/projects\/([^/]+)\/snapshots$/.exec(route)
    if (projectSnapshotsMatch !== null && method === 'GET') {
      const id = decodeSegment(projectSnapshotsMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' })
        return
      }
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50))
      sendJson(res, 200, { items: await requireProjects().snapshots(id, limit) })
      return
    }
    const projectDiffMatch = /^\/projects\/([^/]+)\/snapshots\/diff$/.exec(route)
    if (projectDiffMatch !== null && method === 'GET') {
      const id = decodeSegment(projectDiffMatch[1] ?? '')
      const from = url.searchParams.get('from') ?? ''
      const to = url.searchParams.get('to') ?? undefined
      if (id === undefined || !/^[0-9a-f]{7,40}$/.test(from) || (to !== undefined && !/^[0-9a-f]{7,40}$/.test(to))) {
        sendJson(res, 400, { error: 'invalid', message: '项目编号或快照编号不合法。' })
        return
      }
      try {
        sendJson(res, 200, await requireProjects().snapshotDiff(id, from, to))
      } catch (error) {
        if (error instanceof AdminError) throw error
        sendJson(res, 400, { error: 'invalid', message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const projectDeleteSnapshotMatch = /^\/projects\/([^/]+)\/snapshots\/([^/]+)$/.exec(route)
    if (projectDeleteSnapshotMatch !== null && method === 'DELETE') {
      const id = decodeSegment(projectDeleteSnapshotMatch[1] ?? '')
      const sha = decodeSegment(projectDeleteSnapshotMatch[2] ?? '')
      if (id === undefined || sha === undefined || !/^[0-9a-f]{7,40}$/.test(sha)) {
        sendJson(res, 400, { error: 'invalid', message: '项目编号或快照编号不合法。' })
        return
      }
      const deleted = await requireProjects().deleteSnapshot(id, sha, ticketIsOpen)
      try {
        events.add({
          kind: 'project.snapshot_deleted',
          level: 'info',
          text: `删除了项目 ${id} 的历史快照 ${deleted.deleted.slice(0, 8)}（剩余 ${deleted.remaining} 条）`,
          data: { projectId: id, ...deleted },
        })
      } catch {
        // 快照已删除，审计写入失败不影响返回。
      }
      sendJson(res, 200, { ok: true, ...deleted })
      return
    }
    const projectRestoreMatch = /^\/projects\/([^/]+)\/restore$/.exec(route)
    if (projectRestoreMatch !== null && method === 'POST') {
      const id = decodeSegment(projectRestoreMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' })
        return
      }
      const body = await parseJsonBody(req)
      const parsed = ProjectRestoreSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      sendJson(res, 200, { ok: true, ...await requireProjects().restoreSnapshot(id, parsed.data.snapshot, ticketIsOpen) })
      return
    }
    const projectFilesMatch = /^\/projects\/([^/]+)\/files$/.exec(route)
    if (projectFilesMatch !== null && method === 'GET') {
      const id = decodeSegment(projectFilesMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' })
        return
      }
      const root = requireProjects().treeRoot(id)
      if (root === undefined) {
        sendJson(res, 404, { error: 'not_found', message: '项目还没准备好，或找不到这个项目。' })
        return
      }
      handleFilesInRoot(
        res,
        root,
        url.searchParams.get('path') ?? '',
        url.searchParams.get('raw') === '1',
        url.searchParams.get('download') === '1',
      )
      return
    }
    const projectMatch = /^\/projects\/([^/]+)$/.exec(route)
    if (projectMatch !== null) {
      const id = decodeSegment(projectMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' })
        return
      }
      const service = requireProjects()
      if (method === 'GET') {
        const project = service.get(id)
        if (project === undefined) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这个项目。' })
          return
        }
        sendJson(res, 200, project)
        return
      }
      if (method === 'DELETE') {
        if (!service.delete(id)) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这个项目。' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }

    // Books.
    if (route === '/novels' && method === 'GET') {
      const service = requireNovels()
      sendJson(res, 200, { items: await novelCall(() => service.list()) })
      return
    }
    if (route === '/novels' && method === 'POST') {
      const service = requireNovels()
      const parsed = NovelOpenSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) {
        invalidWithHint(res, parsed.error, ['idea'])
        return
      }
      const input = parsed.data
      const created = await novelCall(() => service.openBook({
        idea: input.idea,
        genre: input.genre,
        ...(input.title ? { title: input.title } : {}),
        ...(input.chapterChars ? { chapterChars: input.chapterChars } : {}),
        ...(input.volumes ? { volumes: input.volumes } : {}),
        ...(input.chaptersPerVolume ? { chaptersPerVolume: input.chaptersPerVolume } : {}),
      }))
      sendJson(res, 200, created)
      return
    }
    if (route === '/novels/import' && method === 'POST') {
      const service = requireNovels()
      const parsed = NovelImportSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const input = parsed.data
      const book = await novelCall(() => service.importBook({
        title: input.title,
        genre: input.genre,
        setup: input.setup,
        ...(input.idea ? { idea: input.idea } : {}),
        ...(input.chapterChars ? { chapterChars: input.chapterChars } : {}),
        ...(input.volumes ? { volumes: input.volumes } : {}),
        ...(input.chaptersPerVolume ? { chaptersPerVolume: input.chaptersPerVolume } : {}),
      }))
      sendJson(res, 200, { id: book.id })
      return
    }
    if (route.startsWith('/pi/')) {
      if (piVersions === undefined) throw new AdminError('not_found', 'Pi 版本管理没有开启。', 404)
      const pi = async <T>(work: () => Promise<T>): Promise<void> => {
        try { sendJson(res, 200, await work()) } catch (e) {
          if (e instanceof PiVersionError) throw new AdminError('pi', e.message, e.status)
          throw e
        }
      }
      const field = async (name: 'version' | 'image'): Promise<string> => {
        const body = await parseJsonBody(req)
        const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined
        if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new AdminError('invalid', `缺少 ${name}。`, 400)
        return value.trim()
      }
      if (route === '/pi/status' && method === 'GET') { await pi(() => piVersions.status()); return }
      if (route === '/pi/check' && method === 'POST') { await pi(() => piVersions.check()); return }
      if (route === '/pi/build' && method === 'POST') {
        const body = await parseJsonBody(req)
        const obj = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
        const v = typeof obj.version === 'string' ? obj.version.trim() : ''
        if (!v || v.length > 200) throw new AdminError('invalid', '缺少 version。', 400)
        const baseImage = obj.baseImage === null || typeof obj.baseImage === 'string' ? obj.baseImage : undefined
        const mirrors = typeof obj.mirrors === 'boolean' ? obj.mirrors : undefined
        await pi(() => piVersions.startBuild(v, {
          ...(baseImage !== undefined ? { baseImage } : {}),
          ...(mirrors !== undefined ? { mirrors } : {}),
        }))
        return
      }
      if (route === '/pi/apply' && method === 'POST') { const i = await field('image'); await pi(() => piVersions.apply(i)); return }
      if (route === '/pi/remove' && method === 'POST') { const i = await field('image'); await pi(() => piVersions.remove(i)); return }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route.startsWith('/devenv/')) {
      if (devEnv === undefined) throw new AdminError('not_found', '开发环境管理没有开启。', 404)
      const dev = async <T>(work: () => Promise<T>): Promise<void> => {
        try { sendJson(res, 200, await work()) } catch (e) {
          if (e instanceof DevEnvError) throw new AdminError('devenv', e.message, e.status)
          throw e
        }
      }
      if (route === '/devenv/status' && method === 'GET') { await dev(() => devEnv.status()); return }
      if (route === '/devenv/build' && method === 'POST') {
        const body = await parseJsonBody(req)
        const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
        await dev(() => devEnv.startBuild({ packages: input.packages, features: input.features, mirrors: input.mirrors }))
        return
      }
      if (route === '/devenv/repack' && method === 'POST') {
        const body = await parseJsonBody(req)
        const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
        const devImage = typeof input.devImage === 'string' ? input.devImage.trim() : ''
        if (!devImage || devImage.length > 200) throw new AdminError('invalid', '缺少 devImage。', 400)
        const mirrors = typeof input.mirrors === 'boolean' ? input.mirrors : undefined
        await dev(() => devEnv.startRepack(devImage, { ...(mirrors !== undefined ? { mirrors } : {}) }))
        return
      }
      if (route === '/devenv/apply' && method === 'POST') {
        const body = await parseJsonBody(req)
        const image = body && typeof body === 'object' ? (body as Record<string, unknown>).image : undefined
        if (typeof image !== 'string' || !image.trim() || image.length > 200) throw new AdminError('invalid', '缺少 image。', 400)
        await dev(() => devEnv.apply(image.trim()))
        return
      }
      if (route === '/devenv/remove' && method === 'POST') {
        const body = await parseJsonBody(req)
        const image = body && typeof body === 'object' ? (body as Record<string, unknown>).image : undefined
        if (typeof image !== 'string' || !image.trim() || image.length > 200) throw new AdminError('invalid', '缺少 image。', 400)
        await dev(() => devEnv.removeDevImage(image.trim()))
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route.startsWith('/fanqie/')) {
      if (fanqie === undefined) throw new AdminError('not_found', '番茄发布功能没有开启。', 404)
      if (route === '/fanqie/status' && method === 'GET') { sendJson(res, 200, fanqie.status()); return }
      if (route === '/fanqie/check' && method === 'POST') { sendJson(res, 200, await fanqie.check()); return }
      if (route === '/fanqie/books' && method === 'GET') {
        try { sendJson(res, 200, { items: await fanqie.remoteBooks() }) } catch (e) { throw new AdminError('fanqie', e instanceof Error ? e.message : String(e), 502) }
        return
      }
      const fb = /^\/fanqie\/novels\/([^/]+)(\/bind)?$/.exec(route)
      if (fb !== null) {
        const bookId = BookIdSchema.safeParse(decodeSegment(fb[1] ?? '') ?? '')
        if (!bookId.success) { sendJson(res, 400, { error: 'invalid_path', message: '书的编号不合法。' }); return }
        if (fb[2] === '/bind' && method === 'PUT') {
          const parsed = z.object({ fqBookId: z.string().regex(/^\d{6,30}$/, '番茄作品 ID 应是一串数字') }).strict().safeParse(await parseJsonBody(req))
          if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return }
          fanqie.bind(bookId.data, parsed.data.fqBookId); sendJson(res, 200, { ok: true }); return
        }
        if (!fb[2] && method === 'GET') { sendJson(res, 200, { fqBookId: fanqie.boundTo(bookId.data) ?? null, chapters: fanqie.list(bookId.data) }); return }
      }
      if (route === '/fanqie/sync' && method === 'POST') {
        const parsed = z.object({
          bookId: BookIdSchema, chapters: z.array(z.number().int().min(1).max(99999)).min(1, '请至少选一章').max(500, '一次最多 500 章'),
          mode: z.enum(['draft', 'publish', 'timer']), timerTime: z.number().int().optional(), useAi: z.boolean().default(true),
        }).strict().safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return }
        try { sendJson(res, 200, fanqie.start(parsed.data)) } catch (e) { throw new AdminError('invalid', e instanceof Error ? e.message : String(e), 400) }
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' }); return
    }
    const novelMatch = /^\/novels\/([^/]+)(?:\/(arcs|canon|work|export|chapters\/(\d{1,5})(?:\/(edit|undo|read))?))?$/.exec(route)
    if (novelMatch !== null) {
      const service = requireNovels()
      const id = BookIdSchema.safeParse(decodeSegment(novelMatch[1] ?? '') ?? '')
      if (!id.success) {
        sendJson(res, 400, { error: 'invalid_path', message: '书的编号不合法。' })
        return
      }
      const bookId = id.data
      const sub = novelMatch[2]
      if (sub === undefined && method === 'GET') {
        sendJson(res, 200, await novelCall(() => service.detail(bookId)))
        return
      }
      if (sub === undefined && method === 'DELETE') {
        await novelCall(() => service.deleteBook(bookId))
        sendJson(res, 200, { ok: true })
        return
      }
      if (sub === 'arcs' && method === 'POST') {
        const parsed = NovelArcSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) {
          invalidWithHint(res, parsed.error, ['note'])
          return
        }
        const result = await novelCall(() => service.startArc(bookId, parsed.data.note))
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (sub === 'canon' && method === 'GET') {
        sendJson(res, 200, await novelCall(() => service.canon(bookId)))
        return
      }
      if (sub === 'work' && method === 'GET') {
        sendJson(res, 200, await novelCall(() => service.work(bookId)))
        return
      }
      if (sub === 'export' && method === 'GET') {
        const from = clampInt(url.searchParams.get('from'), 1, 1, 100000)
        const toRaw = url.searchParams.get('to')
        const exported = await novelCall(() => service.exportText(bookId, from, toRaw === null ? undefined : clampInt(toRaw, from, from, 100000)))
        const name = encodeURIComponent(`${exported.title}.txt`)
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${name}`,
          'cache-control': 'no-store',
        })
        res.end(exported.text)
        return
      }
      const chapterAction = novelMatch[4]
      if (sub?.startsWith('chapters/') && chapterAction === undefined && method === 'GET') {
        const n = Number(novelMatch[3])
        sendJson(res, 200, await novelCall(() => service.chapter(bookId, n)))
        return
      }
      if (sub?.startsWith('chapters/') && chapterAction !== undefined && method === 'POST') {
        const n = Number(novelMatch[3])
        if (chapterAction === 'edit') {
          const parsed = NovelEditSchema.safeParse(await parseJsonBody(req))
          if (!parsed.success) {
            invalidWithHint(res, parsed.error, ['note'])
            return
          }
          sendJson(res, 200, { ok: true, edit: await novelCall(() => service.editChapter(bookId, n, parsed.data.note)) })
          return
        }
        if (chapterAction === 'undo') {
          sendJson(res, 200, { ok: true, edit: await novelCall(() => service.undoEdit(bookId, n)) })
          return
        }
        await novelCall(() => service.markRead(bookId, n))
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }

    // Councils.
    if (route === '/councils' && method === 'GET') {
      const ticketId = url.searchParams.get('ticketId') ?? ''
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
      sendJson(res, 200, {
        items: requireCouncils().list({ ...(ticketId === '' ? {} : { ticketId }), limit }),
      })
      return
    }
    if (route === '/councils' && method === 'POST') {
      const service = requireCouncils()
      const body = await parseJsonBody(req)
      const parsed = CouncilCreateSchema.safeParse(body)
      if (!parsed.success) {
        invalidWithHint(res, parsed.error, ['text'])
        return
      }
      const created = service.create({
        mode: parsed.data.mode,
        text: parsed.data.text,
        ...(parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
        ...(parsed.data.ticketId === undefined ? {} : { ticketId: parsed.data.ticketId }),
        ...(parsed.data.rounds === undefined ? {} : { rounds: parsed.data.rounds }),
        ...(parsed.data.roles === undefined ? {} : { roles: parsed.data.roles }),
        ...(parsed.data.autoStart === undefined ? {} : { autoStart: parsed.data.autoStart }),
      })
      sendJson(res, 200, created)
      return
    }
    const councilActionMatch = /^\/councils\/([^/]+)\/(cancel|commit)$/.exec(route)
    if (councilActionMatch !== null && method === 'POST') {
      const service = requireCouncils()
      const id = decodeSegment(councilActionMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '会商编号不合法。' })
        return
      }
      const action = councilActionMatch[2]
      if (action === 'cancel') {
        service.cancel(id)
        sendJson(res, 200, { ok: true })
        return
      }
      // Commit: only a finished brief can become a ticket, and only once.
      const body = await parseJsonBody(req)
      const parsed = CouncilCommitSchema.safeParse(body)
      if (!parsed.success) {
        invalidWithHint(res, parsed.error, ['brief'])
        return
      }
      const record = service.get(id)
      if (record === undefined) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这次会商。' })
        return
      }
      if (record.mode !== 'brief') throw new AdminError('invalid', '只有任务书模式的会商可以开票。', 400)
      if (record.status !== 'done') throw new AdminError('invalid', '会商还没完成，不能开票。', 400)
      if (record.ticketId !== undefined) throw new AdminError('invalid', '这次会商已经开过任务了。', 400)
      const brief = (parsed.data.brief ?? record.brief ?? '').trim()
      if (brief === '') throw new AdminError('invalid', '这次会商还没有任务书，请等主持人汇总完成。', 400)
      if (brief.length > MAX_COUNCIL_BRIEF_CHARS) {
        throw new AdminError('invalid', '会商任务书不能超过 10000 字，请精简后再开票。', 400)
      }
      const projectId = parsed.data.projectId ?? record.projectId
      service.rememberBrief(id, brief)
      const result = await host.createTicket(brief, parsed.data.model || undefined, parsed.data.secrets, projectId)
      if (result.ticketId !== undefined) service.attachTicket(id, result.ticketId)
      sendJson(res, 200, {
        ok: true,
        ...(result.ticketId === undefined ? {} : { ticketId: result.ticketId }),
        triggerId: result.triggerId,
      })
      return
    }
    const councilMatch = /^\/councils\/([^/]+)$/.exec(route)
    if (councilMatch !== null) {
      const service = requireCouncils()
      const id = decodeSegment(councilMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '会商编号不合法。' })
        return
      }
      if (method === 'GET') {
        const detail = service.detail(id)
        if (detail === undefined) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这次会商。' })
          return
        }
        sendJson(res, 200, detail)
        return
      }
      if (method === 'DELETE') {
        if (!service.remove(id)) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这次会商。' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }

    // Secrets. The request routes are declared before `/secrets/:name` so `requests` is not read as a name.
    if (route === '/secrets' && method === 'GET') {
      sendJson(res, 200, { items: host.listSecrets() })
      return
    }
    if (route === '/secrets' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = SecretCreateSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      try {
        host.createSecret(parsed.data)
      } catch (error) {
        if (error instanceof AdminError && error.code === 'exists') {
          sendJson(res, 409, { error: 'exists', message: error.message })
          return
        }
        throw error
      }
      sendJson(res, 200, { ok: true })
      return
    }
    if (route === '/secrets/requests' && method === 'GET') {
      sendJson(res, 200, { items: host.secretRequests() })
      return
    }
    const secretRequestMatch = /^\/secrets\/requests\/([^/]+)$/.exec(route)
    if (secretRequestMatch !== null && method === 'POST') {
      const id = decodeSegment(secretRequestMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '请求编号不合法。' })
        return
      }
      const body = await parseJsonBody(req)
      const parsed = SecretDecisionSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      host.decideSecretRequest(id, parsed.data.decision)
      sendJson(res, 200, { ok: true })
      return
    }
    const secretMatch = /^\/secrets\/([^/]+)$/.exec(route)
    if (secretMatch !== null && method === 'PUT') {
      const name = decodeSegment(secretMatch[1] ?? '')
      if (name === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '密钥名称不合法。' })
        return
      }
      const body = await parseJsonBody(req)
      const parsed = SecretUpdateSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      host.updateSecret(name, parsed.data)
      sendJson(res, 200, { ok: true })
      return
    }
    if (secretMatch !== null && method === 'DELETE') {
      const name = decodeSegment(secretMatch[1] ?? '')
      if (name === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '密钥名称不合法。' })
        return
      }
      host.deleteSecret(name)
      sendJson(res, 200, { ok: true })
      return
    }

    // Tickets.
    if (route === '/tickets' && method === 'GET') {
      const statusValue = url.searchParams.get('status') ?? 'all'
      if (statusValue !== 'open' && statusValue !== 'ended' && statusValue !== 'needs-person' && statusValue !== 'all') {
        sendJson(res, 400, { error: 'invalid', message: 'status 只能是 open、ended、needs-person 或 all。' })
        return
      }
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
      const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000)
      const result = host.listTickets({ status: statusValue as TicketStatusFilter, ...(q === '' ? {} : { q }), limit, offset })
      sendJson(res, 200, { total: result.total, items: result.items.map(labelSummary) })
      return
    }
    if (route === '/tickets' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = CreateTicketSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      let goal: GoalSpec | undefined
      if (parsed.data.goal !== undefined) {
        try {
          goal = resolveGoal(parsed.data.goal, store.get().goal)
        } catch (error) {
          if (error instanceof GoalError) {
            invalid(res, [{ path: `goal.${error.field}`, message: error.message }])
            return
          }
          throw error
        }
      }
      const result = await host.createTicket(
        parsed.data.text,
        parsed.data.model || undefined,
        parsed.data.secrets,
        parsed.data.projectId,
        parsed.data.collab,
        goal,
        parsed.data.projectMode,
      )
      sendJson(res, 200, { ok: true, ...result })
      return
    }
    // Declared before the id route: `delete` would otherwise look like a ticket id.
    if (route === '/tickets/delete' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = BatchDeleteSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      sendJson(res, 200, host.deleteTickets(parsed.data.ids, {
        deleteWorkspace: parsed.data.deleteWorkspace ?? true,
        force: parsed.data.force ?? false,
      }))
      return
    }

    const streamMatch = /^\/tickets\/([^/]+)\/activity\/stream$/.exec(route)
    if (streamMatch !== null && method === 'GET') {
      const id = decodeSegment(streamMatch[1] ?? '')
      if (id === undefined || host.ticket(id) === undefined) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' })
        return
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      })
      let last = clampInt(String(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? ''), 0, 0, Number.MAX_SAFE_INTEGER)
      let beat = 0
      const push = (): void => {
        if (res.writableEnded || res.destroyed) return
        const view = activity ? activity.list(id, last, 120) : { items: [], last: 0 }
        if (view.last < last) last = 0
        for (const item of view.items) res.write(`id: ${item.seq}\nevent: step\ndata: ${JSON.stringify(item)}\n\n`)
        if (view.items.length > 0) last = Math.max(last, view.last)
        else if (++beat % 15 === 0) res.write(': ping\n\n')
      }
      res.write('retry: 3000\n\n')
      try { push() } catch { /* next tick */ }
      const timer = setInterval(() => { try { push() } catch { /* keep the stream */ } }, 1000)
      timer.unref()
      const stopStream = (): void => clearInterval(timer)
      res.on('close', stopStream)
      res.on('error', stopStream)
      return
    }
    const activityMatch = /^\/tickets\/([^/]+)\/activity$/.exec(route)
    if (activityMatch !== null && method === 'GET') {
      const id = decodeSegment(activityMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' })
        return
      }
      if (host.ticket(id) === undefined) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' })
        return
      }
      const after = clampInt(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = clampInt(url.searchParams.get('limit'), 120, 1, 300)
      sendJson(res, 200, activity ? activity.list(id, after, limit) : { items: [], last: 0 })
      return
    }
    const goalMatch = /^\/tickets\/([^/]+)\/goal$/.exec(route)
    if (goalMatch !== null) {
      if (goals === undefined) throw new AdminError('not_found', '目标功能没有开启。', 404)
      const id = decodeSegment(goalMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' })
        return
      }
      const ticket = host.ticket(id)
      if (ticket === undefined) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' })
        return
      }
      if (method === 'GET') {
        sendJson(res, 200, { goal: goals.view(id) ?? null })
        return
      }
      if (method === 'PUT') {
        if (ticket.status === 'ended') {
          sendJson(res, 400, { error: 'invalid', message: '任务已经结束。先在任务里发一句话重新打开，再设目标。' })
          return
        }
        const body = await parseJsonBody(req)
        const parsed = GoalInputSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let spec: GoalSpec
        try {
          spec = resolveGoal(parsed.data, store.get().goal)
        } catch (error) {
          if (error instanceof GoalError) {
            invalid(res, [{ path: error.field, message: error.message }])
            return
          }
          throw error
        }
        sendJson(res, 200, { ok: true, goal: goals.set(id, spec) ?? null })
        return
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { ok: goals.cancel(id) })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    const actionMatch = /^\/tickets\/([^/]+)\/(stop|retry|note|reply|files|secrets|deliverables|archive)$/.exec(route)
    const ticketMatch = /^\/tickets\/([^/]+)$/.exec(route)
    if (ticketMatch !== null && method === 'GET') {
      const id = decodeSegment(ticketMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' })
        return
      }
      const ticket = host.ticket(id)
      if (ticket === undefined) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' })
        return
      }
      const totals = ledger.ticketTotals(id)
      // While a 2 GB project tree is copied into the workspace the ticket is still `preparing`, not yet working.
      const label = ticket.project?.preparing
        ? { label: '正在准备项目文件', hint: '正在把项目复制到这个任务的工作区，第一次会久一点。' }
        : ticketStatusLabel(ticket)
      const council = councils?.forTicket(id)
      sendJson(res, 200, {
        ...ticket,
        ...(council === undefined ? {} : { council }),
        secrets: host.ticketSecrets(id),
        previews: host.ticketPreviews(id),
        links: host.ticketLinks(id),
        stageLabel: label.label,
        stageHint: label.hint,
        usage: { totalUsd: totals.usd, calls: totals.calls, hit: totals.hit, miss: totals.miss, out: totals.out, hitRate: totals.hitRate },
        calls: ledger.calls({ ticketId: id, limit: 50 }),
        byAgent: ledger.ticketByAgent(id),
        ...(goals ? { goal: goals.view(id) } : {}),
        events: events.list({ ticketId: id, limit: 100 }),
      })
      return
    }
    if (ticketMatch !== null && method === 'DELETE') {
      const id = decodeSegment(ticketMatch[1] ?? '')
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' })
        return
      }
      const body = await parseJsonBody(req)
      const parsed = DeleteTicketSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      sendJson(res, 200, host.deleteTicket(id, {
        deleteWorkspace: parsed.data.deleteWorkspace ?? true,
        force: parsed.data.force ?? false,
      }))
      return
    }
    if (actionMatch !== null) {
      const id = decodeSegment(actionMatch[1] ?? '')
      const action = actionMatch[2]
      if (id === undefined) {
        sendJson(res, 400, { error: 'invalid_path', message: '任务票编号不合法。' })
        return
      }
      if (action === 'files' && method === 'GET') {
        handleFiles(
          res,
          id,
          url.searchParams.get('path') ?? '',
          url.searchParams.get('raw') === '1',
          url.searchParams.get('download') === '1',
        )
        return
      }
      if (action === 'deliverables' && method === 'GET') {
        if (host.ticket(id) === undefined) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' })
          return
        }
        sendJson(res, 200, { items: host.deliverables(id) })
        return
      }
      if (action === 'archive' && method === 'GET') {
        const which = url.searchParams.get('path') ?? ''
        if (!ArchiveQuerySchema.safeParse(which).success) {
          sendJson(res, 400, { error: 'invalid_path', message: 'path 只能是 project 或 output。' })
          return
        }
        const workspace = host.workspaceRoot(id)
        if (workspace === undefined) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' })
          return
        }
        const directory = join(workspace, which)
        let info
        try {
          info = lstatSync(directory)
        } catch {
          sendJson(res, 404, { error: 'not_found', message: which === 'project' ? '这张票没有项目目录。' : '这张票没有产出目录。' })
          return
        }
        if (!info.isDirectory() || info.isSymbolicLink()) {
          sendJson(res, 404, { error: 'not_found', message: '这个目录不存在。' })
          return
        }
        let realDirectory: string
        let realWorkspace: string
        try {
          realDirectory = realpathSync(directory)
          realWorkspace = realpathSync(workspace)
        } catch {
          sendJson(res, 404, { error: 'not_found', message: '这个目录不存在。' })
          return
        }
        if (!isInside(realWorkspace, realDirectory)) {
          sendJson(res, 403, { error: 'forbidden', message: '这个目录超出了任务的工作区。' })
          return
        }
        serveTarArchive(res, realDirectory, `${id}-${which}.tar.gz`)
        return
      }
      if (action === 'secrets' && method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = TicketSecretsSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        sendJson(res, 200, host.setTicketSecrets(id, parsed.data.names))
        return
      }
      if (action === 'stop' && method === 'POST') {
        const body = await parseJsonBody(req)
        const parsed = StopSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        host.stopTicket(id, parsed.data.reason === undefined || parsed.data.reason === '' ? undefined : parsed.data.reason)
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'retry' && method === 'POST') {
        host.retryTicket(id)
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'note' && method === 'POST') {
        const body = await parseJsonBody(req)
        const parsed = TextSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        host.noteTicket(id, parsed.data.text)
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'reply' && method === 'POST') {
        const body = await parseJsonBody(req)
        const parsed = ReplySchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        if (parsed.data.model) host.replyTicket(id, parsed.data.text, parsed.data.model)
        else host.replyTicket(id, parsed.data.text)
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }

    // Decisions.
    if (route === '/decisions' && method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
      const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000)
      const kindValue = url.searchParams.get('kind') ?? ''
      const kinds = ['accept', 'ignore', 'stop', 'unavailable', 'reopen']
      if (kindValue !== '' && !kinds.includes(kindValue)) {
        sendJson(res, 400, { error: 'invalid', message: 'kind 只能是 accept、ignore、stop、unavailable 或 reopen。' })
        return
      }
      const items = host.decisions(limit, offset, kindValue === '' ? undefined : kindValue).map(decision => {
        const { texts, unknown } = reasonLabels(decision.reasons)
        return {
          id: decision.id,
          at: decision.at,
          kind: decision.kind,
          kindLabel: decisionKindLabel(decision.kind),
          threadKey: decision.threadKey,
          ...(decision.ticketId === undefined ? {} : { ticketId: decision.ticketId }),
          triggerText: decision.triggerText,
          reasonText: texts,
          strength: decision.strength,
          ...(unknown.length === 0 ? {} : { data: { reasons: unknown } }),
        }
      })
      sendJson(res, 200, { items })
      return
    }

    // Usage.
    if (route === '/usage' && method === 'GET') {
      const rangeValue = url.searchParams.get('range') ?? 'today'
      if (rangeValue !== 'today' && rangeValue !== '7d' && rangeValue !== '30d') {
        sendJson(res, 400, { error: 'invalid', message: 'range 只能是 today、7d 或 30d。' })
        return
      }
      const summary = ledger.summary(rangeValue as UsageRange)
      const titles = host.ticketTitles(summary.topTickets.map(ticket => ticket.ticketId))
      sendJson(res, 200, {
        totals: summary.totals,
        byDay: summary.byDay,
        byModel: summary.byModel,
        topTickets: summary.topTickets.map(ticket => ({
          ticketId: ticket.ticketId,
          title: titles[ticket.ticketId] ?? '',
          usd: ticket.usd,
          calls: ticket.calls,
        })),
      })
      return
    }
    if (route === '/usage/calls' && method === 'GET') {
      const ticketId = url.searchParams.get('ticketId') ?? undefined
      const model = url.searchParams.get('model') ?? undefined
      const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500)
      const before = optionalCursor(url.searchParams.get('before'))
      sendJson(res, 200, {
        items: ledger.calls({
          ...(ticketId === undefined || ticketId === '' ? {} : { ticketId }),
          ...(model === undefined || model === '' ? {} : { model }),
          limit,
          ...(before === undefined ? {} : { before }),
        }),
      })
      return
    }

    // Events.
    if (route === '/events' && method === 'GET') {
      const ticketId = url.searchParams.get('ticketId') ?? undefined
      const level = url.searchParams.get('level') ?? undefined
      if (level !== undefined && level !== 'info' && level !== 'warn' && level !== 'error') {
        sendJson(res, 400, { error: 'invalid', message: 'level 只能是 info、warn 或 error。' })
        return
      }
      const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500)
      const before = optionalCursor(url.searchParams.get('before'))
      sendJson(res, 200, {
        items: events.list({
          ...(ticketId === undefined || ticketId === '' ? {} : { ticketId }),
          ...(level === undefined ? {} : { level: level as EventLevel }),
          limit,
          ...(before === undefined ? {} : { before }),
        }),
      })
      return
    }

    // Settings.
    if (route === '/settings/policy') {
      if (method === 'GET') {
        sendJson(res, 200, host.getPolicy())
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = PolicySchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const repeatedRules = duplicates(parsed.data.rules.map(rule => rule.id))
        if (repeatedRules.length > 0) {
          invalid(res, [{ path: 'rules', message: `规则 ID 不能重复：${repeatedRules.join('、')}` }])
          return
        }
        const repeatedOperators = duplicates(parsed.data.allowedOperators.map(operator => operator.id))
        if (repeatedOperators.length > 0) {
          invalid(res, [{ path: 'allowedOperators', message: `操作员 ID 不能重复：${repeatedOperators.join('、')}` }])
          return
        }
        const repeatedFeishu = duplicates(parsed.data.feishuOperators.map(operator => operator.id))
        if (repeatedFeishu.length > 0) {
          invalid(res, [{ path: 'feishuOperators', message: `飞书操作员 ID 不能重复：${repeatedFeishu.join('、')}` }])
          return
        }
        const result = host.updatePolicy(parsed.data as PolicyInput)
        finishSettings(res, 'policy', result.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/feishu') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().feishu)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = FeishuSettingsSchema.safeParse(withoutReadOnlySecrets(body))
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let updated
        try {
          updated = store.updateFeishu(parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'feishu', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/feishu/test' && method === 'POST') {
      sendJson(res, 200, await host.testFeishu())
      return
    }
    if (route === '/settings/feishu/status' && method === 'GET') {
      sendJson(res, 200, host.feishuStatus())
      return
    }
    if (route === '/settings/feishu/reconnect' && method === 'POST') {
      sendJson(res, 200, await host.reconnectFeishu())
      return
    }
    if (route === '/settings/github/test' && method === 'POST') {
      sendJson(res, 200, await host.testGithub())
      return
    }
    if (route === '/settings/github') {
      if (method === 'GET') {
        sendJson(res, 200, { ...store.getPublic().github, tokenSet: host.githubTokenSet() })
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = GithubSettingsSchema.safeParse(withoutReadOnlySecrets(body))
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const { token, ...section } = parsed.data
        let updated
        try {
          updated = store.update('github', section)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        if (token !== undefined && token !== '') host.setGithubToken(token)
        finishSettings(res, 'github', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/email/test' && method === 'POST') {
      sendJson(res, 200, await host.testEmail())
      return
    }
    if (route === '/settings/email/status' && method === 'GET') {
      sendJson(res, 200, host.emailStatus())
      return
    }
    if (route === '/settings/email') {
      if (method === 'GET') {
        sendJson(res, 200, { ...store.getPublic().email, passwordSet: host.emailPasswordSet() })
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = EmailSettingsSchema.safeParse(withoutReadOnlySecrets(body))
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const { password, ...section } = parsed.data
        // Validate merged email options before mutating the vault or policy so invalid saves leave no partial side effects.
        const mergedCheck = OptionsSchema.shape.email.safeParse({ ...store.get().email, ...section })
        if (!mergedCheck.success) {
          invalid(res, issuesOf(mergedCheck.error))
          return
        }
        // Write vault password and policy whitelist before store.updateEmail restarts the poll loop.
        if (password !== undefined && password !== '') host.setEmailPassword(password)
        host.setEmailAllowedSenders(section.allowedSenders)
        let updated
        try {
          updated = store.updateEmail(section)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        const changed = [...updated.changed]
        if (password !== undefined && password !== '') {
          if (!changed.includes('email.password')) changed.push('email.password')
          if (updated.changed.length === 0) await host.restartEmail?.()
        }
        finishSettings(res, 'email', changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/email/send' && method === 'POST') {
      if (!host.sendEmail) throw new AdminError('not_found', '当前运行时未启用邮箱发送。', 404)
      const body = await parseJsonBody(req)
      const parsed = EmailSendSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      await host.sendEmail(parsed.data)
      sendJson(res, 200, { ok: true })
      return
    }
    if (route === '/settings/wechat/qr/start' && method === 'POST') {
      if (!host.startWechatQr) throw new AdminError('not_found', '当前运行时不支持个人微信扫码绑定。', 404)
      const body = await parseJsonBody(req).catch(() => ({}))
      const force = typeof body === 'object' && body !== null && (body as { force?: unknown }).force === true
      const qr = await host.startWechatQr({ force })
      sendJson(res, 200, { ok: true, qr, status: host.wechatStatus?.() })
      return
    }
    if (route === '/settings/wechat/qr/status' && method === 'GET') {
      sendJson(res, 200, {
        qr: host.wechatQrStatus ? host.wechatQrStatus() : { active: false, status: 'idle', message: '未启用', updatedAt: new Date().toISOString() },
        status: host.wechatStatus ? host.wechatStatus() : { state: 'off', mode: store.getPublic().wechat.mode, received: 0, sent: 0 },
      })
      return
    }
    if (route === '/settings/wechat/qr/verify' && method === 'POST') {
      if (!host.verifyWechatQr) throw new AdminError('not_found', '当前运行时不支持个人微信扫码配对。', 404)
      const body = await parseJsonBody(req)
      const code = typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code.trim()
        : ''
      if (!code || code.length > 32) {
        invalid(res, [{ path: 'code', message: '请输入手机微信上显示的数字配对码' }])
        return
      }
      const qr = host.verifyWechatQr(code)
      sendJson(res, 200, { ok: true, qr })
      return
    }
    if (route === '/settings/wechat/qr/logout' && method === 'POST') {
      if (!host.logoutWechatIlink) throw new AdminError('not_found', '当前运行时不支持个人微信解绑。', 404)
      await host.logoutWechatIlink()
      events.add({ kind: 'settings.changed', level: 'info', text: '已断开个人微信插件绑定', data: { section: 'wechat' } })
      sendJson(res, 200, { ok: true, status: host.wechatStatus?.() })
      return
    }
    if (route === '/settings/wechat/test' && method === 'POST') {
      sendJson(res, 200, host.testWechat ? await host.testWechat() : { ok: false, message: '微信来源未启用。' })
      return
    }
    if (route === '/settings/wechat/status' && method === 'GET') {
      sendJson(res, 200, host.wechatStatus ? host.wechatStatus() : { state: 'off', mode: store.getPublic().wechat.mode, received: 0, sent: 0 })
      return
    }
    if (route === '/settings/wechat') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().wechat)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = WechatSettingsSchema.safeParse(withoutReadOnlySecrets(body))
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let updated
        try {
          updated = store.updateWechat(parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        host.setWechatAllowedUsers?.(store.get().wechat.allowedUsers)
        finishSettings(res, 'wechat', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/wechat/send' && method === 'POST') {
      if (!host.sendWechat) throw new AdminError('not_found', '当前运行时未启用微信发送。', 404)
      const body = await parseJsonBody(req)
      const parsed = WechatSendSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      await host.sendWechat({
        text: parsed.data.text,
        ...(parsed.data.to ? { to: parsed.data.to } : {}),
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
      })
      sendJson(res, 200, { ok: true })
      return
    }
    if (route === '/settings/director') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().director)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = DirectorSettingsSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const model = parsed.data.model
        if (parsed.data.enabled && model !== null && findModel(store.get().models, model, { enabledOnly: true }) === undefined) {
          invalid(res, [{ path: 'model', message: '总控模型不存在或所在服务商未启用' }])
          return
        }
        let updated
        try {
          updated = store.update('director', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'director', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/director/status' && method === 'GET') {
      sendJson(res, 200, requireDirector().status())
      return
    }
    if (route === '/director/sessions' && method === 'GET') {
      const channelRaw = url.searchParams.get('channel')
      const channel = channelRaw === 'wechat' || channelRaw === 'web' || channelRaw === 'feishu' ? channelRaw : undefined
      const svc = requireDirector()
      sendJson(res, 200, {
        status: svc.status(),
        items: svc.listSessions(channel),
        pendingActions: svc.listPendingActions(undefined, true),
      })
      return
    }
    const dirResetMatch = /^\/director\/sessions\/([^/]+)\/reset$/.exec(route)
    if (dirResetMatch !== null && method === 'POST') {
      const sid = decodeSegment(dirResetMatch[1] ?? '')
      if (!sid || !requireDirector().resetSession(sid)) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这个总控会话。' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }
    const dirSessionMatch = /^\/director\/sessions\/([^/]+)$/.exec(route)
    if (dirSessionMatch !== null && method === 'GET') {
      const sid = decodeSegment(dirSessionMatch[1] ?? '')
      const detail = sid ? requireDirector().getSessionDetail(sid) : undefined
      if (!detail) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这个总控会话。' })
        return
      }
      sendJson(res, 200, detail)
      return
    }
    if (route === '/director/chat' && method === 'POST') {
      const svc = requireDirector()
      const body = await parseJsonBody(req)
      const parsed = DirectorChatSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const resChat = await svc.chat(parsed.data)
      sendJson(res, 200, { ok: true, ...resChat })
      return
    }
    if (route === '/director/actions' && method === 'GET') {
      const sid = url.searchParams.get('sessionId') || undefined
      const onlyPending = url.searchParams.get('pending') === '1'
      sendJson(res, 200, { items: requireDirector().listPendingActions(sid, onlyPending) })
      return
    }
    const dirActionMatch = /^\/director\/actions\/([^/]+)\/decide$/.exec(route)
    if (dirActionMatch !== null && method === 'POST') {
      const aid = decodeSegment(dirActionMatch[1] ?? '')
      if (!aid) {
        sendJson(res, 400, { error: 'invalid', message: '缺少操作短码。' })
        return
      }
      const body = await parseJsonBody(req)
      const parsed = DirectorActionDecideSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const decided = await requireDirector().decidePendingAction(aid, parsed.data.decision)
      sendJson(res, decided.ok ? 200 : 400, decided)
      return
    }
    if (route === '/director/followups' && method === 'GET') {
      const sid = url.searchParams.get('sessionId') || undefined
      const onlyPending = url.searchParams.get('pending') === '1'
      sendJson(res, 200, { items: requireDirector().store.listFollowups(sid, onlyPending) })
      return
    }
    const dirFwCancelMatch = /^\/director\/followups\/([^/]+)\/cancel$/.exec(route)
    if (dirFwCancelMatch !== null && method === 'POST') {
      const fid = decodeSegment(dirFwCancelMatch[1] ?? '')
      if (!fid) {
        sendJson(res, 400, { error: 'invalid', message: '缺少续接计划编号。' })
        return
      }
      const ok = requireDirector().store.cancelFollowup(fid)
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, id: fid } : { error: 'not_found', message: '未找到处于等待状态的续接计划。' })
      return
    }
    if (route === '/settings/projects') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().projects)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = ProjectsSettingsSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let updated
        try {
          updated = store.update('projects', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'projects', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/novel') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().novel)
        return
      }
      if (method === 'PUT') {
        const parsed = NovelSettingsSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let updated
        try {
          updated = store.update('novel', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'novel', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/goal') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().goal)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = GoalSettingsSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const judge = parsed.data.judge
        if (judge !== null && findModel(store.get().models, judge, { enabledOnly: true }) === undefined) {
          invalid(res, [{ path: 'judge', message: '判定模型不存在或没有启用' }])
          return
        }
        let updated
        try {
          updated = store.update('goal', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'goal', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    // SSH connections: the private key goes to the vault as SSH_KEY_<NAME>; the host key is scanned once and pinned.
    if (route === '/ssh' && method === 'GET') {
      const secrets = new Set(host.listSecrets().map(item => item.name))
      const ssh = store.get().ssh
      sendJson(res, 200, {
        allTickets: ssh.allTickets,
        connections: ssh.connections.map(c => ({ ...c, keySecret: keySecretName(c.name), keySet: secrets.has(keySecretName(c.name)) })),
      })
      return
    }
    if (route === '/ssh/settings' && method === 'POST') {
      const body = await parseJsonBody(req)
      const allTickets = body && typeof body === 'object' ? (body as Record<string, unknown>).allTickets : undefined
      if (typeof allTickets !== 'boolean') throw new AdminError('invalid', '缺少 allTickets。', 400)
      const updated = store.update('ssh', { ...store.get().ssh, allTickets })
      finishSettings(res, 'ssh', updated.changed)
      return
    }
    if (route === '/ssh/connections' && method === 'POST') {
      const body = await parseJsonBody(req)
      const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
      const privateKey = typeof raw.privateKey === 'string' ? raw.privateKey : ''
      const draft = { name: raw.name, host: typeof raw.host === 'string' ? raw.host.trim() : raw.host, port: raw.port ?? 22, user: raw.user, knownHosts: '' }
      const parsed = SshConnectionSchema.safeParse(draft)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const conn = parsed.data
      const secret = keySecretName(conn.name)
      const hasKey = host.listSecrets().some(item => item.name === secret)
      if (privateKey.trim() !== '' && !looksLikeKey(privateKey)) {
        invalid(res, [{ path: 'privateKey', message: '这不像 SSH 私钥（要包含 BEGIN … PRIVATE KEY）' }])
        return
      }
      if (privateKey.trim() === '' && !hasKey) {
        invalid(res, [{ path: 'privateKey', message: '新连接要填私钥' }])
        return
      }
      let knownHosts: string
      try {
        knownHosts = await scanHostKeys(conn.host, conn.port)
      } catch (error) {
        invalid(res, [{ path: 'host', message: error instanceof Error ? error.message : String(error) }])
        return
      }
      if (privateKey.trim() !== '') {
        const value = `${privateKey.trim().replace(/\r\n/g, '\n')}\n`
        if (hasKey) host.updateSecret(secret, { value })
        else host.createSecret({ name: secret, value, description: `SSH 连接 ${conn.name} 的私钥` })
      }
      const ssh = store.get().ssh
      const connections = [...ssh.connections.filter(c => c.name !== conn.name), { ...conn, knownHosts }]
      const updated = store.update('ssh', { ...ssh, connections })
      finishSettings(res, 'ssh', updated.changed, { knownHosts })
      return
    }
    const sshMatch = /^\/ssh\/connections\/([^/]+)$/.exec(route)
    if (sshMatch !== null && method === 'DELETE') {
      const name = decodeSegment(sshMatch[1] ?? '')
      const ssh = store.get().ssh
      if (name === undefined || !ssh.connections.some(c => c.name === name)) {
        sendJson(res, 404, { error: 'not_found', message: '没有这个连接。' })
        return
      }
      const updated = store.update('ssh', { ...ssh, connections: ssh.connections.filter(c => c.name !== name) })
      if (host.listSecrets().some(item => item.name === keySecretName(name))) host.deleteSecret(keySecretName(name))
      finishSettings(res, 'ssh', updated.changed)
      return
    }
    if (route === '/settings/web') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().web)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        // The Exa key is write-only: a save without it (or with '') keeps the stored key; `exaKeyClear: true` drops it.
        const raw = (typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : body) as Record<string, unknown>
        const clear = raw?.exaKeyClear === true
        if (raw && typeof raw === 'object') {
          delete raw.exaKeyClear
          delete raw.exaKeySet
          if (!clear && (raw.exaKey === undefined || raw.exaKey === '')) raw.exaKey = store.get().web.exaKey
          if (clear) raw.exaKey = ''
        }
        const parsed = WebSettingsSchema.safeParse(raw)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const model = parsed.data.claudeModel
        if (model !== null) {
          const found = findModel(store.get().models, model, { enabledOnly: true })
          if (found === undefined || found.provider.api !== 'anthropic-messages') {
            invalid(res, [{ path: 'claudeModel', message: 'Claude 代搜要用 Anthropic 协议服务商上已启用的模型' }])
            return
          }
        }
        const gModel = parsed.data.geminiModel
        if (gModel !== null) {
          const found = findModel(store.get().models, gModel, { enabledOnly: true })
          if (found === undefined) {
            invalid(res, [{ path: 'geminiModel', message: 'Gemini 搜索模型必须是已启用服务商上的模型' }])
            return
          }
        }
        let updated
        try {
          updated = store.update('web', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'web', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/collab') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().collab)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = CollabSettingsSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        // A role's model must be usable when it is chosen; one disabled later falls back to the ticket's model.
        const models = store.get().models
        const issues = parsed.data.roles.flatMap((role, index) =>
          role.model === null || findModel(models, role.model, { enabledOnly: true }) !== undefined
            ? []
            : [{ path: `roles.${index}.model`, message: `角色「${role.name}」用的模型不存在或没有启用` }])
        if (issues.length > 0) {
          invalid(res, issues)
          return
        }
        let updated
        try {
          updated = store.update('collab', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'collab', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/council') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().council)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = CouncilSettingsSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let updated
        try {
          updated = store.update('council', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'council', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/preview') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().preview)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = PreviewSettingsSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let updated
        try {
          updated = store.update('preview', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'preview', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/executor') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().executor)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = ExecutorSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let updated
        try {
          updated = store.update('executor', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'executor', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/settings/models/test' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = ModelTestSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      sendJson(res, 200, await host.modelTest(parsed.data.provider, parsed.data.model))
      return
    }
    if (route === '/settings/models/discover' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = ModelDiscoverSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      sendJson(res, 200, await host.discoverModels(parsed.data))
      return
    }
    if (route === '/settings/models') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().models)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        let updated
        try {
          // Validation (and the `models.`-prefixed issue paths) happens in the store; a missing apiKey keeps the old one.
          updated = store.updateModels(withoutReadOnlyModelFlags(body))
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        // `changed` carries dotted field names only; the key value never appears in the response or the event.
        finishSettings(res, 'models', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/models' && method === 'GET') {
      const models = store.get().models
      const items = models.providers
        .filter(provider => provider.enabled)
        .flatMap(provider => provider.models.map(model => ({
          ref: formatRef({ provider: provider.id, model: model.id }),
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          label: model.label || model.id,
          description: model.description,
          enabled: true,
        })))
      sendJson(res, 200, {
        default: formatRef(models.routing.worker),
        autoSelect: models.routing.autoSelect,
        assessorEnabled: models.routing.assessor.enabled,
        items,
      })
      return
    }
    if (route === '/settings/budget') {
      if (method === 'GET') {
        sendJson(res, 200, store.getPublic().budget)
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = BudgetSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        let updated
        try {
          updated = store.update('budget', parsed.data)
        } catch (error) {
          if (error instanceof OptionsError) {
            invalid(res, error.issues)
            return
          }
          throw error
        }
        finishSettings(res, 'budget', updated.changed)
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/pause' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = PauseSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const result = host.setPaused(parsed.data.paused)
      if (result.changed) {
        recordSettings('pause', ['paused'], result.paused ? '暂停接单' : '恢复接单')
        notify({ section: 'pause', changed: ['paused'], policy: host.getPolicy() })
      }
      sendJson(res, 200, {
        ok: true,
        paused: result.paused,
        changed: result.changed,
        ...(result.changed ? { note: noteFor('pause', ['paused'], result.paused) } : {}),
      })
      return
    }

    // System.
    if (route === '/system' && method === 'GET') {
      sendJson(res, 200, { ...host.info(), ...(await host.system()) })
      return
    }
    if (route === '/system/cleanup' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = CleanupSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const result = await host.cleanup(parsed.data)
      try {
        events.add({
          kind: 'admin.cleanup',
          level: 'info',
          text: parsed.data.dryRun ? '预览了旧工作区清理' : `清理了 ${result.deleted.length} 个旧工作区`,
          data: { olderThanDays: parsed.data.olderThanDays, dryRun: parsed.data.dryRun, entries: result.entries.length, freedBytes: result.freedBytes },
        })
      } catch {
        // Recording the action is best effort; the cleanup itself already ran.
      }
      sendJson(res, 200, result)
      return
    }
    if (route === '/system/orphans' && method === 'GET') {
      sendJson(res, 200, host.orphans())
      return
    }
    if (route === '/system/orphans/cleanup' && method === 'POST') {
      const body = await parseJsonBody(req)
      const parsed = OrphanCleanupSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const result = host.cleanupOrphans(parsed.data.ids)
      try {
        events.add({
          kind: 'admin.cleanup',
          level: 'info',
          text: `清理了 ${result.deleted.length} 个孤儿目录`,
          data: { kind: 'orphans', ids: result.deleted, freedBytes: result.freedBytes },
        })
      } catch {
        // Recording the action is best effort; the directories are already gone.
      }
      sendJson(res, 200, result)
      return
    }
    if (route === '/system/backups' && method === 'GET') {
      sendJson(res, 200, host.backups())
      return
    }
    if (route === '/system/backups' && method === 'POST') {
      sendJson(res, 200, await host.createBackup())
      return
    }

    // Internal Security & Defense Hardening Workbench.
    if (route === '/pentest/playbooks' && method === 'GET') {
      const service = requirePentest()
      const wb = url.searchParams.get('workbench') === 'defense' ? 'defense' : 'pentest'
      sendJson(res, 200, { items: service.playbooks(wb) })
      return
    }
    if (route === '/pentest/utils/decode' && method === 'POST') {
      const service = requirePentest()
      const body = await parseJsonBody(req)
      const parsed = PentestDecodeSchema.safeParse(body)
      if (!parsed.success) {
        invalid(res, issuesOf(parsed.error))
        return
      }
      const result = await pentestCall(() => service.decodeUtility(parsed.data.text, parsed.data.mode))
      sendJson(res, 200, { ok: true, ...result })
      return
    }
    const ptAssetMatch = /^\/pentest\/assets\/([^/]+)$/.exec(route)
    if (ptAssetMatch !== null && method === 'DELETE') {
      const service = requirePentest()
      const aid = decodeSegment(ptAssetMatch[1] ?? '')
      if (!aid) {
        sendJson(res, 400, { error: 'invalid_path', message: '资产编号不合法。' })
        return
      }
      if (!service.deleteAsset(aid)) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这条资产记录。' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }
    const ptProofMatch = /^\/pentest\/proofs\/([^/]+)$/.exec(route)
    if (ptProofMatch !== null && method === 'DELETE') {
      const service = requirePentest()
      const pid = decodeSegment(ptProofMatch[1] ?? '')
      if (!pid) {
        sendJson(res, 400, { error: 'invalid_path', message: '证物编号不合法。' })
        return
      }
      if (!service.deleteProof(pid)) {
        sendJson(res, 404, { error: 'not_found', message: '找不到这条证物记录。' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }
    const ptTaskMatch = /^\/pentest\/tasks\/([^/]+)(?:\/(stream|cancel))?$/.exec(route)
    if (ptTaskMatch !== null) {
      const service = requirePentest()
      const tid = decodeSegment(ptTaskMatch[1] ?? '')
      const action = ptTaskMatch[2]
      if (!tid) {
        sendJson(res, 400, { error: 'invalid_path', message: '任务编号不合法。' })
        return
      }
      if (action === undefined && method === 'GET') {
        const task = service.getTask(tid)
        if (!task) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这条执行任务。' })
          return
        }
        sendJson(res, 200, { task })
        return
      }
      if (action === 'cancel' && method === 'POST') {
        const task = await pentestCall(() => service.cancelTask(tid))
        sendJson(res, 200, { ok: true, task })
        return
      }
      if (action === 'stream' && method === 'GET') {
        const task = service.getTask(tid)
        if (!task) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这条执行任务。' })
          return
        }
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        res.flushHeaders?.()
        const sendEv = (payload: unknown): void => {
          if (!res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`)
        }
        for (const ev of task.events) sendEv(ev)
        const terminal = new Set(['completed', 'partial', 'failed', 'cancelled'])
        if (terminal.has(task.status)) {
          sendEv({ taskId: tid, at: task.endedAt ?? task.createdAt, kind: 'done', status: task.status, summary: task.summary })
          res.end()
          return
        }
        const unsubscribe = service.subscribeTask(tid, ev => {
          sendEv(ev)
          if (ev.kind === 'state' && typeof ev.state === 'string' && terminal.has(ev.state)) {
            unsubscribe()
            clearInterval(ping)
            if (!res.destroyed) res.end()
          }
        })
        const ping = setInterval(() => {
          if (!res.destroyed) res.write(': ping\n\n')
        }, 15_000)
        ping.unref?.()
        req.on('close', () => {
          unsubscribe()
          clearInterval(ping)
        })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    if (route === '/pentest/engagements') {
      const service = requirePentest()
      if (method === 'GET') {
        const rawWb = url.searchParams.get('workbench')
        const wb = rawWb === 'defense' || rawWb === 'pentest' ? rawWb : undefined
        sendJson(res, 200, { items: service.listEngagements(wb) })
        return
      }
      if (method === 'POST') {
        const body = await parseJsonBody(req)
        const parsed = PentestEngagementCreateSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const item = await pentestCall(() => service.createEngagement(parsed.data))
        sendJson(res, 200, { ok: true, item })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    const ptFindingMatch = /^\/pentest\/findings\/([^/]+)$/.exec(route)
    if (ptFindingMatch !== null) {
      const service = requirePentest()
      const fid = decodeSegment(ptFindingMatch[1] ?? '')
      if (!fid) {
        sendJson(res, 400, { error: 'invalid_path', message: '漏洞编号不合法。' })
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = PentestFindingUpdateSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const item = await pentestCall(() => service.updateFinding(fid, parsed.data))
        sendJson(res, 200, { ok: true, item })
        return
      }
      if (method === 'DELETE') {
        if (!service.deleteFinding(fid)) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这条漏洞记录。' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    const ptSubMatch = /^\/pentest\/engagements\/([^/]+)\/(findings|assets|proofs|tasks|scan\/web|scan\/source|runs|report|notify)$/.exec(route)
    if (ptSubMatch !== null) {
      const service = requirePentest()
      const eid = decodeSegment(ptSubMatch[1] ?? '')
      const sub = ptSubMatch[2]
      if (!eid) {
        sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' })
        return
      }
      if (sub === 'assets') {
        if (method === 'GET') {
          sendJson(res, 200, { items: service.listAssets(eid) })
          return
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req)
          const parsed = PentestAssetCreateSchema.safeParse(body)
          if (!parsed.success) {
            invalid(res, issuesOf(parsed.error))
            return
          }
          const item = await pentestCall(() => service.addAsset(eid, parsed.data))
          sendJson(res, 200, { ok: true, item })
          return
        }
      }
      if (sub === 'proofs') {
        if (method === 'GET') {
          sendJson(res, 200, { items: service.listProofs(eid) })
          return
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req)
          const parsed = PentestProofCreateSchema.safeParse(body)
          if (!parsed.success) {
            invalid(res, issuesOf(parsed.error))
            return
          }
          const item = await pentestCall(() => service.addProof(eid, parsed.data))
          sendJson(res, 200, { ok: true, item })
          return
        }
      }
      if (sub === 'tasks') {
        if (method === 'GET') {
          const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 30) || 30))
          sendJson(res, 200, { items: service.listTasks(eid, limit) })
          return
        }
        if (method === 'POST') {
          const body = await parseJsonBody(req)
          const parsed = PentestTaskCreateSchema.safeParse(body)
          if (!parsed.success) {
            invalid(res, issuesOf(parsed.error))
            return
          }
          const task = await pentestCall(() => service.startTask(eid, parsed.data.kind, parsed.data.args))
          sendJson(res, 200, { ok: true, task })
          return
        }
      }
      if (sub === 'findings' && method === 'POST') {
        const body = await parseJsonBody(req)
        const parsed = PentestFindingCreateSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const item = await pentestCall(() => service.addFinding(eid, parsed.data))
        sendJson(res, 200, { ok: true, item })
        return
      }
      if (sub === 'scan/web' && method === 'POST') {
        const body = await parseJsonBody(req)
        const parsed = PentestWebScanSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const outcome = await pentestCall(() => service.runWebScan(eid, parsed.data.targetUrl, {
          ...(parsed.data.probePaths === undefined ? {} : { probePaths: parsed.data.probePaths }),
        }))
        sendJson(res, 200, { ok: true, ...outcome })
        return
      }
      if (sub === 'scan/source' && method === 'POST') {
        const outcome = await pentestCall(() => service.runSourceScan(eid))
        sendJson(res, 200, { ok: true, ...outcome })
        return
      }
      if (sub === 'runs' && method === 'POST') {
        const body = await parseJsonBody(req)
        const parsed = PentestRunCreateSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const outcome = await pentestCall(() => service.launchPlaybook(eid, parsed.data.playbookId, {
          ...(parsed.data.model ? { model: parsed.data.model } : {}),
          ...(parsed.data.projectMode ? { projectMode: parsed.data.projectMode } : {}),
          ...(parsed.data.extraInstruction ? { extraInstruction: parsed.data.extraInstruction } : {}),
          ...(parsed.data.secrets ? { secrets: parsed.data.secrets } : {}),
        }))
        sendJson(res, 200, { ok: true, ...outcome })
        return
      }
      if (sub === 'report' && method === 'GET') {
        const format = (url.searchParams.get('format') ?? 'md').toLowerCase()
        const detail = service.getEngagement(eid)
        if (!detail) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这个安全项目。' })
          return
        }
        const prefix = detail.workbench === 'defense' ? `${eid}-defense-report` : `${eid}-pentest-report`
        if (format === 'json') {
          const payload = JSON.stringify(detail, null, 2)
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': attachmentHeader(`${prefix}.json`),
            'content-length': String(Buffer.byteLength(payload)),
          })
          res.end(payload)
          return
        }
        const markdown = await pentestCall(() => service.reportMarkdown(eid))
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': attachmentHeader(`${prefix}.md`),
          'content-length': String(Buffer.byteLength(markdown)),
        })
        res.end(markdown)
        return
      }
      if (sub === 'notify' && method === 'POST') {
        const body = await parseJsonBody(req)
        const parsed = PentestNotifySchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const detail = service.getEngagement(eid)
        if (!detail) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这个安全项目。' })
          return
        }
        const markdown = service.reportMarkdown(eid)
        const tag = detail.workbench === 'defense' ? '安全防御加固报告' : '内部安全报告'
        const subject = `[${tag}] ${detail.name}（严重 ${detail.counts.critical} / 高危 ${detail.counts.high} / 中危 ${detail.counts.medium}）`
        if (parsed.data.channel === 'email') {
          if (!host.sendEmail) throw new AdminError('not_found', '邮箱未启用。', 404)
          const recipient = (parsed.data.to || store.get().email.allowedSenders[0] || store.get().email.address).trim()
          if (!recipient) throw new AdminError('invalid', '请先填写收件邮箱，或在邮箱设置中配置允许的发件人。', 400)
          await host.sendEmail({ to: [recipient], subject, text: markdown })
        } else {
          if (!host.sendWechat) throw new AdminError('not_found', '微信未启用。', 404)
          await host.sendWechat({
            ...(parsed.data.to ? { to: parsed.data.to } : {}),
            title: subject,
            text: markdown.slice(0, 6000),
          })
        }
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }
    const ptEngMatch = /^\/pentest\/engagements\/([^/]+)$/.exec(route)
    if (ptEngMatch !== null) {
      const service = requirePentest()
      const eid = decodeSegment(ptEngMatch[1] ?? '')
      if (!eid) {
        sendJson(res, 400, { error: 'invalid_path', message: '项目编号不合法。' })
        return
      }
      if (method === 'GET') {
        const detail = service.getEngagement(eid)
        if (!detail) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这个渗透项目。' })
          return
        }
        // 为关联了 AI 工单的执行记录补充实时工单状态与最新步骤，方便在工作台内闭环追踪
        const enrichedRuns = detail.runs.map(run => {
          if (!run.ticketId) return run
          const ticket = host.ticket(run.ticketId)
          if (!ticket) return run
          const label = ticketStatusLabel(ticket)
          let latestStep: string | undefined
          try {
            const last = activity?.list(run.ticketId, 0, 1).items.at(-1)
            if (last?.summary) latestStep = last.summary
          } catch { /* best effort */ }
          return {
            ...run,
            ticketStatus: ticket.status,
            ticketStageLabel: label.label,
            ...(latestStep ? { latestStep } : {}),
          }
        })
        sendJson(res, 200, { ...detail, runs: enrichedRuns, reportMarkdown: service.reportMarkdown(eid) })
        return
      }
      if (method === 'PUT') {
        const body = await parseJsonBody(req)
        const parsed = PentestEngagementUpdateSchema.safeParse(body)
        if (!parsed.success) {
          invalid(res, issuesOf(parsed.error))
          return
        }
        const item = await pentestCall(() => service.updateEngagement(eid, parsed.data))
        sendJson(res, 200, { ok: true, item })
        return
      }
      if (method === 'DELETE') {
        if (!service.deleteEngagement(eid)) {
          sendJson(res, 404, { error: 'not_found', message: '找不到这个渗透项目。' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
      return
    }

    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
  }

  return async (req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://admin.invalid')
    } catch {
      return false
    }
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false
    try {
      await handle(req, res, url)
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy()
        return true
      }
      if (error instanceof AdminError) {
        sendJson(res, error.status, {
          error: error.code,
          message: error.message,
          ...(error.issues === undefined ? {} : { issues: error.issues }),
        })
        return true
      }
      console.error(`superagentd: admin api ${req.method ?? 'GET'} ${url.pathname} failed:`, error)
      sendJson(res, 500, { error: 'internal', message: '后台处理请求时出错了，请稍后重试。' })
    }
    return true
  }
}
