/**
 * Asks a provider which models it offers (the console's "获取模型列表").
 *
 * Read-only: GET requests to the provider's model-list endpoint, nothing else. Never throws: every failure comes back as
 * `ok: false` with a Chinese message. The API key is never returned, and it is redacted from any error text.
 */
import type { DiscoveredModel, DiscoverResult } from './host.ts'

export interface DiscoverTarget {
  api: 'openai-completions' | 'anthropic-messages'
  baseUrl: string
  apiKey: string
  sessionHeader?: string
}

export interface DiscoverOptions {
  timeoutMs: number
  fetch?: typeof fetch
}

const MAX_MODELS = 500
const ANTHROPIC_MAX_PAGES = 5
const ANTHROPIC_PAGE_SIZE = 1000
const SESSION_VALUE = 'admin-discover'
const BAD_BODY = '服务商返回的内容看不懂，可以手动添加模型。'

type Json = Record<string, unknown>

type Fetched =
  | { kind: 'ok'; json: unknown }
  | { kind: 'http'; status: number }
  | { kind: 'net'; message: string }
  | { kind: 'badJson' }

export async function discoverModels(target: DiscoverTarget, opts: DiscoverOptions): Promise<DiscoverResult> {
  try {
    return target.api === 'openai-completions' ? await fromOpenAi(target, opts) : await fromAnthropic(target, opts)
  } catch {
    return { ok: false, message: '获取模型列表失败，可以手动添加模型。', models: [] }
  }
}

async function fromOpenAi(target: DiscoverTarget, opts: DiscoverOptions): Promise<DiscoverResult> {
  const headers: Record<string, string> = {}
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`
  if (target.sessionHeader) headers[target.sessionHeader] = SESSION_VALUE
  let fetched: Fetched = { kind: 'http', status: 404 }
  for (const url of openAiListUrls(target.baseUrl)) {
    fetched = await getJson(url, headers, target, opts)
    // Only a missing endpoint moves on to the next candidate; auth, network and server errors are reported as they are.
    if (!(fetched.kind === 'http' && fetched.status === 404)) break
  }
  if (fetched.kind !== 'ok') return failureOf(fetched)
  const list = listOf(fetched.json)
  if (!list) return { ok: false, message: BAD_BODY, models: [] }
  const models: DiscoveredModel[] = []
  for (const item of list) {
    const model = openAiItem(item)
    if (model) models.push(model)
  }
  return success(models)
}

async function fromAnthropic(target: DiscoverTarget, opts: DiscoverOptions): Promise<DiscoverResult> {
  const base = trimSlash(target.baseUrl)
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
  if (target.apiKey) headers['x-api-key'] = target.apiKey
  if (target.sessionHeader) headers[target.sessionHeader] = SESSION_VALUE
  const models: DiscoveredModel[] = []
  let url = `${base}/v1/models?limit=${ANTHROPIC_PAGE_SIZE}`
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page += 1) {
    const fetched = await getJson(url, headers, target, opts)
    if (fetched.kind !== 'ok') return failureOf(fetched)
    const list = listOf(fetched.json)
    if (!list) return { ok: false, message: BAD_BODY, models: [] }
    for (const item of list) {
      const model = anthropicItem(item)
      if (model) models.push(model)
    }
    const body = asObject(fetched.json)
    const lastId = textOf(body?.last_id)
    if (body?.has_more !== true || !lastId) break
    url = `${base}/v1/models?limit=${ANTHROPIC_PAGE_SIZE}&after_id=${encodeURIComponent(lastId)}`
  }
  return success(models)
}

async function getJson(url: string, headers: Record<string, string>, target: DiscoverTarget, opts: DiscoverOptions): Promise<Fetched> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const response = await (opts.fetch ?? fetch)(url, { method: 'GET', headers, signal: controller.signal })
    const raw = await response.text()
    if (!response.ok) return { kind: 'http', status: response.status }
    try {
      return { kind: 'ok', json: JSON.parse(raw) as unknown }
    } catch {
      return { kind: 'badJson' }
    }
  } catch (error) {
    const text = controller.signal.aborted
      ? `请求超过 ${Math.round(opts.timeoutMs / 1000)} 秒，已放弃`
      : error instanceof Error ? error.message : String(error)
    return { kind: 'net', message: redact(text, target.apiKey) }
  } finally {
    clearTimeout(timer)
  }
}

function failureOf(fetched: Exclude<Fetched, { kind: 'ok' }>): DiscoverResult {
  switch (fetched.kind) {
    case 'http': {
      const status = fetched.status
      const message = status === 401 || status === 403
        ? `密钥不对或没有权限（${status}）。`
        : status === 404
          ? '这个地址没有模型列表接口（404），可以手动添加模型。'
          : `服务商返回了 ${status}，请检查地址和密钥。`
      return { ok: false, status, message, models: [] }
    }
    case 'net':
      return { ok: false, message: `连不上服务商或请求超时：${fetched.message}`, models: [] }
    case 'badJson':
      return { ok: false, message: BAD_BODY, models: [] }
  }
}

function success(models: DiscoveredModel[]): DiscoverResult {
  const unique = normalize(models)
  return { ok: true, message: `找到 ${unique.length} 个模型。`, models: unique }
}

function normalize(models: DiscoveredModel[]): DiscoveredModel[] {
  const byId = new Map<string, DiscoveredModel>()
  for (const model of models) {
    if (!byId.has(model.id)) byId.set(model.id, model)
  }
  return [...byId.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_MODELS)
}

function openAiItem(raw: unknown): DiscoveredModel | undefined {
  const item = asObject(raw)
  const id = textOf(item?.id)
  if (!item || !id) return undefined
  const model: DiscoveredModel = { id }
  const label = textOf(item.name)
  if (label) model.label = label
  const contextWindow = positive(item.context_length) ?? positive(item.context_window)
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const top = asObject(item.top_provider)
  const maxTokens = positive(top?.max_completion_tokens) ?? positive(top?.max_output_tokens)
    ?? positive(top?.max_tokens) ?? positive(item.max_output_tokens) ?? positive(item.max_tokens)
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  const arch = asObject(item.architecture)
  const modalities = arch?.input_modalities
  if (Array.isArray(modalities)) model.vision = modalities.includes('image')
  const params = item.supported_parameters
  if (Array.isArray(params)) model.reasoning = params.includes('reasoning') || params.includes('include_reasoning')
  const pricing = asObject(item.pricing)
  const prompt = priceOf(pricing?.prompt)
  const completion = priceOf(pricing?.completion)
  if (prompt !== undefined && completion !== undefined) {
    const cacheRead = priceOf(pricing?.input_cache_read) ?? prompt
    model.price = { input: perMillion(prompt), cacheRead: perMillion(cacheRead), output: perMillion(completion) }
  }
  // OpenCode-style listings publish `cost.text.{input,output}.price` already in USD per million tokens.
  if (model.price === undefined) {
    const text = asObject(asObject(item.cost)?.text)
    const input = asObject(text?.input)
    const inputPrice = priceOf(input?.price)
    const outputPrice = priceOf(asObject(text?.output)?.price)
    if (inputPrice !== undefined && outputPrice !== undefined) {
      const cacheRead = priceOf(asObject(input?.cache)?.read) ?? inputPrice
      model.price = { input: inputPrice, cacheRead, output: outputPrice }
    }
  }
  return model
}

function anthropicItem(raw: unknown): DiscoveredModel | undefined {
  const item = asObject(raw)
  const id = textOf(item?.id)
  if (!item || !id) return undefined
  const label = textOf(item.display_name)
  return label ? { id, label } : { id }
}

function listOf(json: unknown): unknown[] | undefined {
  if (Array.isArray(json)) return json
  const body = asObject(json)
  const data = body?.data
  if (Array.isArray(data)) return data
  const models = body?.models
  if (Array.isArray(models)) return models
  return undefined
}

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function positive(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/** A USD-per-token price from a number or numeric string; undefined when it does not parse to a non-negative number. */
function priceOf(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** USD per token -> USD per million tokens, without float noise such as 3.0000000000000004. */
function perMillion(perToken: number): number {
  return Number((perToken * 1_000_000).toFixed(10))
}

/**
 * Where an OpenAI-compatible provider may list its models: `<base>/models` first, then `/v1/models` under shorter
 * prefixes of the same path. Some gateways serve inference under a sub-path (OpenCode Go:
 * `/inference/go/openai/v1`) but list models one level up (`/inference/go/v1/models`). Every candidate keeps the
 * base URL's origin, so the key is never sent to another host. At most four requests.
 */
export function openAiListUrls(baseUrl: string): string[] {
  const base = trimSlash(baseUrl)
  const urls = [`${base}/models`]
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    return urls
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  // Drop a trailing version segment; it is added back on every candidate.
  const prefix = segments.length > 0 && /^v\d+$/i.test(segments[segments.length - 1]!) ? segments.slice(0, -1) : segments
  for (let keep = prefix.length - 1; keep >= 0 && urls.length < 4; keep -= 1) {
    const path = [...prefix.slice(0, keep), 'v1', 'models'].join('/')
    const url = `${parsed.origin}/${path}${parsed.search}`
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function redact(text: string, key: string): string {
  return key ? text.split(key).join('***') : text
}
