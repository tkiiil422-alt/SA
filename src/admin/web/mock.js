/**
 * MOCK MODE (?mock=1) — a browser-side fake of the admin API described in
 * 04-后台设计.md §3. No build step, no server, no external data.
 *
 * Assumed response shapes where the spec leaves details open
 * (the real backend should either match these or the frontend adjusted):
 *
 *  GET  api/tickets            -> { total, items: TicketSummary[] }
 *  POST api/tickets            -> { id, ticketId } (either is accepted by the UI)
 *  GET  api/decisions          -> { items: Decision[] }
 *  GET  api/events             -> { items: Event[] }   (newest first; `before` = id < before)
 *  PUT  api/settings/:tab      -> { ok: true, changed: string[], note?: string }
 *  POST api/pause              -> { ok: true, paused: boolean, note?: string }
 *  GET  api/settings/feishu    -> { enabled, mode, appId, appSecretSet, verificationTokenSet, encryptKeySet, apiBase, groupMode }
 *  PUT  api/settings/feishu    -> { ok: true, changed, note? } | 400 { issues: [{path:'feishu.appId', message}] }
 *  GET  api/settings/feishu/status -> { mode, state:'off'|'connecting'|'connected'|'error', since?, lastEventAt?, lastError? }
 *  POST api/settings/feishu/reconnect -> same status shape (long connection only)
 *  POST api/settings/feishu/test -> { ok, message, botName? }   (fails when appId contains "fail")
 *  policy also carries feishuOperators: [{ id, name }]
 *  GET  api/settings/github    -> { enabled, repos, defaultBase, apiBase, tokenSet }
 *  PUT  api/settings/github    -> { ok, changed, note } | 400 { issues }; body { enabled, repos, defaultBase, apiBase, token? }
 *  POST api/settings/github/test -> { ok, message, login?, repos?:[{fullName,push}] } (fails when a repo contains "fail")
 *  GET  api/settings/email     -> { enabled, address, displayName, allowedSenders, pollSeconds, maxAttachmentMb, passwordSet }
 *  PUT  api/settings/email     -> { ok, changed, note } | 400 { issues }; body + password?
 *  POST api/settings/email/test -> { ok, message, imap:{ok,message}, smtp:{ok,message} } (fails when address contains "fail")
 *  GET  api/settings/email/status -> { state:'off'|'connecting'|'connected'|'error', lastPollAt?, lastError?, processed }
 *  GET  api/tickets/:id also includes links:[{ kind:'pr', url, title }]
 *  POST api/settings/models/test -> { ok, status, latencyMs, message }
 *  POST api/settings/models/discover -> { ok, message, models:[{id,label?,contextWindow?,maxTokens?,vision?,reasoning?,price?}] }
 *                                  (baseUrl containing "fail" -> ok:false, 401 message)
 *  POST api/system/cleanup     -> { ok, dryRun, items:[{ticketId,title,endedAt,workspaceMb,piConfigMb}], totalMb, deleted? }
 *  DELETE api/tickets/:id      -> { ok, freedBytes } | 409 { error:'running', message }
 *  POST api/tickets/delete     -> { deleted:[id], skipped:[{id,reason}], freedBytes }
 *  GET  api/secrets            -> { items:[{name,description,origin:'operator'|'ai',createdAt,rotatedAt?,lastUsedAt?,grantedTickets}] }
 *                                  (values are never included)
 *  POST api/secrets            -> { ok } | 409 { error:'exists' } | 400 { issues:[{path:'name'|'value',message}] }
 *  PUT  api/secrets/:name      -> { ok } (a non-empty value rotates it; description edits are allowed)
 *  DELETE api/secrets/:name    -> { ok } (also revokes the name from every ticket)
 *  GET  api/secrets/requests   -> { items:[{id,ticketId,ticketTitle,name,why,at,status:'pending'|'granted'|'denied'}] }
 *  POST api/secrets/requests/:id -> { ok } (body { decision:'grant'|'deny' })
 *  GET  api/tickets/:id        -> includes secrets:string[] and previews:[{port,title,path,url,active}]
 *  PUT  api/tickets/:id/secrets -> { ok, names } | 400 { issues }
 *  POST api/tickets            -> accepts optional secrets:string[]
 *  GET  api/settings/preview   -> { enabled, portStart, portEnd, perTicket, publicBase }
 *  PUT  api/settings/preview   -> { ok, changed, note } | 400 { issues }
 *  GET  api/system/orphans     -> { items:[{id,kind:'workspace'|'pi-config',path,bytes}], totalBytes }
 *  POST api/system/orphans/cleanup -> { deleted:[id], freedBytes }
 *  GET  api/system/backups     -> { dir, items:[{name,at,bytes}] }
 *  POST api/system/backups     -> { ok, item }
 *  POST api/tickets/:id/stop|retry|note|reply -> { ok: true }
 *  GET  api/tickets/:id/files  -> dir:  { path, exists, type:'dir', entries:[{name,type,size,modifiedAt}] }
 *                                  file: { path, exists, type:'file', name, size, modifiedAt, binary, text?, truncated? }
 *  Ticket detail includes: reports[], assignments[], messages[], inputs[], usage{totalUsd,calls,hit,miss,out,hitRate},
 *  calls[], events[], workspace{path,exists,fileCount}, attention{kind,question,at}, ended{at,by,outcome,reason}.
 *  `hitRate` and `budgetUsedPct` are ratios in 0..1 (the UI also tolerates percent values).
 */


import { ticketStatus } from './lib/status.js'
import { createState, detail, clone, round4, todayKey, DAY_MS } from './mock-data.js'
import { install as installMockProjects } from './mock-projects.js'
import { install as installMockCouncil } from './mock-council.js'
import { install as installMockReader } from './mock-reader.js'

function ticketSummary(ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    stage: ticket.stage,
    stageLabel: ticket.stageLabel,
    needsPerson: ticket.needsPerson,
    question: ticket.question,
    outcome: ticket.outcome,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    costUsd: ticket.costUsd,
  }
}

/** The public secret shape: names and timestamps only, never the value. */
function secretPublic(state, secret) {
  const grantedTickets = state.tickets
    .filter((ticket) => Array.isArray(ticket.secrets) && ticket.secrets.includes(secret.name))
    .length
  return {
    name: secret.name,
    description: secret.description ?? '',
    origin: secret.origin === 'ai' ? 'ai' : 'operator',
    createdAt: secret.createdAt,
    ...(secret.rotatedAt ? { rotatedAt: secret.rotatedAt } : {}),
    ...(secret.lastUsedAt ? { lastUsedAt: secret.lastUsedAt } : {}),
    grantedTickets,
  }
}

function previewUrl(state, preview) {
  const base = String(state.settings.preview?.publicBase ?? '').replace(/\/+$/, '')
  return base ? `${base}/${preview.path}` : preview.path
}

function ticketTitleOf(state, ticketId) {
  return state.tickets.find((ticket) => ticket.id === ticketId)?.title ?? ticketId
}

function overview(state) {
  const open = state.tickets.filter((ticket) => ticket.status === 'open')
  const running = open.filter((ticket) => ticketStatus(ticket).key === 'running')
  const needs = open.filter((ticket) => ['waiting', 'needs'].includes(ticketStatus(ticket).key))
  const today = todayKey(0)
  const endedToday = state.tickets.filter((ticket) => ticket.status === 'ended' && String(ticket.ended?.at ?? '').slice(0, 10) === today).length
  const day = state.usageDays[0]
  const settings = state.settings
  const alerts = []

  for (const ticket of needs) {
    if (ticketStatus(ticket).key === 'needs') {
      alerts.push({
        level: 'warn', code: 'ticket.failed',
        text: `票「${ticket.title}」失败了，需要你处理`,
        link: `#/tickets/${encodeURIComponent(ticket.id)}`,
      })
    }
  }
  if (settings.budget.enabled) {
    const over = open.filter((ticket) => ticket.costUsd >= settings.budget.perTicketUsd)
    for (const ticket of over) {
      alerts.push({
        level: 'warn', code: 'budget.blocked',
        text: `票「${ticket.title}」已达到单票上限 ${'$'}${settings.budget.perTicketUsd.toFixed(2)}`,
        link: `#/tickets/${encodeURIComponent(ticket.id)}`,
      })
    }
    const ratio = day.usd / settings.budget.dailyUsd
    if (ratio >= 0.8) {
      alerts.push({ level: 'warn', code: 'budget.daily', text: `今日费用已用掉 ${(ratio * 100).toFixed(0)}%，接近每日上限`, link: '#/usage' })
    }
  }
  if (settings.policy.paused) {
    alerts.push({ level: 'warn', code: 'system.paused', text: '已暂停接新任务，新消息会留在队列里。', link: '#/settings/policy' })
  }
  if (state.usingGeneratedPassword) {
    alerts.push({
      level: 'warn', code: 'admin.password_generated',
      text: '你还在用自动生成的口令，建议尽快修改。', link: '#/settings/policy',
    })
  }
  if (state.diskFreeGb < 10) {
    alerts.push({ level: 'error', code: 'disk.low', text: `磁盘只剩下 ${state.diskFreeGb} GB，可能影响新任务。`, link: '#/system' })
  }
  alerts.sort((a, b) => (a.level === 'error' ? -1 : 0) - (b.level === 'error' ? -1 : 0))

  return {
    now: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - Date.parse(state.startedAt)) / 1000),
    version: '0.1.0',
    paused: settings.policy.paused,
    acceptMode: settings.policy.acceptMode,
    slots: { used: running.length, max: settings.executor.maxWorkers, reservedForPerson: running.length ? 1 : 0 },
    tickets: { open: open.length, running: running.length, needsPerson: needs.length, endedToday },
    usage: {
      todayUsd: day.usd,
      todayCalls: day.calls,
      cacheHitRate: day.hitRate,
      dailyBudgetUsd: settings.budget.dailyUsd,
      budgetUsedPct: settings.budget.dailyUsd ? day.usd / settings.budget.dailyUsd : 0,
    },
    host: { load1: 1.24, cpuCount: 8, memUsedPct: 37, diskFreeGb: state.diskFreeGb },
    upstream: {
      ok: state.upstreamOk !== false,
      checkedAt: new Date(Date.now() - 4 * 60000).toISOString(),
      ...upstreamSummary(state),
    },
    alerts,
    recent: state.events.slice(0, 15),
  }
}

function usageFor(state, range) {
  const count = range === 'today' ? 1 : range === '30d' ? 30 : 7
  const slice = state.usageDays.slice(0, count)
  const byDay = [...slice].reverse()
  const totals = slice.reduce((sum, day) => ({
    usd: sum.usd + day.usd,
    calls: sum.calls + day.calls,
    hit: sum.hit + day.hit,
    miss: sum.miss + day.miss,
    out: sum.out + day.out,
  }), { usd: 0, calls: 0, hit: 0, miss: 0, out: 0 })
  totals.usd = round4(totals.usd)
  totals.hitRate = totals.hit + totals.miss ? totals.hit / (totals.hit + totals.miss) : 0
  const byModel = totals.calls
    ? [
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash', usd: round4(totals.usd * 0.78), calls: Math.round(totals.calls * 0.78), hitRate: totals.hitRate },
      { provider: 'opencode-go', model: 'deepseek-v4.1', usd: round4(totals.usd * 0.22), calls: Math.round(totals.calls * 0.22), hitRate: totals.hitRate * 0.93 },
    ]
    : []
  const topTickets = [...state.tickets]
    .filter((ticket) => ticket.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 5)
    .map((ticket) => ({ ticketId: ticket.id, title: ticket.title, usd: ticket.costUsd }))
  return { totals, byDay, byModel, topTickets }
}

function findDir(files, dir) {
  const prefix = dir ? `${dir}/` : ''
  const map = new Map()
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue
    const rest = file.path.slice(prefix.length)
    if (!rest) continue
    const [head, ...tail] = rest.split('/')
    if (tail.length) {
      if (!map.has(head) || map.get(head).type !== 'dir') map.set(head, { name: head, type: 'dir' })
    } else if (!map.has(head)) {
      map.set(head, { name: head, type: 'file', size: file.size, modifiedAt: file.modifiedAt })
    }
  }
  return [...map.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1))
}

function systemPayload(state) {
  const running = state.tickets.filter((ticket) => ticket.status === 'open' && ticketStatus(ticket).key === 'running')
  const cleanedMb = state.tickets.filter((ticket) => ticket.cleaned).reduce((sum, ticket) => sum + ticket.workspaceMb + ticket.piConfigMb, 0)
  return {
    version: '0.1.0',
    node: 'superagent-01',
    platform: 'linux x64 (Debian 13)',
    stateDir: '/var/lib/superagent/state',
    configPath: '/var/lib/superagent/state/options.json',
    startedAt: state.startedAt,
    gatewayUrl: 'http://127.0.0.1:8787',
    mcpUrl: 'http://127.0.0.1:8788/mcp',
    containers: running.map((ticket, index) => ({
      name: `sa-${ticket.id.toLowerCase()}`,
      ticketId: ticket.id,
      status: index === 0 ? 'Up 12 minutes' : 'Up 3 minutes',
      runningFor: index === 0 ? '12 分钟' : '3 分钟',
    })),
    disk: {
      workspacesMb: Math.max(0, Math.round((412.6 - cleanedMb) * 10) / 10),
      piConfigMb: 88.4,
      dbMb: 12.8,
      freeGb: state.diskFreeGb,
    },
    limits: { maxWorkers: state.settings.executor.maxWorkers },
  }
}

function cleanupPayload(state, days, dryRun) {
  const cutoff = Date.now() - Number(days) * DAY_MS
  const candidates = state.tickets.filter((ticket) => ticket.status === 'ended'
    && !ticket.cleaned
    && Date.parse(ticket.ended?.at ?? 0) <= cutoff)
  const items = candidates.map((ticket) => ({
    ticketId: ticket.id,
    title: ticket.title,
    endedAt: ticket.ended?.at,
    workspaceMb: ticket.workspaceMb,
    piConfigMb: ticket.piConfigMb,
  }))
  const totalMb = Math.round(items.reduce((sum, item) => sum + item.workspaceMb + item.piConfigMb, 0) * 10) / 10
  if (!dryRun) {
    for (const ticket of candidates) {
      ticket.cleaned = true
      ticket.files = []
      ticket.workspace = { ...ticket.workspace, exists: false, fileCount: 0 }
    }
    if (candidates.length) {
      state.eventSeq += 1
      state.events.push({
        id: state.eventSeq,
        at: new Date().toISOString(),
        kind: 'admin.cleanup',
        level: 'info',
        text: `清理了 ${candidates.length} 个已结束任务的工作区，释放约 ${totalMb} MB。`,
      })
      state.events.sort((a, b) => b.id - a.id)
    }
  }
  return { ok: true, dryRun, items, totalMb, deleted: dryRun ? 0 : candidates.length }
}

function refKey(ref) {
  return ref?.provider && ref?.model ? `${ref.provider}/${ref.model}` : ''
}

function parseRefText(text) {
  const raw = String(text ?? '')
  const cut = raw.indexOf('/')
  return cut < 0 ? undefined : { provider: raw.slice(0, cut), model: raw.slice(cut + 1) }
}

function refInfo(models, ref) {
  const provider = models.providers.find((item) => item.id === ref?.provider)
  const model = provider?.models.find((item) => item.id === ref?.model)
  return provider && model ? { provider, model } : undefined
}

function modelItems(models) {
  return models.providers.flatMap((provider) => provider.models.map((model) => ({
    ref: `${provider.id}/${model.id}`,
    provider: provider.id,
    providerName: provider.name,
    model: model.id,
    label: model.label || model.id,
    description: model.description,
    enabled: provider.enabled === true,
  })))
}

function publicModels(models) {
  return {
    providers: models.providers.map(({ apiKey, ...rest }) => ({
      ...clone(rest),
      apiKeySet: Boolean(apiKey),
      apiKeyTail: apiKey && apiKey.length > 8 ? apiKey.slice(-4) : '',
    })),
    routing: clone(models.routing),
  }
}

function upstreamSummary(state) {
  const worker = refInfo(state.settings.models, state.settings.models.routing.worker)
  return {
    model: worker ? (worker.model.label || worker.model.id) : '',
    provider: worker?.provider.name ?? '',
  }
}

function ticketModel(state, ticket) {
  if (ticket.model) return ticket.model
  const models = state.settings.models
  const info = refInfo(models, models.routing.worker)
  return {
    ref: refKey(models.routing.worker),
    label: info ? (info.model.label || info.model.id) : '',
    providerName: info?.provider.name ?? '',
    source: 'default',
  }
}

function resolveTicketModel(state, raw) {
  const models = state.settings.models
  if (raw) {
    const info = refInfo(models, parseRefText(raw))
    if (!info || !info.provider.enabled) return { issue: '这个模型没有启用或不存在，请重新选择。' }
    return { model: { ref: raw, label: info.model.label || info.model.id, providerName: info.provider.name, source: 'person' } }
  }
  if (models.routing.autoSelect === true && models.routing.assessor.enabled === true) {
    for (const provider of models.providers) {
      if (!provider.enabled) continue
      const model = provider.models.find((item) => item.autoPick !== false)
      if (model) {
        return {
          model: {
            ref: `${provider.id}/${model.id}`,
            label: model.label || model.id,
            providerName: provider.name,
            source: 'auto',
            reason: '分析模型按任务内容挑选（演示数据）',
          },
        }
      }
    }
  }
  return { model: undefined }
}

function validateModelsBody(body) {
  const issues = []
  const providers = Array.isArray(body.providers) ? body.providers : []
  if (!providers.length) issues.push({ path: 'models.providers', message: '至少需要一个服务商。' })
  providers.forEach((provider, pi) => {
    const base = `models.providers.${pi}`
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(provider.id ?? ''))) {
      issues.push({ path: `${base}.id`, message: '标识只能用小写字母、数字和连字符。' })
    }
    if (!String(provider.name ?? '').trim()) issues.push({ path: `${base}.name`, message: '请填写服务商名称。' })
    let urlOk = true
    try {
      const url = new URL(String(provider.baseUrl ?? ''))
      urlOk = url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      urlOk = false
    }
    if (!urlOk) issues.push({ path: `${base}.baseUrl`, message: '地址格式不对，请包含 http:// 或 https://。' })
    ;(provider.models ?? []).forEach((model, mi) => {
      if (!String(model.id ?? '').trim()) issues.push({ path: `${base}.models.${mi}.id`, message: '请填写模型名。' })
      for (const field of ['input', 'cacheRead', 'output']) {
        if (!(Number(model.price?.[field]) >= 0)) {
          issues.push({ path: `${base}.models.${mi}.price.${field}`, message: '价格不能为负数。' })
        }
      }
    })
  })
  const routing = body.routing ?? {}
  const check = (ref, path, needEnabled) => {
    const info = refInfo({ providers }, ref)
    if (!info) {
      issues.push({ path, message: '这个模型在服务商里找不到。' })
    } else if (needEnabled && !info.provider.enabled) {
      issues.push({ path, message: '这个服务商已经停用，请换一个已启用的模型。' })
    }
  }
  check(routing.worker, 'models.routing.worker', true)
  check(routing.assessor, 'models.routing.assessor', routing.assessor?.enabled === true)
  return issues
}

function validateGithubBody(body) {
  const issues = []
  const repos = (Array.isArray(body.repos) ? body.repos : []).map((repo) => String(repo ?? '').trim()).filter(Boolean)
  if (repos.length > 50) issues.push({ path: 'repos', message: '仓库白名单最多 50 个。' })
  repos.forEach((repo, index) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      issues.push({ path: `repos.${index}`, message: `「${repo}」格式不对，应该是 owner/repo。` })
    }
  })
  if (!String(body.defaultBase ?? '').trim()) issues.push({ path: 'defaultBase', message: '请填写默认目标分支。' })
  try {
    const url = new URL(String(body.apiBase ?? ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
  } catch {
    issues.push({ path: 'apiBase', message: '接口地址要包含 http:// 或 https://。' })
  }
  return issues
}

function validateEmailBody(body) {
  const issues = []
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const address = String(body.address ?? '').trim()
  if (body.enabled === true && !address) issues.push({ path: 'address', message: '启用邮箱前请填写 Gmail 地址。' })
  if (address && !emailRe.test(address)) issues.push({ path: 'address', message: 'Gmail 地址格式不对。' })
  const senders = (Array.isArray(body.allowedSenders) ? body.allowedSenders : []).map((sender) => String(sender ?? '').trim()).filter(Boolean)
  senders.forEach((sender, index) => {
    if (!emailRe.test(sender)) issues.push({ path: `allowedSenders.${index}`, message: `「${sender}」不是有效的邮箱地址。` })
  })
  const poll = Number(body.pollSeconds)
  if (!Number.isInteger(poll) || poll < 15 || poll > 3600) issues.push({ path: 'pollSeconds', message: '检查间隔要在 15–3600 秒之间。' })
  const attachment = Number(body.maxAttachmentMb)
  if (!Number.isInteger(attachment) || attachment < 1 || attachment > 25) issues.push({ path: 'maxAttachmentMb', message: '附件上限要在 1–25 MB 之间。' })
  return issues
}

function validateSettings(tab, body) {
  const issues = []
  if (tab === 'executor') {
    if (!Number.isInteger(Number(body.maxWorkers)) || Number(body.maxWorkers) < 1) issues.push({ path: 'maxWorkers', message: '并发任务数至少为 1。' })
    if (!String(body.image ?? '').trim()) issues.push({ path: 'image', message: '请填写镜像名。' })
  }
  if (tab === 'budget') {
    if (!(Number(body.perTicketUsd) > 0)) issues.push({ path: 'perTicketUsd', message: '单票上限必须大于 0。' })
    if (!(Number(body.dailyUsd) > 0)) issues.push({ path: 'dailyUsd', message: '每日上限必须大于 0。' })
    else if (Number(body.dailyUsd) < Number(body.perTicketUsd)) issues.push({ path: 'dailyUsd', message: '每日上限不能低于单票上限。' })
  }
  if (tab === 'policy') {
    if (!['auto', 'observe', 'off'].includes(body.acceptMode)) issues.push({ path: 'acceptMode', message: '请选择有效的受理方式。' })
  }
  return issues
}

const MOCK_DISCOVERED_MODELS = [
  { id: 'deepseek-chat', label: 'DeepSeek V3.2 Chat', contextWindow: 128000, maxTokens: 8192, vision: false, reasoning: false, price: { input: 0.28, cacheRead: 0.028, output: 0.42 } },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 128000, maxTokens: 65536, vision: false, reasoning: true, price: { input: 0.28, cacheRead: 0.028, output: 0.42 } },
  { id: 'qwen-max', label: 'Qwen Max', contextWindow: 32768, maxTokens: 8192, vision: false, reasoning: false, price: { input: 1.6, cacheRead: 0.16, output: 6.4 } },
  { id: 'qwen3-vl-plus', label: 'Qwen3 VL Plus', contextWindow: 262144, maxTokens: 32768, vision: true, reasoning: true, price: { input: 0.2, cacheRead: 0.02, output: 1.6 } },
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', contextWindow: 1000000, maxTokens: 65536, vision: false, reasoning: false },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextWindow: 200000, maxTokens: 64000, vision: true, reasoning: true, price: { input: 3, cacheRead: 0.3, output: 15 } },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', contextWindow: 200000, maxTokens: 32000, vision: true, reasoning: false, price: { input: 0.8, cacheRead: 0.08, output: 4 } },
  { id: 'glm-4.6', label: 'GLM 4.6', contextWindow: 200000, maxTokens: 96000, vision: false, reasoning: true, price: { input: 0.6, cacheRead: 0.11, output: 2.2 } },
  { id: 'kimi-k2', label: 'Kimi K2', contextWindow: 131072, maxTokens: 8192, vision: false, reasoning: false, price: { input: 0.6, cacheRead: 0.15, output: 2.5 } },
  { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1-with-a-very-long-identifier-for-layout-2026-11-05-preview', label: '', contextWindow: 131072, maxTokens: 4096, vision: false, reasoning: false, price: { input: 0, cacheRead: 0, output: 0 } },
  { id: 'text-embedding-3-small', label: '', vision: false, reasoning: false },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128000, maxTokens: 16384, vision: true, reasoning: false, price: { input: 0.15, cacheRead: 0.075, output: 0.6 } },
]

/** Long-connection status. The mock App ID decides: "fail" -> error, otherwise connected. */
function feishuStatusPayload(state) {
  const feishu = state.settings.feishu
  const mode = feishu.mode === 'ws' ? 'ws' : 'webhook'
  if (mode !== 'ws') return { mode, state: 'off' }
  if (/fail/i.test(String(feishu.appId ?? ''))) {
    return {
      mode,
      state: 'error',
      lastError: '长连接鉴权失败：App ID 或 App Secret 不正确，请检查后重新连接。',
    }
  }
  if (!state.feishuWsSince) state.feishuWsSince = new Date().toISOString()
  return {
    mode,
    state: 'connected',
    since: state.feishuWsSince,
    lastEventAt: new Date(Date.now() - 90 * 1000).toISOString(),
  }
}

export function installMock(params = new URLSearchParams(globalThis.location?.search ?? '')) {
  const state = createState(params)
  state.diskFreeGb = 42.6
  // The mock keeps GitHub / email settings across reloads, like the daemon does.
  for (const key of ['github', 'email']) {
    try {
      const raw = globalThis.sessionStorage?.getItem(`sa:mock:${key}`)
      if (raw) state.settings[key] = { ...state.settings[key], ...JSON.parse(raw) }
    } catch { /* storage may be unavailable; the in-memory state still works */ }
  }
  if (!Number.isFinite(state.emailTick)) state.emailTick = 0
  const slow = params.get('slow') === '1'
  const fail = params.get('fail') === '1'
  let requestSeq = 0

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
  const ok = (body = { ok: true }) => json(200, body)
  const failBody = (status, code, message, issues) => json(status, { error: code, message, ...(issues ? { issues } : {}) })

  function addEvent(kind, ticketId, level, text, at = new Date().toISOString()) {
    state.eventSeq += 1
    state.events.push({ id: state.eventSeq, at, kind, ticketId, level, text })
    state.events.sort((a, b) => b.id - a.id)
  }

  const mbToBytes = (mb) => Math.round(Number(mb ?? 0) * 1024 * 1024)

  /*
   * Small route registry for the feature-owned mock modules.
   *
   * Each of mock-projects.js / mock-council.js / mock-reader.js exports
   * install(registry) and is called once, in that order, when mock mode starts.
   *
   *   registry.add('GET', '/api/projects/:id', handler)
   *   handler({ path, method, params, body, url, state, json, ok, fail, addEvent })
   *     -> plain object (answered as 200 JSON) or a Response (passed through)
   *
   * Paths may be written with or without the leading `/api/`; `:name` captures
   * one segment into `params`. Method is matched exactly (or '*' for any).
   */
  const customRoutes = []
  const compilePattern = (pattern) => {
    const clean = String(pattern).replace(/^\/?api\//, '').replace(/^\/+|\/+$/g, '')
    return clean ? clean.split('/') : []
  }
  function matchCustom(path, method) {
    const parts = path.split('/').filter(Boolean)
    // Later installs win: mock-council.js is installed after mock-projects.js,
    // so its council routes replace any temporary placeholder from F2.
    for (const route of [...customRoutes].reverse()) {
      if (route.method !== '*' && route.method !== method) continue
      if (route.segments.length !== parts.length) continue
      const params = {}
      let matched = true
      for (let index = 0; index < parts.length; index += 1) {
        const segment = route.segments[index]
        if (segment.startsWith(':')) {
          try { params[segment.slice(1)] = decodeURIComponent(parts[index]) } catch { params[segment.slice(1)] = parts[index] }
        } else if (segment !== parts[index]) {
          matched = false
          break
        }
      }
      if (matched) return { route, params }
    }
    return null
  }
  const registry = {
    state,
    add(method, pattern, handler) {
      customRoutes.push({ method: String(method).toUpperCase(), segments: compilePattern(pattern), handler })
    },
    json,
    ok,
    fail: failBody,
    addEvent,
  }
  for (const install of [installMockProjects, installMockCouncil, installMockReader]) {
    try { install(registry) } catch (error) { console.error('[mock] feature module failed to install', error) }
  }

  function backupStamp(date) {
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
      `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  }

  /** Delete one ticket. The caller has already decided whether force applies. */
  function removeTicket(ticket, { deleteWorkspace = true } = {}) {
    let freedBytes = mbToBytes(ticket.piConfigMb)
    const workspaceBytes = ticket.workspace?.exists ? mbToBytes(ticket.workspaceMb) : 0
    if (deleteWorkspace) {
      freedBytes += workspaceBytes
    } else if (workspaceBytes) {
      state.orphans.push({
        id: `orphan-${ticket.id}`,
        kind: 'workspace',
        path: ticket.workspace.path,
        bytes: workspaceBytes,
      })
    }
    if (ticket.status === 'open') {
      addEvent('ticket.stopped', ticket.id, 'warn', `删除前停止了任务：${ticket.title}`)
    }
    const index = state.tickets.findIndex((item) => item.id === ticket.id)
    if (index >= 0) state.tickets.splice(index, 1)
    addEvent('ticket.deleted', ticket.id, 'warn', `删除了任务：${ticket.title}`)
    return { freedBytes }
  }

  const links = {
    async handle(path, method, body, url) {
      const parts = path.split('/').filter(Boolean)

      if (path === 'health' && method === 'GET') {
        return ok({ ok: true, uptimeSec: Math.round((Date.now() - Date.parse(state.startedAt)) / 1000) })
      }
      if (path === 'login' && method === 'POST') {
        if (String(body.password ?? '') !== state.password) {
          state.loginFails += 1
          if (state.loginFails >= 5) return failBody(429, 'too_many_attempts', '尝试次数太多，请 15 分钟后再试。')
          return failBody(401, 'bad_password', '口令不对，请重试。')
        }
        state.loginFails = 0
        state.authenticated = true
        addEvent('admin.login', undefined, 'info', '管理员登录了后台。')
        return ok({ ok: true })
      }

      if (!state.authenticated && path !== 'health' && path !== 'login') {
        return failBody(401, 'unauthenticated', '登录已失效，请重新登录。')
      }

      // Feature-owned modules (mock-projects / mock-council / mock-reader) may
      // extend paths that also have a built-in handler, such as
      // /api/settings/council or /api/tickets/:id/deliverables. Check them
      // before the built-in branches; a route they did not register is ignored.
      const featureRoute = matchCustom(path, method)
      if (featureRoute) {
        const result = await featureRoute.route.handler({
          path, method, params: featureRoute.params, body, url, state, json, ok, fail: failBody, addEvent,
        })
        if (result instanceof Response) return result
        return ok(result ?? { ok: true })
      }

      if (path === 'me' && method === 'GET') {
        return ok({ authenticated: true, usingGeneratedPassword: state.usingGeneratedPassword })
      }
      if (path === 'logout' && method === 'POST') {
        state.authenticated = false
        return ok({ ok: true })
      }
      if (path === 'password' && method === 'POST') {
        if (String(body.old ?? '') !== state.password) {
          return failBody(400, 'validation', '当前口令不对。', [{ path: 'old', message: '当前口令不对。' }])
        }
        const next = String(body.new ?? '')
        if (next.length < 10) {
          return failBody(400, 'validation', '新口令至少 10 位。', [{ path: 'new', message: '新口令至少 10 位。' }])
        }
        state.password = next
        state.usingGeneratedPassword = false
        addEvent('admin.settings', undefined, 'info', '管理员修改了后台口令。')
        return ok({ ok: true })
      }
      if (path === 'overview' && method === 'GET') return ok(overview(state))

      if (path === 'pause' && method === 'POST') {
        state.settings.policy.paused = Boolean(body.paused)
        addEvent('admin.pause', undefined, 'info', body.paused ? '暂停接新任务。' : '恢复接新任务。')
        return ok({
          ok: true,
          paused: state.settings.policy.paused,
          note: body.paused ? '新任务会留在队列里，恢复后才会开始。' : '已恢复接新任务。',
        })
      }

      if (parts[0] === 'secrets') {
        if (parts.length === 2 && parts[1] === 'requests' && method === 'GET') {
          const items = [...state.secretRequests]
            .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
            .map((request) => ({ ...request, ticketTitle: ticketTitleOf(state, request.ticketId) }))
          return ok({ items })
        }
        if (parts.length === 3 && parts[1] === 'requests' && method === 'POST') {
          const request = state.secretRequests.find((item) => item.id === decodeURIComponent(parts[2]))
          if (!request) return failBody(404, 'unknown_request', '找不到这条申请。')
          if (request.status !== 'pending') return failBody(409, 'already_decided', '这条申请已经处理过了。')
          if (body.decision !== 'grant' && body.decision !== 'deny') {
            return failBody(400, 'validation', '请选择同意或拒绝。', [{ path: 'decision', message: '请选择同意或拒绝。' }])
          }
          if (body.decision === 'deny') {
            request.status = 'denied'
            addEvent('secret.denied', request.ticketId, 'info', `拒绝密钥：${request.name}`)
            return ok({ ok: true })
          }
          const secret = state.secrets.find((item) => item.name === request.name)
          if (!secret) {
            return failBody(400, 'missing_secret', '密钥库里还没有这个密钥，请先保存它再同意。', [
              { path: 'name', message: '密钥库里还没有这个密钥。' },
            ])
          }
          request.status = 'granted'
          const ticket = state.tickets.find((item) => item.id === request.ticketId)
          if (ticket) {
            if (!Array.isArray(ticket.secrets)) ticket.secrets = []
            if (!ticket.secrets.includes(request.name)) ticket.secrets.push(request.name)
          }
          addEvent('secret.granted', request.ticketId, 'info', `授权密钥：${request.name}`)
          return ok({ ok: true })
        }
        if (parts.length === 1 && method === 'GET') {
          return ok({ items: state.secrets.map((secret) => secretPublic(state, secret)) })
        }
        if (parts.length === 1 && method === 'POST') {
          const name = String(body.name ?? '').trim()
          const value = typeof body.value === 'string' ? body.value : ''
          const issues = []
          if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
            issues.push({ path: 'name', message: '名称要用大写字母开头，只能包含大写字母、数字和下划线，最长 64 个字符。' })
          }
          if (!value || value.length > 8192) issues.push({ path: 'value', message: '值要在 1–8192 个字符之间。' })
          if (issues.length) return failBody(400, 'validation', '有字段没有通过校验。', issues)
          if (state.secrets.some((secret) => secret.name === name)) {
            return failBody(409, 'exists', '这个名称已经存在。')
          }
          state.secrets.push({
            name,
            description: String(body.description ?? '').trim(),
            origin: 'operator',
            value,
            createdAt: new Date().toISOString(),
          })
          addEvent('secret.stored', undefined, 'info', `保存了密钥：${name}`)
          return ok({ ok: true })
        }
        if (parts.length === 2 && (method === 'PUT' || method === 'DELETE')) {
          const name = decodeURIComponent(parts[1])
          const index = state.secrets.findIndex((secret) => secret.name === name)
          if (index < 0) return failBody(404, 'unknown_secret', '找不到这个密钥。')
          if (method === 'DELETE') {
            state.secrets.splice(index, 1)
            for (const ticket of state.tickets) {
              if (Array.isArray(ticket.secrets)) ticket.secrets = ticket.secrets.filter((item) => item !== name)
            }
            addEvent('secret.deleted', undefined, 'info', `删除密钥：${name}`)
            return ok({ ok: true })
          }
          const secret = state.secrets[index]
          if (Object.prototype.hasOwnProperty.call(body, 'description')) {
            secret.description = String(body.description ?? '').trim()
          }
          if (Object.prototype.hasOwnProperty.call(body, 'value')) {
            const value = typeof body.value === 'string' ? body.value : ''
            if (!value || value.length > 8192) {
              return failBody(400, 'validation', '值要在 1–8192 个字符之间。', [
                { path: 'value', message: '值要在 1–8192 个字符之间。' },
              ])
            }
            secret.value = value
            secret.rotatedAt = new Date().toISOString()
            addEvent('secret.rotated', undefined, 'info', `更换密钥：${name}`)
          }
          return ok({ ok: true })
        }
        return failBody(404, 'not_found', '找不到这个接口。')
      }

      if (parts[0] === 'tickets') {
        if (parts.length === 1 && method === 'GET') {
          const status = url.searchParams.get('status') ?? 'all'
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase()
          const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 50))
          const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
          let items = [...state.tickets]
          if (status === 'open') items = items.filter((ticket) => ticket.status === 'open')
          else if (status === 'ended') items = items.filter((ticket) => ticket.status === 'ended')
          else if (status === 'needs-person') items = items.filter((ticket) => ['waiting', 'needs'].includes(ticketStatus(ticket).key))
          if (q) items = items.filter((ticket) => ticket.title.toLowerCase().includes(q))
          items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          return ok({ total: items.length, items: items.slice(offset, offset + limit).map(ticketSummary) })
        }
        if (parts.length === 1 && method === 'POST') {
          const text = String(body.text ?? '').trim()
          if (!text) return failBody(400, 'validation', '任务内容不能为空。', [{ path: 'text', message: '先写一句话。' }])
          const picked = resolveTicketModel(state, body.model)
          if (picked.issue) return failBody(400, 'validation', picked.issue, [{ path: 'model', message: picked.issue }])
          const requestedSecrets = [...new Set((Array.isArray(body.secrets) ? body.secrets : []).map(String))]
          const missingSecrets = requestedSecrets.filter((name) => !state.secrets.some((secret) => secret.name === name))
          if (missingSecrets.length) {
            return failBody(400, 'validation', '有密钥在密钥库里不存在。', missingSecrets.map((name) => ({
              path: 'secrets', message: `密钥库里没有 ${name}。`,
            })))
          }
          const seq = state.tickets.length + 1
          const now = new Date().toISOString()
          const title = text.length > 46 ? `${text.slice(0, 46)}…` : text
          const ticket = detail({
            id: `T-${todayKey(0).replaceAll('-', '')}-${String(1000 + seq).slice(-4)}`,
            seed: 20 + seq,
            title,
            stage: { stage: 'working', action: 'queued' },
            createdAt: now,
            updatedAt: now,
            costUsd: 0,
            callCount: 0,
            secrets: requestedSecrets,
          })
          if (picked.model) ticket.model = picked.model
          state.tickets.unshift(ticket)
          addEvent('ticket.created', ticket.id, 'info', `新任务：${title}`)
          addEvent('ticket.accepted', ticket.id, 'info', '任务已受理，等待空闲位置。')
          for (const name of requestedSecrets) addEvent('secret.granted', ticket.id, 'info', `授权密钥：${name}`)
          return ok({ ok: true, id: ticket.id, ticketId: ticket.id })
        }
        if (parts.length === 2 && parts[1] === 'delete' && method === 'POST') {
          const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))]
          const deleteWorkspace = body.deleteWorkspace !== false
          const force = body.force === true
          const deleted = []
          const skipped = []
          let freedBytes = 0
          for (const id of ids) {
            const ticket = state.tickets.find((item) => item.id === id)
            if (!ticket) {
              skipped.push({ id, reason: '找不到这张任务' })
              continue
            }
            if (ticket.status === 'open' && !force) {
              skipped.push({ id, reason: '任务还在进行' })
              continue
            }
            freedBytes += removeTicket(ticket, { deleteWorkspace }).freedBytes
            deleted.push(id)
          }
          return ok({ ok: true, deleted, skipped, freedBytes })
        }
        const ticket = state.tickets.find((item) => item.id === decodeURIComponent(parts[1] ?? ''))
        if (!ticket) return failBody(404, 'unknown_ticket', '找不到这张任务票。')
        if (parts.length === 2 && method === 'GET') {
          return ok({
            ...clone(ticket),
            secrets: Array.isArray(ticket.secrets) ? [...ticket.secrets] : [],
            previews: (Array.isArray(ticket.previews) ? ticket.previews : []).map((preview) => ({
              ...preview,
              url: previewUrl(state, preview),
            })),
            model: ticketModel(state, ticket),
            events: state.events.filter((event) => event.ticketId === ticket.id).slice(0, 100),
          })
        }
        if (parts.length === 3 && parts[2] === 'secrets' && method === 'PUT') {
          const names = [...new Set((Array.isArray(body.names) ? body.names : []).map(String))]
          const missing = names.filter((name) => !state.secrets.some((secret) => secret.name === name))
          if (missing.length) {
            return failBody(400, 'validation', '有密钥在密钥库里不存在。', missing.map((name) => ({
              path: 'names', message: `密钥库里没有 ${name}。`,
            })))
          }
          const before = Array.isArray(ticket.secrets) ? ticket.secrets : []
          ticket.secrets = names
          for (const name of names.filter((name) => !before.includes(name))) {
            addEvent('secret.granted', ticket.id, 'info', `授权密钥：${name}`)
          }
          return ok({ ok: true, names })
        }
        if (parts.length === 2 && method === 'DELETE') {
          if (ticket.status === 'open' && body.force !== true) {
            return failBody(409, 'running', '任务还在进行，删除前会先停止它。')
          }
          const result = removeTicket(ticket, { deleteWorkspace: body.deleteWorkspace !== false })
          return ok({ ok: true, freedBytes: result.freedBytes })
        }
        if (parts.length === 3 && parts[2] === 'files' && method === 'GET') {
          const raw = url.searchParams.get('path') ?? ''
          if (raw.split('/').some((part) => part === '..')) return failBody(400, 'bad_path', '路径不合法。')
          const normalized = raw.replace(/^\/+|\/+$/g, '')
          if (!ticket.workspace?.exists) return ok({ path: normalized, exists: false, type: 'dir', entries: [] })
          const file = ticket.files.find((item) => item.path === normalized)
          if (file) {
            return ok({
              path: normalized,
              exists: true,
              type: 'file',
              name: normalized.split('/').at(-1),
              size: file.size,
              modifiedAt: ticket.updatedAt,
              binary: file.binary,
              text: file.binary ? undefined : file.text,
              truncated: false,
            })
          }
          const dirExists = normalized === '' || ticket.files.some((item) => item.path.startsWith(`${normalized}/`))
          if (!dirExists) return ok({ path: normalized, exists: false, type: 'dir', entries: [] })
          const entries = findDir(ticket.files, normalized).map((entry) => ({
            ...entry,
            modifiedAt: ticket.updatedAt,
          }))
          return ok({ path: normalized, exists: true, type: 'dir', entries })
        }
        if (parts.length === 3 && method === 'POST') {
          const action = parts[2]
          const now = new Date().toISOString()
          if (action === 'stop') {
            if (ticket.status === 'ended') return failBody(409, 'already_ended', '这张票已经结束了。')
            ticket.status = 'ended'
            ticket.stage = { stage: 'ended' }
            ticket.outcome = 'stopped'
            ticket.needsPerson = false
            ticket.question = undefined
            ticket.attention = undefined
            ticket.ended = { at: now, by: 'human', outcome: 'stopped', reason: body.reason }
            ticket.updatedAt = now
            addEvent('ticket.stopped', ticket.id, 'warn', `你停止了任务：${ticket.title}`)
            return ok({ ok: true })
          }
          if (action === 'retry') {
            ticket.status = 'open'
            ticket.outcome = undefined
            ticket.ended = undefined
            ticket.stage = { stage: 'working', action: 'queued' }
            ticket.needsPerson = false
            ticket.question = undefined
            ticket.attention = undefined
            ticket.updatedAt = now
            addEvent('ticket.accepted', ticket.id, 'info', `任务重新排队：${ticket.title}`)
            return ok({ ok: true })
          }
          if (action === 'note' || action === 'reply') {
            const text = String(body.text ?? '').trim()
            if (!text) return failBody(400, 'validation', '内容不能为空。', [{ path: 'text', message: '先写一句内容。' }])
            ticket.messages.push({ id: `M-${Date.now()}`, at: now, author: '你', text })
            ticket.inputs.push({ id: `I-${Date.now()}`, kind: action === 'reply' ? 'reply' : 'note', at: now, text })
            if (action === 'reply') {
              ticket.needsPerson = false
              ticket.question = undefined
              ticket.attention = undefined
              ticket.stage = { stage: 'working' }
            }
            ticket.updatedAt = now
            addEvent('input.added', ticket.id, 'info', action === 'reply' ? `你回复了：${ticket.title}` : `补充说明：${ticket.title}`)
            return ok({ ok: true })
          }
          return failBody(404, 'unknown_action', '不认识的操怍。')
        }
        return failBody(404, 'not_found', '找不到这个接口。')
      }

      if (path === 'decisions' && method === 'GET') {
        const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 50))
        return ok({ items: state.decisions.slice(0, limit) })
      }
      if (path === 'usage' && method === 'GET') {
        return ok(usageFor(state, url.searchParams.get('range') ?? '7d'))
      }
      if (path === 'usage/calls' && method === 'GET') {
        const items = state.tickets.flatMap((ticket) => ticket.calls).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100)
        return ok({ items })
      }
      if (path === 'events' && method === 'GET') {
        const level = url.searchParams.get('level')
        const ticketId = url.searchParams.get('ticketId')
        const before = Number(url.searchParams.get('before') ?? Infinity)
        const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 100))
        let items = state.events.filter((event) => event.id < before)
        if (level) items = items.filter((event) => event.level === level)
        if (ticketId) items = items.filter((event) => event.ticketId === ticketId)
        items = items.sort((a, b) => b.id - a.id).slice(0, limit)
        return ok({ items })
      }

      if (path === 'models' && method === 'GET') {
        const models = state.settings.models
        return ok({
          default: refKey(models.routing.worker),
          autoSelect: models.routing.autoSelect === true,
          assessorEnabled: models.routing.assessor.enabled === true,
          items: modelItems(models),
        })
      }

      if (parts[0] === 'settings') {
        if (parts.length === 3 && parts[1] === 'github' && parts[2] === 'test' && method === 'POST') {
          await sleep(300 + Math.random() * 300)
          const github = state.settings.github
          const repos = Array.isArray(github.repos) ? github.repos : []
          if (repos.some((repo) => /fail/i.test(String(repo)))) {
            return ok({ ok: false, message: 'GitHub 拒绝了 Token，或白名单里的仓库没有权限。请检查 Token 和仓库名。' })
          }
          return ok({
            ok: true,
            message: '已连上 GitHub。',
            login: 'octocat',
            repos: repos.map((fullName, index) => ({ fullName, push: index % 2 === 0 && !/read-?only/i.test(String(fullName)) })),
          })
        }
        if (parts.length === 2 && parts[1] === 'github') {
          const github = state.settings.github
          if (method === 'GET') return ok({ ...clone(github), tokenSet: github.tokenSet === true })
          if (method === 'PUT') {
            const issues = validateGithubBody(body)
            if (issues.length) return failBody(400, 'validation', '有字段没有通过校验。', issues)
            const before = clone(github)
            const next = {
              enabled: body.enabled === true,
              repos: (Array.isArray(body.repos) ? body.repos : []).map((repo) => String(repo ?? '').trim()).filter(Boolean).slice(0, 50),
              defaultBase: String(body.defaultBase ?? '').trim() || 'main',
              apiBase: String(body.apiBase ?? '').trim() || 'https://api.github.com',
              tokenSet: before.tokenSet === true || Boolean(body.token),
            }
            state.settings.github = next
            try {
              globalThis.sessionStorage?.setItem('sa:mock:github', JSON.stringify(next))
            } catch { /* ignore storage failures */ }
            const changed = Object.keys(next).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
            if (body.token) changed.push('token')
            addEvent('admin.settings', undefined, 'info', `修改了配置：github${changed.length ? `（${changed.join('、')}）` : ''}`)
            return ok({ ok: true, changed, note: 'GitHub 设置已保存；下一次开票时生效。' })
          }
        }
        if (parts.length === 3 && parts[1] === 'email' && parts[2] === 'status' && method === 'GET') {
          const email = state.settings.email
          if (email.enabled !== true) return ok({ state: 'off', processed: state.emailProcessed ?? 0 })
          state.emailTick += 1
          if (state.emailTick % 3 === 0) state.emailProcessed = (state.emailProcessed ?? 0) + 1
          if (/fail/i.test(String(email.address ?? ''))) {
            return ok({
              state: 'error',
              processed: state.emailProcessed ?? 0,
              lastPollAt: new Date().toISOString(),
              lastError: 'IMAP 登录失败：应用专用密码可能不对，请重新生成后再试。',
            })
          }
          return ok({
            state: state.emailTick <= 1 ? 'connecting' : 'connected',
            processed: state.emailProcessed ?? 0,
            lastPollAt: new Date().toISOString(),
          })
        }
        if (parts.length === 3 && parts[1] === 'email' && parts[2] === 'test' && method === 'POST') {
          await sleep(400 + Math.random() * 400)
          const email = state.settings.email
          if (/fail/i.test(String(email.address ?? ''))) {
            return ok({
              ok: false,
              message: 'Gmail 拒绝了登录：请检查应用专用密码，或确认这台机器能连上 Gmail。',
              imap: { ok: false, message: 'IMAP 连接失败（imap.gmail.com:993）。' },
              smtp: { ok: false, message: 'SMTP 连接失败（smtp.gmail.com:465）。' },
            })
          }
          return ok({
            ok: true,
            message: 'IMAP 和 SMTP 都连上了。',
            imap: { ok: true, message: 'IMAP 已连接（imap.gmail.com:993）。' },
            smtp: { ok: true, message: 'SMTP 已连接（smtp.gmail.com:465）。' },
          })
        }
        if (parts.length === 2 && parts[1] === 'email') {
          const email = state.settings.email
          if (method === 'GET') return ok(clone(email))
          if (method === 'PUT') {
            const issues = validateEmailBody(body)
            if (issues.length) return failBody(400, 'validation', '有字段没有通过校验。', issues)
            const before = clone(email)
            const next = {
              enabled: body.enabled === true,
              address: String(body.address ?? '').trim(),
              displayName: String(body.displayName ?? '').trim(),
              allowedSenders: (Array.isArray(body.allowedSenders) ? body.allowedSenders : []).map((sender) => String(sender ?? '').trim()).filter(Boolean),
              pollSeconds: Number(body.pollSeconds),
              maxAttachmentMb: Number(body.maxAttachmentMb),
              passwordSet: before.passwordSet === true || Boolean(body.password),
            }
            state.settings.email = next
            state.emailTick = 0
            state.emailProcessed = 0
            try {
              globalThis.sessionStorage?.setItem('sa:mock:email', JSON.stringify(next))
            } catch { /* ignore storage failures */ }
            const changed = Object.keys(next).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
            if (body.password) changed.push('password')
            addEvent('admin.settings', undefined, 'info', `修改了配置：email${changed.length ? `（${changed.join('、')}）` : ''}`)
            return ok({ ok: true, changed, note: '邮箱设置已保存；下一轮检查时生效。' })
          }
        }
        if (parts.length === 2 && parts[1] === 'preview') {
          if (method === 'GET') return ok(clone(state.settings.preview))
          if (method === 'PUT') {
            const issues = []
            const portStart = Number(body.portStart)
            const portEnd = Number(body.portEnd)
            const perTicket = Number(body.perTicket)
            if (!Number.isInteger(portStart) || portStart < 1 || portStart > 65535) {
              issues.push({ path: 'portStart', message: '起始端口要在 1–65535 之间。' })
            }
            if (!Number.isInteger(portEnd) || portEnd < 1 || portEnd > 65535) {
              issues.push({ path: 'portEnd', message: '结束端口要在 1–65535 之间。' })
            }
            if (!issues.length && portEnd < portStart) {
              issues.push({ path: 'portEnd', message: '结束端口不能小于起始端口。' })
            }
            if (!Number.isInteger(perTicket) || perTicket < 1 || perTicket > 20) {
              issues.push({ path: 'perTicket', message: '每张任务分几个端口要在 1–20 之间。' })
            }
            if (!issues.length && portEnd - portStart + 1 < perTicket) {
              issues.push({ path: 'perTicket', message: '端口池太小，放不下每张任务的端口数。' })
            }
            if (issues.length) return failBody(400, 'validation', '有字段没有通过校验。', issues)
            const clean = {
              enabled: body.enabled === true,
              portStart,
              portEnd,
              perTicket,
              publicBase: String(body.publicBase ?? '').trim(),
            }
            const before = clone(state.settings.preview)
            state.settings.preview = clean
            const changed = Object.keys(clean).filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(clean[key] ?? null))
            addEvent('admin.settings', undefined, 'info', `修改了配置：preview${changed.length ? `（${changed.join('、')}）` : ''}`)
            return ok({ ok: true, changed, note: '新的预览设置立即生效；已有的预览链接不会变。' })
          }
        }
        if (parts.length === 3 && parts[1] === 'feishu' && parts[2] === 'status' && method === 'GET') {
          return ok(feishuStatusPayload(state))
        }
        if (parts.length === 3 && parts[1] === 'feishu' && parts[2] === 'reconnect' && method === 'POST') {
          state.feishuWsSince = null
          await sleep(400)
          return ok(feishuStatusPayload(state))
        }
        if (parts.length === 3 && parts[1] === 'feishu' && parts[2] === 'test' && method === 'POST') {
          await sleep(300 + Math.random() * 300)
          if (/fail/i.test(state.settings.feishu.appId)) {
            return ok({ ok: false, message: '飞书拒绝了 App ID 或 App Secret，请检查后重试。' })
          }
          return ok({ ok: true, message: '已连上飞书。', botName: '超级智能体' })
        }
        if (parts.length === 2 && parts[1] === 'feishu') {
          const f = state.settings.feishu
          if (method === 'GET') return ok(clone(f))
          if (method === 'PUT') {
            const issues = []
            const base = String(body.apiBase ?? '').trim()
            if (!/^https?:\/\//.test(base)) issues.push({ path: 'feishu.apiBase', message: '请填写以 https:// 开头的完整地址。' })
            if (body.enabled && !String(body.appId ?? '').trim()) issues.push({ path: 'feishu.appId', message: '启用飞书前请填写 App ID。' })
            if (!['webhook', 'ws'].includes(body.mode)) issues.push({ path: 'feishu.mode', message: '请选择接收消息的方式。' })
            if (!['mention', 'all'].includes(body.groupMode)) issues.push({ path: 'feishu.groupMode', message: '请选择群消息的处理方式。' })
            if (issues.length) return failBody(400, 'validation', '有字段没有通过校验。', issues)
            const before = clone(f)
            const next = {
              enabled: body.enabled === true,
              mode: body.mode === 'ws' ? 'ws' : 'webhook',
              appId: String(body.appId ?? '').trim(),
              appSecretSet: f.appSecretSet || Boolean(body.appSecret),
              verificationTokenSet: f.verificationTokenSet || Boolean(body.verificationToken),
              encryptKeySet: f.encryptKeySet || Boolean(body.encryptKey),
              apiBase: base,
              groupMode: body.groupMode,
            }
            state.settings.feishu = next
            if (before.mode !== next.mode) state.feishuWsSince = null
            try {
              globalThis.sessionStorage?.setItem('sa:mock:feishu', JSON.stringify(next))
            } catch {
              // Ignore storage failures; the in-memory state is still updated.
            }
            const changed = Object.keys(next).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
            if (body.appSecret) changed.push('appSecret')
            if (body.verificationToken) changed.push('verificationToken')
            if (body.encryptKey) changed.push('encryptKey')
            addEvent('admin.settings', undefined, 'info', `修改了配置：feishu${changed.length ? `（${changed.join('、')}）` : ''}`)
            return ok({ ok: true, changed, note: '飞书设置已保存，新消息会按新设置处理。' })
          }
        }
        if (parts.length === 3 && parts[1] === 'models' && parts[2] === 'discover' && method === 'POST') {
          await sleep(500 + Math.random() * 400)
          if (/fail/i.test(String(body.baseUrl ?? ''))) {
            return ok({ ok: false, message: '密钥不对或没有权限（401）。', models: [] })
          }
          return ok({ ok: true, message: '', models: MOCK_DISCOVERED_MODELS.map((m) => clone(m)) })
        }
        if (parts.length === 3 && parts[1] === 'models' && parts[2] === 'test' && method === 'POST') {
          await sleep(260 + Math.random() * 240)
          const info = refInfo(state.settings.models, body)
          if (!info) return failBody(404, 'unknown_model', '找不到这个服务商或模型。')
          const bad = /invalid|bad/i.test(info.provider.baseUrl)
          if (refKey(state.settings.models.routing.worker) === refKey(body)) state.upstreamOk = !bad
          return ok(bad
            ? { ok: false, status: 401, latencyMs: 372, message: '上游拒绝了密钥，请检查密钥是否正确。' }
            : { ok: true, status: 200, latencyMs: 318, message: '模型已响应。' })
        }
        if (parts.length === 2 && parts[1] === 'models') {
          if (method === 'GET') return ok(publicModels(state.settings.models))
          if (method === 'PUT') {
            const issues = validateModelsBody(body)
            if (issues.length) return failBody(400, 'validation', '有字段没有通过校验。', issues)
            const before = clone(state.settings.models)
            const next = {
              providers: (body.providers ?? []).map((provider) => {
                const old = before.providers.find((item) => item.id === provider.id)
                const typed = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : ''
                const { apiKey, ...rest } = provider
                return { ...rest, apiKey: typed || old?.apiKey || '' }
              }),
              routing: clone(body.routing),
            }
            state.settings.models = next
            const changed = ['providers', 'routing'].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
            addEvent('admin.settings', undefined, 'info', `修改了配置：models${changed.length ? `（${changed.join('、')}）` : ''}`)
            return ok({ ok: true, changed, note: '新的模型设置会在下一次调用时生效。' })
          }
        }
        const tab = parts[1]
        if (['policy', 'executor', 'budget'].includes(tab)) {
          if (method === 'GET') return ok(clone(state.settings[tab]))
          if (method === 'PUT') {
            const issues = validateSettings(tab, body)
            if (issues.length) return failBody(400, 'validation', '有字段没有通过校验。', issues)
            const before = clone(state.settings[tab])
            state.settings[tab] = { ...state.settings[tab], ...body }
            const changed = Object.keys(body).filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(body[key] ?? null))
            const notes = {
              policy: '新的受理规则会从下一条消息开始生效。',
              executor: '并发与执行环境已生效；已运行的任务不受影响。',
              budget: '新的费用上限立即生效。',
            }
            addEvent('admin.settings', undefined, 'info', `修改了配置：${tab}${changed.length ? `（${changed.join('、')}）` : ''}`)
            return ok({ ok: true, changed, note: notes[tab] })
          }
        }
        return failBody(404, 'not_found', '找不到这个配置。')
      }

      if (path === 'system' && method === 'GET') return ok(systemPayload(state))
      if (path === 'system/cleanup' && method === 'POST') {
        const days = Number(body.olderThanDays ?? 7)
        return ok(cleanupPayload(state, days, Boolean(body.dryRun)))
      }
      if (path === 'system/orphans' && method === 'GET') {
        const items = state.orphans.map((item) => ({ ...item }))
        return ok({ items, totalBytes: items.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0) })
      }
      if (path === 'system/orphans/cleanup' && method === 'POST') {
        const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String))
        const removed = state.orphans.filter((item) => ids.has(item.id))
        state.orphans = state.orphans.filter((item) => !ids.has(item.id))
        const freedBytes = removed.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0)
        if (removed.length) {
          addEvent('system.cleanup', undefined, 'info', `清理了 ${removed.length} 个没有对应任务的文件。`)
        }
        return ok({ deleted: removed.map((item) => item.id), freedBytes })
      }
      if (path === 'system/backups' && method === 'GET') {
        return ok({ dir: state.backupsDir, items: state.backups.map((item) => ({ ...item })) })
      }
      if (path === 'system/backups' && method === 'POST') {
        const at = new Date()
        const item = {
          name: `state-${backupStamp(at)}.tgz`,
          at: at.toISOString(),
          bytes: Math.round(27 * 1024 * 1024 + Math.random() * 2 * 1024 * 1024),
        }
        state.backups.unshift(item)
        state.backups = state.backups.slice(0, 7)
        addEvent('system.backup', undefined, 'info', '完成了一次手动备份。')
        return ok({ ok: true, item })
      }

      const custom = matchCustom(path, method)
      if (custom) {
        const result = await custom.route.handler({
          path, method, params: custom.params, body, url, state, json, ok, fail: failBody, addEvent,
        })
        if (result instanceof Response) return result
        return ok(result ?? { ok: true })
      }

      return failBody(404, 'not_found', '找不到这个接口。')
    },
  }

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input?.url
    let url
    try {
      url = new URL(String(raw), location.href)
    } catch {
      return originalFetch(input, init)
    }
    const match = /\/api\/(.*)$/.exec(url.pathname)
    if (!match) return originalFetch(input, init)

    const path = match[1].replace(/\/+$/, '')
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers ?? {})
    await sleep(slow ? 700 + Math.random() * 900 : 90 + Math.random() * 220)

    requestSeq += 1
    const essential = ['health', 'me', 'login', 'logout'].includes(path)
    if (fail && !essential && requestSeq % 6 === 0) {
      return failBody(500, 'mock_failure', '演示模式：模拟了一次服务故障，请重试。')
    }

    const write = method !== 'GET' && method !== 'HEAD'
    if (write && headers.get('x-sa-request') !== '1') {
      return failBody(403, 'csrf', '缺少 X-SA-Request 请求头。')
    }
    // Normal writes are JSON. A project upload chunk is a raw octet-stream body; the header is still
    // required and the custom route (mock-projects.js) reads the Blob itself.
    const octetStream = String(headers.get('content-type') ?? '').startsWith('application/octet-stream')
    if (write && !octetStream && !String(headers.get('content-type') ?? '').includes('application/json')) {
      return failBody(403, 'csrf', '写请求必须是 application/json（分块上传除外）。')
    }
    let body = {}
    if (init.body) {
      try {
        body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
      } catch {
        return failBody(400, 'invalid_json', '请求体不是合法 JSON。')
      }
    }
    try {
      return await links.handle(path, method, body, url)
    } catch (error) {
      console.error('[mock] handler failed', error)
      return failBody(500, 'mock_crash', '演示数据出错了，请刷新页面。')
    }
  }
}
