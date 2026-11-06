/** 花费: today, a week, a month; which models, which tickets, which calls. */
import { get } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, money2, money4, ago } from '../lib/view.js'
import { dayLabel, tokens } from '../lib/format.js'

const RANGES = [
  { key: 'today', label: '今天', days: 1 },
  { key: '7d', label: '7 天', days: 7 },
  { key: '30d', label: '30 天', days: 30 },
]

// Calls are fetched once (up to 100) and shown in steps of PAGE_CALLS on this page only.
const PAGE_CALLS = 20

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page'
  const state = { range: 'today', model: '', shown: PAGE_CALLS, last: null }
  let alive = true
  let loading = false

  const render = async () => {
    if (!alive || loading) return
    loading = true
    try {
      const [summary, calls] = await Promise.all([
        get('api/usage', { range: state.range }),
        get('api/usage/calls', { limit: 100, ...(state.model ? { model: state.model } : {}) }),
      ])
      if (!alive) return
      paint(summary ?? {}, Array.isArray(calls?.items) ? calls.items : [])
    } catch (error) {
      if (error?.status !== 401) bus.toast(error?.message || '用量没有加载出来', { danger: true })
    } finally {
      loading = false
    }
  }

  function paint(summary, calls) {
    state.last = { summary, calls }
    const totals = summary.totals ?? {}
    const byDay = Array.isArray(summary.byDay) ? summary.byDay : []
    const byModel = Array.isArray(summary.byModel) ? summary.byModel : []
    const top = Array.isArray(summary.topTickets) ? summary.topTickets : []
    const max = Math.max(0.0001, ...byDay.map((day) => Number(day.usd ?? 0)))
    const rangeLabel = RANGES.find((item) => item.key === state.range)?.label ?? '今天'
    const shownCalls = calls.slice(0, state.shown)

    root.innerHTML = `
      <div class="head">
        <div class="head__row"><h1 class="head__title">花费</h1></div>
        <p class="head__sub">${rangeLabel}共 ${money2(totals.usd ?? 0)}，${totals.calls ?? 0} 次调用；命中率越高越便宜</p>
      </div>
      <div class="seg" role="group" aria-label="时间范围">
        ${RANGES.map((item) => `<button class="seg__i" type="button" data-range="${item.key}" aria-pressed="${item.key === state.range}">${item.label}</button>`).join('')}
      </div>
      <div class="strip">
        <div class="num"><div class="num__k">合计</div><div class="num__v">${money2(totals.usd ?? 0)}</div></div>
        <div class="num"><div class="num__k">调用</div><div class="num__v">${totals.calls ?? 0} <small>次</small></div></div>
        <div class="num"><div class="num__k">前缀命中</div><div class="num__v">${Math.round(Number(totals.hitRate ?? 0) * 100)}<small>%</small></div></div>
      </div>
      ${byDay.length > 1 ? `<div class="bars" role="img" aria-label="每日花费，最高 ${money2(max)}">
        ${byDay.map((day) => `<div class="bar-col">
          <div class="bar-col__fill" style="height:${Math.max(2, Math.round((Number(day.usd ?? 0) / max) * 76))}px"></div>
          <div class="bar-col__k">${esc(dayLabel(day.day))}</div>
        </div>`).join('')}
      </div>` : ''}

      <section class="section">
        <div class="section__head"><h2 class="section__title">分模型</h2></div>
        ${byModel.length ? `<div class="list">${byModel.map((row) => `
          <div class="row row--flat${state.model === row.model ? ' row--picked' : ''}" role="button" tabindex="0" data-model="${esc(row.model)}">
            <span class="row__main">
              <span class="row__title mono">${esc(row.model)}</span>
              <span class="row__meta"><span>${row.calls ?? 0} 次调用</span><span>命中 ${Math.round(Number(row.hitRate ?? 0) * 100)}%</span>${state.model === row.model ? '<span>正在看这个模型</span>' : ''}</span>
            </span>
            <span class="row__side row__cost">${money4(row.usd ?? 0)}</span>
          </div>`).join('')}</div>` : '<p class="hint">这段时间没有调用。</p>'}
      </section>

      <section class="section">
        <div class="section__head"><h2 class="section__title">花得最多的工单</h2></div>
        ${top.length ? `<div class="list">${top.map((row) => `
          <a class="row row--link" href="#/tickets/${encodeURIComponent(row.ticketId)}">
            <span class="row__main">
              <span class="row__title">${esc(row.title || row.ticketId)}</span>
              <span class="row__meta"><span>${row.calls ?? 0} 次调用</span></span>
            </span>
            <span class="row__side row__cost">${money4(row.usd ?? 0)}</span>
          </a>`).join('')}</div>` : '<p class="hint">这段时间没有花在工单上的钱。</p>'}
      </section>

      <section class="section">
        <div class="section__head"><h2 class="section__title">最近调用</h2>
          ${state.model ? `<button class="filterchip" type="button" data-clear-model>只看 ${esc(state.model)}，点这里看全部</button>` : '<span class="section__note">按时间倒序；点上面的模型可以只看它的调用</span>'}</div>
        ${calls.length ? `<div class="list calls">${shownCalls.map((call) => `
          <a class="row row--link" href="#/tickets/${encodeURIComponent(call.ticketId)}">
            <span class="row__main">
              <span class="row__title mono">${esc(call.model || '未知模型')}</span>
              <span class="row__meta"><span>命中 ${tokens(call.promptHit ?? 0)} / 未命中 ${tokens(call.promptMiss ?? 0)}</span><span>${esc(ago(call.at))}</span><span>${Math.round(Number(call.latencyMs ?? 0))} ms</span>${call.status !== 200 ? `<span>HTTP ${call.status}</span>` : ''}</span>
            </span>
            <span class="row__side row__cost">${money4(call.costUsd ?? 0)}</span>
          </a>`).join('')}</div>
          ${calls.length > state.shown ? `<button class="loadmore" type="button" data-show-more-calls>显示更多调用（还有 ${calls.length - state.shown} 条）</button>` : ''}`
          : '<p class="hint">还没有调用记录。</p>'}
      </section>`
  }

  const pickModel = (model) => {
    state.model = state.model === model ? '' : model
    state.shown = PAGE_CALLS
    render()
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-range]')
    if (button) {
      state.range = button.dataset.range
      state.shown = PAGE_CALLS
      render()
      return
    }
    if (event.target.closest('[data-show-more-calls]')) {
      state.shown += PAGE_CALLS
      if (state.last) paint(state.last.summary, state.last.calls)
      return
    }
    if (event.target.closest('[data-clear-model]')) { state.model = ''; state.shown = PAGE_CALLS; render(); return }
    const modelRow = event.target.closest('[data-model]')
    if (modelRow) pickModel(modelRow.dataset.model)
  })

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const modelRow = event.target.closest('[data-model]')
    if (!modelRow) return
    event.preventDefault()
    pickModel(modelRow.dataset.model)
  })

  render()
  return { root, refresh: render, destroy() { alive = false } }
}
