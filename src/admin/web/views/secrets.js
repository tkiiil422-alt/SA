/**
 * 密钥: the encrypted vault. The page only ever knows names, never values.
 *
 * The value inputs are write-only: they are never filled from state, and every
 * save clears them before the list is reloaded.
 */
import { get, post, put, del } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, ago } from '../lib/view.js'

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const ORIGIN = { operator: '你保存的', ai: 'AI 保存的' }
const STATUS = { pending: '待处理', granted: '已同意', denied: '已拒绝' }

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page'
  let alive = true
  const state = {
    items: null,
    requests: [],
    error: '',
    addOpen: false,
    rotateName: '',
    editName: '',
    deleteName: '',
    busy: false,
  }

  const load = async () => {
    try {
      const [secrets, requests] = await Promise.all([
        get('api/secrets'),
        get('api/secrets/requests').catch(() => ({ items: [] })),
      ])
      if (!alive) return
      state.items = Array.isArray(secrets?.items) ? secrets.items : []
      state.requests = Array.isArray(requests?.items) ? requests.items : []
      state.error = ''
    } catch (error) {
      if (error?.status === 401) return
      state.error = error?.message || '读不到密钥列表'
    }
    if (alive) paint()
  }

  /* ---------- forms (values never live in state or in rendered HTML) ---------- */

  function addForm() {
    return `<article class="card" style="margin-bottom:12px">
      <h2 class="card__title">新增密钥</h2>
      <div class="field" style="margin-top:10px">
        <label class="field__label" for="secret-add-name">名称</label>
        <input class="input mono" id="secret-add-name" data-add-name autocomplete="off" spellcheck="false" placeholder="OPENAI_API_KEY">
        <p class="field__help">会作为同名环境变量给 AI 用，只能用大写字母、数字和下划线，例如 OPENAI_API_KEY</p>
      </div>
      <div class="field" style="margin-top:10px">
        <label class="field__label" for="secret-add-value">值</label>
        <input class="input" id="secret-add-value" data-add-value type="password" autocomplete="new-password" spellcheck="false" placeholder="粘贴密钥原值">
        <p class="field__help">保存后页面上不会再显示；只在任务启动时注入。</p>
      </div>
      <div class="field" style="margin-top:10px">
        <label class="field__label" for="secret-add-desc">说明（可选）</label>
        <input class="input" id="secret-add-desc" data-add-desc placeholder="例如：翻译任务用的 OpenAI 密钥">
      </div>
      <p class="field__error" data-add-error hidden></p>
      <div class="bar-actions" style="margin-top:12px">
        <button class="btn btn--human" type="button" data-action="add-save">保存密钥</button>
        <button class="btn" type="button" data-action="add-cancel">取消</button>
      </div>
    </article>`
  }

  function rotateForm(secret) {
    return `<article class="confirm confirm--inline">
      <p class="confirm__text">给 <code class="mono">${esc(secret.name)}</code> 换一个新值。原值会被覆盖，用到它的任务下一次启动时拿到新值。</p>
      <div class="field" style="margin-top:8px">
        <label class="field__label" for="secret-rotate-value">新值</label>
        <input class="input" id="secret-rotate-value" data-rotate-value type="password" autocomplete="new-password" spellcheck="false" placeholder="粘贴新的密钥原值">
      </div>
      <p class="field__error" data-rotate-error hidden></p>
      <div class="bar-actions">
        <button class="btn btn--human" type="button" data-action="rotate-save" data-name="${esc(secret.name)}">保存新值</button>
        <button class="btn" type="button" data-action="rotate-cancel">取消</button>
      </div>
    </article>`
  }

  function editForm(secret) {
    return `<article class="card" style="margin-top:12px;background:var(--surface-2)">
      <div class="field">
        <label class="field__label" for="secret-edit-desc">说明</label>
        <textarea class="textarea" id="secret-edit-desc" data-edit-desc style="min-height:76px" placeholder="这个密钥是做什么用的">${esc(secret.description ?? '')}</textarea>
      </div>
      <p class="field__error" data-edit-error hidden></p>
      <div class="bar-actions" style="margin-top:10px">
        <button class="btn btn--human" type="button" data-action="edit-save" data-name="${esc(secret.name)}">保存说明</button>
        <button class="btn" type="button" data-action="edit-cancel">取消</button>
      </div>
    </article>`
  }

  function deleteForm(secret) {
    return `<article class="confirm confirm--inline">
      <p class="confirm__text">删除「<code class="mono">${esc(secret.name)}</code>」？它同时会撤销所有任务对它的授权，正在用它的任务下一次启动就拿不到这个值了。删掉后不能恢复。</p>
      <div class="bar-actions">
        <button class="btn" type="button" data-action="delete-cancel">再想想</button>
        <button class="btn btn--danger" type="button" data-action="delete-confirm" data-name="${esc(secret.name)}">确认删除</button>
      </div>
    </article>`
  }

  function secretCard(secret) {
    return `<article class="secret" data-secret-name="${esc(secret.name)}">
      <div class="secret__head">
        <span class="mono secret__name">${esc(secret.name)}</span>
        <span class="tag${secret.origin === 'ai' ? ' tag--ink' : ''}">${ORIGIN[secret.origin] ?? '你保存的'}</span>
      </div>
      <p class="secret__desc">${secret.description ? esc(secret.description) : '<span class="hint">没有说明</span>'}</p>
      <p class="row__meta secret__meta">
        <span>创建 ${esc(ago(secret.createdAt))}</span>
        ${secret.rotatedAt ? `<span>换新值 ${esc(ago(secret.rotatedAt))}</span>` : ''}
        <span>最近使用 ${esc(secret.lastUsedAt ? ago(secret.lastUsedAt) : '—')}</span>
        <span>已授权给 ${Number(secret.grantedTickets ?? 0)} 个任务</span>
      </p>
      <div class="bar-actions" style="margin-top:10px">
        <button class="btn btn--quiet" type="button" data-action="rotate" data-name="${esc(secret.name)}">换新值</button>
        <button class="btn btn--quiet" type="button" data-action="edit" data-name="${esc(secret.name)}">编辑说明</button>
        <button class="btn btn--quiet" type="button" data-action="delete" data-name="${esc(secret.name)}">删除</button>
      </div>
      ${state.rotateName === secret.name ? rotateForm(secret) : ''}
      ${state.editName === secret.name ? editForm(secret) : ''}
      ${state.deleteName === secret.name ? deleteForm(secret) : ''}
    </article>`
  }

  function requestRow(request, { pending = false } = {}) {
    return `<div class="secret-req"${pending ? ' data-request-pending="1"' : ''}>
      <div class="secret-req__body">
        <p class="secret-req__line">
          <span class="mono">${esc(request.name)}</span>
          <span class="hint">来自 <a href="#/tickets/${encodeURIComponent(request.ticketId)}">${esc(request.ticketTitle || request.ticketId)}</a> · ${esc(ago(request.at))}</span>
        </p>
        <p class="secret-req__why">${esc(request.why || '没有写原因')}</p>
      </div>
      ${pending
        ? `<div class="bar-actions">
            <button class="btn btn--human" type="button" data-decision="grant" data-id="${esc(request.id)}">同意</button>
            <button class="btn" type="button" data-decision="deny" data-id="${esc(request.id)}">拒绝</button>
          </div>`
        : `<span class="tag">${STATUS[request.status] ?? '已处理'}</span>`}
    </div>`
  }

  function requestsCard(pending, decided) {
    return `<div class="card">
      ${pending.length
        ? pending.map((request) => requestRow(request, { pending: true })).join('')
        : '<p class="hint">没有待处理的申请。</p>'}
      ${decided.length ? `<details class="disclose" data-keep="secrets.decided" style="margin-top:${pending.length ? 12 : 0}px">
        <summary>已处理（${decided.length}）</summary>
        <div style="margin-top:6px">${decided.map((request) => requestRow(request)).join('')}</div>
      </details>` : ''}
    </div>`
  }

  /* ---------- paint ---------- */

  function paint() {
    const items = Array.isArray(state.items) ? state.items : []
    const pending = state.requests.filter((request) => request.status === 'pending')
    const decided = state.requests.filter((request) => request.status !== 'pending')
    root.innerHTML = `
      <div class="head">
        <div class="head__row"><h1 class="head__title">密钥</h1></div>
        <p class="head__sub">AI 干活时可能要用到的密钥，都在这里保管。</p>
      </div>

      <div class="card secret-help">
        <p>密钥加密保存在这台主机上，页面上永远看不到原值。AI 只能用你授权给它的密钥；它新存的密钥会标记为「AI 保存的」。</p>
      </div>

      ${state.error ? `<div class="banner" style="margin-top:14px">
        <span>${esc(state.error)}</span>
        <button class="btn btn--quiet" type="button" data-action="retry" style="margin-left:auto;color:inherit">重试</button>
      </div>` : ''}

      <section class="section">
        <div class="section__head">
          <h2 class="section__title">密钥库</h2>
          <span class="section__count">${items.length} 个</span>
          <button class="btn btn--quiet" type="button" data-action="add-open" style="margin-left:auto">${state.addOpen ? '收起' : '新增密钥'}</button>
        </div>
        ${state.addOpen ? addForm() : ''}
        <div class="list" data-secrets-list>
          ${items.length
            ? items.map(secretCard).join('')
            : '<p class="hint" style="padding:12px 2px">还没有密钥。点右上角「新增密钥」保存第一个。</p>'}
        </div>
      </section>

      <section class="section">
        <div class="section__head">
          <h2 class="section__title">AI 的申请</h2>
          <span class="section__count">${pending.length} 个待处理</span>
        </div>
        ${requestsCard(pending, decided)}
      </section>

      <p class="hint" style="margin-top:18px">密钥只在任务启动时作为同名环境变量注入，不写进工作区、日志或事件。</p>`
  }

  /* ---------- actions ---------- */

  function clearValueInputs() {
    for (const input of root.querySelectorAll('[data-add-value], [data-rotate-value]')) {
      input.value = ''
    }
  }

  function setError(selector, message) {
    const node = root.querySelector(selector)
    if (!node) return
    node.hidden = !message
    node.textContent = message
  }

  function issuesMessage(error) {
    if (Array.isArray(error?.issues) && error.issues.length) {
      return error.issues.map((issue) => issue.message).filter(Boolean).join('；')
    }
    return error?.message || '保存失败'
  }

  async function submitAdd() {
    const name = root.querySelector('[data-add-name]')?.value?.trim() ?? ''
    const value = root.querySelector('[data-add-value]')?.value ?? ''
    const description = root.querySelector('[data-add-desc]')?.value?.trim() ?? ''
    if (!NAME_RE.test(name)) {
      setError('[data-add-error]', '名称要用大写字母开头，只能包含大写字母、数字和下划线，最长 64 个字符。')
      return
    }
    if (!value || value.length > 8192) {
      setError('[data-add-error]', '值要在 1–8192 个字符之间。')
      return
    }
    setError('[data-add-error]', '')
    state.busy = true
    const button = root.querySelector('[data-action="add-save"]')
    if (button) button.disabled = true
    try {
      await post('api/secrets', { name, value, ...(description ? { description } : {}) })
      clearValueInputs()
      state.addOpen = false
      bus.toast('密钥已保存')
      await load()
    } catch (error) {
      if (error?.status === 409 || error?.code === 'exists') {
        setError('[data-add-error]', '这个名称已经存在，请换一个。')
      } else {
        setError('[data-add-error]', issuesMessage(error))
      }
    } finally {
      state.busy = false
      const fresh = root.querySelector('[data-action="add-save"]')
      if (fresh) fresh.disabled = false
    }
  }

  async function submitRotate(name) {
    const value = root.querySelector('[data-rotate-value]')?.value ?? ''
    if (!value || value.length > 8192) {
      setError('[data-rotate-error]', '新值要在 1–8192 个字符之间。')
      return
    }
    setError('[data-rotate-error]', '')
    state.busy = true
    const button = root.querySelector('[data-action="rotate-save"]')
    if (button) button.disabled = true
    try {
      await put(`api/secrets/${encodeURIComponent(name)}`, { value })
      clearValueInputs()
      state.rotateName = ''
      bus.toast('已换新值，下一次任务启动时生效')
      await load()
    } catch (error) {
      setError('[data-rotate-error]', issuesMessage(error))
    } finally {
      state.busy = false
      const fresh = root.querySelector('[data-action="rotate-save"]')
      if (fresh) fresh.disabled = false
    }
  }

  async function submitEdit(name) {
    const description = root.querySelector('[data-edit-desc]')?.value?.trim() ?? ''
    state.busy = true
    try {
      await put(`api/secrets/${encodeURIComponent(name)}`, { description })
      state.editName = ''
      bus.toast('说明已保存')
      await load()
    } catch (error) {
      setError('[data-edit-error]', issuesMessage(error))
    } finally {
      state.busy = false
    }
  }

  async function submitDelete(name) {
    if (state.busy) return
    state.busy = true
    const button = root.querySelector('[data-action="delete-confirm"]')
    if (button) button.disabled = true
    try {
      await del(`api/secrets/${encodeURIComponent(name)}`)
      state.deleteName = ''
      bus.toast('已删除，所有任务对它的授权也一并撤销了')
      await load()
    } catch (error) {
      bus.toast(error?.message || '删除没有成功', { danger: true })
      if (button) button.disabled = false
    } finally {
      state.busy = false
    }
  }

  async function decide(id, decision) {
    if (state.busy) return
    state.busy = true
    try {
      await post(`api/secrets/requests/${encodeURIComponent(id)}`, { decision })
      bus.toast(decision === 'grant' ? '已同意，下一次 AI 开始干活时生效' : '已拒绝这次申请')
      await load()
    } catch (error) {
      bus.toast(error?.message || '操作没有成功', { danger: true })
    } finally {
      state.busy = false
    }
  }

  root.addEventListener('click', async (event) => {
    const decision = event.target.closest('[data-decision]')
    if (decision) {
      await decide(decision.dataset.id, decision.dataset.decision)
      return
    }

    const button = event.target.closest('[data-action]')
    if (!button) return
    const action = button.dataset.action
    const name = button.dataset.name ?? ''

    if (action === 'retry') { await load(); return }
    if (action === 'add-open') {
      state.addOpen = !state.addOpen
      state.rotateName = ''
      state.editName = ''
      state.deleteName = ''
      paint()
      if (state.addOpen) root.querySelector('[data-add-name]')?.focus()
      return
    }
    if (action === 'add-cancel') {
      clearValueInputs()
      state.addOpen = false
      paint()
      return
    }
    if (action === 'add-save') { await submitAdd(); return }
    if (action === 'rotate') {
      clearValueInputs()
      state.rotateName = name
      state.editName = ''
      state.deleteName = ''
      paint()
      root.querySelector('[data-rotate-value]')?.focus()
      return
    }
    if (action === 'rotate-cancel') {
      clearValueInputs()
      state.rotateName = ''
      paint()
      return
    }
    if (action === 'rotate-save') { await submitRotate(name); return }
    if (action === 'edit') {
      clearValueInputs()
      state.editName = name
      state.rotateName = ''
      state.deleteName = ''
      paint()
      root.querySelector('[data-edit-desc]')?.focus()
      return
    }
    if (action === 'edit-cancel') { state.editName = ''; paint(); return }
    if (action === 'edit-save') { await submitEdit(name); return }
    if (action === 'delete') {
      clearValueInputs()
      state.deleteName = name
      state.rotateName = ''
      state.editName = ''
      paint()
      return
    }
    if (action === 'delete-cancel') { state.deleteName = ''; paint(); return }
    if (action === 'delete-confirm') { await submitDelete(name) }
  })

  load()
  return {
    root,
    refresh: () => (state.busy || state.addOpen || state.rotateName || state.editName || state.deleteName
      ? Promise.resolve()
      : load()),
    destroy() { alive = false },
  }
}
