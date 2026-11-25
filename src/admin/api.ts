/**
 * Admin 控制台 JSON API 总入口与路由编排。
 *
 * 经 SuperAgent 2.0 架构拆解后，本文件仅负责：
 * - 统一鉴权（Session Cookie / CLI Bearer Token）与 CSRF 防护；
 * - 公共与会话路由（`/health`、`/login`、`/logout`、`/me`、`/password`）；
 * - 实时看板与概览（`/live/stream`、`/overview`、`/plugins`）；
 * - 将具体领域路由分发给 `src/admin/routes/*` 模块及 `PluginRegistry` 注册的子系统插件。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { checkCliToken, clientIp, type AdminAuth } from './auth.ts'
import {
  AdminError,
  type AdminHost,
  type AdminSettingsChange,
  type SettingsSection,
} from './host.ts'
import {
  API_PREFIX,
  clampInt,
  clearSessionCookie,
  cookieValue,
  decodeSegment,
  handleFilesInRoot,
  header,
  invalid,
  isWrite,
  issuesOf,
  labelSummary,
  parseJsonBody,
  securityHeaders,
  sendJson,
  sessionCookie,
} from './http.ts'
import type { Options, OptionsStore } from './options.ts'
import type { EventLog } from '../ledger/events.ts'
import type { Ledger } from '../ledger/ledger.ts'
import type { ProjectService } from '../projects/service.ts'
import type { CouncilService } from '../council/service.ts'
import type { NovelService } from '../novel/service.ts'
import type { ActivityLog } from '../executor/activity.ts'
import type { FanqieService } from '../fanqie/service.ts'
import type { PiVersionService } from '../executor/pi-versions.ts'
import type { DevEnvService } from '../executor/dev-env.ts'
import type { GoalService } from '../goal/service.ts'
import type { ContractStore } from '../contracts/store.ts'
import type { PentestService } from '../pentest/service.ts'
import type { DirectorService } from '../director/service.ts'
import type { PluginRegistry } from '../plugins/registry.ts'
import type { AdminRouteDeps, AdminRouteHandler } from './routes/types.ts'
import { handleProjectsRoutes } from './routes/projects.ts'
import { handleNovelsRoutes } from './routes/novels.ts'
import { handleCouncilsAndRuntimeRoutes } from './routes/councils-runtime.ts'
import { handleTicketsAndAuditRoutes } from './routes/tickets.ts'
import { handleDirectorRoutes } from './routes/director.ts'
import { handleSettingsAndSystemRoutes } from './routes/settings.ts'
import { handlePentestRoutes } from './routes/pentest.ts'

export interface CreateAdminApiOptions {
  host: AdminHost
  auth: AdminAuth
  options: OptionsStore
  ledger: Ledger
  events: EventLog
  cliToken?: string
  onPolicyOrSettingsChange?: (change: AdminSettingsChange) => void
  projects?: ProjectService
  councils?: CouncilService
  activity?: Pick<ActivityLog, 'list'>
  novels?: NovelService
  fanqie?: FanqieService
  piVersions?: PiVersionService
  devEnv?: DevEnvService
  goals?: Pick<GoalService, 'view' | 'set' | 'cancel' | 'brief' | 'buildReceipt' | 'recordEvidence' | 'listEvidences'>
  contracts?: ContractStore
  createTicketPr?: (ticketId: string, input: { repo: string; head: string; base?: string; title: string; body: string }) => Promise<{ ok: true; url: string; number: number } | { ok: false; message: string }>
  pentest?: PentestService
  director?: DirectorService
  /** 子系统插件注册中心（记忆、技能、定时调度及未来扩展插件）。 */
  plugins?: PluginRegistry
}

export type AdminApi = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

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

const LoginSchema = z.object({ password: z.string().min(1, '请输入口令') }).strict()
const PasswordSchema = z.object({
  old: z.string().min(1, '请输入当前口令'),
  new: z.string().min(1, '请输入新口令'),
}).strict()

const SECTION_NAMES: Record<SettingsSection, string> = {
  policy: '受理规则',
  executor: '执行配置',
  models: '模型',
  budget: '预算设置',
  pause: '接单开关',
  feishu: '飞书设置',
  qq: 'QQ 机器人设置',
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
    case 'models': return '模型设置已保存，新的调用立即使用新设置。'
    case 'budget': return '预算设置已保存并立即生效。'
    case 'feishu': return '飞书设置已保存，新收到的消息立即按新设置处理。'
    case 'qq': return 'QQ 机器人设置已保存，长连接与推送按钮策略立即按新设置生效。'
    case 'preview': return '预览设置已保存；已有的预览链接不会变，新启动的任务按新端口池分配。'
    case 'projects': return '项目设置已保存；下一次上传和解压按新上限执行，正在进行的任务不受影响。'
    case 'github': return 'GitHub 设置已保存；下一次启动任务时，启用的令牌会自动授权给新票。'
    case 'email': return '邮箱设置已保存，新收到的邮件立即按新设置处理。'
    case 'wechat': return '微信设置已保存，新收到的消息和推送立即按新设置生效。'
    case 'director': return '总控助手设置已保存并立即生效。'
    case 'council': return '会商设置已保存；之后召集的会商按新角色、轮数和字数执行，正在进行的会商不受影响。'
    case 'novel': return '小说设置已保存；正在写的书从下一次模型调用起按新设置执行。'
    case 'collab': return '协作设置已保存；任务下一次启动执行者时按新角色和上限执行，正在进行的这一轮不受影响。'
    case 'goal': return '目标设置已保存；之后设定的目标按新的默认上限，判定模型和命令超时从下一次检查起生效。'
    case 'ssh': return 'SSH 连接已保存；任务下一次启动执行者时生效。'
    case 'web': return '搜索设置已保存；后端顺序和额度立即生效，开关从任务下一次启动执行者时生效。'
    case 'policy': return '受理规则已保存；新收到的消息按新规则判断，正在运行的任务不受影响。'
    case 'pause': return paused ? '已暂停接单；新任务会留在队列里，恢复后才会开始。' : '已恢复接单，新任务会正常受理。'
  }
}

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

const ROUTE_MODULES: readonly AdminRouteHandler[] = [
  handleProjectsRoutes,
  handleNovelsRoutes,
  handleCouncilsAndRuntimeRoutes,
  handleTicketsAndAuditRoutes,
  handleDirectorRoutes,
  handleSettingsAndSystemRoutes,
  handlePentestRoutes,
]

export function createAdminApi(options: CreateAdminApiOptions): AdminApi {
  const { host, auth, options: store, ledger, events, cliToken, onPolicyOrSettingsChange, goals, plugins, novels } = options

  /** 短 TTL 共享看板快照，防止多个并发 SSE 标签页重复查库。 */
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
    let novelEdits: unknown[] | undefined
    if (novels && store.get().novel.enabled) {
      try { novelEdits = novels.listRecentEdits(10) } catch { /* ignore */ }
    }
    const body = JSON.stringify({
      paused: facts.paused,
      slots: facts.slots,
      tickets: facts.tickets,
      usage: { todayUsd: totals.usd, todayCalls: totals.calls, dailyBudgetUsd: budget.dailyUsd },
      upstream: facts.upstream,
      runningSteps: facts.runningSteps ?? [],
      ...(novelEdits && novelEdits.length > 0 ? { novelEdits } : {}),
      open,
      ended,
      alerts: buildAlerts(facts, budget, totals.usd, !devAutoAuthEnabled() && auth.usingGeneratedPassword),
    })
    cachedBoard = { at: nowMs, body }
    return body
  }

  function devAutoAuthEnabled(): boolean {
    return process.env.SA_DEV_AUTO_AUTH === '1' && !process.env.SA_ADMIN_PASSWORD
  }

  function authenticate(req: IncomingMessage): AuthState {
    if (checkCliToken(cliToken ?? '', header(req, 'authorization'))) return { authenticated: true, via: 'bearer' }
    const token = cookieValue(header(req, 'cookie'), 'sa_session')
    if (token !== undefined && auth.verify(token)) return { authenticated: true, via: 'cookie', token }
    if (devAutoAuthEnabled()) return { authenticated: true, via: 'cookie' }
    return { authenticated: false, via: 'none' }
  }

  function csrfOk(req: IncomingMessage, state: AuthState): boolean {
    if (state.via === 'bearer') return true
    const contentType = header(req, 'content-type').toLowerCase()
    const simpleBody = /^application\/json(\s*;|$)/.test(contentType) || /^application\/octet-stream(\s*;|$)/.test(contentType)
    return header(req, 'x-sa-request') === '1' && simpleBody
  }

  function recordSettings(section: SettingsSection, changed: string[], text: string): void {
    try { events.add({ kind: 'admin.settings', level: 'info', text, data: { section, changed } }) }
    catch { /* 已持久化，审计失败不翻转结果 */ }
  }

  function notify(change: AdminSettingsChange): void {
    try { onPolicyOrSettingsChange?.(change) }
    catch { /* 缓存刷新失败不影响已落盘配置 */ }
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
    if (root === undefined) { sendJson(res, 404, { error: 'not_found', message: '找不到这张任务票。' }); return }
    handleFilesInRoot(res, root, requested, raw, download)
  }

  const deps: AdminRouteDeps = {
    host,
    auth,
    store,
    ledger,
    events,
    ...(options.projects ? { projects: options.projects } : {}),
    ...(options.councils ? { councils: options.councils } : {}),
    ...(options.activity ? { activity: options.activity } : {}),
    ...(options.novels ? { novels: options.novels } : {}),
    ...(options.fanqie ? { fanqie: options.fanqie } : {}),
    ...(options.piVersions ? { piVersions: options.piVersions } : {}),
    ...(options.devEnv ? { devEnv: options.devEnv } : {}),
    ...(options.goals ? { goals: options.goals } : {}),
    ...(options.contracts ? { contracts: options.contracts } : {}),
    ...(options.createTicketPr ? { createTicketPr: options.createTicketPr } : {}),
    ...(options.pentest ? { pentest: options.pentest } : {}),
    ...(options.director ? { director: options.director } : {}),
    ...(plugins ? { plugins } : {}),
    recordSettings,
    notify,
    finishSettings,
    noteFor,
    handleFiles,
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const isHealth = route === '/health' && method === 'GET'
    const isLogin = route === '/login' && method === 'POST'
    const state = authenticate(req)

    if (!isHealth && !isLogin) {
      if (!state.authenticated) { sendJson(res, 401, { error: 'unauthorized', message: '请先登录后台。' }); return }
      if (isWrite(method) && !csrfOk(req, state)) {
        sendJson(res, 403, { error: 'csrf', message: '请求缺少防止跨站伪造的标记，请刷新页面后重试。' })
        return
      }
    } else if (isWrite(method) && !csrfOk(req, state)) {
      sendJson(res, 403, { error: 'csrf', message: '请求缺少防止跨站伪造的标记，请刷新页面后重试。' })
      return
    }

    // 公共与会话路由
    if (isHealth) { sendJson(res, 200, { ok: true, uptimeSec: host.info().uptimeSec }); return }
    if (isLogin) {
      const parsed = LoginSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return }
      const ip = clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'])
      const result = auth.login(ip, parsed.data.password)
      if (!result.ok) {
        const retry = result.retryAfterSec === undefined ? {} : { retryAfterSec: result.retryAfterSec }
        const headers: Record<string, string> = {}
        if (result.retryAfterSec !== undefined) headers['retry-after'] = String(result.retryAfterSec)
        try {
          events.add({
            kind: 'admin.login_failed',
            level: 'warn',
            text: result.reason === 'locked' ? '登录尝试过多，已暂时锁定' : '有登录尝试但口令不正确',
            data: { reason: result.reason, ip },
          })
        } catch { /* best effort */ }
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
      sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie(result.token, req) })
      return
    }
    if (route === '/logout' && method === 'POST') {
      if (state.token !== undefined) auth.logout(state.token)
      sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(req) })
      return
    }
    if (route === '/me' && method === 'GET') {
      sendJson(res, 200, { authenticated: true, usingGeneratedPassword: !devAutoAuthEnabled() && auth.usingGeneratedPassword })
      return
    }
    if (route === '/password' && method === 'POST') {
      const parsed = PasswordSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return }
      const result = auth.changePassword(parsed.data.old, parsed.data.new)
      if (!result.ok) {
        sendJson(res, 400, result.reason === 'bad_password'
          ? { error: 'bad_password', message: '当前口令不正确。' }
          : { error: 'too_short', message: '新口令至少需要 10 位。' })
        return
      }
      try { events.add({ kind: 'admin.password', level: 'warn', text: '管理口令已修改，所有登录已失效' }) }
      catch { /* best effort */ }
      sendJson(res, 200, { ok: true, relogin: true }, { 'set-cookie': clearSessionCookie(req) })
      return
    }

    // 实时看板 SSE 与概览
    if (route === '/live/stream' && method === 'GET') {
      res.writeHead(200, {
        ...securityHeaders(),
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
      const timer = setInterval(() => { try { push() } catch { /* keep stream */ } }, 1000)
      timer.unref()
      const stopStream = (): void => clearInterval(timer)
      res.on('close', stopStream)
      res.on('error', stopStream)
      return
    }
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
        alerts: buildAlerts(facts, budget, totals.usd, !devAutoAuthEnabled() && auth.usingGeneratedPassword),
        recent: events.recent(15),
      })
      return
    }

    // 已加载子系统插件清单与热启停控制（停用后路由、工具、导航与后台任务同步退出）
    if (route === '/plugins' && method === 'GET') {
      sendJson(res, 200, { items: plugins ? plugins.list() : [] })
      return
    }
    const pluginToggle = /^\/plugins\/([^/]+)$/.exec(route)
    if (pluginToggle !== null && method === 'PUT') {
      const id = decodeSegment(pluginToggle[1] ?? '')
      if (!id || !plugins) { sendJson(res, 404, { error: 'not_found', message: '找不到这个插件。' }); return }
      const body = await parseJsonBody(req)
      const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(body)
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return }
      const updated = await plugins.setEnabled(id, parsed.data.enabled)
      if (!updated) { sendJson(res, 404, { error: 'not_found', message: '找不到这个插件。' }); return }
      try {
        events.add({
          kind: 'plugin.toggled',
          level: 'info',
          text: `${parsed.data.enabled ? '启用' : '停用'}插件「${updated.name}」(${updated.id})`,
          data: { pluginId: updated.id, enabled: updated.enabled },
        })
      } catch { /* ignore */ }
      sendJson(res, 200, { ok: true, item: updated })
      return
    }

    // 优先派发给已注册子系统插件（记忆、技能、定时调度等扩展）
    if (plugins) {
      const handled = await plugins.handleRoute({
        req,
        res,
        url,
        method,
        route,
        events,
        sendJson,
        parseJsonBody,
        invalid,
        decodeSegment,
        clampInt,
      })
      if (handled) return
    }

    // 分发给内置领域路由模块
    const routeReq = { req, res, url, method, route }
    for (const moduleHandler of ROUTE_MODULES) {
      if (await moduleHandler(deps, routeReq)) return
    }

    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
  }

  return async (req, res) => {
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://admin.invalid') } catch { return false }
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
