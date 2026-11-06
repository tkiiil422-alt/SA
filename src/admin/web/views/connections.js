/**
 * 连接：飞书 / GitHub / 邮箱 / 密钥库 / 网页预览，一处看状态并去绑定。
 *
 * 每个接口独立 catch：一个接口失败只让那一行显示「读不到状态」，其它行照常。
 *
 * 状态判定规则（与 mock 的默认数据一致）：
 *   飞书    status.state=error                    -> 出错：<lastError>
 *           没有 appId / appSecretSet 都为假        -> 未配置
 *           已配置但 enabled=false                 -> 已配置但没开
 *           status.state=connected                 -> 已连接
 *           status.state=connecting                -> 正在连接
 *           其它                                    -> 已配置
 *   GitHub  tokenSet=false                           -> 未配置
 *           tokenSet=true && enabled=true            -> 已连接
 *           tokenSet=true && enabled=false           -> 已配置但没开
 *   邮箱    status.state=error                       -> 出错：<lastError>
 *           没有 address 或 passwordSet=false        -> 未配置
 *           已配置但 enabled=false                   -> 已配置但没开
 *           status.state=connected                   -> 已连接
 *           其它                                      -> 正在连接
 *   密钥库  items.length>0                            -> 已配置（N 个）
 *           0 个                                     -> 未配置
 *   预览    enabled=true                              -> 已开启
 *           enabled=false                            -> 已配置但没开
 *   接口读不到                                         -> 读不到状态
 */
import { get } from '../lib/api.js'

const ROWS = [
  {
    key: 'feishu',
    name: '飞书',
    desc: '让 AI 在飞书群里接消息、回结果',
    section: 'feishu',
  },
  {
    key: 'github',
    name: 'GitHub',
    desc: '让 AI 能推分支、开 PR',
    section: 'github',
  },
  {
    key: 'email',
    name: '邮箱',
    desc: '让 AI 能读信、发周报',
    section: 'email',
  },
  {
    key: 'secrets',
    name: '密钥库',
    desc: '加密保存的 API Key，决定任务能用哪些服务',
    href: '#/secrets',
  },
  {
    key: 'preview',
    name: '网页预览',
    desc: '把 AI 做好的网页临时开放到指定端口',
    section: 'preview',
  },
]

const READ_FAILED = { tone: 'unknown', word: '读不到状态', detail: '' }

function settle(promise) {
  return promise.then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error }))
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function feishuStatus(settings, status) {
  if (!settings.ok || !status.ok) return { ...READ_FAILED, configured: false, tone: 'unknown' }
  const config = settings.value ?? {}
  const live = status.value ?? {}
  const configured = Boolean(text(config.appId)) || config.appSecretSet === true
  if (live.state === 'error') {
    return { tone: 'error', word: '出错', detail: text(live.lastError) || '连接失败', configured }
  }
  if (!configured) return { tone: 'off', word: '未配置', detail: '', configured: false }
  if (config.enabled !== true) return { tone: 'warn', word: '已配置但没开', detail: '', configured: true }
  if (live.state === 'connected') return { tone: 'ok', word: '已连接', detail: '', configured: true }
  if (live.state === 'connecting') return { tone: 'warn', word: '正在连接', detail: '', configured: true }
  return { tone: 'warn', word: '已配置', detail: '', configured: true }
}

function githubStatus(result) {
  if (!result.ok) return { ...READ_FAILED, configured: false, tone: 'unknown' }
  const config = result.value ?? {}
  const configured = config.tokenSet === true
  if (!configured) return { tone: 'off', word: '未配置', detail: '还没填访问令牌', configured: false }
  if (config.enabled === true) return { tone: 'ok', word: '已连接', detail: '', configured: true }
  return { tone: 'warn', word: '已配置但没开', detail: '', configured: true }
}

function emailStatus(settings, status) {
  if (!settings.ok || !status.ok) return { ...READ_FAILED, configured: false, tone: 'unknown' }
  const config = settings.value ?? {}
  const live = status.value ?? {}
  const configured = Boolean(text(config.address)) && config.passwordSet === true
  if (live.state === 'error') {
    return { tone: 'error', word: '出错', detail: text(live.lastError) || '收信失败', configured }
  }
  if (!configured) return { tone: 'off', word: '未配置', detail: '', configured: false }
  if (config.enabled !== true) return { tone: 'warn', word: '已配置但没开', detail: '', configured: true }
  if (live.state === 'connected') return { tone: 'ok', word: '已连接', detail: '', configured: true }
  return { tone: 'warn', word: '正在连接', detail: '', configured: true }
}

function secretsStatus(result) {
  if (!result.ok) return { ...READ_FAILED, configured: false, tone: 'unknown', count: 0 }
  const items = Array.isArray(result.value?.items) ? result.value.items : []
  if (!items.length) return { tone: 'off', word: '未配置', detail: '', configured: false, count: 0 }
  return { tone: 'ok', word: '已配置', detail: `${items.length} 个`, configured: true, count: items.length }
}

function previewStatus(result) {
  if (!result.ok) return { ...READ_FAILED, configured: false, tone: 'unknown' }
  const config = result.value ?? {}
  if (config.enabled === true) return { tone: 'ok', word: '已开启', detail: '', configured: true }
  return { tone: 'warn', word: '已配置但没开', detail: '', configured: true }
}

function actionFor(row, status) {
  if (row.key === 'secrets') {
    return { label: status.count > 0 ? '去管理' : '去添加', href: '#/secrets' }
  }
  if (status.tone === 'unknown') {
    return { label: '去管理', href: `#/settings/${row.section}` }
  }
  if (status.configured) return { label: '去管理', href: `#/settings/${row.section}` }
  return { label: '去绑定', href: `#/settings/${row.section}?focus=unset` }
}

function statusHtml(status) {
  return `<span class="conn-status" data-status data-s="${status.tone}">
    <span class="conn-status__shape" aria-hidden="true"></span>
    <span class="conn-status__word">${escape(status.word)}</span>
    ${status.detail ? `<span class="conn-status__detail">${escape(status.detail)}</span>` : ''}
  </span>`
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function rowHtml(row, status) {
  const action = actionFor(row, status)
  return `<li class="conn-row" data-row="${row.key}">
    <div class="conn-row__text">
      <span class="conn-row__name">${escape(row.name)}</span>
      <span class="conn-row__desc">${escape(row.desc)}</span>
    </div>
    <div class="conn-row__side">
      ${statusHtml(status)}
      <a class="btn conn-row__action" data-action href="${escape(action.href)}">${escape(action.label)}</a>
    </div>
  </li>`
}

export function mount() {
  const root = document.createElement('div')
  root.className = 'page connections-page'

  const state = {
    alive: true,
    loaded: false,
    loading: false,
    statuses: {},
  }

  async function collect() {
    const [feishuSettings, feishuLive, github, emailSettings, emailLive, secrets, preview] = await Promise.all([
      settle(get('api/settings/feishu')),
      settle(get('api/settings/feishu/status')),
      settle(get('api/settings/github')),
      settle(get('api/settings/email')),
      settle(get('api/settings/email/status')),
      settle(get('api/secrets')),
      settle(get('api/settings/preview')),
    ])
    const statuses = {
      feishu: feishuStatus(feishuSettings, feishuLive),
      github: githubStatus(github),
      email: emailStatus(emailSettings, emailLive),
      secrets: secretsStatus(secrets),
      preview: previewStatus(preview),
    }
    return statuses
  }

  function hintHidden() {
    // 建议顺序只在 GitHub 和邮箱都还没绑时出现；飞书是可选的。
    return !(state.statuses.github?.configured === false && state.statuses.email?.configured === false)
  }

  function paint() {
    const rows = ROWS.map((row) => rowHtml(row, state.statuses[row.key] ?? { ...READ_FAILED, configured: false, tone: 'unknown' })).join('')
    root.innerHTML = `
      <div class="head">
        <div class="head__row"><h1 class="head__title">连接</h1></div>
        <p class="head__sub">这里集中管理 AI 能用的外部账号。</p>
      </div>
      <p class="conn-intro">绑定后，AI 才知道能用哪些服务；没绑的它不会碰。</p>
      <ul class="conn-list">${rows}</ul>
      <p class="conn-hint" data-hint${hintHidden() ? ' hidden' : ''}>建议先绑 GitHub（让 AI 能推分支、开 PR），再绑邮箱（让它能读信、发周报）。</p>
      <p class="conn-foot">每 3 秒自动更新状态；改完设置回到这里就能看到。</p>`
  }

  function patch() {
    for (const row of ROWS) {
      const host = root.querySelector(`[data-row="${row.key}"]`)
      if (!host) continue
      const status = state.statuses[row.key]
      if (!status) continue
      const slot = host.querySelector('[data-status]')
      if (slot) slot.outerHTML = statusHtml(status)
      const action = actionFor(row, status)
      const button = host.querySelector('[data-action]')
      if (button) {
        button.setAttribute('href', action.href)
        button.textContent = action.label
      }
    }
    const hint = root.querySelector('[data-hint]')
    if (hint) hint.hidden = hintHidden()
  }

  async function load({ silent = false } = {}) {
    if (state.loading) return
    state.loading = true
    try {
      if (!silent && !state.loaded) {
        state.statuses = {}
        paint()
      }
      const statuses = await collect()
      if (!state.alive) return
      state.statuses = statuses
      state.loaded = true
      if (state.loaded) patch()
    } finally {
      state.loading = false
    }
  }

  paint()
  load()

  return {
    root,
    refresh: async () => {
      // Silent refresh updates words and links in place; no skeleton, no flash.
      await load({ silent: true })
    },
    destroy() {
      state.alive = false
    },
  }
}
