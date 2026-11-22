/**
 * Shared rendering for a council meeting: the seat stamps, one turn, the round
 * headings and the decision output. Both views/council.js and views/ticket.js
 * use this so a decision meeting looks the same wherever it is shown.
 */
import { esc } from './view.js'
import { renderMarkdown } from './markdown.js'
import { splitDecision, roundWord } from './brief.js'
import { bus } from './bus.js'

const SEAT_CHAR = {
  analyst: '需',
  architect: '架',
  engineer: '工',
  tester: '测',
  risk: '险',
  host: '主',
}

const KNOWN_SEATS = new Set(Object.keys(SEAT_CHAR))

export function modeWord(mode) {
  return mode === 'decision' ? '决策会商' : '需求会商'
}

export function statusWord(status) {
  if (status === 'done') return '已完成'
  if (status === 'failed') return '没能完成'
  if (status === 'cancelled') return '已取消'
  return '进行中'
}

export function seatChar(turn) {
  const roleId = String(turn?.roleId ?? '')
  if (SEAT_CHAR[roleId]) return SEAT_CHAR[roleId]
  const name = String(turn?.name ?? '').trim()
  return name ? [...name][0] : '议'
}

export function seatClass(roleId) {
  const id = String(roleId ?? '')
  return KNOWN_SEATS.has(id) ? `seat-${id}` : 'seat-custom'
}

export function msText(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1000) return `${Math.round(value)} 毫秒`
  return `${Math.max(1, Math.round(value / 1000))} 秒`
}

export function roundHeading(n) {
  return n === 1 ? `${roundWord(1)} · 各抒己见` : `${roundWord(n)} · 回应与修正`
}

export function roundProgress(council) {
  const total = Array.isArray(council?.rounds) ? council.rounds.length : 0
  const phase = String(council?.phase ?? '')
  if (council?.status === 'done') return `共 ${total} 轮`
  if (council?.status === 'failed') return total ? `共 ${total} 轮未完成` : '还没开始'
  if (council?.status === 'cancelled') return total ? `共 ${total} 轮，已取消` : '已取消'
  if (phase === 'summary') return `主持人汇总中 / 共 ${total} 轮`
  const round = /^round-(\d+)$/.exec(phase)
  if (round) return `第 ${round[1]} 轮 / 共 ${total} 轮`
  return total ? `准备开始 / 共 ${total} 轮` : '准备开始'
}

export function seatStampHtml(turn) {
  return `<span class="cv-seat ${seatClass(turn?.roleId)}" aria-hidden="true"><span class="seat-stamp">${esc(seatChar(turn))}</span></span>`
}

export function turnHtml(turn) {
  const status = ['done', 'running', 'failed', 'pending'].includes(turn?.status) ? turn.status : 'pending'
  const name = turn?.name || '这一位'
  let body = ''
  if (status === 'pending') body = '<p class="cv-turn__wait">等待发言</p>'
  else if (status === 'running') body = `<div class="cv-skeleton" aria-hidden="true"><i></i><i></i><i></i></div><p class="cv-turn__wait">正在发言</p>`
  else if (status === 'failed') body = '<p class="cv-turn__failed"><span class="cv-mark" aria-hidden="true">—</span>这位没能发言</p>'
  else body = `<div class="read cv-turn__body">${renderMarkdown(turn?.text ?? '')}</div>`
  const time = status === 'done' && turn?.ms ? `<span class="cv-turn__ms">${msText(turn.ms)}</span>` : ''
  return `<article class="cv-turn" data-status="${status}">
    ${seatStampHtml(turn)}
    <div class="cv-turn__main">
      <div class="cv-turn__head"><span class="cv-turn__name">${esc(name)}</span>${time}</div>
      ${body}
    </div>
  </article>`
}

export function roundsHtml(rounds) {
  const list = Array.isArray(rounds) ? rounds : []
  if (!list.length) return '<p class="hint">会商刚开始，还没有人发言。</p>'
  return list.map((round) => `<section class="cv-round">
    <h3 class="cv-round__title">${esc(roundHeading(round?.n ?? 1))}</h3>
    ${(Array.isArray(round?.turns) ? round.turns : []).map(turnHtml).join('')}
  </section>`).join('')
}

export function hostNoteHtml(council) {
  if (!council?.brief) return ''
  if (council.mode === 'decision') {
    return `<section class="cv-round cv-round--host">
      <h3 class="cv-round__title">主持人汇总</h3>
      <article class="cv-turn" data-status="done">
        ${seatStampHtml({ roleId: 'host', name: '主持人' })}
        <div class="cv-turn__main">
          <div class="cv-turn__head"><span class="cv-turn__name">主持人</span></div>
          ${decisionHtml(council.brief)}
        </div>
      </article>
    </section>`
  }
  return `<section class="cv-round cv-round--host">
    <h3 class="cv-round__title">主持人汇总</h3>
    <article class="cv-turn" data-status="done">
      ${seatStampHtml({ roleId: 'host', name: '主持人' })}
      <div class="cv-turn__main">
        <div class="cv-turn__head"><span class="cv-turn__name">主持人</span></div>
        <p class="cv-turn__body cv-host-note">主持人把讨论汇总成了任务书，见下方。</p>
      </div>
    </article>
  </section>`
}

export function decisionParts(markdown) {
  const parts = splitDecision(markdown)
  const any = parts.advice || parts.reason || parts.alternatives || parts.risks
  if (!any && String(markdown ?? '').trim()) parts.advice = String(markdown).trim()
  return parts
}

export function decisionHtml(markdown) {
  const parts = decisionParts(markdown)
  const section = (label, body) => `<section class="cv-decision__part">
    <h4 class="cv-decision__label">${esc(label)}</h4>
    ${body ? `<div class="read">${renderMarkdown(body)}</div>` : '<p class="hint">主持人没写到这一部分。</p>'}
  </section>`
  return `<div class="cv-decision">
    ${section('建议', parts.advice)}
    ${section('理由', parts.reason)}
    ${section('备选', parts.alternatives)}
    ${section('风险', parts.risks)}
  </div>`
}

export function briefHtml(markdown) {
  return `<article class="read cv-brief__read">${renderMarkdown(markdown ?? '')}</article>`
}

/**
 * Copy text. Plain HTTP pages (the production console) have no
 * navigator.clipboard, so fall back to a hidden textarea + execCommand; if that
 * also fails, show a dialog with the text selected instead of failing silently.
 */
export async function copyText(text, label = '已复制') {
  const value = String(text ?? '')
  if (!value) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      bus.toast(label)
      return true
    }
  } catch { /* plain HTTP or permission denied: fall through */ }

  const field = document.createElement('textarea')
  field.value = value
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  field.style.pointerEvents = 'none'
  document.body.appendChild(field)
  field.select()
  let copied = false
  try { copied = document.execCommand('copy') } catch { copied = false }
  field.remove()
  if (copied) {
    bus.toast(label)
    return true
  }
  showManualCopy(value)
  bus.toast('自动复制没成功，已给出可手动复制的文本框', { danger: true })
  return false
}

function showManualCopy(value) {
  document.querySelector('.cv-copy')?.remove()
  const host = document.createElement('div')
  host.className = 'cv-copy'
  host.innerHTML = `<div class="cv-copy__backdrop" data-copy-close></div>
    <div class="cv-copy__panel" role="dialog" aria-modal="true" aria-label="手动复制">
      <h2 class="cv-copy__title">请手动复制</h2>
      <p class="hint">浏览器不允许自动复制。下面的文字已经选中，按 Ctrl+C 即可。</p>
      <textarea class="textarea cv-copy__field" readonly>${esc(value)}</textarea>
      <div class="bar-actions"><button class="btn" type="button" data-copy-close>关掉</button></div>
    </div>`
  document.body.appendChild(host)
  const close = () => host.remove()
  host.querySelectorAll('[data-copy-close]').forEach((node) => node.addEventListener('click', close))
  const field = host.querySelector('textarea')
  field.focus()
  field.select()
  document.addEventListener('keydown', function onKey(event) {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close()
    document.removeEventListener('keydown', onKey, true)
  }, true)
}
