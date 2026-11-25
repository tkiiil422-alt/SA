/**
 * 总控助手（Director）的全平台配置补丁引擎与敏感字段脱敏工具。
 *
 * 覆盖 SuperAgent 控制台的全部 17 个配置分区：
 * - models（服务商增删改、模型条目增删改、API Key 设置/轮换/清除、路由与自动选模）
 * - director / executor / budget / policy / feishu / email / wechat / github
 * - preview / projects / novel / collab / council / goal / web / ssh
 *
 * 所有写入均复刻并严于 Web 后台的校验规则与副作用联动（Vault 凭据写入、策略白名单同步、事件审计），
 * 并且任何确认摘要、工具入参审计与待确认列表均会递归脱敏敏感字段，绝不回显明文密钥。
 */
import { z } from 'zod'
import type { AdminHost, PolicyInput, PolicyOperatorView, PolicyRuleView, PolicyView } from '../admin/host.ts'
import {
  EmailSchema,
  findModel,
  OptionsError,
  parseRef,
  type Model,
  type ModelRef,
  type ModelsOptions,
  type OptionsSection,
  type OptionsStore,
  type Provider,
} from '../admin/options.ts'
import type { EventLog } from '../ledger/events.ts'
import { LIMITS } from '../limits.ts'
import type { PendingAction } from './store.ts'

export const ALL_SETTINGS_SECTIONS = [
  'executor', 'models', 'budget', 'director', 'policy',
  'feishu', 'qq', 'email', 'wechat', 'github',
  'preview', 'projects', 'novel', 'collab', 'council', 'goal', 'web', 'ssh',
] as const

export type DirectorSettingsSection = (typeof ALL_SETTINGS_SECTIONS)[number]

const SENSITIVE_KEY_RE = /(secret|token|password|apikey|api_key|privatekey|private_key|webhookurl|encryptkey|aeskey|exakey|cookie)/i
const NON_SECRET_SUFFIX_RE = /(set|tail|clear)$/i

const READ_ONLY_SECRET_FLAGS = [
  'appSecretSet', 'verificationTokenSet', 'encryptKeySet', 'tokenSet', 'passwordSet',
  'corpSecretSet', 'callbackTokenSet', 'encodingAesKeySet', 'webhookUrlSet', 'bridgeTokenSet', 'ilinkRelayTokenSet',
  'exaKeySet',
] as const

const READ_ONLY_MODEL_FLAGS = ['apiKeySet', 'apiKeyTail'] as const

const PolicyRulePatchSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/, '规则 ID 只能包含字母、数字、下划线和短横线，长度 1–80'),
  name: z.string().trim().min(1, '规则名称不能为空').max(LIMITS.ruleName, `规则名称不能超过 ${LIMITS.ruleName} 个字`),
  enabled: z.boolean(),
  instruction: z.string().trim().min(1, '规则说明不能为空').max(LIMITS.ruleInstruction, `规则说明不能超过 ${LIMITS.ruleInstruction} 个字`),
}).strict()

const PolicyOperatorPatchSchema = z.object({
  id: z.string().trim().min(1, '操作员 ID 不能为空').max(200, '操作员 ID 不能超过 200 个字'),
  name: z.string().trim().max(100, '名字不能超过 100 个字').default(''),
}).strict()

const PolicyFullSchema = z.object({
  paused: z.boolean(),
  acceptMode: z.enum(['off', 'observe', 'auto']),
  evalTimeoutSeconds: z.number().int('必须是整数')
    .min(LIMITS.evalTimeoutSeconds.min, `不能小于 ${LIMITS.evalTimeoutSeconds.min} 秒`)
    .max(LIMITS.evalTimeoutSeconds.max, `不能大于 ${LIMITS.evalTimeoutSeconds.max} 秒`),
  rules: z.array(PolicyRulePatchSchema).max(50, '最多 50 条规则'),
  allowedOperators: z.array(PolicyOperatorPatchSchema).max(100, '最多 100 个操作员'),
  feishuOperators: z.array(PolicyOperatorPatchSchema).max(100, '最多 100 个飞书操作员').default([]),
}).strict()

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function isSecretKey(key: string, maskValueField: boolean): boolean {
  if (maskValueField && key === 'value') return true
  if (NON_SECRET_SUFFIX_RE.test(key)) return false
  return SENSITIVE_KEY_RE.test(key)
}

/** 递归脱敏任意对象/数组中的密钥类字段（同时解析并脱敏 `params_json` 字符串）。 */
export function redactSensitiveValue(value: unknown, opts: { maskValueField?: boolean; depth?: number } = {}): unknown {
  const depth = opts.depth ?? 0
  if (depth > 8 || value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveValue(item, { ...opts, depth: depth + 1 }))
  }
  if (!isPlainObject(value)) return value

  const maskValueField = opts.maskValueField === true || value.action === 'secret_manage'
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'params_json' && typeof v === 'string' && v.trim().startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(v)
        out[k] = JSON.stringify(redactSensitiveValue(parsed, { maskValueField, depth: depth + 1 }))
        continue
      } catch {
        // 解析失败时原样兜底（外层仍会做整体秘密文本脱敏）
      }
    }
    if (isSecretKey(k, maskValueField) && typeof v === 'string' && v.length > 0) {
      out[k] = '***'
      continue
    }
    out[k] = redactSensitiveValue(v, { maskValueField, depth: depth + 1 })
  }
  return out
}

/** 返回已脱敏的 PendingAction 视图，供接口、前端和审计展示，不暴露明文凭据。 */
export function redactPendingAction(action: PendingAction): PendingAction {
  return {
    ...action,
    args: redactSensitiveValue(action.args, { maskValueField: action.toolName === 'secret_manage' }) as Record<string, unknown>,
  }
}

/** 脱敏工具调用入参，用于写入会话历史与返回 toolsUsed。 */
export function redactToolCallArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const maskValueField = toolName === 'secret_manage' || args.action === 'secret_manage'
  return redactSensitiveValue(args, { maskValueField }) as Record<string, unknown>
}

/** 生成用于 L3 二次确认提示的安全变更摘要（递归脱敏嵌套密钥）。 */
export function summarizeSettingsPatch(patch: Record<string, unknown>): string {
  const safe = redactSensitiveValue(patch) as Record<string, unknown>
  return Object.entries(safe).map(([k, v]) => {
    const valStr = JSON.stringify(v)
    return `${k}=${valStr.length > 80 ? `${valStr.slice(0, 77)}…` : valStr}`
  }).join('，')
}

/** 解析非空模型引用：同时支持 `"provider/model"` 字符串和 `{ provider, model }` 对象。 */
export function normalizeModelRef(raw: unknown, fieldLabel: string): ModelRef {
  if (typeof raw === 'string') {
    const parsed = parseRef(raw.trim())
    if (!parsed) throw new Error(`${fieldLabel} 格式不合法，应为 "服务商id/模型id" 或 {provider, model}`)
    return parsed
  }
  if (isPlainObject(raw)) {
    const provider = str(raw.provider)
    const model = str(raw.model)
    if (provider && model) return { provider, model }
  }
  throw new Error(`${fieldLabel} 格式不合法，应为 "服务商id/模型id" 或 {provider, model}`)
}

/** 解析可空模型引用：`null` 或空字符串视为 `null`（跟随默认模型）。 */
export function normalizeNullableModelRef(raw: unknown, fieldLabel: string): ModelRef | null {
  if (raw === null || raw === '') return null
  return normalizeModelRef(raw, fieldLabel)
}

function stripReadOnlyFlags(obj: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj }
  for (const flag of READ_ONLY_SECRET_FLAGS) delete copy[flag]
  return copy
}

function normalizePrice(raw: unknown, prior?: Model['price']): Model['price'] {
  const base = prior ?? { input: 0, cacheRead: 0, output: 0 }
  if (!isPlainObject(raw)) return { ...base }
  return {
    input: typeof raw.input === 'number' ? raw.input : base.input,
    cacheRead: typeof raw.cacheRead === 'number' ? raw.cacheRead : base.cacheRead,
    output: typeof raw.output === 'number' ? raw.output : base.output,
  }
}

function normalizeModelEntry(raw: unknown, prior?: Model): Record<string, unknown> {
  if (typeof raw === 'string') {
    const id = raw.trim()
    if (!id) throw new Error('模型 id 不能为空')
    if (prior) return { ...prior, id }
    return {
      id,
      label: '',
      description: '',
      reasoning: false,
      vision: false,
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      autoPick: true,
      price: { input: 0, cacheRead: 0, output: 0 },
    }
  }
  if (!isPlainObject(raw)) throw new Error('模型条目必须是对象或模型 id 字符串')
  const id = str(raw.id) || str(raw.model) || prior?.id || ''
  if (!id) throw new Error('模型条目缺少 id')

  // 剥离快捷别名键，其余字段透传以便严格校验能捕获拼写错误
  const rest: Record<string, unknown> = { ...raw }
  delete rest.provider
  delete rest.model
  delete rest.ref
  delete rest.id
  delete rest.price

  const base: Record<string, unknown> = prior
    ? { ...prior }
    : {
      id,
      label: '',
      description: '',
      reasoning: false,
      vision: false,
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      autoPick: true,
      price: { input: 0, cacheRead: 0, output: 0 },
    }

  const next: Record<string, unknown> = {
    ...base,
    ...rest,
    id,
    price: normalizePrice(raw.price, prior?.price),
  }
  if (raw.thinkingLevelMap === null) delete next.thinkingLevelMap
  return next
}

function normalizeProviderModels(rawModels: unknown, existingModels: readonly Model[]): Record<string, unknown>[] {
  if (!Array.isArray(rawModels)) throw new Error('服务商的 models 必须是数组')
  const byId = new Map(existingModels.map(m => [m.id, m]))
  return rawModels.map(item => {
    const id = typeof item === 'string' ? item.trim() : (isPlainObject(item) ? (str(item.id) || str(item.model)) : '')
    return normalizeModelEntry(item, id ? byId.get(id) : undefined)
  })
}

function applyProviderModelMutations(
  models: Record<string, unknown>[],
  existingModels: readonly Model[],
  upserts: unknown,
  deletes: unknown,
): Record<string, unknown>[] {
  let list = [...models]
  const origById = new Map(existingModels.map(m => [m.id, m]))

  if (Array.isArray(upserts)) {
    for (const item of upserts) {
      const id = typeof item === 'string' ? item.trim() : (isPlainObject(item) ? (str(item.id) || str(item.model)) : '')
      if (!id) throw new Error('modelUpserts 中的条目缺少 id')
      const idx = list.findIndex(m => m.id === id)
      const prior = (idx >= 0 ? list[idx] as unknown as Model : origById.get(id))
      const normalized = normalizeModelEntry(item, prior)
      if (idx >= 0) list[idx] = normalized
      else list.push(normalized)
    }
  }

  if (Array.isArray(deletes)) {
    const delSet = new Set(deletes.map(d => (typeof d === 'string' ? d.trim() : (isPlainObject(d) ? (str(d.id) || str(d.model)) : ''))).filter(Boolean))
    if (delSet.size > 0) list = list.filter(m => !delSet.has(String(m.id)))
  }

  return list
}

function buildProviderRecord(raw: Record<string, unknown>, prior?: Provider): Record<string, unknown> {
  const id = str(raw.id) || prior?.id || ''
  if (!id) throw new Error('模型服务商缺少 id')

  const clearApiKey = raw.clearApiKey === true
  const rawModels = raw.models
  const modelUpserts = raw.modelUpserts
  const modelDeletes = raw.modelDeletes

  const rest: Record<string, unknown> = { ...raw }
  for (const flag of READ_ONLY_MODEL_FLAGS) delete rest[flag]
  delete rest.clearApiKey
  delete rest.models
  delete rest.modelUpserts
  delete rest.modelDeletes
  delete rest.apiKey

  const existingModels = prior?.models ?? []
  let models: Record<string, unknown>[] = rawModels !== undefined
    ? normalizeProviderModels(rawModels, existingModels)
    : existingModels.map(m => ({ ...m }))
  models = applyProviderModelMutations(models, existingModels, modelUpserts, modelDeletes)

  let apiKey: string
  if (clearApiKey) {
    apiKey = ''
  } else if (typeof raw.apiKey === 'string' && raw.apiKey !== '') {
    apiKey = raw.apiKey
  } else {
    apiKey = prior?.apiKey ?? ''
  }

  const base: Record<string, unknown> = prior
    ? {
      id: prior.id,
      name: prior.name,
      api: prior.api,
      baseUrl: prior.baseUrl,
      sessionHeader: prior.sessionHeader,
      ...(prior.maxPromptKb !== undefined ? { maxPromptKb: prior.maxPromptKb } : {}),
      enabled: prior.enabled,
    }
    : {
      id,
      name: str(raw.name) || id,
      api: 'openai-completions',
      baseUrl: '',
      sessionHeader: '',
      enabled: true,
    }

  return {
    ...base,
    ...rest,
    id,
    apiKey,
    models,
  }
}

/**
 * 构建完整的 `models` 配置对象，支持：
 * - `providers` 整表替换（省略 `apiKey` 时保留旧密钥，`clearApiKey: true` 时显式清空）
 * - `providerDeletes: string[]` 删除指定服务商
 * - `providerUpserts` / `providerUpdates` 增量新增或修改服务商（支持所有字段、密钥与服务商内 `modelUpserts`/`modelDeletes`）
 * - `modelUpserts` 顶层快捷新增/修改指定服务商的模型条目
 * - `modelDeletes` 顶层快捷删除模型条目（支持 `"provider/model"` 或 `{ provider, model }`）
 * - `routing` 修改默认执行模型 `worker`、分析模型 `assessor`、自动选模 `autoSelect`（均支持 `"provider/model"` 简写）
 */
export function buildNextModels(cur: ModelsOptions, patch: Record<string, unknown>): Record<string, unknown> {
  const priorById = new Map(cur.providers.map(p => [p.id, p]))
  let providers: Record<string, unknown>[] = cur.providers.map(p => ({ ...p, models: p.models.map(m => ({ ...m })) }))

  if (patch.providers !== undefined) {
    if (!Array.isArray(patch.providers)) throw new Error('providers 必须是数组')
    providers = patch.providers.map(item => {
      if (!isPlainObject(item)) throw new Error('providers 中的每项都必须是对象')
      const id = str(item.id)
      return buildProviderRecord(item, id ? priorById.get(id) : undefined)
    })
  }

  if (Array.isArray(patch.providerDeletes)) {
    const delIds = new Set(patch.providerDeletes.map(str).filter(Boolean))
    if (delIds.size > 0) {
      providers = providers.filter(p => !delIds.has(String(p.id)))
    }
  }

  const upsertList: unknown[] = [
    ...(Array.isArray(patch.providerUpdates) ? patch.providerUpdates : []),
    ...(Array.isArray(patch.providerUpserts) ? patch.providerUpserts : []),
  ]
  for (const item of upsertList) {
    if (!isPlainObject(item)) throw new Error('providerUpserts / providerUpdates 中的每项都必须是对象')
    const id = str(item.id)
    if (!id) throw new Error('providerUpserts / providerUpdates 缺少服务商 id')
    const idx = providers.findIndex(p => p.id === id)
    const prior = idx >= 0 ? (providers[idx] as unknown as Provider) : priorById.get(id)
    const nextRec = buildProviderRecord(item, prior)
    if (idx >= 0) providers[idx] = nextRec
    else providers.push(nextRec)
  }

  if (Array.isArray(patch.modelUpserts)) {
    for (const rawItem of patch.modelUpserts) {
      if (!isPlainObject(rawItem)) throw new Error('modelUpserts 中的每项都必须是对象')
      let providerId = str(rawItem.provider)
      let modelId = str(rawItem.id) || str(rawItem.model)
      if (!providerId && typeof rawItem.ref === 'string') {
        const parsed = parseRef(rawItem.ref.trim())
        if (parsed) {
          providerId = parsed.provider
          if (!modelId) modelId = parsed.model
        }
      }
      if (!providerId || !modelId) throw new Error('modelUpserts 条目需要提供 provider + id（或 ref="provider/model"）')
      const pIdx = providers.findIndex(p => p.id === providerId)
      if (pIdx < 0) throw new Error(`找不到模型服务商：${providerId}（如需新建请使用 providerUpserts）`)
      const target = providers[pIdx]!
      const list = Array.isArray(target.models) ? [...target.models as Record<string, unknown>[]] : []
      const mIdx = list.findIndex(m => m.id === modelId)
      const normalized = normalizeModelEntry({ ...rawItem, id: modelId }, mIdx >= 0 ? list[mIdx] as unknown as Model : undefined)
      if (mIdx >= 0) list[mIdx] = normalized
      else list.push(normalized)
      providers[pIdx] = { ...target, models: list }
    }
  }

  if (Array.isArray(patch.modelDeletes)) {
    for (const rawItem of patch.modelDeletes) {
      let providerId = ''
      let modelId = ''
      if (typeof rawItem === 'string') {
        const parsed = parseRef(rawItem.trim())
        if (!parsed) throw new Error(`modelDeletes 条目格式无效：${rawItem}，应为 "provider/model"`)
        providerId = parsed.provider
        modelId = parsed.model
      } else if (isPlainObject(rawItem)) {
        providerId = str(rawItem.provider)
        modelId = str(rawItem.model) || str(rawItem.id)
      }
      if (!providerId || !modelId) throw new Error('modelDeletes 条目需要 provider 和 model/id')
      const pIdx = providers.findIndex(p => p.id === providerId)
      if (pIdx < 0) continue
      const target = providers[pIdx]!
      const list = Array.isArray(target.models) ? (target.models as Record<string, unknown>[]).filter(m => m.id !== modelId) : []
      providers[pIdx] = { ...target, models: list }
    }
  }

  const nextRouting: Record<string, unknown> = {
    worker: { ...cur.routing.worker },
    assessor: { ...cur.routing.assessor },
    autoSelect: cur.routing.autoSelect,
  }
  if (isPlainObject(patch.routing)) {
    const r = patch.routing
    if (r.worker !== undefined) {
      nextRouting.worker = normalizeModelRef(r.worker, 'routing.worker')
    }
    if (r.autoSelect !== undefined) {
      nextRouting.autoSelect = r.autoSelect
    }
    if (r.assessor !== undefined) {
      if (typeof r.assessor === 'string') {
        const ref = normalizeModelRef(r.assessor, 'routing.assessor')
        nextRouting.assessor = { ...cur.routing.assessor, provider: ref.provider, model: ref.model }
      } else if (isPlainObject(r.assessor)) {
        const aPatch: Record<string, unknown> = { ...r.assessor }
        if (typeof aPatch.ref === 'string') {
          const ref = normalizeModelRef(aPatch.ref, 'routing.assessor.ref')
          aPatch.provider = ref.provider
          aPatch.model = ref.model
          delete aPatch.ref
        }
        nextRouting.assessor = { ...cur.routing.assessor, ...aPatch }
      } else {
        throw new Error('routing.assessor 必须是对象或 "provider/model" 字符串')
      }
    }
  }

  return { providers, routing: nextRouting }
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) dup.add(v)
    seen.add(v)
  }
  return [...dup]
}

function upsertById<T extends { id: string }>(
  list: readonly T[],
  upserts: unknown,
  deletes: unknown,
  build: (raw: Record<string, unknown>, prior?: T) => T,
): T[] {
  let next = [...list]
  if (Array.isArray(deletes)) {
    const delSet = new Set(deletes.map(str).filter(Boolean))
    if (delSet.size > 0) next = next.filter(item => !delSet.has(item.id))
  }
  if (Array.isArray(upserts)) {
    for (const raw of upserts) {
      if (!isPlainObject(raw)) throw new Error('增量列表项必须是对象')
      const id = str(raw.id)
      if (!id) throw new Error('增量列表项缺少 id')
      const idx = next.findIndex(item => item.id === id)
      const built = build(raw, idx >= 0 ? next[idx] : undefined)
      if (idx >= 0) next[idx] = built
      else next.push(built)
    }
  }
  return next
}

function buildNextPolicy(cur: PolicyView, patch: Record<string, unknown>): PolicyInput {
  const {
    ruleUpserts, ruleDeletes,
    operatorUpserts, operatorDeletes,
    feishuOperatorUpserts, feishuOperatorDeletes,
    ...direct
  } = patch

  let rules: PolicyRuleView[] = Array.isArray(direct.rules) ? direct.rules as PolicyRuleView[] : [...cur.rules]
  rules = upsertById(rules, ruleUpserts, ruleDeletes, (raw, prior) => ({
    id: str(raw.id),
    name: typeof raw.name === 'string' ? raw.name.trim() : (prior?.name ?? str(raw.id)),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : (prior?.enabled ?? true),
    instruction: typeof raw.instruction === 'string' ? raw.instruction.trim() : (prior?.instruction ?? ''),
  }))

  let allowedOperators: PolicyOperatorView[] = Array.isArray(direct.allowedOperators)
    ? direct.allowedOperators as PolicyOperatorView[]
    : [...cur.allowedOperators]
  allowedOperators = upsertById(allowedOperators, operatorUpserts, operatorDeletes, (raw, prior) => ({
    id: str(raw.id),
    name: typeof raw.name === 'string' ? raw.name.trim() : (prior?.name ?? ''),
  }))

  let feishuOperators: PolicyOperatorView[] = Array.isArray(direct.feishuOperators)
    ? direct.feishuOperators as PolicyOperatorView[]
    : [...cur.feishuOperators]
  feishuOperators = upsertById(feishuOperators, feishuOperatorUpserts, feishuOperatorDeletes, (raw, prior) => ({
    id: str(raw.id),
    name: typeof raw.name === 'string' ? raw.name.trim() : (prior?.name ?? ''),
  }))

  const candidate = {
    paused: direct.paused !== undefined ? direct.paused : cur.paused,
    acceptMode: direct.acceptMode !== undefined ? direct.acceptMode : cur.acceptMode,
    evalTimeoutSeconds: direct.evalTimeoutSeconds !== undefined ? direct.evalTimeoutSeconds : cur.evalTimeoutSeconds,
    rules,
    allowedOperators,
    feishuOperators,
  }

  const parsed = PolicyFullSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(i => `${i.path.join('.') || 'policy'}: ${i.message}`).join('；'))
  }
  const dupRules = findDuplicates(parsed.data.rules.map(r => r.id))
  if (dupRules.length > 0) throw new Error(`规则 ID 重复：${dupRules.join('、')}`)
  const dupOps = findDuplicates(parsed.data.allowedOperators.map(o => o.id))
  if (dupOps.length > 0) throw new Error(`操作员 ID 重复：${dupOps.join('、')}`)
  const dupFs = findDuplicates(parsed.data.feishuOperators.map(o => o.id))
  if (dupFs.length > 0) throw new Error(`飞书操作员 ID 重复：${dupFs.join('、')}`)
  return parsed.data as PolicyInput
}

export interface SettingsPatchResult {
  ok: true
  section: DirectorSettingsSection
  changed: string[]
  current: unknown
}

/**
 * 执行任意平台设置分区的校验、持久化与运行时联动。
 * 返回的 `current` 永远为脱敏后的公开视图，绝不包含任何明文密钥/口令。
 */
export async function applySettingsPatch(
  deps: { host: AdminHost; options: OptionsStore; events?: EventLog },
  section: DirectorSettingsSection,
  patch: Record<string, unknown>,
): Promise<SettingsPatchResult> {
  const { host, options, events } = deps
  const recordAudit = (changed: string[]): void => {
    if (changed.length === 0) return
    try {
      events?.add({
        kind: 'settings.changed',
        level: 'info',
        text: `总控助手修改了「${section}」配置（${changed.slice(0, 6).join('、')}${changed.length > 6 ? ' 等' : ''}）`,
        data: { section, changed, by: 'director' },
      })
    } catch { /* 审计失败不影响已持久化配置 */ }
  }

  if (section === 'policy') {
    const next = buildNextPolicy(host.getPolicy(), patch)
    const updated = host.updatePolicy(next)
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: host.getPolicy() }
  }

  if (section === 'models') {
    const nextModels = buildNextModels(options.get().models, patch)
    const updated = options.update('models', nextModels)
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().models }
  }

  if (section === 'feishu') {
    const cur = options.get().feishu
    const clean = stripReadOnlyFlags(patch)
    const clearFields = Array.isArray(clean.clearFields) ? clean.clearFields.map(str) : []
    delete clean.clearFields
    const merged: Record<string, unknown> = { ...cur, ...clean }
    let updated: { changed: string[] }
    if (clearFields.length > 0) {
      for (const f of clearFields) {
        if (f === 'appSecret' || f === 'verificationToken' || f === 'encryptKey') merged[f] = ''
      }
      if (merged.enabled === true) {
        const needToken = merged.mode !== 'ws'
        if (!merged.appSecret || !merged.appId || (needToken && !merged.verificationToken)) {
          throw new OptionsError([{
            path: 'feishu',
            message: needToken
              ? '开启飞书前需要填写 App ID、App Secret 和 Verification Token'
              : '开启飞书长连接前需要填写 App ID 和 App Secret',
          }])
        }
      }
      updated = options.update('feishu', merged)
    } else {
      updated = options.updateFeishu(merged)
    }
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().feishu }
  }

  if (section === 'qq') {
    const clean = stripReadOnlyFlags(patch)
    const clearFields = Array.isArray(clean.clearFields) ? clean.clearFields.map(str) : []
    delete clean.clearFields
    const updated = options.updateQq(clean)
    let changed = [...updated.changed]
    if (clearFields.includes('appSecret')) {
      const curAfter = options.get().qq
      const cleared = { ...curAfter, appSecret: '' }
      const u2 = options.updateQq(cleared)
      changed = [...new Set([...changed, ...u2.changed])]
    }
    recordAudit(changed)
    return { ok: true, section, changed, current: options.getPublic().qq }
  }

  if (section === 'wechat') {
    const clean = stripReadOnlyFlags(patch)
    const clearFields = Array.isArray(clean.clearFields) ? clean.clearFields.map(str) : []
    delete clean.clearFields
    const updated = options.updateWechat(clean)
    let changed = [...updated.changed]
    if (clearFields.length > 0) {
      const clearable = new Set(['corpSecret', 'appSecret', 'callbackToken', 'encodingAesKey', 'webhookUrl', 'bridgeToken', 'ilinkRelayToken'])
      const curAfter = options.get().wechat as Record<string, unknown>
      const cleared: Record<string, unknown> = { ...curAfter }
      for (const f of clearFields) {
        if (clearable.has(f)) cleared[f] = ''
      }
      const u2 = options.update('wechat', cleared)
      changed = [...new Set([...changed, ...u2.changed])]
    }
    host.setWechatAllowedUsers?.(options.get().wechat.allowedUsers)
    recordAudit(changed)
    return { ok: true, section, changed, current: options.getPublic().wechat }
  }

  if (section === 'email') {
    const clean = stripReadOnlyFlags(patch)
    const password = typeof clean.password === 'string' ? clean.password : undefined
    delete clean.password
    const cur = options.get().email
    const candidate = { ...cur, ...clean }
    if (Array.isArray(candidate.allowedSenders)) {
      candidate.allowedSenders = candidate.allowedSenders
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    }
    const checked = EmailSchema.safeParse(candidate)
    if (!checked.success) {
      throw new Error(checked.error.issues.map(i => `${i.path.join('.') || 'email'}: ${i.message}`).join('；'))
    }
    if (password !== undefined && password !== '') host.setEmailPassword(password)
    host.setEmailAllowedSenders(checked.data.allowedSenders)
    const updated = options.updateEmail(checked.data)
    const changed = [...updated.changed]
    if (password !== undefined && password !== '') {
      if (!changed.includes('email.password')) changed.push('email.password')
      if (updated.changed.length === 0) await host.restartEmail?.()
    }
    recordAudit(changed)
    return {
      ok: true,
      section,
      changed,
      current: { ...options.getPublic().email, passwordSet: host.emailPasswordSet() },
    }
  }

  if (section === 'github') {
    const clean = stripReadOnlyFlags(patch)
    const token = typeof clean.token === 'string' ? clean.token : undefined
    delete clean.token
    const cur = options.get().github
    const updated = options.update('github', { ...cur, ...clean })
    const changed = [...updated.changed]
    if (token !== undefined && token !== '') {
      host.setGithubToken(token)
      if (!changed.includes('github.token')) changed.push('github.token')
    }
    recordAudit(changed)
    return {
      ok: true,
      section,
      changed,
      current: { ...options.getPublic().github, tokenSet: host.githubTokenSet() },
    }
  }

  if (section === 'web') {
    const cur = options.get().web
    const clean = stripReadOnlyFlags(patch)
    const clear = clean.exaKeyClear === true
    delete clean.exaKeyClear
    if (clear) clean.exaKey = ''
    else if (clean.exaKey === undefined || clean.exaKey === '') clean.exaKey = cur.exaKey
    if (clean.claudeModel !== undefined) clean.claudeModel = normalizeNullableModelRef(clean.claudeModel, 'web.claudeModel')
    if (clean.geminiModel !== undefined) clean.geminiModel = normalizeNullableModelRef(clean.geminiModel, 'web.geminiModel')

    const merged = { ...cur, ...clean }
    const models = options.get().models
    if (merged.claudeModel !== null) {
      const found = findModel(models, merged.claudeModel as ModelRef, { enabledOnly: true })
      if (!found || found.provider.api !== 'anthropic-messages') {
        throw new Error('web.claudeModel 必须是 Anthropic 协议且已启用服务商上的模型')
      }
    }
    if (merged.geminiModel !== null) {
      if (!findModel(models, merged.geminiModel as ModelRef, { enabledOnly: true })) {
        throw new Error('web.geminiModel 必须是已启用服务商上的模型')
      }
    }
    const updated = options.update('web', merged)
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().web }
  }

  if (section === 'director') {
    const cur = options.get().director
    const merged: Record<string, unknown> = { ...cur, ...patch }
    if (patch.model !== undefined) {
      merged.model = normalizeNullableModelRef(patch.model, 'director.model')
    }
    if (merged.enabled !== false && merged.model !== null) {
      if (!findModel(options.get().models, merged.model as ModelRef, { enabledOnly: true })) {
        throw new Error('director.model 指定的模型不存在或所在服务商未启用')
      }
    }
    const updated = options.update('director', merged)
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().director }
  }

  if (section === 'goal') {
    const cur = options.get().goal
    const merged: Record<string, unknown> = { ...cur, ...patch }
    if (patch.judge !== undefined) {
      merged.judge = normalizeNullableModelRef(patch.judge, 'goal.judge')
    }
    if (merged.judge !== null) {
      if (!findModel(options.get().models, merged.judge as ModelRef, { enabledOnly: true })) {
        throw new Error('goal.judge 指定的判定模型不存在或所在服务商未启用')
      }
    }
    const updated = options.update('goal', merged)
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().goal }
  }

  if (section === 'novel') {
    const cur = options.get().novel
    const merged: Record<string, unknown> = { ...cur, ...patch }
    if (isPlainObject(patch.models)) {
      const nextModels: Record<string, unknown> = { ...cur.models }
      for (const role of ['planner', 'writer', 'reviewer', 'extractor'] as const) {
        if (role in patch.models) {
          nextModels[role] = normalizeNullableModelRef(patch.models[role], `novel.models.${role}`)
        }
      }
      merged.models = nextModels
    }
    const updated = options.update('novel', merged)
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().novel }
  }

  if (section === 'collab') {
    const cur = options.get().collab
    const { roleUpserts, roleDeletes, ...rest } = patch
    let roles = Array.isArray(rest.roles)
      ? rest.roles.map((r, i) => {
        if (!isPlainObject(r)) throw new Error(`collab.roles[${i}] 必须是对象`)
        return { ...r, ...(r.model !== undefined ? { model: normalizeNullableModelRef(r.model, `collab.roles[${i}].model`) } : {}) }
      })
      : cur.roles.map(r => ({ ...r }))

    if (Array.isArray(roleDeletes)) {
      const delSet = new Set(roleDeletes.map(str).filter(Boolean))
      if (delSet.size > 0) roles = roles.filter(r => !delSet.has(String((r as Record<string, unknown>).id)))
    }
    if (Array.isArray(roleUpserts)) {
      for (const raw of roleUpserts) {
        if (!isPlainObject(raw)) throw new Error('collab.roleUpserts 中的每项都必须是对象')
        const id = str(raw.id)
        if (!id) throw new Error('collab.roleUpserts 缺少角色 id')
        const idx = roles.findIndex(r => (r as Record<string, unknown>).id === id)
        const prior = idx >= 0 ? roles[idx] as Record<string, unknown> : undefined
        const nextRole: Record<string, unknown> = {
          ...(prior ?? { id, name: id, description: '', access: 'read', enabled: true, model: null, prompt: '' }),
          ...raw,
          id,
        }
        if (raw.model !== undefined) {
          nextRole.model = normalizeNullableModelRef(raw.model, `collab.role(${id}).model`)
        }
        if (idx >= 0) roles[idx] = nextRole
        else roles.push(nextRole)
      }
    }

    const models = options.get().models
    for (const r of roles) {
      const rec = r as Record<string, unknown>
      if (rec.model !== null && rec.model !== undefined) {
        if (!findModel(models, rec.model as ModelRef, { enabledOnly: true })) {
          throw new Error(`协作角色「${String(rec.name ?? rec.id)}」使用的模型不存在或所在服务商未启用`)
        }
      }
    }
    const updated = options.update('collab', { ...cur, ...rest, roles })
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().collab }
  }

  if (section === 'council') {
    const cur = options.get().council
    const { roleUpserts, roleDeletes, ...rest } = patch
    const merged: Record<string, unknown> = { ...cur, ...rest }
    if (rest.moderator !== undefined) {
      merged.moderator = normalizeNullableModelRef(rest.moderator, 'council.moderator')
    }
    const normalizeCouncilSeat = (raw: Record<string, unknown>, prior?: Record<string, unknown>): Record<string, unknown> => {
      const id = str(raw.id) || str(prior?.id)
      const next: Record<string, unknown> = {
        ...(prior ?? { id, name: id, persona: '', enabled: true }),
        ...raw,
        id,
      }
      if ('model' in raw) {
        if (raw.model === null || raw.model === '' || raw.model === undefined) delete next.model
        else next.model = normalizeModelRef(raw.model, `council.role(${id}).model`)
      }
      return next
    }
    let roles: Record<string, unknown>[] = Array.isArray(rest.roles)
      ? rest.roles.map((r, i) => {
        if (!isPlainObject(r)) throw new Error(`council.roles[${i}] 必须是对象`)
        return normalizeCouncilSeat(r)
      })
      : cur.roles.map(r => ({ ...r }))

    if (Array.isArray(roleDeletes)) {
      const delSet = new Set(roleDeletes.map(str).filter(Boolean))
      if (delSet.size > 0) roles = roles.filter(r => !delSet.has(String(r.id)))
    }
    if (Array.isArray(roleUpserts)) {
      for (const raw of roleUpserts) {
        if (!isPlainObject(raw)) throw new Error('council.roleUpserts 中的每项都必须是对象')
        const id = str(raw.id)
        if (!id) throw new Error('council.roleUpserts 缺少角色 id')
        const idx = roles.findIndex(r => r.id === id)
        const nextSeat = normalizeCouncilSeat(raw, idx >= 0 ? roles[idx] : undefined)
        if (idx >= 0) roles[idx] = nextSeat
        else roles.push(nextSeat)
      }
    }
    merged.roles = roles
    const updated = options.update('council', merged)
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().council }
  }

  if (section === 'ssh') {
    if ('connections' in patch) {
      throw new Error('增删或修改 SSH 连接（含扫描主机指纹与写入私钥）请使用 high_risk_action(ssh_manage)；此处仅修改全局策略 allTickets')
    }
    const cur = options.get().ssh
    const updated = options.update('ssh', { ...cur, ...patch })
    recordAudit(updated.changed)
    return { ok: true, section, changed: updated.changed, current: options.getPublic().ssh }
  }

  // executor / budget / preview / projects 等普通分区
  const curSection = options.get()[section as OptionsSection] as Record<string, unknown>
  const updated = options.update(section as OptionsSection, { ...curSection, ...patch })
  recordAudit(updated.changed)
  return {
    ok: true,
    section,
    changed: updated.changed,
    current: (options.getPublic() as unknown as Record<string, unknown>)[section],
  }
}
