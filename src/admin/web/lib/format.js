/**
 * Formatting helpers shared by every view.
 * Everything here is pure (no DOM) so it can be unit-tested with node.
 */

const pad = (n) => String(n).padStart(2, '0')

/** Parse an ISO timestamp; null when unusable. */
export function asDate(iso) {
  if (!iso) return null
  const value = typeof iso === 'number' ? iso : Date.parse(iso)
  return Number.isFinite(value) ? new Date(value) : null
}

/** "3 分钟前" / "2 小时后"; empty input becomes a dash. */
export function relTime(iso, now = Date.now()) {
  const date = asDate(iso)
  if (!date) return '—'
  const diff = Math.round((now - date.getTime()) / 1000)
  const future = diff < -1
  const n = Math.abs(diff)
  const suffix = future ? '后' : '前'
  if (n < 5) return future ? '马上' : '刚刚'
  if (n < 60) return `${n} 秒${suffix}`
  if (n < 3600) return `${Math.floor(n / 60)} 分钟${suffix}`
  if (n < 86400) return `${Math.floor(n / 3600)} 小时${suffix}`
  if (n < 86400 * 30) return `${Math.floor(n / 86400)} 天${suffix}`
  if (n < 86400 * 365) return `${Math.floor(n / (86400 * 30))} 个月${suffix}`
  return `${Math.floor(n / (86400 * 365))} 年${suffix}`
}

/** Absolute local time, e.g. 2026-11-05 14:03:22. */
export function absTime(iso) {
  const date = asDate(iso)
  if (!date) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Day label used by the usage charts, e.g. 11-05. */
export function dayLabel(day) {
  if (!day) return ''
  const date = asDate(`${day}T00:00:00`)
  return date ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : String(day)
}

/** Duration in seconds -> compact Chinese ("2 天 3 小时"). */
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
  }
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return h ? `${d} 天 ${h} 小时` : `${d} 天`
}

/** Money in USD with four decimals ($0.0001 resolution). */
export function usd(value, digits = 4) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '$—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** Optional rough yuan conversion shown as secondary text. */
export function yuan(value, rate = 7.2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  return `约 ¥${(n * rate).toFixed(2)}`
}

/** Integer token counts with thousands separators. */
export function tokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

/** Ratio 0..1 -> "91.2%". */
export function pct(ratio, digits = 1) {
  const n = Number(ratio)
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

/** Value already in percent -> "12.5%". */
export function pctValue(value, digits = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

/** Number -> "1.4 GB" style size, input in megabytes by default. */
export function size(value, unit = 'MB') {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (unit === 'MB') {
    if (n >= 1024) return `${(n / 1024).toFixed(2)} GB`
    return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} MB`
  }
  return `${n.toFixed(1)} ${unit}`
}

/** Byte count -> "1.4 KB" / "2.1 MB". */
export function bytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Shorten an identifier for tight rows, keeping the tail readable. */
export function shortId(id, head = 10, tail = 4) {
  const text = String(id ?? '')
  if (text.length <= head + tail + 1) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

/** First non-empty string among candidates. */
export function firstText(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value
  return ''
}
