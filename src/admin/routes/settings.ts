/**
 * 全平台设置、通道连接、SSH、模型清单、全局暂停与系统运维路由
 * （`/settings/*`、`/email/send`、`/wechat/send`、`/ssh/*`、`/models`、`/pause`、`/system/*`）。
 */
import { z } from 'zod'
import { AdminError, type PolicyInput } from '../host.ts'
import { decodeSegment, duplicates, invalid, issuesOf, parseJsonBody, sendJson } from '../http.ts'
import { OptionsError, OptionsSchema, QqSchema, SshConnectionSchema as SshConnectionOptionSchema, findModel, formatRef } from '../options.ts'
import { LIMITS } from '../../limits.ts'
import { keySecretName, looksLikeKey, scanHostKeys } from '../../ssh/connections.ts'
import type { AdminRouteDeps, AdminRouteRequest } from './types.ts'

const ExecutorSchema = OptionsSchema.shape.executor
const PreviewSettingsSchema = OptionsSchema.shape.preview
const ProjectsSettingsSchema = OptionsSchema.shape.projects
const CouncilSettingsSchema = OptionsSchema.shape.council
const NovelSettingsSchema = OptionsSchema.shape.novel
const CollabSettingsSchema = OptionsSchema.shape.collab
const GoalSettingsSchema = OptionsSchema.shape.goal
const WebSettingsSchema = OptionsSchema.shape.web
const SshConnectionSchema = SshConnectionOptionSchema
const BudgetSchema = OptionsSchema.shape.budget
const DirectorSettingsSchema = OptionsSchema.shape.director

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

const FeishuSettingsSchema = OptionsSchema.shape.feishu
  .omit({ mode: true })
  .partial({ appSecret: true, verificationToken: true, encryptKey: true })
  .extend({ mode: z.enum(['webhook', 'ws']).optional() })
const QqSettingsSchema = QqSchema.partial()
const GithubSettingsSchema = OptionsSchema.shape.github.extend({ token: z.string().max(500).optional() })
const EmailSettingsSchema = OptionsSchema.shape.email.extend({ password: z.string().max(500).optional() })
const WechatSettingsSchema = OptionsSchema.shape.wechat.partial({
  mode: true, corpId: true, agentId: true, corpSecret: true, appId: true, appSecret: true,
  callbackToken: true, encodingAesKey: true, webhookUrl: true, bridgeUrl: true, bridgeToken: true,
  ilinkRelayUrl: true, ilinkRelayToken: true,
  apiBase: true, allowedUsers: true, notifyOnComplete: true, routingMode: true,
})
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
const PauseSchema = z.object({ paused: z.boolean() }).strict()
const CleanupSchema = z.object({
  olderThanDays: z.number().int('必须是整数').min(0, '不能小于 0').max(3650, '不能超过 3650 天'),
  dryRun: z.boolean(),
}).strict()
const OrphanCleanupSchema = z.object({
  ids: z.array(z.string().min(1)).max(2_000, '一次最多清理 2000 个目录'),
}).strict()

const READ_ONLY_SECRET_FLAGS = [
  'appSecretSet', 'verificationTokenSet', 'encryptKeySet', 'tokenSet', 'passwordSet',
  'corpSecretSet', 'callbackTokenSet', 'encodingAesKeySet', 'webhookUrlSet', 'bridgeTokenSet', 'ilinkRelayTokenSet',
] as const
const READ_ONLY_MODEL_FLAGS = ['apiKeySet', 'apiKeyTail'] as const

function withoutReadOnlySecrets(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const flag of READ_ONLY_SECRET_FLAGS) delete copy[flag]
  return copy
}

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

export async function handleSettingsAndSystemRoutes(deps: AdminRouteDeps, { req, res, method, route }: AdminRouteRequest): Promise<boolean> {
  const { host, store, events, finishSettings, recordSettings, notify, noteFor } = deps

  if (route === '/settings/policy') {
    if (method === 'GET') { sendJson(res, 200, host.getPolicy()); return true }
    if (method === 'PUT') {
      const parsed = PolicySchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const repeatedRules = duplicates(parsed.data.rules.map(rule => rule.id))
      if (repeatedRules.length > 0) { invalid(res, [{ path: 'rules', message: `规则 ID 不能重复：${repeatedRules.join('、')}` }]); return true }
      const repeatedOperators = duplicates(parsed.data.allowedOperators.map(operator => operator.id))
      if (repeatedOperators.length > 0) { invalid(res, [{ path: 'allowedOperators', message: `操作员 ID 不能重复：${repeatedOperators.join('、')}` }]); return true }
      const repeatedFeishu = duplicates(parsed.data.feishuOperators.map(operator => operator.id))
      if (repeatedFeishu.length > 0) { invalid(res, [{ path: 'feishuOperators', message: `飞书操作员 ID 不能重复：${repeatedFeishu.join('、')}` }]); return true }
      const result = host.updatePolicy(parsed.data as PolicyInput)
      finishSettings(res, 'policy', result.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/settings/feishu') {
    if (method === 'GET') { sendJson(res, 200, store.getPublic().feishu); return true }
    if (method === 'PUT') {
      const parsed = FeishuSettingsSchema.safeParse(withoutReadOnlySecrets(await parseJsonBody(req)))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      let updated
      try { updated = store.updateFeishu(parsed.data) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      finishSettings(res, 'feishu', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }
  if (route === '/settings/feishu/test' && method === 'POST') { sendJson(res, 200, await host.testFeishu()); return true }
  if (route === '/settings/feishu/status' && method === 'GET') { sendJson(res, 200, host.feishuStatus()); return true }
  if (route === '/settings/feishu/reconnect' && method === 'POST') { sendJson(res, 200, await host.reconnectFeishu()); return true }

  if (route === '/settings/qq') {
    if (method === 'GET') { sendJson(res, 200, store.getPublic().qq); return true }
    if (method === 'PUT') {
      const parsed = QqSettingsSchema.safeParse(withoutReadOnlySecrets(await parseJsonBody(req)))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      let updated
      try { updated = store.updateQq(parsed.data) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      finishSettings(res, 'qq', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }
  if (route === '/settings/qq/test' && method === 'POST') {
    sendJson(res, 200, host.testQq ? await host.testQq() : { ok: false, message: '当前运行时未启用 QQ 机器人来源。' })
    return true
  }
  if (route === '/settings/qq/status' && method === 'GET') {
    sendJson(res, 200, host.qqStatus ? host.qqStatus() : { mode: store.get().qq.mode, state: 'off', received: 0, sent: 0 })
    return true
  }
  if (route === '/settings/qq/reconnect' && method === 'POST') {
    sendJson(res, 200, host.reconnectQq ? await host.reconnectQq() : { mode: store.get().qq.mode, state: 'off', received: 0, sent: 0 })
    return true
  }

  if (route === '/settings/github/test' && method === 'POST') { sendJson(res, 200, await host.testGithub()); return true }
  if (route === '/settings/github') {
    if (method === 'GET') { sendJson(res, 200, { ...store.getPublic().github, tokenSet: host.githubTokenSet() }); return true }
    if (method === 'PUT') {
      const parsed = GithubSettingsSchema.safeParse(withoutReadOnlySecrets(await parseJsonBody(req)))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const { token, ...section } = parsed.data
      let updated
      try { updated = store.update('github', section) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      if (token !== undefined && token !== '') host.setGithubToken(token)
      finishSettings(res, 'github', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/settings/email/test' && method === 'POST') { sendJson(res, 200, await host.testEmail()); return true }
  if (route === '/settings/email/status' && method === 'GET') { sendJson(res, 200, host.emailStatus()); return true }
  if (route === '/settings/email') {
    if (method === 'GET') { sendJson(res, 200, { ...store.getPublic().email, passwordSet: host.emailPasswordSet() }); return true }
    if (method === 'PUT') {
      const parsed = EmailSettingsSchema.safeParse(withoutReadOnlySecrets(await parseJsonBody(req)))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const { password, ...section } = parsed.data
      const mergedCheck = OptionsSchema.shape.email.safeParse({ ...store.get().email, ...section })
      if (!mergedCheck.success) { invalid(res, issuesOf(mergedCheck.error)); return true }
      if (password !== undefined && password !== '') host.setEmailPassword(password)
      host.setEmailAllowedSenders(section.allowedSenders)
      let updated
      try { updated = store.updateEmail(section) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      const changed = [...updated.changed]
      if (password !== undefined && password !== '') {
        if (!changed.includes('email.password')) changed.push('email.password')
        if (updated.changed.length === 0) await host.restartEmail?.()
      }
      finishSettings(res, 'email', changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }
  if (route === '/email/send' && method === 'POST') {
    if (!host.sendEmail) throw new AdminError('not_found', '当前运行时未启用邮箱发送。', 404)
    const parsed = EmailSendSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    await host.sendEmail(parsed.data)
    sendJson(res, 200, { ok: true })
    return true
  }

  if (route === '/settings/wechat/qr/start' && method === 'POST') {
    if (!host.startWechatQr) throw new AdminError('not_found', '当前运行时不支持个人微信扫码绑定。', 404)
    const body = await parseJsonBody(req).catch(() => ({}))
    const force = typeof body === 'object' && body !== null && (body as { force?: unknown }).force === true
    const qr = await host.startWechatQr({ force })
    sendJson(res, 200, { ok: true, qr, status: host.wechatStatus?.() })
    return true
  }
  if (route === '/settings/wechat/qr/status' && method === 'GET') {
    sendJson(res, 200, {
      qr: host.wechatQrStatus ? host.wechatQrStatus() : { active: false, status: 'idle', message: '未启用', updatedAt: new Date().toISOString() },
      status: host.wechatStatus ? host.wechatStatus() : { state: 'off', mode: store.getPublic().wechat.mode, received: 0, sent: 0 },
    })
    return true
  }
  if (route === '/settings/wechat/qr/verify' && method === 'POST') {
    if (!host.verifyWechatQr) throw new AdminError('not_found', '当前运行时不支持个人微信扫码配对。', 404)
    const body = await parseJsonBody(req)
    const code = typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code.trim()
      : ''
    if (!code || code.length > 32) { invalid(res, [{ path: 'code', message: '请输入手机微信上显示的数字配对码' }]); return true }
    sendJson(res, 200, { ok: true, qr: host.verifyWechatQr(code) })
    return true
  }
  if (route === '/settings/wechat/qr/logout' && method === 'POST') {
    if (!host.logoutWechatIlink) throw new AdminError('not_found', '当前运行时不支持个人微信解绑。', 404)
    await host.logoutWechatIlink()
    events.add({ kind: 'settings.changed', level: 'info', text: '已断开个人微信插件绑定', data: { section: 'wechat' } })
    sendJson(res, 200, { ok: true, status: host.wechatStatus?.() })
    return true
  }
  if (route === '/settings/wechat/test' && method === 'POST') {
    sendJson(res, 200, host.testWechat ? await host.testWechat() : { ok: false, message: '微信来源未启用。' })
    return true
  }
  if (route === '/settings/wechat/status' && method === 'GET') {
    sendJson(res, 200, host.wechatStatus ? host.wechatStatus() : { state: 'off', mode: store.getPublic().wechat.mode, received: 0, sent: 0 })
    return true
  }
  if (route === '/settings/wechat') {
    if (method === 'GET') { sendJson(res, 200, store.getPublic().wechat); return true }
    if (method === 'PUT') {
      const parsed = WechatSettingsSchema.safeParse(withoutReadOnlySecrets(await parseJsonBody(req)))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      let updated
      try { updated = store.updateWechat(parsed.data) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      host.setWechatAllowedUsers?.(store.get().wechat.allowedUsers)
      finishSettings(res, 'wechat', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }
  if (route === '/wechat/send' && method === 'POST') {
    if (!host.sendWechat) throw new AdminError('not_found', '当前运行时未启用微信发送。', 404)
    const parsed = WechatSendSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    await host.sendWechat({
      text: parsed.data.text,
      ...(parsed.data.to ? { to: parsed.data.to } : {}),
      ...(parsed.data.title ? { title: parsed.data.title } : {}),
    })
    sendJson(res, 200, { ok: true })
    return true
  }

  if (route === '/settings/director') {
    if (method === 'GET') { sendJson(res, 200, store.getPublic().director); return true }
    if (method === 'PUT') {
      const parsed = DirectorSettingsSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const model = parsed.data.model
      if (parsed.data.enabled && model !== null && findModel(store.get().models, model, { enabledOnly: true }) === undefined) {
        invalid(res, [{ path: 'model', message: '总控模型不存在或所在服务商未启用' }])
        return true
      }
      let updated
      try { updated = store.update('director', parsed.data) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      finishSettings(res, 'director', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  // 简洁标准设置段分发：projects / novel / council / preview / executor / budget
  const simpleSections = {
    '/settings/projects': ['projects', ProjectsSettingsSchema],
    '/settings/novel': ['novel', NovelSettingsSchema],
    '/settings/council': ['council', CouncilSettingsSchema],
    '/settings/preview': ['preview', PreviewSettingsSchema],
    '/settings/executor': ['executor', ExecutorSchema],
    '/settings/budget': ['budget', BudgetSchema],
  } as const
  if (route in simpleSections) {
    const [section, schema] = simpleSections[route as keyof typeof simpleSections]
    if (method === 'GET') { sendJson(res, 200, store.getPublic()[section]); return true }
    if (method === 'PUT') {
      const parsed = schema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      let updated
      try { updated = store.update(section, parsed.data as never) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      finishSettings(res, section, updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/settings/goal') {
    if (method === 'GET') { sendJson(res, 200, store.getPublic().goal); return true }
    if (method === 'PUT') {
      const parsed = GoalSettingsSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const judge = parsed.data.judge
      if (judge !== null && findModel(store.get().models, judge, { enabledOnly: true }) === undefined) {
        invalid(res, [{ path: 'judge', message: '判定模型不存在或没有启用' }])
        return true
      }
      let updated
      try { updated = store.update('goal', parsed.data) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      finishSettings(res, 'goal', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/ssh' && method === 'GET') {
    const secrets = new Set(host.listSecrets().map(item => item.name))
    const ssh = store.get().ssh
    sendJson(res, 200, {
      allTickets: ssh.allTickets,
      connections: ssh.connections.map(c => ({ ...c, keySecret: keySecretName(c.name), keySet: secrets.has(keySecretName(c.name)) })),
    })
    return true
  }
  if (route === '/ssh/settings' && method === 'POST') {
    const body = await parseJsonBody(req)
    const allTickets = body && typeof body === 'object' ? (body as Record<string, unknown>).allTickets : undefined
    if (typeof allTickets !== 'boolean') throw new AdminError('invalid', '缺少 allTickets。', 400)
    const updated = store.update('ssh', { ...store.get().ssh, allTickets })
    finishSettings(res, 'ssh', updated.changed)
    return true
  }
  if (route === '/ssh/connections' && method === 'POST') {
    const body = await parseJsonBody(req)
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
    const privateKey = typeof raw.privateKey === 'string' ? raw.privateKey : ''
    const draft = { name: raw.name, host: typeof raw.host === 'string' ? raw.host.trim() : raw.host, port: raw.port ?? 22, user: raw.user, knownHosts: '' }
    const parsed = SshConnectionSchema.safeParse(draft)
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const conn = parsed.data
    const secret = keySecretName(conn.name)
    const hasKey = host.listSecrets().some(item => item.name === secret)
    if (privateKey.trim() !== '' && !looksLikeKey(privateKey)) {
      invalid(res, [{ path: 'privateKey', message: '这不像 SSH 私钥（要包含 BEGIN … PRIVATE KEY）' }])
      return true
    }
    if (privateKey.trim() === '' && !hasKey) { invalid(res, [{ path: 'privateKey', message: '新连接要填私钥' }]); return true }
    let knownHosts: string
    try { knownHosts = await scanHostKeys(conn.host, conn.port) }
    catch (error) { invalid(res, [{ path: 'host', message: error instanceof Error ? error.message : String(error) }]); return true }
    if (privateKey.trim() !== '') {
      const value = `${privateKey.trim().replace(/\r\n/g, '\n')}\n`
      if (hasKey) host.updateSecret(secret, { value })
      else host.createSecret({ name: secret, value, description: `SSH 连接 ${conn.name} 的私钥` })
    }
    const ssh = store.get().ssh
    const connections = [...ssh.connections.filter(c => c.name !== conn.name), { ...conn, knownHosts }]
    const updated = store.update('ssh', { ...ssh, connections })
    finishSettings(res, 'ssh', updated.changed, { knownHosts })
    return true
  }
  const sshMatch = /^\/ssh\/connections\/([^/]+)$/.exec(route)
  if (sshMatch !== null && method === 'DELETE') {
    const name = decodeSegment(sshMatch[1] ?? '')
    const ssh = store.get().ssh
    if (name === undefined || !ssh.connections.some(c => c.name === name)) {
      sendJson(res, 404, { error: 'not_found', message: '没有这个连接。' })
      return true
    }
    const updated = store.update('ssh', { ...ssh, connections: ssh.connections.filter(c => c.name !== name) })
    if (host.listSecrets().some(item => item.name === keySecretName(name))) host.deleteSecret(keySecretName(name))
    finishSettings(res, 'ssh', updated.changed)
    return true
  }

  if (route === '/settings/web') {
    if (method === 'GET') { sendJson(res, 200, store.getPublic().web); return true }
    if (method === 'PUT') {
      const body = await parseJsonBody(req)
      const raw = (typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : body) as Record<string, unknown>
      const clear = raw?.exaKeyClear === true
      if (raw && typeof raw === 'object') {
        delete raw.exaKeyClear
        delete raw.exaKeySet
        if (!clear && (raw.exaKey === undefined || raw.exaKey === '')) raw.exaKey = store.get().web.exaKey
        if (clear) raw.exaKey = ''
      }
      const parsed = WebSettingsSchema.safeParse(raw)
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const model = parsed.data.claudeModel
      if (model !== null) {
        const found = findModel(store.get().models, model, { enabledOnly: true })
        if (found === undefined || found.provider.api !== 'anthropic-messages') {
          invalid(res, [{ path: 'claudeModel', message: 'Claude 代搜要用 Anthropic 协议服务商上已启用的模型' }])
          return true
        }
      }
      const gModel = parsed.data.geminiModel
      if (gModel !== null && findModel(store.get().models, gModel, { enabledOnly: true }) === undefined) {
        invalid(res, [{ path: 'geminiModel', message: 'Gemini 搜索模型必须是已启用服务商上的模型' }])
        return true
      }
      let updated
      try { updated = store.update('web', parsed.data) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      finishSettings(res, 'web', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/settings/collab') {
    if (method === 'GET') { sendJson(res, 200, store.getPublic().collab); return true }
    if (method === 'PUT') {
      const parsed = CollabSettingsSchema.safeParse(await parseJsonBody(req))
      if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
      const models = store.get().models
      const issues = parsed.data.roles.flatMap((role, index) =>
        role.model === null || findModel(models, role.model, { enabledOnly: true }) !== undefined
          ? []
          : [{ path: `roles.${index}.model`, message: `角色「${role.name}」用的模型不存在或没有启用` }])
      if (issues.length > 0) { invalid(res, issues); return true }
      let updated
      try { updated = store.update('collab', parsed.data) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      finishSettings(res, 'collab', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
  }

  if (route === '/settings/models/test' && method === 'POST') {
    const parsed = ModelTestSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    sendJson(res, 200, await host.modelTest(parsed.data.provider, parsed.data.model))
    return true
  }
  if (route === '/settings/models/discover' && method === 'POST') {
    const parsed = ModelDiscoverSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    sendJson(res, 200, await host.discoverModels(parsed.data))
    return true
  }
  if (route === '/settings/models') {
    if (method === 'GET') { sendJson(res, 200, store.getPublic().models); return true }
    if (method === 'PUT') {
      const body = await parseJsonBody(req)
      let updated
      try { updated = store.updateModels(withoutReadOnlyModelFlags(body)) } catch (error) {
        if (error instanceof OptionsError) { invalid(res, error.issues); return true }
        throw error
      }
      finishSettings(res, 'models', updated.changed)
      return true
    }
    sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
    return true
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
    return true
  }

  if (route === '/pause' && method === 'POST') {
    const parsed = PauseSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
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
    return true
  }

  // System.
  if (route === '/system' && method === 'GET') {
    sendJson(res, 200, { ...host.info(), ...(await host.system()) })
    return true
  }
  if (route === '/system/cleanup' && method === 'POST') {
    const parsed = CleanupSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const result = await host.cleanup(parsed.data)
    try {
      events.add({
        kind: 'admin.cleanup',
        level: 'info',
        text: parsed.data.dryRun ? '预览了旧工作区清理' : `清理了 ${result.deleted.length} 个旧工作区`,
        data: { olderThanDays: parsed.data.olderThanDays, dryRun: parsed.data.dryRun, entries: result.entries.length, freedBytes: result.freedBytes },
      })
    } catch { /* best effort */ }
    sendJson(res, 200, result)
    return true
  }
  if (route === '/system/orphans' && method === 'GET') { sendJson(res, 200, host.orphans()); return true }
  if (route === '/system/orphans/cleanup' && method === 'POST') {
    const parsed = OrphanCleanupSchema.safeParse(await parseJsonBody(req))
    if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
    const result = host.cleanupOrphans(parsed.data.ids)
    try {
      events.add({
        kind: 'admin.cleanup',
        level: 'info',
        text: `清理了 ${result.deleted.length} 个孤儿目录`,
        data: { kind: 'orphans', ids: result.deleted, freedBytes: result.freedBytes },
      })
    } catch { /* best effort */ }
    sendJson(res, 200, result)
    return true
  }
  if (route === '/system/backups' && method === 'GET') { sendJson(res, 200, host.backups()); return true }
  if (route === '/system/backups' && method === 'POST') { sendJson(res, 200, await host.createBackup()); return true }

  return false
}
