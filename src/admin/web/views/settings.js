/**
 * 设置: sections, one save bar.
 *
 * The page keeps a draft per section and writes only the section being saved.
 * Field paths are dotted (`rules.2.name`, `routing.worker.model`), so one
 * delegated listener updates the draft without re-rendering (focus stays).
 */
import { get, put, post, invalidateOverview } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, ago } from '../lib/view.js'
import { seatStampHtml } from '../lib/council-view.js'
import { validateProjects, validateCouncil, projectsHint, formatMb, formatFiles } from '../lib/settings-validate.js'

const SECTIONS = [
  { key: 'policy', label: '受理规则', hint: '决定哪些消息会被接成任务，以及哪些人能下指令。' },
  { key: 'executor', label: '执行环境', hint: '决定 AI 在什么环境里干活、同时能跑几个任务。' },
  { key: 'models', label: '模型', hint: '用哪些 AI 服务、默认用谁，以及要不要先分析再派活。' },
  { key: 'budget', label: '费用上限', hint: '决定一张票和一天最多能花多少钱。' },
  { key: 'feishu', label: '飞书', hint: '让飞书里的人发消息下指令，并把结果回到飞书。' },
  { key: 'github', label: 'GitHub', hint: '让 AI 拉代码、推分支、开 PR。' },
  { key: 'email', label: '邮箱', hint: '用 Gmail 收指令、回结果。' },
  { key: 'preview', label: '预览', hint: 'AI 把容器里的网页发布成临时链接，端口从这里分配。' },
  { key: 'projects', label: '项目', hint: '上传项目压缩包时的大小限制，防止磁盘被撑满。' },
  { key: 'council', label: '会商', hint: '让几个 AI 角色先讨论再开工。这里改角色、轮数和主持人。' },
  { key: 'account', label: '账号', hint: '改后台口令。' },
]

const SETTINGS_TABS = SECTIONS.map((item) => item.key)

/**
 * Landing focus for `?focus=unset`: per section, the key fields in priority
 * order. `path` is a data-path input; `secret` is a data-secret input whose
 * "already set" flag is `set` (the typed value is never echoed back).
 */
const FOCUS_ORDER = {
  feishu: [
    { path: 'appId' },
    { path: 'appSecret', set: 'appSecretSet' },
    { path: 'verificationToken', set: 'verificationTokenSet' },
  ],
  github: [
    { secret: true, set: 'tokenSet' },
    { repoIndex: 0 },
  ],
  email: [
    { path: 'address' },
    { secret: true, set: 'passwordSet' },
    { senderIndex: 0 },
  ],
  preview: [{ path: 'publicBase' }],
}
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateGithub(draft) {
  const issues = []
  const repos = Array.isArray(draft.repos) ? draft.repos : []
  if (repos.length > 50) issues.push({ path: 'repos', message: '仓库白名单最多 50 个。' })
  repos.forEach((repo, index) => {
    const text = String(repo ?? '').trim()
    if (!text) issues.push({ path: `repos.${index}`, message: `第 ${index + 1} 个仓库还没有填。` })
    else if (!REPO_RE.test(text)) issues.push({ path: `repos.${index}`, message: `「${text}」格式不对，应该是 owner/repo。` })
  })
  if (!String(draft.defaultBase ?? '').trim()) issues.push({ path: 'defaultBase', message: '请填写默认目标分支，例如 main。' })
  let urlOk = false
  try {
    const url = new URL(String(draft.apiBase ?? ''))
    urlOk = url.protocol === 'http:' || url.protocol === 'https:'
  } catch { urlOk = false }
  if (!urlOk) issues.push({ path: 'apiBase', message: '接口地址要包含 http:// 或 https://。' })
  return issues
}

function validateEmail(draft) {
  const issues = []
  const address = String(draft.address ?? '').trim()
  if (draft.enabled === true && !address) issues.push({ path: 'address', message: '启用邮箱前请填写 Gmail 地址。' })
  if (address && !EMAIL_RE.test(address)) issues.push({ path: 'address', message: 'Gmail 地址格式不对。' })
  const senders = Array.isArray(draft.allowedSenders) ? draft.allowedSenders : []
  senders.forEach((sender, index) => {
    const text = String(sender ?? '').trim()
    if (!text) issues.push({ path: `allowedSenders.${index}`, message: `第 ${index + 1} 个发件人还没有填。` })
    else if (!EMAIL_RE.test(text)) issues.push({ path: `allowedSenders.${index}`, message: `「${text}」不是有效的邮箱地址。` })
  })
  const poll = Number(draft.pollSeconds)
  if (!Number.isInteger(poll) || poll < 15 || poll > 3600) {
    issues.push({ path: 'pollSeconds', message: '检查间隔要在 15–3600 秒之间。' })
  }
  const attachment = Number(draft.maxAttachmentMb)
  if (!Number.isInteger(attachment) || attachment < 1 || attachment > 25) {
    issues.push({ path: 'maxAttachmentMb', message: '附件上限要在 1–25 MB 之间。' })
  }
  return issues
}

const MODES = [
  { value: 'off', label: '不接推断', help: '只接明确点名或直接私聊的请求' },
  { value: 'observe', label: '只记录', help: '照常判断，但只写进判断记录，不开票' },
  { value: 'auto', label: '自动接单', help: '规则判断通过就直接开票' },
]

const FEISHU_MODES = [
  { value: 'ws', label: '长连接', help: '只需要出站网络，不用公网地址（推荐）' },
  { value: 'webhook', label: '回调地址', help: '需要公网能访问到这台机器' },
]

const GROUP_MODES = [
  { value: 'mention', label: '只有在群里 @ 它才接', help: '' },
  { value: 'all', label: '群里所有消息都看', help: '' },
]

const clone = (value) => JSON.parse(JSON.stringify(value))
const isObject = (value) => value !== null && typeof value === 'object'

/** GET that reports failure instead of throwing, so one bad section cannot hide the rest. */
const settleGet = (path) => get(path).then(
  (value) => ({ value, error: '' }),
  (error) => {
    if (error?.status === 401) throw error
    return { value: null, error: error?.message || '请求失败' }
  },
)

function setPath(target, path, value) {
  const parts = path.split('.')
  let node = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    if (!isObject(node[key])) node[key] = /^\d+$/.test(parts[index + 1]) ? [] : {}
    node = node[key]
  }
  node[parts[parts.length - 1]] = value
}

function getPath(target, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), target)
}

const money = (value) => Number(value ?? 0).toFixed(2)

/** Council PUT body: exactly the strict keys; `model` only when chosen; moderator null when following the worker model. */
function councilPayload(council) {
  const moderator = council.moderator && typeof council.moderator === 'object'
    ? { provider: String(council.moderator.provider), model: String(council.moderator.model) }
    : null
  return {
    enabled: council.enabled === true,
    defaultOn: council.defaultOn === true,
    rounds: Number(council.rounds),
    maxCharsPerTurn: Number(council.maxCharsPerTurn),
    moderator,
    roles: (council.roles ?? []).map((role) => {
      const out = {
        id: String(role.id ?? ''),
        name: String(role.name ?? '').trim(),
        persona: String(role.persona ?? '').trim(),
        enabled: role.enabled === true,
      }
      if (role.model && role.model.provider && role.model.model) {
        out.model = { provider: String(role.model.provider), model: String(role.model.model) }
      }
      return out
    }),
  }
}

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page'
  const state = {
    tab: SETTINGS_TABS.includes(ctx.params.tab) ? ctx.params.tab : 'policy',
    saved: {},
    draft: {},
    dirty: new Set(),
    issues: [],
    saving: false,
    discover: { open: false, form: { api: 'openai-completions', baseUrl: '', apiKey: '', sessionHeader: '' }, result: null, busy: false },
    feishuStatus: null,
    secret: '',
    githubTest: null,
    emailTest: null,
    emailStatus: null,
    password: { old: '', next: '', again: '' },
    passwordError: '',
    loadError: {},
    openRole: '',
    newRole: { open: false, id: '', name: '', persona: '', error: '' },
  }
  let alive = true
  let loaded = false
  let emailTimer = null
  // Landing focus runs once per mount, after the first load (see landFocus).
  let focusPending = ctx.query?.focus === 'unset'

  const load = async () => {
    try {
      const [policy, executor, models, budget, feishu, github, email, preview] = await Promise.all([
        get('api/settings/policy'), get('api/settings/executor'), get('api/settings/models'),
        get('api/settings/budget'), get('api/settings/feishu'),
        get('api/settings/github').catch(() => null),
        get('api/settings/email').catch(() => null),
        get('api/settings/preview').catch(() => null),
      ])
      const [projects, council] = await Promise.all([settleGet('api/settings/projects'), settleGet('api/settings/council')])
      if (!alive) return
      // A person may have edited while this request was in flight. Their draft wins across every
      // section: drop the whole response instead of overwriting the draft and clearing dirty.
      if (loaded && state.dirty.size > 0) return
      loaded = true
      state.loadError = { projects: projects.error, council: council.error }
      state.saved = {
        policy, executor, models, budget, feishu, projects: projects.value, council: council.value,
        github: github ?? { enabled: false, repos: [], defaultBase: 'main', apiBase: 'https://api.github.com', tokenSet: false },
        email: email ?? { enabled: false, address: '', displayName: '', allowedSenders: [], pollSeconds: 60, maxAttachmentMb: 20, passwordSet: false },
        preview: preview ?? { enabled: false, portStart: 19000, portEnd: 19199, perTicket: 2, publicBase: '' },
      }
      state.draft = clone(state.saved)
      state.dirty.clear()
      state.issues = []
      state.secret = ''
      paint()
      if (focusPending) { focusPending = false; landFocus() }
      loadFeishuStatus()
    } catch (error) {
      if (error?.status === 401) return
      root.innerHTML = `<div class="banner"><span>设置没有读出来：${esc(error?.message || '请求失败')}</span></div>`
    }
  }

  const loadFeishuStatus = async () => {
    try {
      state.feishuStatus = await get('api/settings/feishu/status')
      if (alive && state.tab === 'feishu') paintStatus()
    } catch { /* older daemons have no status route */ }
  }

  const refreshEmailStatus = async () => {
    if (!alive || state.tab !== 'email' || document.hidden) return
    try {
      state.emailStatus = await get('api/settings/email/status')
      if (alive) paintEmailStatus()
    } catch { /* keep the last known status */ }
  }

  const startEmailPolling = () => {
    if (state.tab !== 'email' || emailTimer) return
    refreshEmailStatus()
    emailTimer = window.setInterval(refreshEmailStatus, 10000)
  }

  const stopEmailPolling = () => {
    if (emailTimer) window.clearInterval(emailTimer)
    emailTimer = null
  }

  /* ---------- fragments ---------- */

  const input = (path, { label, help, type = 'text', placeholder = '' } = {}) => {
    const value = getPath(state.draft[state.tab], path) ?? ''
    return `<label class="formrow">
      <span class="formrow__label">${esc(label)}</span>
      <input class="input" type="${type}" value="${esc(value)}" data-focus-key="settings.${path}" data-path="${path}" placeholder="${esc(placeholder)}"${type === 'number' ? ' inputmode="decimal"' : ''}>
      ${help ? `<span class="formrow__help">${esc(help)}</span>` : ''}
    </label>`
  }

  const switchRow = (path, { label, help } = {}) => {
    const on = getPath(state.draft[state.tab], path) === true
    return `<div class="switchline">
      <span class="switchline__text"><span class="switchline__title">${esc(label)}</span>${help ? `<span class="switchline__desc">${esc(help)}</span>` : ''}</span>
      <button class="switch" type="button" role="switch" aria-checked="${on}" data-toggle="${path}"><span class="switch__track"><i></i></span></button>
    </div>`
  }

  const segRow = (path, options, label) => {
    const current = getPath(state.draft[state.tab], path)
    return `<div class="field">
      <span class="field__label">${esc(label)}</span>
      <div class="seg" role="group" aria-label="${esc(label)}">
        ${options.map((option) => `<button class="seg__i" type="button" data-choice="${path}" data-value="${option.value}" aria-pressed="${option.value === current}">${esc(option.label)}</button>`).join('')}
      </div>
      <p class="hint">${esc(options.find((option) => option.value === current)?.help ?? '')}</p>
    </div>`
  }

  /* ---------- sections ---------- */

  function policySection() {
    const policy = state.draft.policy
    return `
      ${segRow('acceptMode', MODES, '接单模式')}
      <div class="setgrid" style="margin-top:16px">
        ${input('evalTimeoutSeconds', { label: '分析超时（秒）', help: '分析模型超过这个时间就按原话受理，不会把票卡住', type: 'number' })}
      </div>
      <section class="section">
        <div class="section__head"><h2 class="section__title">规则</h2><span class="section__count">${policy.rules.length} 条</span>
          <button class="btn btn--quiet" type="button" data-add-rule style="margin-left:auto">加一条规则</button></div>
        <div class="setgrid">
          ${policy.rules.map((rule, index) => `<div class="card">
            <div class="switchline" style="min-height:44px">
              <span class="switchline__text"><span class="switchline__title">${esc(rule.name || rule.id || `规则 ${index + 1}`)}</span>
                <span class="switchline__desc">规则 ID：${esc(rule.id || '（未填）')}</span></span>
              <button class="switch" type="button" role="switch" aria-checked="${rule.enabled === true}" data-toggle="rules.${index}.enabled"><span class="switch__track"><i></i></span></button>
              <button class="btn btn--quiet" type="button" data-remove-rule="${index}">删除</button>
            </div>
            <div class="formrow"><span class="formrow__label">名称</span>
              <input class="input" value="${esc(rule.name)}" data-focus-key="settings.rules.${index}.name" data-path="rules.${index}.name" placeholder="例如：代码修复"></div>
            <div class="formrow"><span class="formrow__label">ID</span>
              <input class="input mono" value="${esc(rule.id)}" data-focus-key="settings.rules.${index}.id" data-path="rules.${index}.id" placeholder="例如：code-fix（字母数字下划线）"></div>
            <div class="formrow"><span class="formrow__label">说明（分析模型按这段判断）</span>
              <textarea class="textarea" style="min-height:96px" data-focus-key="settings.rules.${index}.instruction" data-path="rules.${index}.instruction" placeholder="什么情况下算这一类活">${esc(rule.instruction)}</textarea></div>
          </div>`).join('')}
        </div>
      </section>
      <section class="section">
        <div class="section__head"><h2 class="section__title">命令行里能下指令的人</h2>
          <button class="btn btn--quiet" type="button" data-add-operator="allowedOperators" style="margin-left:auto">加一个</button></div>
        <div class="list">
          ${policy.allowedOperators.map((operator, index) => `<div class="row row--flat">
            <span class="row__main" style="display:flex;gap:8px;flex-wrap:wrap">
              <input class="input" style="flex:1 1 120px" value="${esc(operator.id)}" data-focus-key="settings.allowedOperators.${index}.id" data-path="allowedOperators.${index}.id" placeholder="命令行 ID">
              <input class="input" style="flex:1 1 120px" value="${esc(operator.name)}" data-focus-key="settings.allowedOperators.${index}.name" data-path="allowedOperators.${index}.name" placeholder="备注名（可选）">
            </span>
            <button class="btn btn--quiet" type="button" data-remove-operator="allowedOperators:${index}">移除</button>
          </div>`).join('')}
        </div>
      </section>
      <section class="section">
        <div class="section__head"><h2 class="section__title">飞书里能下指令的人</h2>
          <button class="btn btn--quiet" type="button" data-add-operator="feishuOperators" style="margin-left:auto">加一个</button></div>
        <div class="list">
          ${policy.feishuOperators.length ? policy.feishuOperators.map((operator, index) => `<div class="row row--flat">
            <span class="row__main" style="display:flex;gap:8px;flex-wrap:wrap">
              <input class="input" style="flex:1 1 120px" value="${esc(operator.id)}" data-focus-key="settings.feishuOperators.${index}.id" data-path="feishuOperators.${index}.id" placeholder="飞书 open_id">
              <input class="input" style="flex:1 1 120px" value="${esc(operator.name)}" data-focus-key="settings.feishuOperators.${index}.name" data-path="feishuOperators.${index}.name" placeholder="备注名（可选）">
            </span>
            <button class="btn btn--quiet" type="button" data-remove-operator="feishuOperators:${index}">移除</button>
          </div>`).join('') : '<p class="hint" style="padding:10px 2px">还没有；飞书里只有这些人能派活。</p>'}
        </div>
      </section>`
  }

  function executorSection() {
    return `<div class="setgrid">
      ${input('maxWorkers', { label: '同时跑几个任务', type: 'number', help: '1–8；另外永远留 1 个位置给你的追问' })}
      ${input('cpus', { label: '每个任务的 CPU 核数', help: '这台机器 4 核，两个任务各 2 核刚好' })}
      ${input('memory', { label: '每个任务的内存上限', help: '例如 6g；写错容器会起不来' })}
      ${input('image', { label: '执行镜像', help: '升级镜像等于换执行环境，先在测试票上试' })}
    </div>`
  }

  function modelOptions(selected) {
    const providers = state.draft.models.providers ?? []
    return providers.filter((provider) => provider.enabled).flatMap((provider) => provider.models.map((model) => {
      const ref = `${provider.id}/${model.id}`
      const isSelected = selected?.provider === provider.id && selected?.model === model.id
      return `<option value="${esc(ref)}"${isSelected ? ' selected' : ''}>${esc(provider.name)} · ${esc(model.label || model.id)}</option>`
    })).join('')
  }

  function modelsSection() {
    const models = state.draft.models
    return `
      <section class="section" style="margin-top:0">
        <div class="section__head"><h2 class="section__title">默认分工</h2>
          <button class="btn btn--quiet" type="button" data-add-provider style="margin-left:auto">加一个服务商</button></div>
        <div class="setgrid">
          <div class="formrow"><span class="formrow__label">默认执行模型</span>
            <select class="select" data-focus-key="settings.routing.worker" data-ref="routing.worker">${modelOptions(models.routing.worker) || '<option value="">先加一个可用模型</option>'}</select>
            <span class="formrow__help">真正干活的模型；只能选已启用服务商里的模型</span></div>
          <div class="formrow"><span class="formrow__label">分析模型</span>
            <select class="select" data-focus-key="settings.routing.assessor" data-ref="routing.assessor">${modelOptions(models.routing.assessor) || '<option value="">先加一个可用模型</option>'}</select>
            <span class="formrow__help">负责读懂任务、挑执行模型；选便宜快的就够</span></div>
          ${switchRow('routing.assessor.enabled', { label: '先分析再派活', help: '关掉则直接接单，不调用分析模型' })}
          ${input('routing.assessor.timeoutSec', { label: '分析超时（秒）', type: 'number' })}
          ${switchRow('routing.autoSelect', { label: '让它自己挑执行模型', help: '按任务难度挑；关掉则一律用默认模型' })}
        </div>
      </section>

      ${(models.providers ?? []).map((provider, index) => `<section class="section">
        <div class="provider">
          <div class="provider__head">
            <span class="provider__name">${esc(provider.name || provider.id || '服务商')}</span>
            <span class="tag">${provider.enabled ? '已启用' : '已停用'}</span>
            <button class="btn btn--quiet" type="button" data-test-provider="${index}" style="margin-left:auto">测试连接</button>
            <button class="btn btn--quiet" type="button" data-remove-provider="${index}">删除</button>
          </div>
          <p class="provider__meta">${esc(provider.api)} · ${esc(provider.baseUrl)} · ${provider.apiKeySet ? `密钥已设置（…${esc(provider.apiKeyTail || '')}）` : '还没填密钥'}</p>
          <div class="formrow"><span class="formrow__label">名称</span>
            <input class="input" value="${esc(provider.name)}" data-focus-key="settings.providers.${index}.name" data-path="providers.${index}.name"></div>
          <div class="formrow"><span class="formrow__label">接口类型</span>
            <select class="select" data-focus-key="settings.providers.${index}.api" data-path="providers.${index}.api">
              ${['openai-completions', 'anthropic-messages'].map((api) => `<option value="${api}"${provider.api === api ? ' selected' : ''}>${api}</option>`).join('')}
            </select></div>
          <div class="formrow"><span class="formrow__label">Base URL</span>
            <input class="input mono" value="${esc(provider.baseUrl)}" data-focus-key="settings.providers.${index}.baseUrl" data-path="providers.${index}.baseUrl"></div>
          <div class="formrow"><span class="formrow__label">API 密钥</span>
            <input class="input" type="password" value="" data-focus-key="settings.providers.${index}.apiKey" data-path="providers.${index}.apiKey" placeholder="${provider.apiKeySet ? '已设置；留空表示不修改' : '粘贴密钥'}">
            <span class="formrow__help">只存在这台机器的 state 目录里，不会回显</span></div>
          <div class="formrow"><span class="formrow__label">会话头（可选）</span>
            <input class="input mono" value="${esc(provider.sessionHeader ?? '')}" data-focus-key="settings.providers.${index}.sessionHeader" data-path="providers.${index}.sessionHeader" placeholder="例如 x-opencode-session"></div>
          ${switchRow(`providers.${index}.enabled`, { label: '启用这个服务商' })}
          <div class="section__head" style="margin-top:10px"><h3 class="section__title">模型</h3>
            <button class="btn btn--quiet" type="button" data-add-model="${index}" style="margin-left:auto">加模型</button></div>
          <div class="setgrid">
            ${(provider.models ?? []).map((model, modelIndex) => `<div class="card">
              <div class="provider__models">
                <span class="tag mono">${esc(model.id || '新模型')}</span>
                ${model.label ? `<span class="tag">${esc(model.label)}</span>` : ''}
                <button class="btn btn--quiet" type="button" data-remove-model="${index}:${modelIndex}" style="margin-left:auto">删除</button>
              </div>
              <div class="formrow__inline" style="margin-top:8px">
                <label class="formrow" style="flex:1 1 140px"><span class="formrow__label">模型 ID</span>
                  <input class="input mono" value="${esc(model.id)}" data-focus-key="settings.providers.${index}.models.${modelIndex}.id" data-path="providers.${index}.models.${modelIndex}.id"></label>
                <label class="formrow" style="flex:1 1 140px"><span class="formrow__label">显示名</span>
                  <input class="input" value="${esc(model.label)}" data-focus-key="settings.providers.${index}.models.${modelIndex}.label" data-path="providers.${index}.models.${modelIndex}.label"></label>
              </div>
              <div class="formrow__inline">
                <label class="formrow" style="flex:1 1 120px"><span class="formrow__label">上下文</span>
                  <input class="input" type="number" value="${model.contextWindow}" data-focus-key="settings.providers.${index}.models.${modelIndex}.contextWindow" data-path="providers.${index}.models.${modelIndex}.contextWindow"></label>
                <label class="formrow" style="flex:1 1 120px"><span class="formrow__label">最大输出</span>
                  <input class="input" type="number" value="${model.maxTokens}" data-focus-key="settings.providers.${index}.models.${modelIndex}.maxTokens" data-path="providers.${index}.models.${modelIndex}.maxTokens"></label>
              </div>
              <div class="bar-actions" style="margin-top:8px">
                ${['reasoning', 'vision', 'autoPick'].map((flag) => `<button class="btn ${model[flag] ? 'btn--ink' : ''}" type="button" data-toggle="providers.${index}.models.${modelIndex}.${flag}">${flag === 'reasoning' ? '推理' : flag === 'vision' ? '看图' : '可自动选'}</button>`).join('')}
              </div>
            </div>`).join('')}
          </div>
        </div>
      </section>`).join('')}

      <section class="section">
        <div class="section__head"><h2 class="section__title">从服务商拉模型</h2>
          <span class="section__note">只读，不会自动保存</span></div>
        <div class="card">
          ${state.discover.open ? `
            <div class="formrow__inline">
              <label class="formrow" style="flex:1 1 130px"><span class="formrow__label">接口类型</span>
                <select class="select" data-discover="api">
                  <option value="openai-completions"${state.discover.form.api === 'openai-completions' ? ' selected' : ''}>openai-completions</option>
                  <option value="anthropic-messages"${state.discover.form.api === 'anthropic-messages' ? ' selected' : ''}>anthropic-messages</option>
                </select></label>
              <label class="formrow" style="flex:1 1 200px"><span class="formrow__label">Base URL</span>
                <input class="input mono" data-discover="baseUrl" value="${esc(state.discover.form.baseUrl)}" placeholder="https://…/v1"></label>
            </div>
            <div class="formrow__inline">
              <label class="formrow" style="flex:1 1 200px"><span class="formrow__label">API 密钥（可留空，用已保存的）</span>
                <input class="input" type="password" data-discover="apiKey" value="${esc(state.discover.form.apiKey)}"></label>
              <label class="formrow" style="flex:1 1 160px"><span class="formrow__label">会话头（可选）</span>
                <input class="input mono" data-discover="sessionHeader" value="${esc(state.discover.form.sessionHeader)}"></label>
            </div>
            <div class="bar-actions" style="margin-top:10px">
              <button class="btn btn--ink" type="button" data-do-discover ${state.discover.busy ? 'disabled' : ''}>${state.discover.busy ? '正在拉…' : '拉取模型列表'}</button>
              <button class="btn btn--quiet" type="button" data-close-discover>收起</button>
            </div>
            ${state.discover.result ? `<div class="list" style="margin-top:10px">
              ${state.discover.result.ok === false ? `<p class="hint" style="padding:8px 2px">${esc(state.discover.result.message || '拉取失败')}</p>` : ''}
              ${(state.discover.result.models ?? []).map((model) => `<div class="row row--flat">
                <span class="row__main"><span class="row__title mono">${esc(model.id)}</span>
                  <span class="row__meta">${model.contextWindow ? `<span>上下文 ${model.contextWindow}</span>` : ''}${model.vision ? '<span>可看图</span>' : ''}</span></span>
                <button class="btn btn--quiet" type="button" data-add-discovered="${esc(model.id)}">加入</button>
              </div>`).join('')}
            </div>` : ''}` : `<div class="bar-actions">
              <button class="btn" type="button" data-open-discover>单独拉一次模型列表</button>
              <span class="hint" style="align-self:center">用于确认地址和密钥是否可用</span>
            </div>`}
        </div>
      </section>`
  }

  function budgetSection() {
    const budget = state.draft.budget
    const perTicket = Number(budget.perTicketUsd ?? 0)
    const daily = Number(budget.dailyUsd ?? 0)
    const estimate = daily > 0
      ? `按每张 ${money(perTicket)} 估算，一天大约够 ${perTicket > 0 ? Math.max(1, Math.floor(daily / perTicket)) : '—'} 张票`
      : '没有日上限，不会自动停'
    return `<div class="setgrid">
      ${switchRow('enabled', { label: '启用费用上限', help: '到上限时网关直接拦住，票转成「等你决定」' })}
      ${input('perTicketUsd', { label: '单张工单上限（美元）', type: 'number' })}
      ${input('dailyUsd', { label: '每天上限（美元）', type: 'number' })}
      <p class="hint">${esc(estimate)}</p>
    </div>`
  }

  function feishuSection() {
    const feishu = state.draft.feishu
    return `
      <div class="setgrid">
        ${switchRow('enabled', { label: '启用飞书入口', help: '关掉之后飞书里的消息不再进来' })}
        ${segRow('mode', FEISHU_MODES, '怎么接收消息')}
        ${input('appId', { label: 'App ID' })}
        ${input('apiBase', { label: '飞书 API 地址', help: '自建应用一般不用改' })}
        ${segRow('groupMode', GROUP_MODES, '群里的消息')}
        <div class="formrow"><span class="formrow__label">App Secret</span>
          <input class="input" type="password" value="" data-focus-key="settings.appSecret" data-path="appSecret" placeholder="${feishu.appSecretSet ? '已设置；留空表示不修改' : '粘贴 App Secret'}"></div>
        <div class="formrow"><span class="formrow__label">Verification Token</span>
          <input class="input" type="password" value="" data-focus-key="settings.verificationToken" data-path="verificationToken" placeholder="${feishu.verificationTokenSet ? '已设置；留空表示不修改' : '粘贴 Verification Token'}"></div>
        <div class="formrow"><span class="formrow__label">Encrypt Key（可选）</span>
          <input class="input" type="password" value="" data-focus-key="settings.encryptKey" data-path="encryptKey" placeholder="${feishu.encryptKeySet ? '已设置；留空表示不修改' : '不加密就留空'}"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="bar-actions">
          <button class="btn" type="button" data-feishu-test>测试连接</button>
          <span class="hint" style="align-self:center" data-feishu-status>用已保存的配置连一次</span>
        </div>
      </div>
      <details class="disclose" data-keep="settings.feishu-guide" style="margin-top:18px">
        <summary>怎么在飞书里配置（7 步，点开看）</summary>
        <div class="steps">
          <div class="step"><div class="step__title">建一个企业自建应用</div><div class="step__text">长连接只支持自建应用；在你能当管理员的组织里创建。</div></div>
          <div class="step"><div class="step__title">开权限</div><div class="step__text">收消息、读群消息历史、发消息、传文件。</div></div>
          <div class="step"><div class="step__title">订阅事件</div><div class="step__text">选「长连接」；用回调就填公网地址。</div><div class="step__code">im.message.receive_v1</div></div>
          <div class="step"><div class="step__title">把凭据填回左边</div><div class="step__text">App ID、App Secret、Verification Token，加密再填 Encrypt Key。</div></div>
          <div class="step"><div class="step__title">发布应用</div><div class="step__text">自己审批；发布后机器人才会出现在群里。</div></div>
          <div class="step"><div class="step__title">把机器人拉进群</div><div class="step__text">@ 它说一句话，看「任务」里有没有新票。</div></div>
          <div class="step"><div class="step__title">补白名单</div><div class="step__text">回「受理规则」→「飞书里能下指令的人」加上 open_id。</div></div>
        </div>
      </details>`
  }

  function githubTestHtml() {
    const result = state.githubTest
    if (!result) return ''
    if (result.ok !== true) {
      return `<p class="field__error" style="margin-top:10px">${esc(result.message || '没有连上')}</p>`
    }
    const repos = Array.isArray(result.repos) ? result.repos : []
    return `<div style="margin-top:10px">
      <p class="hint">已连上，账号 <strong>${esc(result.login || '—')}</strong></p>
      <div class="list" style="margin-top:6px;border-top:1px solid var(--line)">
        ${repos.length ? repos.map((repo) => `<div class="row row--flat">
          <span class="row__main"><span class="row__title mono" style="overflow-wrap:anywhere">${esc(repo.fullName)}</span></span>
          <span class="row__side"><span class="tag">${repo.push ? '可推送' : '只读'}</span></span>
        </div>`).join('') : '<p class="hint" style="padding:8px 2px">白名单里还没有仓库。</p>'}
      </div>
    </div>`
  }

  function githubSection() {
    const github = state.draft.github
    const repos = Array.isArray(github.repos) ? github.repos : []
    return `
      <div class="setgrid">
        ${switchRow('enabled', { label: '启用 GitHub', help: '关掉之后 AI 不能用 GitHub 拉代码、推分支、开 PR' })}
        <div class="formrow"><span class="formrow__label">Token</span>
          <input class="input" type="password" value="" data-secret data-focus-key="settings.secret" autocomplete="new-password" placeholder="${github.tokenSet ? '已设置；留空表示不修改' : '尚未设置'}">
          <span class="formrow__help">在 GitHub → Settings → Developer settings → Fine-grained tokens 生成，只勾选需要的仓库，权限给 Contents 读写和 Pull requests 读写</span>
        </div>
        <div class="formrow"><span class="formrow__label">仓库白名单</span>
          <div class="list" style="border-top:0">
            ${repos.length ? repos.map((repo, index) => `<div class="row row--flat">
              <span class="row__main" style="display:flex;gap:8px;flex-wrap:wrap">
                <input class="input mono" style="flex:1 1 160px" value="${esc(repo)}" data-repo-index="${index}" data-focus-key="settings.repos.${index}" placeholder="owner/repo" aria-label="仓库 ${index + 1}">
              </span>
              <button class="btn btn--quiet" type="button" data-remove-repo="${index}">移除</button>
            </div>`).join('') : '<p class="hint" style="padding:10px 2px">还没有仓库；没有白名单时 AI 不能碰任何仓库。</p>'}
          </div>
          <div class="bar-actions" style="margin-top:8px">
            <button class="btn btn--quiet" type="button" data-add-repo>加一个仓库</button>
            <span class="hint" style="align-self:center">最多 50 个，格式 owner/repo</span>
          </div>
        </div>
        ${input('defaultBase', { label: '默认目标分支', placeholder: 'main', help: '开 PR 时默认合到这个分支' })}
        ${input('apiBase', { label: '接口地址', placeholder: 'https://api.github.com', help: '一般不用改；GitHub Enterprise 填自己的地址' })}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="bar-actions">
          <button class="btn" type="button" data-github-test>测试连接</button>
          <span class="hint" style="align-self:center">用已保存的配置连一次</span>
        </div>
        ${githubTestHtml()}
      </div>
      <div class="card" style="margin-top:14px">
        <p class="hint">开启后，AI 干活时可以拉代码、推分支、开 PR；只能碰白名单里的仓库。</p>
      </div>`
  }

  function emailTestHtml() {
    const result = state.emailTest
    if (!result) return ''
    const row = (label, part) => `<div class="row row--flat">
      <span class="row__main"><span class="row__title">${esc(label)}</span>
        <span class="row__meta">${esc(part?.message || (part?.ok ? '正常' : '没有连上'))}</span></span>
      <span class="row__side"><span class="tag">${part?.ok ? '正常' : '失败'}</span></span>
    </div>`
    return `<div style="margin-top:10px">
      ${result.ok !== true && result.message ? `<p class="field__error">${esc(result.message)}</p>` : ''}
      <div class="list" style="margin-top:6px;border-top:1px solid var(--line)">
        ${row('收信（IMAP）', result.imap)}
        ${row('发信（SMTP）', result.smtp)}
      </div>
    </div>`
  }

  function emailSection() {
    const email = state.draft.email
    const senders = Array.isArray(email.allowedSenders) ? email.allowedSenders : []
    return `
      <div class="setgrid">
        ${switchRow('enabled', { label: '启用邮箱', help: '关掉之后不再轮询收件箱' })}
        ${input('address', { label: 'Gmail 地址', placeholder: 'you@gmail.com', help: '用这个邮箱收信和回信' })}
        ${input('displayName', { label: '发件人显示名', placeholder: '例如：超级智能体', help: '回信时对方看到的名字' })}
        <div class="formrow"><span class="formrow__label">应用专用密码</span>
          <input class="input" type="password" value="" data-secret data-focus-key="settings.secret" autocomplete="new-password" placeholder="${email.passwordSet ? '已设置；留空表示不修改' : '尚未设置'}">
          <span class="formrow__help">不是 Gmail 登录密码，是 16 位应用专用密码</span>
        </div>
        <div class="formrow"><span class="formrow__label">允许的发件人</span>
          <div class="list" style="border-top:0">
            ${senders.length ? senders.map((sender, index) => `<div class="row row--flat">
              <span class="row__main" style="display:flex;gap:8px;flex-wrap:wrap">
                <input class="input" style="flex:1 1 180px" value="${esc(sender)}" data-sender-index="${index}" data-focus-key="settings.allowedSenders.${index}" placeholder="name@example.com" aria-label="发件人 ${index + 1}">
              </span>
              <button class="btn btn--quiet" type="button" data-remove-sender="${index}">移除</button>
            </div>`).join('') : '<p class="hint" style="padding:10px 2px">还没有；名单为空时所有来信都会被忽略。</p>'}
          </div>
          <div class="bar-actions" style="margin-top:8px">
            <button class="btn btn--quiet" type="button" data-add-sender>加一个发件人</button>
          </div>
        </div>
        ${input('pollSeconds', { label: '检查间隔（秒）', type: 'number', help: '15–3600；越短越及时，也越费资源' })}
        ${input('maxAttachmentMb', { label: '附件上限（MB）', type: 'number', help: '1–25；超过的附件跳过，并在正文里说明' })}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="bar-actions">
          <button class="btn" type="button" data-email-test>测试连接</button>
          <span class="hint" style="align-self:center">用已保存的配置分别测 IMAP 和 SMTP</span>
        </div>
        ${emailTestHtml()}
        <div class="hint" style="margin-top:10px" data-email-status>读取状态中…</div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card__title">怎么拿到应用专用密码</div>
        <div class="steps" style="margin-top:10px">
          <div class="step"><div class="step__title">开启两步验证</div><div class="step__text">Gmail 账号必须先开两步验证，应用专用密码才会出现。</div></div>
          <div class="step"><div class="step__title">生成 16 位密码</div><div class="step__text">打开 <span class="mono" style="overflow-wrap:anywhere">https://myaccount.google.com/apppasswords</span>，给这台机器生成一个。</div></div>
          <div class="step"><div class="step__title">填到这里保存</div><div class="step__text">粘到上面的「应用专用密码」，然后点保存。</div></div>
          <div class="step"><div class="step__title">在「允许的发件人」里加上你自己</div><div class="step__text">只处理名单里的来信；自己发的信会被跳过。</div></div>
        </div>
      </div>
      <p class="hint" style="margin-top:12px">主机在国内网络时可能连不上 Gmail，测试连接会告诉你。</p>`
  }

  function previewSection() {
    const preview = state.draft.preview ?? {}
    return `<div class="setgrid">
      ${switchRow('enabled', { label: '启用 Web 预览', help: '允许 AI 把容器里的网页发布成一个临时链接；关掉后已有的预览也不再转发' })}
      ${input('portStart', { label: '起始端口', type: 'number', help: '从这一段里给每张任务分配端口，例如 19000' })}
      ${input('portEnd', { label: '结束端口', type: 'number', help: '端口池的上限，例如 19199' })}
      ${input('perTicket', { label: '每张任务分几个端口', type: 'number', help: '一张任务最多同时发布几个预览，默认 2' })}
      ${input('publicBase', { label: '公网地址', placeholder: 'http://175.178.18.140:18081/sa', help: '公网访问后台的地址，例如 http://175.178.18.140:18081/sa，留空则用相对地址' })}
      <p class="hint">预览地址是 <code>公网地址/p/随机串/</code>；任务不在运行时打开会看到「预览已暂停」。</p>
    </div>`
  }

  function accountSection() {
    return `
      <div class="field">
        <span class="field__label">外观</span>
        <div class="seg" role="group" aria-label="外观">
          ${[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, label]) => `<button class="seg__i" type="button" data-pick-theme="${value}" aria-pressed="${(bus.theme?.() ?? 'system') === value}">${label}</button>`).join('')}
        </div>
        <p class="hint">只影响这台浏览器，和「更多 → 外观」是同一个开关。</p>
      </div>
      <div class="setgrid" style="margin-top:16px">
      <div class="formrow"><span class="formrow__label">当前口令</span>
        <input class="input" type="password" data-password="old" value="${esc(state.password.old)}"></div>
      <div class="formrow"><span class="formrow__label">新口令</span>
        <input class="input" type="password" data-password="next" value="${esc(state.password.next)}">
        <span class="formrow__help">至少 10 位；改完所有设备都要重新登录</span></div>
      <div class="formrow"><span class="formrow__label">再输一次</span>
        <input class="input" type="password" data-password="again" value="${esc(state.password.again)}"></div>
      ${state.passwordError ? `<p class="field__error">${esc(state.passwordError)}</p>` : ''}
      <div class="bar-actions"><button class="btn btn--human" type="button" data-save-password>改口令</button></div>
      </div>`
  }

  /* ---------- project & council sections (F5a-2) ---------- */

  const COUNCIL_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
  const blankNewRole = () => ({ open: false, id: '', name: '', persona: '', error: '' })

  function projectsSection() {
    const draft = state.draft.projects ?? {}
    const rows = [
      { key: 'maxUploadMb', label: '单个压缩包最大上传（MB）', help: '一次上传的压缩包不能超过这个大小；允许 1–65536 MB。', conv: formatMb },
      { key: 'maxExtractMb', label: '解压后总大小上限（MB）', help: '压缩包解开以后，全部文件加起来不能超过这个大小；允许 1–1048576 MB。', conv: formatMb },
      { key: 'maxFiles', label: '解压后文件数上限（个）', help: '解开以后的文件个数上限；允许 1–5000000 个。', conv: formatFiles },
    ]
    return `<div class="setgrid">
      ${rows.map((row) => `<label class="formrow">
        <span class="formrow__label">${esc(row.label)}</span>
        <input class="input" type="number" inputmode="numeric" value="${esc(draft[row.key] ?? '')}" data-focus-key="settings.${row.key}" data-path="${row.key}">
        <span class="formrow__help">${esc(row.help)}</span>
        <span class="hint mono" data-conv="${row.key}">${esc(row.conv(draft[row.key]))}</span>
      </label>`).join('')}
      <p class="hint" data-projects-hint style="color:var(--warn)">${esc(projectsHint(draft))}</p>
      <p class="hint">上传时还会检查磁盘剩余空间，要求不少于压缩包的 3 倍。</p>
    </div>`
  }

  function roleHtml(role, index) {
    const id = String(role.id ?? '')
    const name = String(role.name ?? '')
    const persona = String(role.persona ?? '')
    const enabled = role.enabled === true
    return `<details class="disclose council-role" data-keep="settings.council-role-${esc(id || `new-${index}`)}"${state.openRole === id ? ' open' : ''}>
      <summary class="council-role__sum">${seatStampHtml({ roleId: id, name: name || '角色' })}
        <span class="council-role__name">${esc(name || '未命名角色')}</span>
        ${enabled ? '' : '<span class="tag">已停用</span>'}</summary>
      <div class="setgrid" style="margin-top:10px">
        <div class="formrow"><span class="formrow__label">名称（60 字以内）</span>
          <input class="input" value="${esc(name)}" data-focus-key="settings.roles.${index}.name" data-path="roles.${index}.name"></div>
        <div class="formrow"><span class="formrow__label">人设（2000 字以内）</span>
          <textarea class="textarea" style="min-height:120px" data-focus-key="settings.roles.${index}.persona" data-path="roles.${index}.persona">${esc(persona)}</textarea>
          <span class="formrow__help" data-count-for="roles.${index}.persona">已写 ${persona.length} / 2000 字</span></div>
        ${switchRow(`roles.${index}.enabled`, { label: '启用这个角色' })}
        <div class="formrow"><span class="formrow__label">模型</span>
          <select class="select" data-focus-key="settings.roles.${index}.model" data-cref="roles.${index}.model"><option value="">跟随主持人模型</option>${modelOptions(role.model)}</select></div>
        <div class="formrow"><span class="formrow__label">角色 id（建好后不能改）</span>
          <input class="input mono" value="${esc(id)}" readonly></div>
        <div class="bar-actions"><button class="btn btn--quiet" type="button" data-council-delete="${index}">删除角色</button></div>
      </div>
    </details>`
  }

  function newRoleForm() {
    const form = state.newRole
    return `<div class="card" style="margin-top:10px">
      <div class="card__title">新增一个角色</div>
      <div class="setgrid" style="margin-top:10px">
        <div class="formrow"><span class="formrow__label">角色 id</span>
          <input class="input mono" value="${esc(form.id)}" data-newrole="id" data-focus-key="settings.newrole.id" placeholder="例如 reviewer（小写字母、数字、连字符）"></div>
        <div class="formrow"><span class="formrow__label">名称</span>
          <input class="input" value="${esc(form.name)}" data-newrole="name" data-focus-key="settings.newrole.name" placeholder="例如：代码审查"></div>
        <div class="formrow"><span class="formrow__label">人设</span>
          <textarea class="textarea" style="min-height:120px" data-newrole="persona" data-focus-key="settings.newrole.persona">${esc(form.persona)}</textarea></div>
        ${form.error ? `<p class="field__error">${esc(form.error)}</p>` : ''}
        <div class="bar-actions"><button class="btn btn--ink" type="button" data-council-add>加入列表</button><button class="btn btn--quiet" type="button" data-council-cancel-new>收起</button></div>
      </div>
    </div>`
  }

  function councilSection() {
    const council = state.draft.council ?? {}
    const roles = Array.isArray(council.roles) ? council.roles : []
    const enabledCount = roles.filter((role) => role.enabled === true).length
    return `
      <div class="setgrid">
        ${switchRow('enabled', { label: '启用会商', help: '关掉后「发任务」里不再出现会商选项' })}
        ${switchRow('defaultOn', { label: '新任务默认先会商', help: '打开后新建的任务默认先开一场会商' })}
        ${segRow('rounds', [1, 2, 3].map((n) => ({ value: n, label: `${n} 轮`, help: n === 1 ? '每个角色只发言一次' : n === 2 ? '发言后再互相回应一轮' : '多一轮回应，更慢也更贵' })), '会商轮数')}
        ${input('maxCharsPerTurn', { label: '每条发言最多字数', type: 'number', help: '100–2000 字' })}
        <div class="formrow"><span class="formrow__label">主持人模型</span>
          <select class="select" data-focus-key="settings.moderator" data-cref="moderator"><option value="">跟随默认工作模型</option>${modelOptions(council.moderator)}</select>
          <span class="formrow__help">负责把讨论汇总成任务书；不选就用「默认分工」里的执行模型</span></div>
      </div>
      <section class="section">
        <div class="section__head"><h2 class="section__title">会商角色</h2><span class="section__count">${roles.length} 个，启用 ${enabledCount} 个</span>
          <button class="btn btn--quiet" type="button" data-council-new style="margin-left:auto">新增角色</button></div>
        ${state.newRole.open ? newRoleForm() : ''}
        <div class="council-roles">${roles.map((role, index) => roleHtml(role, index)).join('')}</div>
      </section>`
  }

  /** Put the server's (or client's) field-level messages on their inputs and open the role that holds them. */
  function markIssueFields() {
    root.querySelectorAll('[aria-invalid="true"]').forEach((node) => node.removeAttribute('aria-invalid'))
    for (const issue of state.issues) {
      if (!issue?.path) continue
      const node = root.querySelector(`[data-path="${issue.path}"]`)
      if (!node) continue
      node.setAttribute('aria-invalid', 'true')
      const details = node.closest('details')
      if (details) details.open = true
    }
  }

  /** Live hints that must not repaint (a repaint would drop the caret). */
  function liveHints() {
    if (state.tab === 'projects') {
      const draft = state.draft.projects ?? {}
      root.querySelectorAll('[data-conv]').forEach((node) => {
        const key = node.dataset.conv
        node.textContent = key === 'maxFiles' ? formatFiles(draft[key]) : formatMb(draft[key])
      })
      const hint = root.querySelector('[data-projects-hint]')
      if (hint) hint.textContent = projectsHint(draft)
    }
    if (state.tab === 'council') {
      root.querySelectorAll('[data-count-for]').forEach((node) => {
        const length = String(getPath(state.draft.council ?? {}, node.dataset.countFor) ?? '').length
        node.textContent = `已写 ${length} / 2000 字`
      })
    }
  }

  function addCouncilRole() {
    const form = state.newRole
    const id = String(form.id ?? '').trim()
    const name = String(form.name ?? '').trim()
    const persona = String(form.persona ?? '').trim()
    const roles = Array.isArray(state.draft.council?.roles) ? state.draft.council.roles : []
    let error = ''
    if (!COUNCIL_ID_RE.test(id)) error = '角色 id 只能是小写字母、数字和连字符，以字母或数字开头，最多 32 位。'
    else if (roles.some((role) => role.id === id)) error = `角色 id「${id}」已经有了，换一个。`
    else if (!name) error = '请填写角色名称。'
    else if (name.length > 60) error = '角色名称不能超过 60 个字。'
    else if (!persona) error = '请填写人设。'
    else if (persona.length > 2000) error = '人设不能超过 2000 字。'
    else if (roles.length >= 20) error = '最多 20 个角色。'
    if (error) {
      state.newRole.error = error
      paint()
      return
    }
    roles.push({ id, name, persona, enabled: true })
    state.openRole = id
    state.newRole = blankNewRole()
    paint()
    markDirty()
  }

  async function deleteCouncilRole(index) {
    const roles = Array.isArray(state.draft.council?.roles) ? state.draft.council.roles : []
    const role = roles[index]
    if (!role) return
    const remaining = roles.filter((_, at) => at !== index)
    if (remaining.length < 2) {
      bus.toast('只剩一个角色时不能再删，至少留两个。', { danger: true })
      return
    }
    if (!remaining.some((item) => item.enabled === true)) {
      bus.toast('删掉以后没有启用的角色了，先启用另一个角色再删。', { danger: true })
      return
    }
    const answer = await bus.sheet({ title: `删除「${role.name || role.id}」？`, text: '删除后要点保存才真正生效。', confirmLabel: '删除', danger: true })
    if (!answer) return
    roles.splice(index, 1)
    paint()
    markDirty()
  }

  /* ---------- landing focus (?focus=unset) ---------- */

  /** The node that should take focus for one FOCUS_ORDER entry, or null when that field is already filled. */
  function focusTarget(item) {
    const draft = state.draft[state.tab] ?? {}
    if (item.secret) {
      const node = root.querySelector('[data-secret]')
      return node && !draft[item.set] ? node : null
    }
    if (item.repoIndex !== undefined || item.senderIndex !== undefined) {
      const list = item.repoIndex !== undefined ? (draft.repos ?? []) : (draft.allowedSenders ?? [])
      const index = item.repoIndex ?? item.senderIndex
      if (!list.length) return root.querySelector(item.repoIndex !== undefined ? '[data-add-repo]' : '[data-add-sender]')
      if (String(list[index] ?? '').trim() !== '') return null
      return root.querySelector(item.repoIndex !== undefined ? `[data-repo-index="${index}" data-focus-key="settings.repos.${index}"]` : `[data-sender-index="${index}" data-focus-key="settings.allowedSenders.${index}"]`)
    }
    const node = root.querySelector(`[data-path="${item.path}"]`)
    if (!node) return null
    if (item.set) return draft[item.set] ? null : node
    return String(getPath(draft, item.path) ?? '').trim() === '' ? node : null
  }

  /** Runs once per mount, after the first load. Never steals focus from a person or from unsaved edits. */
  function landFocus() {
    const order = FOCUS_ORDER[state.tab]
    if (!order) { window.scrollTo(0, 0); return }
    if (state.dirty.size > 0) return
    const active = document.activeElement
    if (active && active !== document.body && root.contains(active) && active.matches('input, textarea, select')) return
    let target = null
    for (const item of order) {
      target = focusTarget(item)
      if (target) break
    }
    if (!target) { bus.toast('这一项已经设置好了'); return }
    const row = target.closest('.formrow, .row') ?? target.parentElement
    target.scrollIntoView({ block: 'center' })
    target.focus({ preventScroll: true })
    if (row) {
      row.classList.add('is-landed')
      window.setTimeout(() => row.classList.remove('is-landed'), 2000)
    }
  }

  /* ---------- page ---------- */

  /**
   * An internal repaint (a late load, a poll that started before the landing) replaces the whole page. The shell only
   * protects refreshes whose snapshot already had the focus, so the page keeps its own focused field and caret.
   */
  function captureFocus() {
    const active = document.activeElement
    if (!active || active === document.body || !root.contains(active)) return null
    const key = active.dataset?.focusKey
    if (!key) return null
    const saved = { key }
    if (typeof active.selectionStart === 'number') {
      saved.start = active.selectionStart
      saved.end = active.selectionEnd
    }
    return saved
  }

  function restoreFocus(saved) {
    if (!saved) return
    const node = root.querySelector(`[data-focus-key="${saved.key.replace(/"/g, '\\"')}"]`)
    if (!node || node === document.activeElement) return
    node.focus({ preventScroll: true })
    if (typeof saved.start === 'number' && typeof node.setSelectionRange === 'function') {
      try { node.setSelectionRange(saved.start, saved.end) } catch { /* some inputs reject ranges */ }
    }
  }

  function paint() {
    const keptFocus = captureFocus()
    const section = SECTIONS.find((item) => item.key === state.tab) ?? SECTIONS[0]
    const body = state.tab === 'policy' ? policySection()
      : state.tab === 'executor' ? executorSection()
      : state.tab === 'models' ? modelsSection()
      : state.tab === 'budget' ? budgetSection()
      : state.tab === 'feishu' ? feishuSection()
      : state.tab === 'github' ? githubSection()
      : state.tab === 'email' ? emailSection()
      : state.tab === 'preview' ? previewSection()
      : state.tab === 'projects' ? projectsSection()
      : state.tab === 'council' ? councilSection()
      : accountSection()
    const dirtyCount = state.dirty.size
    const loadFailed = (state.tab === 'projects' || state.tab === 'council') && Boolean(state.loadError[state.tab])
    root.innerHTML = `
      <div class="head">
        <div class="head__row"><h1 class="head__title">设置</h1></div>
        <p class="head__sub">${esc(section.hint)} 改完立即生效；受影响的运行中工单会收到一条变更通知。</p>
      </div>
      <nav class="snav" aria-label="设置分区">
        ${SECTIONS.map((item) => `<a class="snav__i" href="#/settings/${item.key}"${item.key === state.tab ? ' aria-current="page"' : ''}>${item.label}</a>`).join('')}
      </nav>
      ${loadFailed ? `<div class="banner" style="margin-top:14px"><span>读不到当前设置：${esc(state.loadError[state.tab])}</span><button class="btn" type="button" data-settings-retry>重试</button></div>` : ''}
      <div class="setgrid" style="margin-top:16px">${loadFailed ? '' : body}</div>
      ${state.issues.length ? `<div class="banner" style="margin-top:14px"><span>${state.issues.map((issue) => esc(issue.message)).join('；')}</span></div>` : ''}
      ${state.tab === 'account' ? '' : `<div class="savebar">
        <span class="savebar__state">${dirtyCount ? `有 ${dirtyCount} 处未保存` : '没有未保存的修改'}</span>
        <button class="btn btn--quiet" type="button" data-reset ${dirtyCount ? '' : 'disabled'}>还原</button>
        <button class="btn btn--human" type="button" data-save ${dirtyCount && !state.saving && !loadFailed ? '' : 'disabled'}>${state.saving ? '保存中…' : '保存'}</button>
      </div>`}`
    markIssueFields()
    restoreFocus(keptFocus)
    if (state.tab === 'feishu') paintStatus()
    if (state.tab === 'email') {
      paintEmailStatus()
      startEmailPolling()
    } else {
      stopEmailPolling()
    }
  }

  function paintEmailStatus() {
    const node = root.querySelector('[data-email-status]')
    if (!node) return
    const status = state.emailStatus
    if (!status) { node.textContent = '读取状态中…'; return }
    const label = { off: '未开启', connecting: '连接中', connected: '已连接', error: '出错' }[status.state] ?? status.state
    const bits = [esc(label)]
    if (status.lastPollAt) bits.push(`上次检查 ${esc(ago(status.lastPollAt))}`)
    if (status.processed != null) bits.push(`已处理 ${esc(status.processed)} 封`)
    node.innerHTML = bits.join(' · ')
      + (status.lastError ? ` · <span style="color:var(--human)">${esc(status.lastError)}</span>` : '')
    node.style.color = status.state === 'error' ? 'var(--human)' : ''
  }

  function paintStatus() {
    const node = root.querySelector('[data-feishu-status]')
    if (!node) return
    const status = state.feishuStatus
    if (!status) { node.textContent = '用已保存的配置连一次'; return }
    const map = { off: '未启用', connecting: '正在连接…', connected: '已连接', error: '连接失败' }
    node.textContent = `${map[status.state] ?? status.state}${status.lastError ? `：${status.lastError}` : ''}`
    node.style.color = status.state === 'error' ? 'var(--human)' : 'var(--ink-3)'
  }

  /* ---------- editing ---------- */

  function markDirty() {
    const draft = state.draft[state.tab]
    const saved = state.saved[state.tab]
    const changed = new Set()
    const walk = (path, a, b) => {
      if (isObject(a) && !Array.isArray(a)) {
        const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
        for (const key of keys) walk(path ? `${path}.${key}` : key, a?.[key], b?.[key])
      } else if (JSON.stringify(a) !== JSON.stringify(b)) changed.add(path || 'value')
    }
    walk('', draft, saved)
    if (state.secret.trim()) changed.add('secret')
    state.dirty = changed
    const label = root.querySelector('.savebar__state')
    if (label) label.textContent = changed.size ? `有 ${changed.size} 处未保存` : '没有未保存的修改'
    const save = root.querySelector('[data-save]')
    if (save) save.disabled = changed.size === 0 || state.saving
    const reset = root.querySelector('[data-reset]')
    if (reset) reset.disabled = changed.size === 0
  }

  function onFieldChange(target) {
    const path = target.dataset.path
    if (!path) return
    let value = target.value
    if (target.type === 'number') value = value === '' ? 0 : Number(value)
    setPath(state.draft[state.tab], path, value)
    markDirty()
  }

  root.addEventListener('input', (event) => {
    if (event.target.matches('[data-newrole]')) {
      state.newRole[event.target.dataset.newrole] = event.target.value
      return
    }
    if (event.target.matches('[data-discover]')) {
      state.discover.form[event.target.dataset.discover] = event.target.value
      return
    }
    if (event.target.dataset.password !== undefined) {
      state.password[event.target.dataset.password] = event.target.value
      return
    }
    if (event.target.matches('[data-secret]')) {
      state.secret = event.target.value
      markDirty()
      return
    }
    if (event.target.matches('[data-repo-index]')) {
      setPath(state.draft.github, `repos.${event.target.dataset.repoIndex}`, event.target.value)
      markDirty()
      return
    }
    if (event.target.matches('[data-sender-index]')) {
      setPath(state.draft.email, `allowedSenders.${event.target.dataset.senderIndex}`, event.target.value)
      markDirty()
      return
    }
    if (event.target.matches('[data-path]')) {
      onFieldChange(event.target)
      liveHints()
    }
  })

  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-cref]')) {
      const target = event.target.dataset.cref
      const value = String(event.target.value ?? '')
      const at = value.indexOf('/')
      const ref = value && at > 0 ? { provider: value.slice(0, at), model: value.slice(at + 1) } : null
      if (target === 'moderator') {
        setPath(state.draft.council, 'moderator', ref)
      } else {
        const index = Number(/^roles\.(\d+)\.model$/.exec(target)?.[1])
        const role = state.draft.council?.roles?.[index]
        if (role) {
          if (ref) role.model = ref
          else delete role.model
        }
      }
      markDirty()
      return
    }
    const ref = event.target.closest('[data-ref]')
    if (ref) {
      const [provider, model] = String(ref.value).split('/')
      if (provider && model) {
        setPath(state.draft.models, ref.dataset.ref, { provider, model })
        markDirty()
      }
      return
    }
    if (event.target.matches('[data-path]')) onFieldChange(event.target)
  })

  root.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-toggle]')
    if (toggle) {
      const path = toggle.dataset.toggle
      const current = getPath(state.draft[state.tab], path) === true
      setPath(state.draft[state.tab], path, !current)
      toggle.setAttribute('aria-checked', String(!current))
      if (/\.(reasoning|vision|autoPick)$/.test(path)) toggle.classList.toggle('btn--ink', !current)
      if (/^roles\.\d+\.enabled$/.test(path)) paint()
      markDirty()
      return
    }
    const themeButton = event.target.closest('[data-pick-theme]')
    if (themeButton) {
      bus.setTheme(themeButton.dataset.pickTheme)
      paint()
      return
    }
    const choice = event.target.closest('[data-choice]')
    if (choice) {
      const raw = choice.dataset.value
      setPath(state.draft[state.tab], choice.dataset.choice, /^\d+$/.test(raw) ? Number(raw) : raw)
      paint()
      markDirty()
      return
    }
    if (event.target.closest('[data-add-rule]')) {
      state.draft.policy.rules.push({ id: '', name: '', enabled: true, instruction: '' })
      paint()
      return
    }
    const removeRule = event.target.closest('[data-remove-rule]')
    if (removeRule) {
      state.draft.policy.rules.splice(Number(removeRule.dataset.removeRule), 1)
      paint()
      markDirty()
      return
    }
    const addOperator = event.target.closest('[data-add-operator]')
    if (addOperator) {
      state.draft.policy[addOperator.dataset.addOperator].push({ id: '', name: '' })
      paint()
      markDirty()
      return
    }
    const removeOperator = event.target.closest('[data-remove-operator]')
    if (removeOperator) {
      const [list, index] = removeOperator.dataset.removeOperator.split(':')
      state.draft.policy[list].splice(Number(index), 1)
      paint()
      markDirty()
      return
    }
    if (event.target.closest('[data-add-provider]')) {
      state.draft.models.providers.push({
        id: `provider-${state.draft.models.providers.length + 1}`,
        name: '新服务商', api: 'openai-completions', baseUrl: 'https://', apiKey: '', apiKeySet: false, apiKeyTail: '',
        sessionHeader: '', enabled: true,
        models: [{ id: '', label: '', description: '', reasoning: false, vision: false, contextWindow: 1000000, maxTokens: 131072, autoPick: true, price: { input: 0, cacheRead: 0, output: 0 } }],
      })
      paint()
      markDirty()
      return
    }
    const removeProvider = event.target.closest('[data-remove-provider]')
    if (removeProvider) {
      const providers = state.draft.models.providers
      if (providers.length <= 1) { bus.toast('至少留一个服务商', { danger: true }); return }
      providers.splice(Number(removeProvider.dataset.removeProvider), 1)
      paint()
      markDirty()
      return
    }
    const addModel = event.target.closest('[data-add-model]')
    if (addModel) {
      state.draft.models.providers[Number(addModel.dataset.addModel)].models.push({
        id: '', label: '', description: '', reasoning: false, vision: false,
        contextWindow: 1000000, maxTokens: 131072, autoPick: true, price: { input: 0, cacheRead: 0, output: 0 },
      })
      paint()
      markDirty()
      return
    }
    const removeModel = event.target.closest('[data-remove-model]')
    if (removeModel) {
      const [providerIndex, modelIndex] = removeModel.dataset.removeModel.split(':').map(Number)
      const provider = state.draft.models.providers[providerIndex]
      if (provider.models.length <= 1) { bus.toast('每个服务商至少留一个模型', { danger: true }); return }
      provider.models.splice(modelIndex, 1)
      paint()
      markDirty()
      return
    }
    const testProvider = event.target.closest('[data-test-provider]')
    if (testProvider) {
      const provider = state.draft.models.providers[Number(testProvider.dataset.testProvider)]
      const model = provider?.models?.[0]
      if (!provider || !model?.id) { bus.toast('这个服务商还没有模型', { danger: true }); return }
      testProvider.disabled = true
      try {
        const result = await post('api/settings/models/test', { provider: provider.id, model: model.id })
        bus.toast(result?.ok ? `连接正常：${result.latencyMs ?? 0} ms` : `没连上：${result?.message ?? '未知原因'}`, { danger: !result?.ok })
      } catch (error) {
        bus.toast(error?.message || '测试失败', { danger: true })
      } finally {
        testProvider.disabled = false
      }
      return
    }
    if (event.target.closest('[data-open-discover]')) {
      state.discover.open = true
      const first = state.draft.models.providers[0]
      if (first) {
        state.discover.form.baseUrl = first.baseUrl
        state.discover.form.api = first.api
        state.discover.form.sessionHeader = first.sessionHeader ?? ''
      }
      paint()
      return
    }
    if (event.target.closest('[data-close-discover]')) { state.discover.open = false; paint(); return }
    if (event.target.closest('[data-do-discover]')) {
      state.discover.busy = true
      paint()
      try {
        state.discover.result = await post('api/settings/models/discover', {
          api: state.discover.form.api,
          baseUrl: state.discover.form.baseUrl,
          ...(state.discover.form.apiKey ? { apiKey: state.discover.form.apiKey } : {}),
          ...(state.discover.form.sessionHeader ? { sessionHeader: state.discover.form.sessionHeader } : {}),
        })
      } catch (error) {
        state.discover.result = { ok: false, message: error?.message || '拉取失败', models: [] }
      } finally {
        state.discover.busy = false
        paint()
      }
      return
    }
    const addDiscovered = event.target.closest('[data-add-discovered]')
    if (addDiscovered && state.discover.result?.models) {
      const model = state.discover.result.models.find((item) => item.id === addDiscovered.dataset.addDiscovered)
      const provider = state.draft.models.providers.find((item) => item.baseUrl === state.discover.form.baseUrl) ?? state.draft.models.providers[0]
      if (model && provider) {
        provider.models.push({
          id: model.id,
          label: model.label ?? model.id,
          description: '',
          reasoning: model.reasoning === true,
          vision: model.vision === true,
          contextWindow: model.contextWindow ?? 1000000,
          maxTokens: model.maxTokens ?? 131072,
          autoPick: true,
          price: { input: 0, cacheRead: 0, output: 0 },
        })
        bus.toast(`已加入 ${model.id}，记得保存`)
        paint()
        markDirty()
      }
      return
    }
    if (event.target.closest('[data-feishu-test]')) {
      try {
        const result = await post('api/settings/feishu/test', {})
        bus.toast(result?.ok ? `连接正常${result.botName ? `：${result.botName}` : ''}` : `没连上：${result?.message ?? '未知原因'}`, { danger: !result?.ok })
        loadFeishuStatus()
      } catch (error) {
        bus.toast(error?.message || '测试失败', { danger: true })
      }
      return
    }
    if (event.target.closest('[data-add-repo]')) {
      state.draft.github.repos.push('')
      paint()
      markDirty()
      return
    }
    const removeRepo = event.target.closest('[data-remove-repo]')
    if (removeRepo) {
      state.draft.github.repos.splice(Number(removeRepo.dataset.removeRepo), 1)
      paint()
      markDirty()
      return
    }
    if (event.target.closest('[data-add-sender]')) {
      state.draft.email.allowedSenders.push('')
      paint()
      markDirty()
      return
    }
    const removeSender = event.target.closest('[data-remove-sender]')
    if (removeSender) {
      state.draft.email.allowedSenders.splice(Number(removeSender.dataset.removeSender), 1)
      paint()
      markDirty()
      return
    }
    if (event.target.closest('[data-github-test]')) {
      if (state.dirty.size > 0) { bus.toast('先保存，再测试连接', { danger: true }); return }
      const button = event.target.closest('[data-github-test]')
      button.disabled = true
      try {
        state.githubTest = await post('api/settings/github/test', {})
      } catch (error) {
        state.githubTest = { ok: false, message: error?.message || '测试失败' }
      } finally {
        button.disabled = false
        paint()
      }
      return
    }
    if (event.target.closest('[data-email-test]')) {
      if (state.dirty.size > 0) { bus.toast('先保存，再测试连接', { danger: true }); return }
      const button = event.target.closest('[data-email-test]')
      button.disabled = true
      try {
        state.emailTest = await post('api/settings/email/test', {})
      } catch (error) {
        state.emailTest = { ok: false, message: error?.message || '测试失败', imap: { ok: false, message: '' }, smtp: { ok: false, message: '' } }
      } finally {
        button.disabled = false
        paint()
        refreshEmailStatus()
      }
      return
    }
    if (event.target.closest('[data-save-password]')) {
      const { old, next, again } = state.password
      if (!old || !next) { state.passwordError = '当前口令和新口令都要填。'; paint(); return }
      if (next !== again) { state.passwordError = '两次输入的新口令不一样。'; paint(); return }
      try {
        await post('api/password', { old, new: next })
        state.password = { old: '', next: '', again: '' }
        state.passwordError = ''
        bus.toast('口令已更新，其它设备已退出')
        paint()
      } catch (error) {
        state.passwordError = error?.message || '改口令失败'
        paint()
      }
      return
    }
    if (event.target.closest('[data-reset]')) {
      state.draft = clone(state.saved)
      state.secret = ''
      state.dirty.clear()
      paint()
      return
    }
    if (event.target.closest('[data-settings-retry]')) {
      if (state.dirty.size > 0) { bus.toast('先保存或还原其它修改，再重试', { danger: true }); return }
      state.loadError = {}
      await load()
      return
    }
    if (event.target.closest('[data-council-new]')) { state.newRole = { ...blankNewRole(), open: true }; paint(); return }
    if (event.target.closest('[data-council-cancel-new]')) { state.newRole = blankNewRole(); paint(); return }
    if (event.target.closest('[data-council-add]')) { addCouncilRole(); return }
    const councilDelete = event.target.closest('[data-council-delete]')
    if (councilDelete) { await deleteCouncilRole(Number(councilDelete.dataset.councilDelete)); return }
    if (event.target.closest('[data-save]')) await save()
  })

  async function save() {
    if (state.tab === 'account') return
    const preIssues = state.tab === 'github' ? validateGithub(state.draft.github)
      : state.tab === 'email' ? validateEmail(state.draft.email)
      : state.tab === 'projects' ? validateProjects(state.draft.projects ?? {})
      : state.tab === 'council' ? validateCouncil(state.draft.council ?? {})
      : []
    if (preIssues.length) {
      state.issues = preIssues
      paint()
      return
    }
    state.saving = true
    state.issues = []
    const label = root.querySelector('[data-save]')
    if (label) { label.disabled = true; label.textContent = '保存中…' }
    try {
      const draft = clone(state.draft[state.tab])
      if (state.tab === 'policy') {
        // `paused` lives on the system page; keep whatever the daemon already had.
        draft.paused = state.saved.policy.paused
        draft.evalTimeoutSeconds = Number(draft.evalTimeoutSeconds) || 60
      }
      if (state.tab === 'executor') {
        draft.maxWorkers = Number(draft.maxWorkers) || 1
      }
      if (state.tab === 'models') {
        draft.providers = draft.providers.map((provider) => {
          const next = { ...provider }
          if (!next.apiKey) delete next.apiKey
          next.models = next.models.map((model) => ({
            id: model.id,
            label: model.label ?? '',
            description: model.description ?? '',
            reasoning: model.reasoning === true,
            vision: model.vision === true,
            contextWindow: Number(model.contextWindow) || 1000000,
            maxTokens: Number(model.maxTokens) || 131072,
            autoPick: model.autoPick !== false,
            price: {
              input: Number(model.price?.input ?? 0),
              cacheRead: Number(model.price?.cacheRead ?? 0),
              output: Number(model.price?.output ?? 0),
            },
          }))
          return next
        })
      }
      if (state.tab === 'feishu') {
        for (const key of ['appSecret', 'verificationToken', 'encryptKey']) {
          if (!draft[key]) delete draft[key]
        }
      }
      if (state.tab === 'budget') {
        draft.perTicketUsd = Number(draft.perTicketUsd) || 0
        draft.dailyUsd = Number(draft.dailyUsd) || 0
      }
      if (state.tab === 'preview') {
        // Only the five editable fields go back; anything else the daemon
        // returned (counters, resolved URLs) is read-only.
        const clean = {
          enabled: draft.enabled === true,
          portStart: Number(draft.portStart) || 19000,
          portEnd: Number(draft.portEnd) || 19199,
          perTicket: Number(draft.perTicket) || 2,
          publicBase: String(draft.publicBase ?? '').trim(),
        }
        state.draft.preview = clean
        for (const key of Object.keys(draft)) delete draft[key]
        Object.assign(draft, clean)
      }

      let payload = draft
      let typedSecret = false
      if (state.tab === 'github') {
        typedSecret = Boolean(state.secret.trim())
        payload = {
          enabled: draft.enabled === true,
          repos: (draft.repos ?? []).map((repo) => String(repo ?? '').trim()).filter(Boolean),
          defaultBase: String(draft.defaultBase ?? '').trim() || 'main',
          apiBase: String(draft.apiBase ?? '').trim() || 'https://api.github.com',
        }
        if (typedSecret) payload.token = state.secret.trim()
      }
      if (state.tab === 'email') {
        typedSecret = Boolean(state.secret.trim())
        payload = {
          enabled: draft.enabled === true,
          address: String(draft.address ?? '').trim(),
          displayName: String(draft.displayName ?? '').trim(),
          allowedSenders: (draft.allowedSenders ?? []).map((sender) => String(sender ?? '').trim()).filter(Boolean),
          pollSeconds: Number(draft.pollSeconds),
          maxAttachmentMb: Number(draft.maxAttachmentMb),
        }
        if (typedSecret) payload.password = state.secret.trim()
      }

      if (state.tab === 'projects') {
        payload = {
          maxUploadMb: Number(draft.maxUploadMb),
          maxExtractMb: Number(draft.maxExtractMb),
          maxFiles: Number(draft.maxFiles),
        }
      }
      if (state.tab === 'council') payload = councilPayload(state.draft.council)

      const result = await put(`api/settings/${state.tab}`, payload)
      if (state.tab === 'github') {
        if (typedSecret) state.draft.github.tokenSet = true
        state.draft.github.repos = payload.repos
        state.draft.github.defaultBase = payload.defaultBase
        state.draft.github.apiBase = payload.apiBase
      }
      if (state.tab === 'email') {
        if (typedSecret) state.draft.email.passwordSet = true
        state.draft.email.address = payload.address
        state.draft.email.displayName = payload.displayName
        state.draft.email.allowedSenders = payload.allowedSenders
        state.draft.email.pollSeconds = payload.pollSeconds
        state.draft.email.maxAttachmentMb = payload.maxAttachmentMb
      }
      if (state.tab === 'github' || state.tab === 'email') state.secret = ''
      state.saved[state.tab] = clone(state.draft[state.tab])
      state.dirty.clear()
      invalidateOverview()
      await bus.refreshOverview()
      bus.toast(result?.note || '已保存')
      paint()
      if (state.tab === 'feishu') loadFeishuStatus()
      if (state.tab === 'email') refreshEmailStatus()
    } catch (error) {
      state.issues = Array.isArray(error?.issues) ? error.issues : [{ path: '', message: error?.message || '保存失败' }]
      paint()
    } finally {
      state.saving = false
      const button = root.querySelector('[data-save]')
      if (button) { button.disabled = state.dirty.size === 0; button.textContent = '保存' }
    }
  }

  load()
  return {
    root,
    refresh: async () => {
      if (state.dirty.size > 0) return
      await load()
    },
    destroy() {
      alive = false
      stopEmailPolling()
    },
  }
}
