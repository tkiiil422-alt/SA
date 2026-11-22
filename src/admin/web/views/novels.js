/**
 * 书库：所有写小说的书，一行一本。开新书走发任务面板的写小说模式。
 * 写小说没开时，接口返回 404，这里给出去设置打开的提示。
 */
import { get } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, money2, emptyHtml } from '../lib/view.js'

const PHASE_LABEL = {
  setup: '准备中',
  drafting: '生成设定中',
  ready: '待开写',
  writing: '写作中',
  paused: '已暂停',
  done: '完结',
  failed: '设定失败',
}
const PHASE_TONE = { failed: 'ask', drafting: 'run', writing: 'run', done: 'done' }
const REFRESH_MS = 15000

function ticketIdOf(value) {
  if (typeof value === 'string') return value
  return value && typeof value === 'object' ? String(value.id ?? '') : ''
}

export function mount() {
  const root = document.createElement('div')
  root.className = 'page'
  let alive = true
  let lastAt = 0
  const state = { items: [], err: '', disabled: false, loaded: false }

  async function load() {
    try {
      const data = await get('api/novels')
      if (!alive) return
      state.items = Array.isArray(data?.items) ? data.items : []
      state.err = ''
      state.disabled = false
    } catch (error) {
      if (!alive || error?.status === 401) return
      if (error?.status === 404) state.disabled = true
      else state.err = error?.message || '请求失败'
    }
    state.loaded = true
    lastAt = Date.now()
    if (alive) paint()
  }

  function rowHtml(item) {
    const tone = PHASE_TONE[item.phase] ?? 'queue'
    const label = item.phase === 'failed'
      ? `设定失败${item.error ? `：${item.error}` : ''}`
      : (PHASE_LABEL[item.phase] ?? item.phase ?? '')
    const ticket = ticketIdOf(item.currentTicket)
    const flagged = Number(item.flagged ?? 0)
    return `<div class="row">
      <a class="row__main nv-book-link" href="#/novels/${encodeURIComponent(item.id)}">
        <span class="row__title">${esc(item.title ?? '未命名')}</span>
        <span class="row__meta"><span class="state" data-s="${tone}">${esc(label)}</span>
          <span>${esc(item.genreLabel ?? '')}</span>
          <span>第 ${esc(item.lastChapter ?? 0)} 章</span>
          <span>${Number(item.chars ?? 0).toLocaleString('zh-CN')} 字</span>
          <span>${money2(item.costUsd)}</span>
          ${flagged > 0 ? `<span class="nv-flag">${esc(flagged)} 章待你看</span>` : ''}</span>
      </a>
      <span class="row__side">${ticket ? `<a class="nv-ticket-link" href="#/tickets/${encodeURIComponent(ticket)}">当前工单</a>` : ''}</span>
    </div>`
  }

  const headHtml = (showNew) => `<div class="head"><div class="head__row">
      <h1 class="head__title">书库</h1>
      ${showNew ? '<button class="btn btn--ink" type="button" data-new-book style="margin-left:auto">开新书</button>' : ''}
    </div>
    <p class="head__sub">每本书先生成设定，你确认后再一弧一弧地写。</p></div>`

  function paint() {
    if (state.disabled) {
      root.innerHTML = `${headHtml(false)}
        <div class="banner"><span>写小说功能没有开启，去设置里打开。</span>
        <a class="btn" href="#/settings/novel" style="margin-left:auto">去设置</a></div>`
      return
    }
    if (state.err) {
      root.innerHTML = `${headHtml(false)}<div class="banner"><span>书库没读出来：${esc(state.err)}</span></div>`
      return
    }
    if (!state.loaded) {
      root.innerHTML = `${headHtml(false)}<p class="hint">正在读书库…</p>`
      return
    }
    root.innerHTML = `${headHtml(true)}${state.items.length
      ? `<div class="list">${state.items.map(rowHtml).join('')}</div>`
      : emptyHtml('书库还是空的', '点“开新书”，一句灵感就能开始。', '', '')}`
  }

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-new-book]')) bus.openCompose({ mode: 'novel' })
  })

  load()
  return {
    root,
    refresh: async () => {
      if (Date.now() - lastAt < REFRESH_MS) return
      await load()
    },
    destroy() {
      alive = false
    },
  }
}
