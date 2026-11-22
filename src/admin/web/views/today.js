/** 今日: a connect hint, alerts, what waits for a person, what the machine is doing, the day's numbers, and today's endings. */
import { get, post, loadOverview, invalidateOverview } from '../lib/api.js'
import { bus } from '../lib/bus.js'
import { esc, money2, money4, ago, rowHtml, stateWord, emptyHtml } from '../lib/view.js'

const MODE = { off: '不接推断', observe: '只记录', auto: '自动接单' }
const HINT_KEY = 'sa-connect-hint-closed'

function todayLabel() {
  const now = new Date()
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 周${week}`
}

function readHintClosed() {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

function writeHintClosed() {
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch { /* a private window may refuse storage */ }
}

/**
 * Read once per mount. GitHub and email both unbound -> show the hint.
 * A bound channel hides it; if both reads failed we show nothing (no false alarm).
 */
async function loadConnectHint() {
  let gh = null
  let em = null
  let ghFail = false
  let emFail = false
  try { gh = await get('api/settings/github') } catch { ghFail = true }
  try { em = await get('api/settings/email/status') } catch { emFail = true }
  const ghBound = !ghFail && Boolean(gh?.tokenSet)
  const emBound = !emFail && Boolean(em?.state) && em.state !== 'off'
  return { show: !ghBound && !emBound && !(ghFail && emFail) }
}

function alertHtml(alert) {
  const level = alert.level === 'error' ? 'error' : 'warn'
  const go = alert.link ? `<a class="btn btn--quiet alert__go" href="${esc(alert.link)}">去看看</a>` : ''
  return `<div class="alert" data-level="${level}">
    <span class="alert__flag"></span>
    <span class="alert__text"><span class="alert__title">${esc(alert.text)}</span></span>
    ${go}
  </div>`
}

function needsCard(ticket) {
  const question = ticket.question
  const kind = question ? '等你回答' : (ticket.stageLabel || '等你处理')
  const hint = question ? '问题来自它最近一次报告；工单停在这里等你，不占槽位' : (ticket.stageHint || '看过就可以决定下一步')
  return `
    <article class="ask" data-ticket="${esc(ticket.id)}">
      <span class="ask__kind">${esc(kind)}</span>
      <h3 class="ask__title">${esc(ticket.title)}</h3>
      ${question ? `<p class="ask__q">${esc(question)}</p>` : ''}
      <p class="ask__hint">${esc(hint)}</p>
      <div class="ask__reply">
        ${question ? `<div class="replybox">
          <input class="input" type="text" placeholder="直接回一句" aria-label="回复这个问题" data-reply-input>
          <button class="btn btn--human" type="button" data-action="reply">回复</button>
        </div>` : ''}
        <div class="bar-actions">
          <a class="btn ${question ? 'btn--quiet' : 'btn--ink'}" href="#/tickets/${encodeURIComponent(ticket.id)}${question ? '' : '#report'}">${question ? '看详情' : '看报告'}</a>
          <button class="btn btn--quiet" type="button" data-action="note">留句话</button>
          <button class="btn btn--danger" type="button" data-action="stop">停止</button>
        </div>
      </div>
    </article>`
}

/** A compact running row: one line, state word first, no card. */
function runHtml(ticket) {
  return `
    <a class="row row--link row--compact" href="#/tickets/${encodeURIComponent(ticket.id)}">
      <span class="row__main">
        <span class="row__title">${esc(ticket.title)}</span>
        <span class="row__meta">${stateWord(ticket)}<span>${esc(ago(ticket.updatedAt))}</span>${ticket.costUsd > 0 ? `<span>${money4(ticket.costUsd)}</span>` : ''}</span>
      </span>
    </a>`
}

export function mount(ctx) {
  const root = document.createElement('div')
  root.className = 'page'
  let alive = true
  let busy = false
  let hint = null // null until the one-time read lands
  let hintLoading = false
  let hintClosed = readHintClosed()

  const hintHtml = () => (hint?.show && !hintClosed)
    ? `<div class="connect-hint" role="region" aria-label="连接提示">
        <span class="connect-hint__text">还没绑定 GitHub 和邮箱，AI 暂时不能推代码、收发邮件。</span>
        <a class="btn btn--ink connect-hint__go" href="#/connections">去连接</a>
        <button class="connect-hint__close" type="button" data-hint-close aria-label="关闭这条提示">关闭</button>
      </div>`
    : ''

  const render = async () => {
    if (!alive) return
    if (hint === null && !hintLoading) {
      hintLoading = true
      loadConnectHint().then((result) => {
        hint = result
        hintLoading = false
        if (alive && result.show && !hintClosed) render()
      })
    }
    let overview
    let list
    try {
      overview = await loadOverview()
      list = await get('api/tickets', { status: 'all', limit: 50 })
    } catch (error) {
      if (error?.status === 401) return
      root.innerHTML = `${hintHtml()}<div class="banner"><span>没能读到今日数据：${esc(error?.message || '请求失败')}</span></div>`
      return
    }
    if (!alive) return
    // Councils that are running, or finished but not yet turned into a ticket: they live nowhere else in the lists.
    let councils = []
    try {
      const result = await get('api/councils', { limit: 20 })
      councils = (Array.isArray(result?.items) ? result.items : [])
        .filter((item) => !item.ticketId && (item.status === 'running' || item.status === 'done'))
        .slice(0, 5)
    } catch { /* councils are optional */ }

    const tickets = Array.isArray(list.items) ? list.items : []
    const needs = tickets.filter((ticket) => ticket.needsPerson || ticket.stage?.stage === 'person')
    const running = tickets.filter((ticket) => ticket.status === 'open' && !(ticket.needsPerson || ticket.stage?.stage === 'person'))
    const ended = tickets.filter((ticket) => ticket.status === 'ended').slice(0, 5)
    const usage = overview.usage ?? {}
    const usedPct = Math.round(Number(usage.budgetUsedPct ?? 0) * 100)
    const alerts = Array.isArray(overview.alerts) ? overview.alerts : []

    root.innerHTML = `
      ${hintHtml()}
      ${alerts.length ? `<div class="alert-list">${alerts.map(alertHtml).join('')}</div>` : ''}
      <div class="head">
        <div class="head__row"><h1 class="head__title">今日</h1></div>
        <p class="head__sub">${esc(todayLabel())}，${usage.todayCalls ?? 0} 次模型调用，前缀命中 ${Math.round(Number(usage.cacheHitRate ?? 0) * 100)}%，接单模式：${esc(MODE[overview.acceptMode] ?? overview.acceptMode ?? '—')}</p>
      </div>

      <section class="section">
        <div class="section__head">
          <h2 class="section__title">需要你处理</h2>
          <span class="section__count">${needs.length} 件</span>
          ${needs.length ? '<span class="section__note">处理完就不用管了</span>' : '<span class="section__note">都处理完了</span>'}
        </div>
        ${needs.length
          ? `<div class="need">${needs.map(needsCard).join('')}</div>`
          : emptyHtml('没有等你的事', running.length ? `${running.length} 张在忙，有事会在这里找你。` : '现在没有在跑的任务，发一句话就能开始。', '看全部任务', '#/tickets')}
      </section>

      ${councils.length ? `<section class="section">
        <div class="section__head">
          <h2 class="section__title">会商</h2>
          <span class="section__count">${councils.length} 场</span>
          <span class="section__note">任务书确认后才会开工</span>
        </div>
        <div class="list">${councils.map((item) => `
          <a class="row row--link row--compact" href="#/council/${encodeURIComponent(item.id)}">
            <span class="row__main">
              <span class="row__title">${esc(String(item.topic || '会商').split(/\r?\n/).find((line) => line.trim()) ?? '会商')}</span>
              <span class="row__meta"><span>${item.status === 'running' ? '讨论中' : '待你确认任务书'}</span><span>${esc(ago(item.createdAt))}</span></span>
            </span>
          </a>`).join('')}</div>
      </section>` : ''}

      <section class="section">
        <div class="section__head">
          <h2 class="section__title">机器在干活</h2>
          <span class="section__count">${running.length} 件</span>
        </div>
        ${running.length
          ? `<div class="list">${running.map((ticket) => runHtml(ticket)).join('')}</div>`
          : '<p class="hint">现在没有在跑的任务。</p>'}
      </section>

      <div class="strip">
        <div class="num"><div class="num__k">今日花费</div><div class="num__v">${money2(usage.todayUsd ?? 0)}</div><div class="meter meter--thin"><i style="width:${Math.min(100, usedPct)}%"></i></div></div>
        <div class="num"><div class="num__k">模型调用</div><div class="num__v">${usage.todayCalls ?? 0} <small>次</small></div></div>
        <div class="num"><div class="num__k">前缀命中</div><div class="num__v">${Math.round(Number(usage.cacheHitRate ?? 0) * 100)}<small>%</small></div></div>
      </div>
      <p class="hint strip-note">${usage.dailyBudgetUsd > 0 ? `日上限 ${money2(usage.dailyBudgetUsd)}，已用 ${usedPct}%；到 100% 会被网关拦住并停下来问你。` : '没有设置日上限；在设置里可以设一个。'}</p>

      ${ended.length ? `<section class="section">
        <div class="section__head"><h2 class="section__title">今天收工</h2><span class="section__count">${overview.tickets?.endedToday ?? ended.length} 件</span></div>
        <div class="list">${ended.map((ticket) => rowHtml(ticket)).join('')}</div>
      </section>` : ''}

      <p class="hint-row"><span class="kbd">j</span><span class="kbd">k</span> 移动，<span class="kbd">Enter</span> 打开，<span class="kbd">⌘K</span> 跳到任务</p>`
  }

  async function onKey(event) {
    if (event.key !== 'Enter' || event.target.tagName !== 'INPUT') return
    const card = event.target.closest('.ask')
    if (!card) return
    event.preventDefault()
    await reply(card)
  }

  async function reply(card) {
    const id = card.dataset.ticket
    const input = card.querySelector('[data-reply-input]')
    const text = input?.value?.trim()
    if (!text) return
    await act(id, () => post(`api/tickets/${encodeURIComponent(id)}/reply`, { text }), '已回复，它下一轮会读到')
  }

  async function act(id, run, message) {
    if (busy) return
    busy = true
    try {
      await run()
      bus.toast(message)
      invalidateOverview()
      await bus.refreshOverview()
      await render()
    } catch (error) {
      bus.toast(error?.message || '操作没有成功', { danger: true })
    } finally {
      busy = false
    }
  }

  async function onClick(event) {
    if (event.target.closest('[data-hint-close]')) {
      hintClosed = true
      writeHintClosed()
      root.querySelector('.connect-hint')?.remove()
      return
    }
    const card = event.target.closest('.ask')
    if (!card) return
    const id = card.dataset.ticket
    const action = event.target.closest('[data-action]')?.dataset.action
    if (action === 'reply') { await reply(card); return }
    if (action === 'note') {
      const values = await bus.sheet({
        title: '留一句话',
        text: '这句话会作为备注送到这张工单，不触发模型，也不改变它的状态。',
        confirmLabel: '送过去',
        field: { id: 'text', label: '备注', placeholder: '比如：先按万一跑，别管手续费了' },
      })
      const text = values?.text?.trim()
      if (!text) return
      await act(id, () => post(`api/tickets/${encodeURIComponent(id)}/note`, { text }), '已送到这张工单')
      return
    }
    if (action === 'stop') {
      const values = await bus.sheet({
        title: '停止这张工单？',
        text: '停止后它不再继续，已经花的钱不退；之后在详情里点「新指令」就能让它接着干。',
        confirmLabel: '停止',
        danger: true,
        field: { id: 'reason', label: '原因（可选，会记进事件）', placeholder: '比如：方向不对，先别跑了' },
      })
      if (!values) return
      const reason = values.reason?.trim()
      await act(id, () => post(`api/tickets/${encodeURIComponent(id)}/stop`, reason ? { reason } : {}), '已停止这张工单')
    }
  }

  // Listeners go on the persistent root once; render() only replaces its children.
  root.addEventListener('click', onClick)
  root.addEventListener('keydown', onKey)

  render().catch(() => {})
  return { root, refresh: render, destroy() { alive = false } }
}
