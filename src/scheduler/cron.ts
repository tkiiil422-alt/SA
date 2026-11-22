/**
 * 零依赖标准 5 段 Cron 表达式解析器（分 时 日 月 周）。
 *
 * 支持：
 * - 通配符 `*`、步长 `* / n`、区间 `a-b`、带步长区间 `a-b/n`、逗号列表 `a,b,c`
 * - 星期字段 `0` 和 `7` 均表示周日
 * - 快捷别名：`@hourly`、`@daily`、`@weekly`、`@monthly`
 */

export interface ParsedCron {
  readonly expr: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  readonly domWildcard: boolean
  readonly dowWildcard: boolean
}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
}

function parseField(raw: string, min: number, max: number, label: string, normalize7To0 = false): { values: Set<number>; wildcard: boolean } {
  const field = raw.trim()
  if (!field) throw new Error(`Cron「${label}」字段不能为空`)
  const values = new Set<number>()
  const wildcard = field === '*'

  const add = (n: number): void => {
    const v = normalize7To0 && n === 7 ? 0 : n
    if (!Number.isInteger(v) || v < min || v > (normalize7To0 ? 6 : max)) {
      throw new Error(`Cron「${label}」取值 ${n} 超出范围（${min}-${max}）`)
    }
    values.add(v)
  }

  for (const part of field.split(',')) {
    const token = part.trim()
    if (!token) throw new Error(`Cron「${label}」存在空项`)
    const slashParts = token.split('/')
    if (slashParts.length > 2) throw new Error(`Cron「${label}」步长语法不合法：${token}`)
    const rangeExpr = slashParts[0]!
    const step = slashParts.length === 2 ? Number(slashParts[1]) : 1
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Cron「${label}」步长必须是正整数：${token}`)
    }

    if (rangeExpr === '*') {
      const upper = normalize7To0 ? 6 : max
      for (let v = min; v <= upper; v += step) add(v)
      continue
    }

    const dashParts = rangeExpr.split('-')
    if (dashParts.length === 1) {
      const n = Number(dashParts[0])
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`Cron「${label}」取值不合法：${token}（允许 ${min}-${max}）`)
      }
      if (slashParts.length === 2) {
        const upper = normalize7To0 ? 6 : max
        for (let v = normalize7To0 && n === 7 ? 0 : n; v <= upper; v += step) add(v)
      } else {
        add(n)
      }
      continue
    }

    if (dashParts.length === 2) {
      const start = Number(dashParts[0])
      const end = Number(dashParts[1])
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error(`Cron「${label}」范围不合法：${token}（允许 ${min}-${max}）`)
      }
      for (let v = start; v <= end; v += step) add(v)
      continue
    }

    throw new Error(`Cron「${label}」格式不合法：${token}`)
  }

  if (values.size === 0) throw new Error(`Cron「${label}」未匹配任何有效值`)
  return { values, wildcard }
}

/** 解析并校验 5 段 Cron 表达式。 */
export function parseCron(input: string): ParsedCron {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Cron 表达式不能为空')
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed
  const parts = expanded.split(/\s+/)
  if (parts.length !== 5) {
    throw new Error('Cron 表达式必须是 5 段（分 时 日 月 周），例如 "30 8 * * *" 表示每天 08:30')
  }
  const min = parseField(parts[0]!, 0, 59, '分钟')
  const hour = parseField(parts[1]!, 0, 23, '小时')
  const dom = parseField(parts[2]!, 1, 31, '日')
  const mon = parseField(parts[3]!, 1, 12, '月')
  const dow = parseField(parts[4]!, 0, 7, '星期', true)

  return {
    expr: trimmed,
    minutes: min.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: mon.values,
    daysOfWeek: dow.values,
    domWildcard: dom.wildcard,
    dowWildcard: dow.wildcard,
  }
}

function dayMatches(parsed: ParsedCron, d: Date): boolean {
  const domOk = parsed.daysOfMonth.has(d.getDate())
  const dowOk = parsed.daysOfWeek.has(d.getDay())
  // 标准 Vixie Cron 语义：日与周均非通配符时取并集（任一命中即可），否则取交集。
  if (!parsed.domWildcard && !parsed.dowWildcard) return domOk || dowOk
  return domOk && dowOk
}

/** 计算给定时间点 `after` 之后的下一次触发时间（严格晚于 `after`，精确到分钟）。 */
export function nextCronTime(exprOrParsed: string | ParsedCron, after: Date = new Date()): Date {
  const parsed = typeof exprOrParsed === 'string' ? parseCron(exprOrParsed) : exprOrParsed
  const cursor = new Date(after.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  const maxYear = cursor.getFullYear() + 4
  let guard = 0
  while (cursor.getFullYear() <= maxYear && guard < 10_000) {
    guard += 1
    if (!parsed.months.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(parsed, cursor)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!parsed.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!parsed.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }
    return cursor
  }
  throw new Error(`Cron 表达式「${parsed.expr}」在未来 4 年内无有效触发时间`)
}

/** 预览未来 N 次触发时间（ISO 字符串）。 */
export function previewCronTimes(expr: string, count = 5, from: Date = new Date()): string[] {
  const parsed = parseCron(expr)
  const out: string[] = []
  let cur = from
  for (let i = 0; i < Math.max(1, Math.min(20, count)); i += 1) {
    cur = nextCronTime(parsed, cur)
    out.push(cur.toISOString())
  }
  return out
}
