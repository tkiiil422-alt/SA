/** Small rendering helpers shared by the rewritten views. */
import { relTime, usd } from './format.js'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape untrusted text for an HTML template. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])
}

export const money2 = (value) => usd(value ?? 0, 2)
export const money4 = (value) => usd(value ?? 0, 4)
export const ago = (iso) => relTime(iso)

/** The colour family of a ticket's state: cinnabar for "a person must decide", pine for the machine. */
export function toneOf(ticket) {
  if (ticket.status === 'ended' || ticket.stage?.stage === 'ended') return 'done'
  if (ticket.needsPerson || ticket.stage?.stage === 'person') return 'ask'
  if (ticket.stage?.stage === 'working') return ticket.stage.action === 'queued' ? 'queue' : 'run'
  return 'queue'
}

/** A short state word; `stageLabel` comes from the API and already reads like a person wrote it. */
export function stateWord(ticket) {
  const ended = ticket.status === 'ended' || ticket.stage?.stage === 'ended'
  const fallback = ended ? '已结束'
    : ticket.question ? '等你回答'
    : ticket.needsPerson ? '等你处理'
    : ticket.stage?.action === 'queued' ? '排队'
    : ticket.stage?.stage === 'working' ? '在跑'
    : '进行中'
  const label = ticket.stageLabel || fallback
  return `<span class="state" data-s="${toneOf(ticket)}">${esc(label)}</span>`
}

/** The stamp only appears on a finished ticket; it is the one ornament in the list. */
export function stampFor(ticket) {
  if (ticket.status !== 'ended' && ticket.stage?.stage !== 'ended') return ''
  const outcome = ticket.outcome
  if (outcome === 'stopped') return '<span class="stamp" data-s="stopped">停止</span>'
  if (outcome === 'dropped') return '<span class="stamp" data-s="stopped">放弃</span>'
  if (outcome === 'completed' || outcome === 'merged') return '<span class="stamp" data-s="done">完成</span>'
  return '<span class="stamp" data-s="stopped">结束</span>'
}

/** One list row; the caller supplies the href so the same row works in every list. */
export function rowHtml(ticket, { href } = {}) {
  const link = href ?? `#/tickets/${encodeURIComponent(ticket.id)}`
  const question = ticket.question
    ? `<span class="row__q">等你回答：${esc(ticket.question)}</span>`
    : ''
  const meta = [
    stateWord(ticket),
    `<span>${esc(ago(ticket.updatedAt))}</span>`,
    ticket.costUsd > 0 ? `<span>${money4(ticket.costUsd)}</span>` : '',
  ].filter(Boolean).join('')
  return `
    <a class="row row--link" href="${link}">
      <span class="row__main">
        <span class="row__title">${esc(ticket.title)}</span>
        <span class="row__meta">${meta}</span>
        ${question}
      </span>
      <span class="row__side">${stampFor(ticket) || (ticket.costUsd > 0 ? `<span class="row__cost">${money4(ticket.costUsd)}</span>` : '')}</span>
    </a>`
}

/** A centred message for an empty list. */
export function emptyHtml(title, text, actionLabel, href) {
  return `
    <div class="empty">
      <p class="empty__title">${esc(title)}</p>
      <p class="empty__text">${esc(text)}</p>
      ${actionLabel && href ? `<a class="btn btn--quiet" href="${href}" style="margin-top:8px;padding-left:0">${esc(actionLabel)}</a>` : ''}
    </div>`
}

/** Replace a container's children after an async load, keeping the scroll position. */
export function renderInto(host, html) {
  const y = window.scrollY
  host.innerHTML = html
  requestAnimationFrame(() => window.scrollTo(0, y))
}

export const icons = {
  chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
}
