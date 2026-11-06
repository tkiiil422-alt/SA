/**
 * The shell: routing, login, polling, badges, the compose dialog, and the two
 * transient surfaces (toast and confirmation sheet). Views get `mount(ctx)` and
 * own their content; the shell owns everything that must survive a repaint.
 */
import { get, post, me as fetchMe, login as apiLogin, logout as apiLogout, loadOverview, invalidateOverview, setUnauthorizedHandler } from './lib/api.js'
import { bus } from './lib/bus.js'
import { esc, money2, ago } from './lib/view.js'
import * as keep from './lib/keep.js'
import * as todayView from './views/today.js'
import * as ticketsView from './views/tickets.js'
import * as ticketView from './views/ticket.js'
import * as newView from './views/new.js'
import * as usageView from './views/usage.js'
import * as decisionsView from './views/decisions.js'
import * as eventsView from './views/events.js'
import * as moreView from './views/more.js'
import * as settingsView from './views/settings.js'
import * as secretsView from './views/secrets.js'
import * as systemView from './views/system.js'
import * as projectsView from './views/projects.js'
import * as projectView from './views/project.js'
import * as councilView from './views/council.js'
import * as readerView from './views/reader.js'
import * as connectionsView from './views/connections.js'

const query = new URLSearchParams(location.search)
const mockMode = query.get('mock') === '1'
// No top-level await (Safari before 15 cannot parse it): the mock installs first, and the boot at the bottom waits for it.
const mockReady = mockMode
  ? import('./mock.js').then(({ installMock }) => installMock(query))
  : Promise.resolve()

/** `MediaQueryList.addEventListener` is missing before Safari 14; fall back to the old `addListener`. */
function onMediaChange(list, handler) {
  if (typeof list.addEventListener === 'function') list.addEventListener('change', handler)
  else if (typeof list.addListener === 'function') list.addListener(handler)
}

/* ---------- theme ---------- */

const THEME_KEY = 'sa-theme'
const THEME_COLOR = { light: '#e8ebeb', dark: '#0b100e' }
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

let themeMode = readTheme()

function applyTheme(mode) {
  const resolved = mode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : mode
  const root = document.documentElement
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved])
}

applyTheme(themeMode)
onMediaChange(darkQuery, () => {
  if (themeMode === 'system') applyTheme('system')
})

const VIEWS = {
  today: todayView,
  tickets: ticketsView,
  ticket: ticketView,
  new: newView,
  usage: usageView,
  decisions: decisionsView,
  events: eventsView,
  more: moreView,
  settings: settingsView,
  secrets: secretsView,
  system: systemView,
  projects: projectsView,
  project: projectView,
  council: councilView,
  reader: readerView,
  connections: connectionsView,
}

const TITLES = {
  today: '今日', tickets: '任务', ticket: '任务详情', new: '发任务',
  usage: '花费', decisions: '判断记录', events: '事件', more: '更多',
  settings: '设置', secrets: '密钥', system: '系统',
  projects: '项目', project: '项目详情', council: '会商', reader: '文档', connections: '连接',
}

const TABS = [
  { key: 'today', label: '今日', href: '#/today', badge: true,
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/></svg>' },
  { key: 'tickets', label: '任务', href: '#/tickets',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="5" rx="1.5"/><rect x="4" y="14" width="16" height="5" rx="1.5"/></svg>' },
  { key: 'new', label: '发任务', href: '#/new', isNew: true,
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' },
  { key: 'projects', label: '项目', href: '#/projects',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h6l2 2h8v9H4z"/></svg>' },
  { key: 'more', label: '更多', href: '#/more',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>' },
]

const RAIL_GROUPS = [
  {
    title: '工作',
    items: [
      { key: 'today', label: '今日', href: '#/today', badge: true },
      { key: 'tickets', label: '任务', href: '#/tickets' },
      { key: 'projects', label: '项目', href: '#/projects' },
    ],
  },
  {
    title: '资源',
    items: [
      { key: 'connections', label: '连接', href: '#/connections' },
      { key: 'secrets', label: '密钥', href: '#/secrets' },
      { key: 'usage', label: '花费', href: '#/usage' },
    ],
  },
  {
    title: '记录',
    items: [
      { key: 'decisions', label: '判断记录', href: '#/decisions' },
      { key: 'events', label: '事件', href: '#/events' },
    ],
  },
  {
    title: '管理',
    items: [
      { key: 'settings', label: '设置', href: '#/settings/policy' },
      { key: 'system', label: '系统', href: '#/system' },
    ],
  },
]

const THEME_CHOICES = [
  { value: 'system', label: '自动' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const shell = document.getElementById('shell')
const stage = document.getElementById('stage')
const tabsHost = document.getElementById('tabs')
const railNav = document.getElementById('rail-nav')
const railTheme = document.getElementById('rail-theme')
const asideHost = document.getElementById('aside')
const bannerHost = document.getElementById('banner-host')
const barTitle = document.getElementById('bar-title')
const lamp = document.getElementById('lamp')
const railLamp = document.getElementById('rail-lamp')
const loginLayer = document.getElementById('login-layer')
const loginForm = document.getElementById('login-form')
const loginPassword = document.getElementById('login-password')
const loginError = document.getElementById('login-error')
const loginSubmit = document.getElementById('login-submit')
const loginMockHint = document.getElementById('login-mock-hint')
const loginHttpWarning = document.getElementById('login-http-warning')
const toastHost = document.getElementById('toast-host')
const sheetHost = document.getElementById('sheet-host')
const announcer = document.getElementById('route-announcer')
const composeHost = document.getElementById('compose-host')
const composeFab = document.getElementById('compose-fab')
const uploadChip = document.getElementById('upload-chip')

const session = { me: null, overview: null, started: false }
const splitQuery = window.matchMedia('(min-width: 1200px)')
const splitMode = () => splitQuery.matches
let current = null
let mountedSplit = false
let currentRoute = null
let pollTimer = null
let toastTimer = null
let overviewError = null
let unwatchKeep = null
let lastNonComposeHash = '#/today'
let composeState = null

/* ---------- routing ---------- */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '')
  const [beforeFragment, fragment = ''] = raw.split('#')
  const [pathPart, queryPart = ''] = beforeFragment.split('?')
  let parts = []
  try {
    parts = pathPart.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  } catch {
    parts = []
  }
  const parsedQuery = {}
  if (queryPart) {
    try {
      for (const [key, value] of new URLSearchParams(queryPart)) parsedQuery[key] = value
    } catch { /* malformed query: keep it empty */ }
  }
  const [first, second, third] = parts
  const base = (extra) => ({ params: {}, base: extra ?? first, query: parsedQuery, fragment })

  if (!first || first === 'overview') return { key: 'today', ...base('today') }
  if (first === 'tickets' && second) return { key: 'ticket', params: { id: second }, base: 'tickets', query: parsedQuery, fragment }
  if (first === 'events' && second) return { key: 'events', params: { ticketId: second }, base: 'events', query: parsedQuery, fragment }
  if (first === 'tickets') return { key: 'tickets', ...base('tickets') }
  if (first === 'projects' && second) return { key: 'project', params: { id: second }, base: 'projects', query: parsedQuery, fragment }
  if (first === 'projects') return { key: 'projects', ...base('projects') }
  if (first === 'council' && second) return { key: 'council', params: { id: second }, base: 'tickets', query: parsedQuery, fragment }
  if (first === 'doc' && second && third) {
    const readerBase = second === 'project' ? 'projects' : 'tickets'
    return { key: 'reader', params: { kind: second, id: third }, base: readerBase, query: parsedQuery, fragment }
  }
  if (first === 'settings') {
    const tab = second === 'upstream' ? 'models' : (second ?? 'policy')
    const known = ['policy', 'executor', 'models', 'budget', 'feishu', 'github', 'email', 'preview', 'projects', 'council', 'account']
    return { key: 'settings', params: { tab: known.includes(tab) ? tab : 'policy' }, base: 'settings', query: parsedQuery, fragment }
  }
  if (['today', 'new', 'usage', 'decisions', 'events', 'more', 'secrets', 'system', 'connections'].includes(first)) {
    return { key: first, ...base(first) }
  }
  return { key: 'today', ...base('today') }
}

function navigate(path) {
  const clean = String(path).replace(/^#?\/?/, '')
  const target = `#/${clean}`
  if (location.hash === target) {
    renderRoute()
    return
  }
  location.hash = target
}

/* ---------- transient UI ---------- */

function toast(text, action) {
  toastHost.innerHTML = `
    <div class="toast${action?.danger ? ' toast--danger' : ''}">
      <span class="toast__text">${esc(text)}</span>
      ${action ? `<button class="toast__undo" type="button" data-toast-action>${esc(action.label)}</button>` : ''}
    </div>`
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastHost.innerHTML = '' }, action ? 6000 : 4000)
  const button = toastHost.querySelector('[data-toast-action]')
  if (button) {
    button.addEventListener('click', () => {
      toastHost.innerHTML = ''
      action.run()
    }, { once: true })
  }
}

/**
 * A confirmation sheet. Resolves with `{ [fieldId]: value }` (an empty object
 * when there is no field) or null when dismissed.
 */
function sheet({ title, text = '', confirmLabel = '确定', cancelLabel = '再想想', danger = false, field }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      sheetHost.hidden = true
      sheetHost.innerHTML = ''
      document.removeEventListener('keydown', onKey, true)
      resolve(value)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); finish(null) }
    }
    document.addEventListener('keydown', onKey, true)
    sheetHost.hidden = false
    sheetHost.innerHTML = `
      <div class="sheet__backdrop" data-sheet-cancel></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <h2 class="sheet__title" id="sheet-title">${esc(title)}</h2>
        ${text ? `<p class="sheet__text">${esc(text)}</p>` : ''}
        ${field ? `<div class="field" style="margin-top:12px">
          <label class="field__label" for="sheet-field">${esc(field.label)}</label>
          <input class="input" id="sheet-field" type="text" placeholder="${esc(field.placeholder ?? '')}">
        </div>` : ''}
        <div class="sheet__actions">
          <button class="btn" type="button" data-sheet-cancel>${esc(cancelLabel)}</button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--human'}" type="button" data-sheet-confirm>${esc(confirmLabel)}</button>
        </div>
      </div>`
    const input = sheetHost.querySelector('#sheet-field')
    sheetHost.querySelector('[data-sheet-cancel]').addEventListener('click', () => finish(null))
    sheetHost.querySelector('[data-sheet-cancel]:not(.sheet__backdrop)')?.focus?.()
    sheetHost.querySelector('[data-sheet-confirm]').addEventListener('click', () => {
      finish(field ? { [field.id ?? 'value']: input?.value?.trim() ?? '' } : {})
    })
    sheetHost.querySelector('.sheet__backdrop').addEventListener('click', () => finish(null))
  })
}

bus.toast = toast
bus.sheet = sheet
bus.navigate = navigate
bus.reload = async () => {
  // Snapshot -> await refresh -> restore, so a view can reload its data without
  // losing expanded sections, scroll or focus.
  await refreshCurrent()
}
bus.refreshOverview = () => refreshOverview({ force: true })
bus.openCompose = (preset = {}) => openCompose(preset)
bus.closeCompose = (options = {}) => closeCompose(options)

railTheme?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-rail-theme]')
  if (!button) return
  bus.setTheme(button.dataset.railTheme)
  paintRailTheme()
  refreshCurrent()
})

bus.theme = () => themeMode
bus.setTheme = (mode) => {
  themeMode = mode === 'light' || mode === 'dark' ? mode : 'system'
  try {
    localStorage.setItem(THEME_KEY, themeMode)
  } catch { /* a private window may refuse */ }
  applyTheme(themeMode)
}

/* ---------- compose dialog ---------- */

function closeCompose({ stay = false, restoreFocus = true } = {}) {
  if (!composeState) {
    if (!stay && location.hash.startsWith('#/new')) navigate(lastNonComposeHash || '#/today')
    return
  }
  const { panel, returnFocus, returnHash, onKey } = composeState
  composeState = null
  composeHost.removeEventListener('keydown', onKey, true)
  try { panel?.destroy?.() } catch { /* the form's own cleanup must not block closing */ }
  composeHost.hidden = true
  composeHost.innerHTML = ''
  document.body.style.overflow = ''
  if (restoreFocus && returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
    returnFocus.focus({ preventScroll: true })
  }
  if (!stay && location.hash.startsWith('#/new')) navigate(returnHash || '#/today')
}

function composeFocusables(dialog) {
  return [...dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.getClientRects().length > 0)
}

function openCompose(preset = {}, { returnHash = null } = {}) {
  if (composeState) return
  const returnFocus = document.activeElement
  composeHost.hidden = false
  composeHost.innerHTML = `
    <div class="compose__backdrop" data-compose-close></div>
    <div class="compose__dialog" role="dialog" aria-modal="true" aria-labelledby="compose-title" tabindex="-1">
      <div class="compose__head">
        <h2 class="compose__title" id="compose-title">发任务</h2>
        <button class="btn btn--quiet compose__close" type="button" data-compose-close>关闭</button>
      </div>
      <div class="compose__body"></div>
    </div>`
  const dialog = composeHost.querySelector('.compose__dialog')
  const body = composeHost.querySelector('.compose__body')
  let panel
  try {
    panel = newView.mountPanel(makeContext(parseHash()), { preset })
  } catch (error) {
    body.innerHTML = `<div class="banner"><span>发任务面板没能打开：${esc(error?.message || '未知错误')}</span></div>`
    panel = { root: body.firstElementChild, destroy() {} }
  }
  if (panel?.root && panel.root !== body.firstElementChild) body.append(panel.root)
  document.body.style.overflow = 'hidden'

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeCompose()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = composeFocusables(dialog)
    if (!focusables.length) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }
  composeHost.addEventListener('keydown', onKey, true)
  composeState = { panel, returnFocus, returnHash, onKey }
  requestAnimationFrame(() => {
    const first = dialog.querySelector('[data-text]') || composeFocusables(dialog)[0]
    if (first) first.focus({ preventScroll: true })
    else dialog.focus()
  })
}

composeHost.addEventListener('click', (event) => {
  if (event.target.closest('[data-compose-close]')) closeCompose()
})
composeFab?.addEventListener('click', () => openCompose())

/* ---------- shell paint ---------- */

function paintRailTheme() {
  if (!railTheme) return
  const mode = themeMode
  railTheme.innerHTML = THEME_CHOICES
    .map((choice) => `<button type="button" data-rail-theme="${choice.value}" aria-pressed="${choice.value === mode}">${choice.label}</button>`)
    .join('')
}

function paintTabs(base) {
  const needs = session.overview?.tickets?.needsPerson ?? 0
  tabsHost.innerHTML = TABS.map((tab) => {
    if (tab.isNew) {
      return `<a class="tab tab__new" href="${tab.href}" aria-label="发新任务"><span>${tab.icon}</span></a>`
    }
    const active = tab.key === base ? ' aria-current="page"' : ''
    const badge = tab.badge && needs > 0 ? `<span class="tab__badge">${needs > 9 ? '9+' : needs}</span>` : ''
    return `<a class="tab" href="${tab.href}"${active}>${tab.icon}<span>${tab.label}</span>${badge}</a>`
  }).join('')

  paintRailTheme()
  railNav.innerHTML = RAIL_GROUPS.map((group) => `
    <div class="rail__group">
      <div class="rail__group-title">${esc(group.title)}</div>
      ${group.items.map((item) => {
        const active = item.key === base ? ' aria-current="page"' : ''
        const badge = item.badge && needs > 0 ? `<span class="n">${needs}</span>` : ''
        return `<a href="${item.href}"${active}>${item.label}${badge}</a>`
      }).join('')}
    </div>`).join('')
}

function lampState(overview) {
  if (overviewError) return { state: 'down', text: '连不上' }
  if (!overview) return { state: 'ok', text: '连接中' }
  if (overview.paused) return { state: 'warn', text: '已暂停' }
  const alerts = Array.isArray(overview.alerts) ? overview.alerts : []
  if (alerts.some((alert) => alert.level === 'error')) return { state: 'danger', text: '有问题' }
  if (alerts.some((alert) => alert.level === 'warn')) return { state: 'warn', text: '有提醒' }
  return { state: 'ok', text: '正常' }
}

function paintLamps(overview) {
  const { state, text } = lampState(overview)
  lamp.dataset.state = state
  lamp.textContent = text
  railLamp.dataset.state = state
  railLamp.textContent = overview?.paused ? '已暂停接单' : `运行中 · 槽位 ${overview?.slots?.used ?? 0}/${overview?.slots?.max ?? 0}`
}

function paintBanner(overview) {
  if (overviewError) {
    bannerHost.innerHTML = `<div class="banner banner--down"><span>连不上守护进程，显示的是上一次的数据</span><span class="banner__note">每 3 秒重试</span></div>`
    return
  }
  if (overview?.paused) {
    bannerHost.innerHTML = `<div class="banner banner--paused"><span>已暂停接新任务：新请求会排队，正在跑的不受影响</span><button class="btn btn--quiet" type="button" data-resume style="margin-left:auto;color:inherit">恢复接单</button></div>`
    bannerHost.querySelector('[data-resume]')?.addEventListener('click', () => setPaused(false))
    return
  }
  bannerHost.innerHTML = ''
}

function asideHtml(overview) {
  if (!overview) return ''
  const usage = overview.usage ?? {}
  const pctUsed = Math.round(Number(usage.budgetUsedPct ?? 0) * 100)
  const slots = overview.slots ?? {}
  const recent = Array.isArray(overview.recent) ? overview.recent.slice(0, 3) : []
  return `
    <div class="aside__block">
      <div class="aside__k">今日花费</div>
      <div class="aside__v">${money2(usage.todayUsd ?? 0)} <small>${usage.todayCalls ?? 0} 次调用</small></div>
      <div class="meter"><i style="width:${Math.min(100, pctUsed)}%"></i></div>
      <div class="aside__k" style="margin-top:6px">${usage.dailyBudgetUsd > 0 ? `日上限 ${money2(usage.dailyBudgetUsd)}，已用 ${pctUsed}%` : '没有设置日上限'}</div>
    </div>
    <div class="aside__block">
      <div class="aside__k">槽位</div>
      <div class="aside__v">${slots.used ?? 0} / ${slots.max ?? 0} <small>另有 1 个留给你</small></div>
    </div>
    <div class="aside__block">
      <div class="aside__k" style="margin-bottom:8px">最近事件</div>
      ${recent.map((event) => `<div class="ev" data-tone="${event.level === 'warn' || event.level === 'error' ? 'human' : 'machine'}">
        <div class="ev__time">${esc(ago(event.at))}</div>
        <div class="ev__what">${esc(event.text)}</div>
      </div>`).join('')}
      <a class="rail__quiet" href="#/events" style="font-size:0.7812rem">看全部事件</a>
    </div>`
}

function paintShell(overview) {
  paintLamps(overview)
  paintBanner(overview)
  asideHost.innerHTML = asideHtml(overview)
  paintTabs(currentRoute?.base ?? 'today')
}

/* ---------- data ---------- */

async function refreshOverview({ force = false } = {}) {
  try {
    const overview = await loadOverview({ force })
    session.overview = overview
    overviewError = null
    paintShell(overview)
    return overview
  } catch (error) {
    if (error?.status === 401) return null
    overviewError = error
    paintShell(session.overview)
    return null
  }
}

async function setPaused(paused) {
  try {
    await post('api/pause', { paused })
    invalidateOverview()
    const overview = await refreshOverview({ force: true })
    toast(paused ? '已暂停接单：新请求在队列里等' : '已恢复接单')
    const snap = keep.snapshot(stage)
    await current?.refresh?.().catch(() => {})
    keep.restore(stage, snap)
    return overview
  } catch (error) {
    toast(error?.message || '操作没有成功', { danger: true })
    return null
  }
}
bus.setPaused = setPaused

/* ---------- route rendering ---------- */

function makeContext(route) {
  return {
    params: route.params,
    query: route.query ?? {},
    fragment: route.fragment ?? '',
    state: {},
    me: session.me,
    overview: () => session.overview,
    navigate,
    openCompose: (preset) => openCompose(preset),
    showError: (message) => toast(message, { danger: true, label: '重试', run: () => renderRoute() }),
    refreshMe: async () => {
      session.me = await fetchMe()
      return session.me
    },
    setPaused,
  }
}

function viewKeyFor(route) {
  return splitMode() && (route.key === 'ticket' || route.key === 'tickets') ? 'tickets' : route.key
}

function canReuseTickets(route) {
  return Boolean(current && typeof current.select === 'function' && mountedSplit && splitMode()
    && (route.key === 'ticket' || route.key === 'tickets'))
}

function mountIntoStage(route) {
  const key = viewKeyFor(route)
  const split = key === 'tickets' && splitMode()
  const module = VIEWS[key]
  let instance
  try {
    const ctx = makeContext(route)
    if (split) {
      // Split layout: the list stays mounted; the detail is picked by id.
      ctx.params = { id: route.key === 'ticket' ? route.params.id : undefined }
      ctx.split = true
    }
    instance = module.mount(ctx)
  } catch (error) {
    const host = document.createElement('div')
    host.className = 'page'
    host.innerHTML = `<div class="banner"><span>这个页面没能打开：${esc(error?.message || '未知错误')}</span><button class="btn btn--quiet" type="button" data-retry style="margin-left:auto;color:inherit">重试</button></div>`
    host.querySelector('[data-retry]').addEventListener('click', () => renderRoute())
    instance = { root: host, refresh: async () => {}, destroy() {} }
  }
  stage.replaceChildren(instance.root)
  current = instance
  mountedSplit = split
  unwatchKeep?.()
  unwatchKeep = keep.watch(instance.root)
  shell.dataset.view = route.key
  return instance
}

function renderComposeRoute() {
  const returnHash = lastNonComposeHash || '#/today'
  if (!(currentRoute?.key === 'today' && current)) {
    currentRoute = { key: 'today', params: {}, base: 'today', query: {}, fragment: '' }
    mountIntoStage(currentRoute)
  }
  paintTabs('today')
  barTitle.textContent = TITLES.new
  document.title = `${TITLES.new} · 超级智能体后台`
  announcer.textContent = '发任务面板已打开'
  openCompose({}, { returnHash })
}

function renderRoute() {
  if (!session.started) return
  const route = parseHash()
  if (route.key === 'new') {
    renderComposeRoute()
    refreshOverview()
    return
  }
  lastNonComposeHash = location.hash || '#/today'
  closeCompose({ stay: true, restoreFocus: false })
  const reuse = canReuseTickets(route)
  currentRoute = route
  shell.dataset.view = route.key
  if (reuse) {
    // Same split layout: move the selection without remounting, so the list keeps its scroll, search and filters.
    current.select(route.key === 'ticket' ? route.params.id : null)
  } else {
    current?.destroy?.()
    current = null
    mountIntoStage(route)
    keep.holdScroll()
    window.scrollTo(0, 0)
  }
  paintTabs(route.base)
  barTitle.textContent = TITLES[route.key] ?? '今日'
  document.title = `${TITLES[route.key] ?? '今日'} · 超级智能体后台`
  announcer.textContent = `${TITLES[route.key] ?? '今日'}已打开`
  if (!reuse) stage.focus({ preventScroll: true })
  refreshOverview()
}

/* ---------- polling ---------- */

function isEditing() {
  const active = document.activeElement
  if (!active || !stage.contains(active)) return false
  if (active.isContentEditable) return true
  if (active.tagName === 'TEXTAREA' || active.tagName === 'SELECT') return true
  if (active.tagName === 'INPUT') {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(active.type)
  }
  return false
}

async function refreshCurrent() {
  const snap = keep.snapshot(stage)
  try {
    await current?.refresh?.()
  } catch { /* the view reports its own errors */ }
  keep.restore(stage, snap)
}

async function tick() {
  if (document.hidden || !session.started) return
  await refreshOverview()
  if (!isEditing()) await refreshCurrent()
}

function startPolling() {
  if (pollTimer) return
  pollTimer = window.setInterval(tick, 3000)
  document.addEventListener('visibilitychange', onVisibility)
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = null
  document.removeEventListener('visibilitychange', onVisibility)
}

function onVisibility() {
  if (!document.hidden) tick()
}

/* ---------- upload chip ---------- */

function paintUpload(state) {
  const value = state && typeof state === 'object' ? state : { active: false }
  const visible = Boolean(value.active || value.done || value.error)
  uploadChip.hidden = !visible
  if (!visible) return
  uploadChip.dataset.done = value.done ? 'true' : 'false'
  uploadChip.dataset.error = value.error ? 'true' : 'false'
  if (value.error) uploadChip.textContent = '上传失败'
  else if (value.done) uploadChip.textContent = `${value.name || '文件'} 上传完成`
  else uploadChip.textContent = `上传 ${Math.round(Number(value.percent ?? 0))}%`
}

bus.upload.subscribe(paintUpload)
paintUpload(bus.upload.state())

/* ---------- auth ---------- */

function showLogin(message) {
  session.started = false
  stopPolling()
  closeCompose({ stay: true, restoreFocus: false })
  shell.hidden = true
  loginLayer.hidden = false
  loginError.hidden = !message
  if (message) loginError.textContent = message
  loginPassword.value = ''
  loginPassword.focus()
}

async function start() {
  session.me = await fetchMe()
  loginLayer.hidden = true
  shell.hidden = false
  session.started = true
  await refreshOverview({ force: true })
  renderRoute()
  startPolling()
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const password = loginPassword.value
  if (!password) {
    loginError.hidden = false
    loginError.textContent = '先输入口令。'
    return
  }
  loginSubmit.disabled = true
  try {
    await apiLogin(password)
    await start()
  } catch (error) {
    loginError.hidden = false
    loginError.textContent = error?.message || '登录没有成功。'
  } finally {
    loginSubmit.disabled = false
  }
})

setUnauthorizedHandler(() => showLogin('登录已失效，请重新登录。'))

loginHttpWarning.hidden = location.protocol !== 'http:'
loginMockHint.hidden = !mockMode

/* ---------- global keys ---------- */

document.addEventListener('keydown', (event) => {
  if (composeState) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    navigate('tickets')
    return
  }
  if (event.key === 'Escape' && currentRoute?.key === 'ticket') {
    navigate('tickets')
    return
  }
  if (!['today', 'tickets'].includes(currentRoute?.key ?? '') && !(currentRoute?.key === 'ticket' && mountedSplit)) return
  const rows = [...stage.querySelectorAll('.row--link')]
  if (!rows.length) return
  const index = rows.indexOf(document.activeElement)
  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault()
    rows[Math.min(index + 1, rows.length - 1)].focus()
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault()
    rows[Math.max(index - 1, 0)].focus()
  }
})

onMediaChange(splitQuery, () => {
  if (session.started) renderRoute()
})

window.addEventListener('hashchange', () => {
  if (!session.started) return
  renderRoute()
})

/* ---------- boot ---------- */

mockReady
  .then(() => {
    if (!location.hash) location.hash = '#/today'
    return start()
  })
  .catch((error) => {
    if (error?.status === 401) showLogin()
    else showLogin(error?.message || '连不上后台服务。')
  })
