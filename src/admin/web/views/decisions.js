/** 判断记录: why each message was accepted, ignored, or failed to judge. */
import { get } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, ago } from '../lib/view.js'

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'accept', label: '受理' },
  { key: 'ignore', label: '忽略' },
  { key: 'unavailable', label: '失败' },
]

const TONE = { accept: 'run', ignore: 'queue', stop: 'ask', unavailable: 'ask', reopen: 'queue' }

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page'
  const state = { filter: 'all', items: [], page: 0, more: true, loading: false }
  const PAGE = 50
  let alive = true

  const render = async ({ append = false } = {}) => {
    if (state.loading) return
    state.loading = true
    try {
      const offset = append ? state.items.length : 0
      const data = await get('api/decisions', {
        limit: PAGE,
        offset,
        ...(state.filter === 'all' ? {} : { kind: state.filter }),
      })
      if (!alive) return
      const items = Array.isArray(data.items) ? data.items : []
      state.items = append ? [...state.items, ...items] : items
      state.more = items.length === PAGE
      state.page = Math.floor(state.items.length / PAGE)
      paint()
    } catch (error) {
      if (error?.status !== 401) bus.toast(error?.message || '判断记录没有加载出来', { danger: true })
    } finally {
      state.loading = false
    }
  }

  function paint() {
    const shown = state.filter === 'all' ? state.items : state.items.filter((item) => item.kind === state.filter)
    root.innerHTML = `
      <div class="head">
        <div class="head__row"><h1 class="head__title">判断记录</h1></div>
        <p class="head__sub">每次要不要接、为什么接，都留了理由；不对就去改规则</p>
      </div>
      <div class="seg" role="group" aria-label="筛选记录">
        ${FILTERS.map((filter) => `<button class="seg__i" type="button" data-kind="${filter.key}" aria-pressed="${filter.key === state.filter}">${filter.label}</button>`).join('')}
      </div>
      ${shown.length ? `<div class="list" style="margin-top:12px">${shown.map((item) => {
        const reasons = Array.isArray(item.reasonText) && item.reasonText.length ? item.reasonText.join('；') : ''
        return `
        <div class="item">
          <div class="item__main">
            <div class="item__title">${esc(item.triggerText || '（没有原文）')}</div>
            <div class="item__meta">
              <span class="state" data-s="${TONE[item.kind] ?? 'queue'}">${esc(item.kindLabel || item.kind)}</span>
              <span>${esc(ago(item.at))}</span>
              ${reasons ? `<span class="item__reason">${esc(reasons)}</span>` : ''}
              ${item.strength ? `<span>${item.strength === 'explicit' ? '明确请求' : '推断'}</span>` : ''}
            </div>
          </div>
          ${item.ticketId ? `<div class="item__side"><a class="item__go btn btn--quiet" href="#/tickets/${encodeURIComponent(item.ticketId)}">看票</a></div>` : ''}
        </div>`
      }).join('')}</div>`
        : '<div class="empty" style="margin-top:12px"><p class="empty__title">还没有记录</p><p class="empty__text">有人给它派活、或它自己判断过一次之后，这里就会有。</p></div>'}
      ${state.more ? '<button class="loadmore" type="button" data-more>加载更多</button>' : ''}
      <p class="hint-row">按时间倒序${state.filter === 'all' ? '' : '，已按类型筛选'}；已加载 ${state.items.length} 条</p>`
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]')
    if (button) {
      state.filter = button.dataset.kind
      state.items = []
      render()
      return
    }
    if (event.target.closest('[data-more]')) render({ append: true })
  })

  render()
  return { root, refresh: render, destroy() { alive = false } }
}
