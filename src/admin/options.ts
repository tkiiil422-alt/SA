/**
 * Runtime options for the admin console.
 *
 * Options live in a single JSON file (normally `state/options.json`) with three sections: `executor`, `models`
 * (AI providers, their models, and routing) and `budget`. Reads merge a partial file over the defaults section by
 * section, except `models`, which the file replaces wholesale. Writes replace one section and land atomically.
 * Provider API keys are stored in the file (the console writes them) but never appear in any public view, change
 * report, or error.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { defaultCouncilRoles } from '../council/roles.ts'

export const PriceSchema = z.object({
  input: z.number().min(0),
  cacheRead: z.number().min(0),
  output: z.number().min(0),
}).strict()

export const ModelSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().max(60).default(''),
  description: z.string().max(300).default(''),
  reasoning: z.boolean().default(false),
  vision: z.boolean().default(false),
  contextWindow: z.number().int().min(1000).max(10_000_000).default(1_000_000),
  maxTokens: z.number().int().min(256).max(1_000_000).default(131_072),
  autoPick: z.boolean().default(true),
  price: PriceSchema,
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
}).strict()

export const ProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, '服务商 id 只能是小写字母、数字和连字符，且不超过 32 位'),
  name: z.string().trim().min(1).max(60),
  api: z.enum(['openai-completions', 'anthropic-messages']),
  baseUrl: z.string().url().refine(u => /^https?:\/\//.test(u), '必须是 http(s) 地址'),
  apiKey: z.string().default(''),
  sessionHeader: z.string().regex(/^[A-Za-z0-9-]*$/),
  enabled: z.boolean(),
  models: z.array(ModelSchema).min(1).max(50),
}).strict().superRefine((provider, ctx) => {
  const ids = new Set<string>()
  provider.models.forEach((model, index) => {
    if (ids.has(model.id)) ctx.addIssue({ code: 'custom', path: ['models', index, 'id'], message: '模型 id 重复' })
    ids.add(model.id)
  })
})

const RefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
}).strict()

const AssessorSchema = z.object({
  enabled: z.boolean(),
  provider: z.string().min(1),
  model: z.string().min(1),
  timeoutSec: z.number().int().min(5).max(120),
}).strict()

export const ModelsSchema = z.object({
  providers: z.array(ProviderSchema).min(1).max(20),
  routing: z.object({
    worker: RefSchema,
    assessor: AssessorSchema,
    autoSelect: z.boolean(),
  }).strict(),
}).strict().superRefine((models, ctx) => {
  const ids = new Set<string>()
  models.providers.forEach((provider, index) => {
    if (ids.has(provider.id)) ctx.addIssue({ code: 'custom', path: ['providers', index, 'id'], message: '服务商 id 重复' })
    ids.add(provider.id)
  })

  const { worker, assessor } = models.routing
  const workerProvider = models.providers.find(p => p.id === worker.provider)
  if (!workerProvider || !workerProvider.models.some(m => m.id === worker.model)) {
    ctx.addIssue({ code: 'custom', path: ['routing', 'worker'], message: '默认执行模型不存在，请从已配置的模型中选择' })
  } else if (!workerProvider.enabled) {
    ctx.addIssue({ code: 'custom', path: ['routing', 'worker'], message: '默认执行模型所在的服务商未启用' })
  }

  const assessorProvider = models.providers.find(p => p.id === assessor.provider)
  if (!assessorProvider || !assessorProvider.models.some(m => m.id === assessor.model)) {
    ctx.addIssue({ code: 'custom', path: ['routing', 'assessor'], message: '分析模型不存在，请从已配置的模型中选择' })
  } else if (assessor.enabled && !assessorProvider.enabled) {
    ctx.addIssue({ code: 'custom', path: ['routing', 'assessor'], message: '开启任务分析时，分析模型所在的服务商必须已启用' })
  }
})

/** Feishu (Lark) message source. The three secrets are write-only: public views report only whether they are set. */
export const FeishuSchema = z.object({
  enabled: z.boolean(),
  /** How Feishu delivers events: an HTTP callback to us, or the official SDK's long connection. */
  mode: z.enum(['webhook', 'ws']).default('webhook'),
  appId: z.string().trim().max(200),
  appSecret: z.string().max(500),
  verificationToken: z.string().max(500),
  encryptKey: z.string().max(500),
  apiBase: z.string().url().refine(u => /^https?:\/\//.test(u), '必须是 http(s) 地址'),
  groupMode: z.enum(['mention', 'all']),
}).strict()

/** GitHub: a fine-grained PAT lives in the vault; these options only name the API and the repositories it may touch. */
export const GithubRepoSchema = z.string().trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, '仓库格式应为 owner/repo')
export const GithubSchema = z.object({
  enabled: z.boolean(),
  repos: z.array(GithubRepoSchema).max(50, '最多 50 个仓库'),
  defaultBase: z.string().trim().min(1, '默认分支不能为空').max(200),
  apiBase: z.string().url().refine(u => /^https?:\/\//.test(u), '必须是 http(s) 地址'),
}).strict().superRefine((github, ctx) => {
  const seen = new Set<string>()
  github.repos.forEach((repo, index) => {
    const key = repo.toLowerCase()
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['repos', index], message: '仓库重复' })
    seen.add(key)
  })
})

/** Gmail over IMAP/SMTP. The app password lives in the vault; these options never carry it. */
const EmailAddressSchema = z.string().trim().max(320)
  .refine(value => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), '必须是有效的邮箱地址')
export const EmailSchema = z.object({
  enabled: z.boolean(),
  address: EmailAddressSchema,
  displayName: z.string().trim().max(100),
  allowedSenders: z.array(z.string().trim().min(1).max(320)).max(100, '最多 100 个允许的发件人'),
  pollSeconds: z.number().int().min(15).max(3600),
  maxAttachmentMb: z.number().int().min(1).max(25),
}).strict().superRefine((email, ctx) => {
  if (email.enabled && email.address === '') {
    ctx.addIssue({ code: 'custom', path: ['address'], message: '开启邮箱前需要填写邮箱地址' })
  }
})

/** Public base address for preview links: empty, or an http(s) URL without a trailing slash. */
const PublicBaseSchema = z.string().trim().max(500).refine(value => {
  if (value === '') return true
  if (value.endsWith('/')) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.search === '' && url.hash === ''
  } catch {
    return false
  }
}, '必须是不带结尾斜杠的 http(s) 地址')

/** Host ports handed to ticket containers for web previews. */
export const PreviewSchema = z.object({
  enabled: z.boolean(),
  portStart: z.number().int().min(1024).max(65535),
  portEnd: z.number().int().min(1024).max(65535),
  perTicket: z.number().int().min(1).max(5),
  publicBase: PublicBaseSchema,
}).strict().superRefine((preview, ctx) => {
  if (preview.portEnd < preview.portStart) {
    ctx.addIssue({ code: 'custom', path: ['portEnd'], message: '结束端口不能小于起始端口' })
  }
})

/** Limits of the project library. The upload is checked at `POST /api/uploads`; extraction reads them when it starts. */
export const ProjectsSchema = z.object({
  maxUploadMb: z.number().int().min(1).max(65536),
  maxExtractMb: z.number().int().min(1).max(1_048_576),
  maxFiles: z.number().int().min(1).max(5_000_000),
}).strict()

/** One council seat. `model` overrides the moderator's model for that seat only. */
export const CouncilRoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, '角色 id 只能是小写字母、数字和连字符，且不超过 32 位'),
  name: z.string().trim().min(1, '角色名称不能为空').max(60, '角色名称不能超过 60 个字'),
  persona: z.string().trim().min(1, '人设不能为空').max(2000, '人设不能超过 2000 字'),
  enabled: z.boolean(),
  model: RefSchema.optional(),
}).strict()

/** Multi-role council: the seats, how many rounds, and the moderator (null means `routing.worker`). */
export const CouncilSchema = z.object({
  enabled: z.boolean(),
  defaultOn: z.boolean(),
  rounds: z.number().int('必须是整数').min(1, '轮数不能小于 1').max(3, '轮数不能大于 3'),
  maxCharsPerTurn: z.number().int('必须是整数').min(100, '每条发言不能少于 100 字').max(2000, '每条发言不能超过 2000 字'),
  moderator: RefSchema.nullable(),
  roles: z.array(CouncilRoleSchema).min(1, '至少需要一个会商角色').max(20, '最多 20 个角色'),
}).strict().superRefine((council, ctx) => {
  const ids = new Set<string>()
  council.roles.forEach((role, index) => {
    if (ids.has(role.id)) ctx.addIssue({ code: 'custom', path: ['roles', index, 'id'], message: '角色 id 重复' })
    ids.add(role.id)
  })
  if (!council.roles.some(role => role.enabled)) {
    ctx.addIssue({ code: 'custom', path: ['roles'], message: '至少要启用一个角色' })
  }
})

export const OptionsSchema = z.object({
  executor: z.object({
    maxWorkers: z.number().int().min(1).max(8),
    cpus: z.string().regex(/^\d+(\.\d+)?$/),
    memory: z.string().regex(/^\d+[mMgG]$/),
    image: z.string().trim().min(1).max(200),
  }).strict(),
  models: ModelsSchema,
  budget: z.object({
    enabled: z.boolean(),
    perTicketUsd: z.number().min(0).max(1000),
    dailyUsd: z.number().min(0).max(100000),
  }).strict(),
  feishu: FeishuSchema,
  preview: PreviewSchema,
  projects: ProjectsSchema,
  github: GithubSchema,
  email: EmailSchema,
  council: CouncilSchema,
}).strict().superRefine((options, ctx) => {
  // Model references are validated against the models section, which a per-section parse cannot see. A seat may reuse
  // the moderator's model, so only explicit `model` overrides and the moderator itself are checked.
  const check = (ref: { provider: string; model: string }, path: (string | number)[], label: string): void => {
    const provider = options.models.providers.find(item => item.id === ref.provider)
    if (provider === undefined || !provider.models.some(item => item.id === ref.model)) {
      ctx.addIssue({ code: 'custom', path, message: `${label}模型不存在，请从已配置的模型中选择` })
    } else if (!provider.enabled) {
      ctx.addIssue({ code: 'custom', path, message: `${label}模型所在的服务商未启用` })
    }
  }
  if (options.council.moderator !== null) check(options.council.moderator, ['council', 'moderator'], '主持人使用的')
  options.council.roles.forEach((role, index) => {
    if (role.model !== undefined) check(role.model, ['council', 'roles', index, 'model'], `角色「${role.name}」使用的`)
  })
})

export type Price = z.infer<typeof PriceSchema>
export type Model = z.infer<typeof ModelSchema>
export type Provider = z.infer<typeof ProviderSchema>
export type ModelsOptions = z.infer<typeof ModelsSchema>
export type Options = z.infer<typeof OptionsSchema>
export type OptionsSection = keyof Options
export type ModelRef = { provider: string; model: string }

export type PublicProvider = Omit<Provider, 'apiKey'> & { apiKeySet: boolean; apiKeyTail: string }
export type FeishuOptions = z.infer<typeof FeishuSchema>
export type PreviewOptions = z.infer<typeof PreviewSchema>
export type GithubOptions = z.infer<typeof GithubSchema>
export type EmailOptions = z.infer<typeof EmailSchema>
export type ProjectsOptions = z.infer<typeof ProjectsSchema>
export type CouncilOptions = z.infer<typeof CouncilSchema>
export type CouncilRoleOptions = z.infer<typeof CouncilRoleSchema>
export type PublicFeishu = Omit<FeishuOptions, 'appSecret' | 'verificationToken' | 'encryptKey'> & {
  appSecretSet: boolean
  verificationTokenSet: boolean
  encryptKeySet: boolean
}

/** External view of the options: API keys and Feishu secrets are never returned. */
export interface PublicOptions {
  executor: Options['executor']
  models: { providers: PublicProvider[]; routing: ModelsOptions['routing'] }
  budget: Options['budget']
  feishu: PublicFeishu
  preview: Options['preview']
  projects: Options['projects']
  github: Options['github']
  email: Options['email']
  council: Options['council']
}

function publicFeishu({ appSecret, verificationToken, encryptKey, ...rest }: FeishuOptions): PublicFeishu {
  return {
    ...rest,
    appSecretSet: appSecret.length > 0,
    verificationTokenSet: verificationToken.length > 0,
    encryptKeySet: encryptKey.length > 0,
  }
}

export interface OptionsIssue {
  path: string
  message: string
}

/** Raised when an options update fails validation. Carries field paths and human-readable (Chinese) messages. */
export class OptionsError extends Error {
  readonly issues: OptionsIssue[]

  constructor(issues: OptionsIssue[]) {
    super(issues.length > 0 ? issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ') : '选项校验失败')
    this.name = 'OptionsError'
    this.issues = issues
  }
}

type Listener = (section: OptionsSection, next: Options, changed: string[]) => void

const SECTIONS: OptionsSection[] = ['executor', 'models', 'budget', 'feishu', 'preview', 'projects', 'github', 'email', 'council']

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

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

/** Translate a zod issue into a Chinese message. Custom messages (already Chinese) are kept as-is. */
function chineseMessage(issue: z.ZodIssue): string {
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
      return issue.message
    case 'invalid_union':
      return '取值不符合任何允许的形式'
    case 'invalid_value':
      return '取值无效'
    case 'not_multiple_of':
      return `必须是 ${String(issue.divisor)} 的倍数`
    default:
      return '格式不正确'
  }
}

/** Convert a zod error into the issue list held by `OptionsError`. */
function toIssues(error: z.ZodError): OptionsIssue[] {
  return error.issues.map(issue => ({
    path: issue.path.map(String).join('.'),
    message: chineseMessage(issue),
  }))
}

/** Merge a partial file value over the defaults, section by section. The `models` section is replaced, never merged. */
function mergeDefaults(defaults: Options, fileValue: unknown): unknown {
  if (!isPlainObject(fileValue)) return fileValue
  const merged: Record<string, unknown> = {}
  for (const section of SECTIONS) {
    const base = defaults[section] as unknown
    const override = fileValue[section]
    if (section === 'models') {
      merged.models = override === undefined ? base : override
    } else if (isPlainObject(base) && isPlainObject(override)) {
      merged[section] = { ...base, ...override }
    } else {
      merged[section] = override === undefined ? base : override
    }
  }
  // Preserve unknown top-level keys so the strict schema can report them instead of silently dropping them.
  for (const key of Object.keys(fileValue)) {
    if (!(key in merged)) merged[key] = fileValue[key]
  }
  return merged
}

const DEEPSEEK_FLASH_IDS = new Set(['deepseek-v4.1-flash', 'deepseek-flash'])

/** Model entry for a legacy or default model id. Known DeepSeek Flash ids get their documented metadata. */
function modelFromId(id: string): Record<string, unknown> {
  if (DEEPSEEK_FLASH_IDS.has(id)) {
    return {
      id,
      reasoning: true,
      vision: true,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      price: { input: 0.3, cacheRead: 0.006, output: 1.2 },
      thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
    }
  }
  return { id, price: { input: 0, cacheRead: 0, output: 0 } }
}

/** Convert an old `upstream` section (plus the rest of the file) into the `models` layout. */
function migrateLegacy(file: Record<string, unknown>, defaults: Options): Record<string, unknown> {
  const legacy: Record<string, unknown> = isPlainObject(file.upstream) ? file.upstream : {}
  const fallback = defaults.models.providers[0]
  const model = typeof legacy.model === 'string' ? legacy.model : defaults.models.routing.worker.model
  const rest: Record<string, unknown> = { ...file }
  delete rest.upstream
  return {
    ...rest,
    models: {
      providers: [{
        id: 'default',
        name: '默认服务',
        api: 'openai-completions',
        baseUrl: legacy.baseUrl ?? fallback?.baseUrl,
        apiKey: legacy.apiKey ?? fallback?.apiKey ?? '',
        sessionHeader: legacy.sessionHeader ?? fallback?.sessionHeader ?? '',
        enabled: true,
        models: [modelFromId(model)],
      }],
      routing: {
        worker: { provider: 'default', model },
        assessor: { enabled: false, provider: 'default', model, timeoutSec: 30 },
        autoSelect: false,
      },
    },
  }
}

/** Recursively collect dotted paths whose values differ. */
function difference(a: unknown, b: unknown, prefix: string, out: string[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      difference(a[key], b[key], prefix ? `${prefix}.${key}` : key, out)
    }
    return
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(prefix)
      return
    }
    a.forEach((item, index) => difference(item, b[index], `${prefix}.${index}`, out))
    return
  }
  if (a !== b) out.push(prefix)
}

/** Write text to `file` through a sibling temporary file, then rename it into place. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temporary file may not exist; the original error is the one worth reporting.
    }
    throw error
  }
}

/** In-memory options with validation, atomic persistence, and change notification. */
export class OptionsStore {
  private readonly file: string
  private readonly listeners = new Set<Listener>()
  private current: Options

  constructor(file: string, defaults: Options) {
    this.file = file
    const base = OptionsSchema.parse(defaults)
    this.current = clone(base)

    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (isEnoent(error)) return
      throw new Error(`无法读取配置文件 ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`无法解析配置文件 ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const legacy = isPlainObject(parsed) && 'upstream' in parsed && !('models' in parsed)
    const source: unknown = isPlainObject(parsed) && legacy ? migrateLegacy(parsed, base) : parsed
    const result = OptionsSchema.safeParse(mergeDefaults(base, source))
    if (!result.success) {
      throw new Error(`配置文件 ${file} 内容无效: ${toIssues(result.error).map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ')}`)
    }
    this.current = result.data
    if (legacy) writeAtomic(file, `${JSON.stringify(result.data, null, 2)}\n`)
  }

  get(): Options {
    return clone(this.current)
  }

  getPublic(): PublicOptions {
    const { executor, models, budget, feishu, preview, projects, github, email, council } = this.current
    return {
      feishu: publicFeishu(feishu),
      executor: { ...executor },
      models: {
        providers: models.providers.map(({ apiKey, ...rest }) => ({
          ...clone(rest),
          apiKeySet: apiKey.length > 0,
          apiKeyTail: apiKey.length > 8 ? apiKey.slice(-4) : '',
        })),
        routing: clone(models.routing),
      },
      budget: { ...budget },
      preview: { ...preview },
      projects: { ...projects },
      github: clone(github),
      email: clone(email),
      council: clone(council),
    }
  }

  /** Replace one whole section, validate, persist atomically, and notify listeners when something changed. */
  update<S extends OptionsSection>(section: S, value: unknown): { changed: string[] } {
    const before = this.current
    const candidate = { ...before, [section]: value } as unknown
    const result = OptionsSchema.safeParse(candidate)
    if (!result.success) throw new OptionsError(toIssues(result.error))

    const next = result.data
    const changed: string[] = []
    difference(before, next, '', changed)
    if (changed.length === 0) return { changed }

    this.current = next
    writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`)
    for (const listener of [...this.listeners]) {
      try {
        listener(section, this.get(), [...changed])
      } catch {
        // A misbehaving listener must not break persistence or the other listeners.
      }
    }
    return { changed }
  }

  /**
   * Replace the whole models section. A provider whose apiKey is undefined or '' keeps the key of the previous
   * provider with the same id; a new id starts with ''.
   */
  updateModels(value: unknown): { changed: string[] } {
    if (!isPlainObject(value) || !Array.isArray(value.providers)) return this.update('models', value)
    const incoming: unknown[] = value.providers
    const providers = incoming.map(item => {
      if (!isPlainObject(item) || (item.apiKey !== undefined && item.apiKey !== '')) return item
      const prior = this.current.models.providers.find(p => p.id === item.id)
      return { ...item, apiKey: prior?.apiKey ?? '' }
    })
    return this.update('models', { ...value, providers })
  }

  /**
   * Replace the whole feishu section. A secret that is undefined or '' keeps its previous value (write-only fields).
   * Enabling the source requires the app credentials and the verification token.
   */
  updateFeishu(value: unknown): { changed: string[] } {
    const input: Record<string, unknown> = isPlainObject(value) ? value : {}
    const prior = this.current.feishu
    const keep = (field: 'appSecret' | 'verificationToken' | 'encryptKey'): unknown => {
      const incoming = input[field]
      return incoming === undefined || incoming === '' ? prior[field] : incoming
    }
    const next: Record<string, unknown> = {
      ...input,
      // An omitted transport keeps the stored one, so an older console never flips a long connection back to webhook.
      mode: input.mode === undefined ? prior.mode : input.mode,
      appSecret: keep('appSecret'),
      verificationToken: keep('verificationToken'),
      encryptKey: keep('encryptKey'),
    }
    if (next.enabled === true && (!next.appSecret || !next.appId || !next.verificationToken)) {
      throw new OptionsError([{ path: 'feishu', message: '开启飞书前需要填写 App ID、App Secret 和 Verification Token' }])
    }
    return this.update('feishu', next)
  }

  /**
   * Replace the whole email section. The vault password is written by the caller, never here; `password` in the body is
   * dropped so a form echo cannot land it in options.json. Sender addresses are stored lower-cased for stable matching.
   */
  updateEmail(value: unknown): { changed: string[] } {
    const input: Record<string, unknown> = isPlainObject(value) ? { ...value } : {}
    delete input.password
    delete input.passwordSet
    if (Array.isArray(input.allowedSenders)) {
      input.allowedSenders = input.allowedSenders
        .filter((sender): sender is string => typeof sender === 'string')
        .map(sender => sender.trim().toLowerCase())
        .filter(sender => sender !== '')
    }
    return this.update('email', input)
  }

  /** Register a change listener. Returns a function that removes it. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/** Parse "provider/model". Split at the first '/', so model ids may themselves contain '/'. */
export function parseRef(text: string): ModelRef | undefined {
  const index = text.indexOf('/')
  if (index < 0) return undefined
  const provider = text.slice(0, index)
  const model = text.slice(index + 1)
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

export function formatRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`
}

/** Look up a provider and model by reference. `enabledOnly` also requires the provider to be enabled. */
export function findModel(
  models: Options['models'],
  ref: ModelRef,
  opts: { enabledOnly?: boolean } = {},
): { provider: Provider; model: Model } | undefined {
  const provider = models.providers.find(p => p.id === ref.provider)
  if (!provider) return undefined
  if (opts.enabledOnly && !provider.enabled) return undefined
  const model = provider.models.find(m => m.id === ref.model)
  return model ? { provider, model } : undefined
}

/** Options for a fresh installation, seeded from the environment where available. */
export function defaultOptions(env: NodeJS.ProcessEnv): Options {
  return OptionsSchema.parse({
    executor: {
      maxWorkers: 2,
      cpus: '2',
      memory: '6g',
      image: 'localhost/superagent-pi:1.5.0',
    },
    models: {
      providers: [{
        id: 'default',
        name: '默认服务',
        api: 'openai-completions',
        baseUrl: env.SA_DEEPSEEK_UPSTREAM ?? 'https://api.deepseek.com',
        apiKey: env.DEEPSEEK_API_KEY ?? '',
        sessionHeader: env.SA_UPSTREAM_SESSION_HEADER ?? '',
        enabled: true,
        models: [modelFromId('deepseek-v4.1-flash')],
      }],
      routing: {
        worker: { provider: 'default', model: 'deepseek-v4.1-flash' },
        assessor: { enabled: false, provider: 'default', model: 'deepseek-v4.1-flash', timeoutSec: 30 },
        autoSelect: false,
      },
    },
    budget: {
      enabled: true,
      perTicketUsd: 0.5,
      dailyUsd: 5,
    },
    feishu: {
      enabled: false,
      mode: 'webhook',
      appId: '',
      appSecret: '',
      verificationToken: '',
      encryptKey: '',
      apiBase: 'https://open.feishu.cn',
      groupMode: 'mention',
    },
    preview: {
      enabled: true,
      portStart: 19000,
      portEnd: 19199,
      perTicket: 2,
      publicBase: '',
    },
    projects: {
      maxUploadMb: 4096,
      maxExtractMb: 12288,
      maxFiles: 300_000,
    },
    github: {
      enabled: false,
      repos: [],
      defaultBase: 'main',
      apiBase: 'https://api.github.com',
    },
    email: {
      enabled: false,
      address: '',
      displayName: '',
      allowedSenders: [],
      pollSeconds: 60,
      maxAttachmentMb: 20,
    },
    council: {
      enabled: true,
      defaultOn: false,
      rounds: 2,
      maxCharsPerTurn: 600,
      moderator: null,
      roles: defaultCouncilRoles(),
    },
  })
}
