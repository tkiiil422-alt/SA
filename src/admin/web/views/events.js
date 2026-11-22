/** 事件: what the machine did, warnings first-class. */
import { get } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, ago } from '../lib/view.js'

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'info', label: '提示' },
  { key: 'warn', label: '警告' },
  { key: 'error', label: '错误' },
]

const LEVEL_WORD = { info: '提示', warn: '警告', error: '错误' }

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page'
  const state = { level: '', ticketId: ctx.params?.ticketId ?? '', items: [] }
  let alive = true
  let loading = false

  const render = async ({ append = false } = {}) => {
    if (!alive || loading) return
    loading = true
    try {
      const before = append && state.items.length ? state.items[state.items.length - 1].id : undefined
      const data = await get('api/events', {
        limit: 100,
        ...(state.level ? { level: state.level } : {}),
        ...(state.ticketId ? { ticketId: state.ticketId } : {}),
        ...(before ? { before } : {}),
      })
      if (!alive) return
      const items = Array.isArray(data.items) ? data.items : []
      state.items = append ? [...state.items, ...items] : items
      paint(items.length === 100)
    } catch (error) {
      if (error?.status !== 401) bus.toast(error?.message || '事件没有加载出来', { danger: true })
    } finally {
      loading = false
    }
  }

  function paint(more) {
    root.innerHTML = `
      <div class="head">
        <div class="head__row"><h1 class="head__title">事件</h1></div>
        <p class="head__sub">${state.ticketId ? `只看工单 ${esc(state.ticketId)} 的事` : '机器做过的事；出错的位置会标出来'}</p>
      </div>
      ${state.ticketId ? `<button class="filterchip" type="button" data-clear>只看 ${esc(state.ticketId)}，点这里看全部</button>` : ''}
      <div class="seg" role="group" aria-label="筛选事件">
        ${FILTERS.map((filter) => `<button class="seg__i" type="button" data-level="${filter.key}" aria-pressed="${filter.key === state.level}">${filter.label}</button>`).join('')}
      </div>
      ${state.items.length ? `<div class="list" style="margin-top:12px">${state.items.map((item) => {
        const level = LEVEL_WORD[item.level] ? item.level : 'info'
        return `
        <div class="item item--event">
          <span class="lvl" data-sev="${level}"><i aria-hidden="true"></i>${LEVEL_WORD[level]}</span>
          <div class="item__main">
            <div class="item__title">${esc(item.text)}</div>
            <div class="item__meta">
              <span>${esc(ago(item.at))}</span>
              ${item.kind ? `<span>${esc(item.kind)}</span>` : ''}
            </div>
          </div>
          ${item.ticketId ? `<div class="item__side"><a class="item__go btn btn--quiet" href="#/tickets/${encodeURIComponent(item.ticketId)}">看票</a></div>` : ''}
        </div>`
      }).join('')}</div>`
        : '<div class="empty" style="margin-top:12px"><p class="empty__title">没有事件</p><p class="empty__text">换一个筛选，或者等它干点活。</p></div>'}
      ${more ? '<button class="loadmore" type="button" data-more>加载更多</button>' : ''}`
  }

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-clear]')) {
      state.ticketId = ''
      state.items = []
      if (location.hash.startsWith('#/events/')) location.hash = '#/events'
      else render()
      return
    }
    const filter = event.target.closest('[data-level]')
    if (filter) {
      state.level = filter.dataset.level
      state.items = []
      render()
      return
    }
    if (event.target.closest('[data-more]')) render({ append: true })
  })

  render()
  return { root, refresh: () => render(), destroy() { alive = false } }
}
