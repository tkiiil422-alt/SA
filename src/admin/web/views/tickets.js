/** 任务: the same list the API offers, with the filters people actually use. */
import { get, post, invalidateOverview } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, rowHtml, emptyHtml } from '../lib/view.js'
import { bytes } from '../lib/format.js'
import * as ticketView from './ticket.js'

const FILTERS = [
  { key: 'needs-person', label: '需要你' },
  { key: 'open', label: '进行中' },
  { key: 'ended', label: '已结束' },
  { key: 'all', label: '全部' },
]

const PAGE = 30

export function mount(ctx) {
  // Split layout (>= 1200 px, ctx.split): the list stays mounted on the left and
  // the selected ticket's detail is mounted on the right. Below 1200 px the root
  // is the single page it always was, and listHost === root.
  const split = Boolean(ctx.split)
  const root = document.createElement('div')
  root.className = split ? 'page split' : 'page'
  let listHost = root
  let detailHost = null
  if (split) {
    listHost = document.createElement('section')
    listHost.className = 'split__list'
    listHost.dataset.keepScroll = 'tickets.list'
    detailHost = document.createElement('section')
    detailHost.className = 'split__detail'
    root.append(listHost, detailHost)
  }
  // Split only: a route that opens a ticket starts on 全部, so that ticket is in the list.
  const initialId = split ? String(ctx.params?.id ?? '') : ''
  const state = {
    status: initialId ? 'all' : 'needs-person', q: '', items: [], total: 0, loading: false, loaded: false,
    batch: false, selected: new Set(), confirmOpen: false, deleteWorkspace: true,
    skipped: null, busy: false,
  }
  let alive = true
  let searchTimer = null
  let openId = initialId
  let detail = null

  const render = async ({ append = false } = {}) => {
    if (!alive || state.loading) return
    state.loading = true
    try {
      const data = await get('api/tickets', {
        status: state.status,
        ...(state.q ? { q: state.q } : {}),
        limit: PAGE,
        offset: append ? state.items.length : 0,
      })
      if (!alive) return
      const items = Array.isArray(data.items) ? data.items : []
      state.items = append ? [...state.items, ...items] : items
      state.total = Number(data.total ?? state.items.length)
      state.loaded = true
      paint()
    } catch (error) {
      if (error?.status !== 401) bus.toast(error?.message || '列表没有加载出来', { danger: true })
    } finally {
      state.loading = false
    }
  }

  // Split only: mark the open row. Non-split rows are returned untouched.
  function markOpen(html, current) {
    if (!split || !current) return html
    return html.replace('class="row row--link"', 'class="row row--link row--selected" aria-current="true"')
  }

  // Split only: the open ticket is not among the loaded rows (more pages may exist; the person can still switch to 全部).
  function hintNeeded() {
    return split && Boolean(openId) && state.loaded
      && !state.items.some((ticket) => ticket.id === openId)
  }

  function hintHtml() {
    return `<div class="list-hint" data-open-hint role="status"><span>当前打开的任务不在这个筛选里</span><button class="btn btn--quiet" type="button" data-show-all>显示全部</button></div>`
  }

  /** Split only: add or remove the hint at the top of the list without repainting it (keeps scroll). */
  function syncHint() {
    const shown = listHost.querySelector('[data-open-hint]')
    if (hintNeeded() && !shown) listHost.insertAdjacentHTML('afterbegin', hintHtml())
    else if (!hintNeeded() && shown) shown.remove()
  }

  function setStatus(key) {
    state.status = key
    state.items = []
    state.loaded = false
    state.selected.clear()
    state.confirmOpen = false
    state.skipped = null
    render()
  }

  function rowFor(ticket) {
    const current = split && ticket.id === openId
    if (!state.batch) return markOpen(rowHtml(ticket), current)
    const picked = state.selected.has(ticket.id)
    return `
      <div class="pickrow${picked ? ' row--picked' : ''}">
        <input class="pick" type="checkbox" data-pick="${esc(ticket.id)}" ${picked ? 'checked' : ''} aria-label="选择 ${esc(ticket.title)}">
        ${markOpen(rowHtml(ticket), current)}
      </div>`
  }

  function confirmHtml(count) {
    return `
      <article class="card confirm" style="margin-top:12px" role="region" aria-label="批量删除确认">
        <h2 class="confirm__title">删除选中的 ${count} 个任务？</h2>
        <p class="confirm__text">会删除任务记录、工作区文件和 AI 配置；花费记录会保留。还在进行的任务会跳过。</p>
        <label class="checkline">
          <input type="checkbox" data-batch-workspace ${state.deleteWorkspace ? 'checked' : ''}>
          <span>同时删除工作区文件</span>
        </label>
        <div class="bar-actions">
          <button class="btn" type="button" data-batch-cancel>再想想</button>
          <button class="btn btn--danger" type="button" data-batch-confirm ${state.busy ? 'disabled' : ''}>确认删除 ${count} 个任务</button>
        </div>
      </article>`
  }

  function skippedHtml() {
    const items = Array.isArray(state.skipped) ? state.skipped : []
    if (!items.length) return ''
    return `
      <div class="card confirm" style="margin-top:12px">
        <div class="card__title">有 ${items.length} 个任务没有删除</div>
        <ul class="skip-list">
          ${items.map((item) => {
            const title = state.items.find((ticket) => ticket.id === item.id)?.title
            return `<li>
              <span class="skip-list__name">${esc(title || item.id)}</span>
              <span class="skip-list__reason">${esc(item.reason)}</span>
            </li>`
          }).join('')}
        </ul>
      </div>`
  }

  function paint() {
    const selectedCount = state.selected.size
    const allSelected = state.items.length > 0 && state.items.every((ticket) => state.selected.has(ticket.id))
    listHost.innerHTML = `${hintNeeded() ? hintHtml() : ''}
      <div class="head">
        <div class="head__row">
          <h1 class="head__title">任务</h1>
          <button class="btn btn--quiet" type="button" data-batch-toggle aria-pressed="${state.batch}">${state.batch ? '退出批量' : '批量管理'}</button>
        </div>
        <p class="head__sub">${state.q ? `搜「${esc(state.q)}」` : state.status === 'needs-person' ? `${state.total} 张在等你` : `共 ${state.total} 张`}</p>
      </div>
      <div class="seg" role="group" aria-label="筛选任务">
        ${FILTERS.map((filter) => `<button class="seg__i" type="button" data-status="${filter.key}" aria-pressed="${filter.key === state.status}">${filter.label}</button>`).join('')}
      </div>
      <div class="field" style="margin:12px 0 4px">
        <input class="input" type="search" placeholder="搜标题或编号" aria-label="搜索任务" data-search value="${esc(state.q)}">
      </div>
      ${state.batch ? `<div class="batchbar">
        <button class="btn btn--quiet" type="button" data-select-all aria-pressed="${allSelected}">全选本页</button>
        <span class="hint" data-batch-count>已选 ${selectedCount} 张</span>
        <button class="btn btn--danger" type="button" data-batch-delete ${selectedCount ? '' : 'disabled'}>删除选中（${selectedCount}）</button>
      </div>` : ''}
      ${state.items.length
        ? `<div class="list">${state.items.map((ticket) => rowFor(ticket)).join('')}</div>`
        : split
          ? emptyHtml('这个筛选下没有任务', state.q ? '换个词试试，或者看全部。' : '切到「全部」可以看到所有任务。', '看全部', '#/tickets')
          : emptyHtml('没有符合条件的任务', state.q ? '换个词试试，或者看全部。' : '这一栏现在是空的。', '看全部', '#/tickets')}
      ${state.items.length < state.total ? `<button class="loadmore" type="button" data-more>加载更多（还有 ${state.total - state.items.length} 张）</button>` : ''}
      ${state.confirmOpen ? confirmHtml(selectedCount) : ''}
      ${skippedHtml()}
      <p class="hint-row"><span class="kbd">j</span><span class="kbd">k</span> 移动，<span class="kbd">Enter</span> 打开，<span class="kbd">Esc</span> 返回，<span class="kbd">⌘K</span> 搜索</p>`

    const search = listHost.querySelector('[data-search]')
    if (search) {
      search.addEventListener('input', () => {
        state.q = search.value.trim()
        state.selected.clear()
        state.confirmOpen = false
        state.skipped = null
        if (searchTimer) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => render(), 240)
      })
    }
  }

  function syncBatchUI() {
    const count = state.selected.size
    const counter = listHost.querySelector('[data-batch-count]')
    if (counter) counter.textContent = `已选 ${count} 张`
    const remove = listHost.querySelector('[data-batch-delete]')
    if (remove) {
      remove.textContent = `删除选中（${count}）`
      remove.disabled = count === 0
    }
    const all = listHost.querySelector('[data-select-all]')
    if (all) {
      all.setAttribute('aria-pressed', String(state.items.length > 0 && state.items.every((ticket) => state.selected.has(ticket.id))))
    }
    const confirm = listHost.querySelector('[data-batch-confirm]')
    if (confirm) {
      const title = confirm.closest('.confirm')?.querySelector('.confirm__title')
      if (title) title.textContent = `删除选中的 ${count} 个任务？`
      confirm.textContent = `确认删除 ${count} 个任务`
      confirm.disabled = count === 0
    }
  }

  /** Split only: show the detail for `id` (or the empty state). The list is not repainted. */
  function mountDetail() {
    detail?.destroy?.()
    detail = null
    if (!openId) {
      detailHost.innerHTML = emptyHtml('选一张任务看详情', '', '', '')
      return
    }
    try {
      detail = ticketView.mount({ ...ctx, params: { id: openId }, split: true })
      detailHost.replaceChildren(detail.root)
    } catch (error) {
      detailHost.innerHTML = `<div class="banner"><span>这张任务没能打开：${esc(error?.message || '未知错误')}</span></div>`
      detail = null
    }
  }

  /** Split only: move the selection. Called by app.js instead of remounting. */
  function select(id) {
    if (!split) return
    openId = id ? String(id) : ''
    listHost.querySelectorAll('.row--link').forEach((link) => {
      const on = Boolean(openId) && link.getAttribute('href') === `#/tickets/${encodeURIComponent(openId)}`
      link.classList.toggle('row--selected', on)
      if (on) link.setAttribute('aria-current', 'true')
      else link.removeAttribute('aria-current')
    })
    syncHint()
    mountDetail()
  }

  listHost.addEventListener('click', async (event) => {
    if (split && state.batch && event.target.closest('.pickrow .row--link')) {
      // Batch mode: a row click must not open the detail.
      event.preventDefault()
      return
    }
    const filter = event.target.closest('[data-status]')
    const showAll = event.target.closest('[data-show-all]')
    if (filter || showAll) {
      setStatus(filter ? filter.dataset.status : 'all')
      return
    }
    if (event.target.closest('[data-more]')) {
      render({ append: true })
      return
    }
    if (event.target.closest('[data-batch-toggle]')) {
      state.batch = !state.batch
      state.selected.clear()
      state.confirmOpen = false
      state.skipped = null
      paint()
      return
    }
    if (event.target.closest('[data-select-all]')) {
      const all = state.items.length > 0 && state.items.every((ticket) => state.selected.has(ticket.id))
      for (const ticket of state.items) {
        if (all) state.selected.delete(ticket.id)
        else state.selected.add(ticket.id)
      }
      listHost.querySelectorAll('[data-pick]').forEach((box) => {
        box.checked = !all
        box.closest('.pickrow')?.classList.toggle('row--picked', box.checked)
      })
      syncBatchUI()
      return
    }
    if (event.target.closest('[data-batch-delete]')) {
      if (!state.selected.size) return
      state.confirmOpen = true
      state.deleteWorkspace = true
      state.skipped = null
      paint()
      return
    }
    if (event.target.closest('[data-batch-cancel]')) {
      state.confirmOpen = false
      paint()
      return
    }
    if (event.target.closest('[data-batch-confirm]')) {
      if (state.busy || !state.selected.size) return
      const ids = [...state.selected]
      const box = listHost.querySelector('[data-batch-workspace]')
      if (box) state.deleteWorkspace = box.checked
      state.busy = true
      const button = event.target.closest('[data-batch-confirm]')
      if (button) button.disabled = true
      try {
        const result = await post('api/tickets/delete', {
          ids,
          deleteWorkspace: state.deleteWorkspace,
          force: false,
        })
        const deleted = Array.isArray(result?.deleted) ? result.deleted : []
        state.skipped = Array.isArray(result?.skipped) ? result.skipped : []
        state.selected.clear()
        state.confirmOpen = false
        bus.toast(`已删除 ${deleted.length} 个任务，释放了 ${bytes(result?.freedBytes ?? 0)}`)
        invalidateOverview()
        bus.refreshOverview?.()
        await render()
        // The open ticket was deleted: clear the selection and go back to the empty detail.
        const skippedIds = new Set(state.skipped.map((item) => item.id))
        if (split && openId && ids.includes(openId) && !skippedIds.has(openId)) bus.navigate('tickets')
      } catch (error) {
        bus.toast(error?.message || '批量删除没有成功', { danger: true })
        if (button) button.disabled = false
      } finally {
        state.busy = false
      }
    }
  })

  listHost.addEventListener('change', (event) => {
    const pick = event.target.closest('[data-pick]')
    if (pick) {
      if (pick.checked) state.selected.add(pick.dataset.pick)
      else state.selected.delete(pick.dataset.pick)
      pick.closest('.pickrow')?.classList.toggle('row--picked', pick.checked)
      syncBatchUI()
      return
    }
    const box = event.target.closest('[data-batch-workspace]')
    if (box) state.deleteWorkspace = box.checked
  })

  if (split) mountDetail()
  render()
  return {
    root,
    select,
    refresh: () => {
      const list = state.confirmOpen || state.busy ? Promise.resolve() : render()
      if (!split) return list
      const inner = detail?.refresh ? detail.refresh() : Promise.resolve()
      return Promise.all([list, inner]).then(() => undefined)
    },
    destroy() {
      alive = false
      if (searchTimer) clearTimeout(searchTimer)
      detail?.destroy?.()
      detail = null
    },
  }
}
