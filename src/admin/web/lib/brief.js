/**
 * Task-book helpers. Pure functions only: no DOM, no fetch, so they can be
 * loaded straight from node in tests (tests/web-brief.spec.ts).
 *
 * The moderator's brief is Markdown with a fixed shape, but models do not
 * always honour it. Everything here is therefore tolerant: a missing title is
 * fine, section order may change, "默认" may use a Chinese or an English colon,
 * and list items may be written with "-" or "1.".
 */

const ZH_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

function normalize(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

function cleanHeading(text) {
  return String(text ?? '')
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\d+[.、)]\s*/, '')
    .replace(/\s+#+\s*$/, '')
    .trim()
}

function trimBody(lines) {
  return lines.join('\n').replace(/^\n+|\n+$/g, '')
}

function headingText(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
  if (!match) return null
  return { level: match[1].length, text: cleanHeading(match[2]) }
}

/**
 * Split the brief into its title, its `##` sections, and the questions under
 * "待你确认" (each with its default answer).
 *
 * @param {string} markdown
 * @returns {{ title: string, sections: { heading: string, body: string }[], questions: { text: string, default: string }[] }}
 */
export function parseBrief(markdown) {
  const lines = normalize(markdown).split('\n')
  let title = ''
  const sections = []
  let current = null
  let fence = false

  const finish = () => {
    if (!current) return
    sections.push({ heading: current.heading, body: trimBody(current.lines) })
    current = null
  }

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) fence = !fence
    if (!fence) {
      const heading = headingText(raw)
      if (heading) {
        if (heading.level === 1) {
          finish()
          if (!title) title = heading.text
          continue
        }
        if (heading.level === 2) {
          finish()
          current = { heading: heading.text, lines: [] }
          continue
        }
      }
    }
    if (current) current.lines.push(raw)
  }
  finish()

  const confirm = sections.find((section) => /待你确认/.test(section.heading))
  return {
    title,
    sections,
    questions: confirm ? parseQuestions(confirm.body) : [],
  }
}

/**
 * Pull questions out of the "待你确认" body. Recognises `- item`, `* item`,
 * `+ item`, `1. item` and `1) item`; continuation lines belong to the item
 * above. A trailing "默认：…" (or "默认: …") becomes `default`.
 */
function parseQuestions(body) {
  const lines = normalize(body).split('\n')
  const items = []
  let current = null
  const itemPattern = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

  for (const line of lines) {
    const match = itemPattern.exec(line)
    if (match) {
      if (current) items.push(current)
      current = [match[1]]
      continue
    }
    if (!current) {
      if (line.trim()) current = [line.trim()]
      continue
    }
    if (!line.trim()) {
      if (current) { items.push(current); current = null }
      continue
    }
    current.push(line.trim())
  }
  if (current) items.push(current)

  const questions = []
  for (const parts of items) {
    const raw = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (!raw) continue
    const defaultMatch = /默认\s*[:：]\s*(.+)$/.exec(raw)
    let text = raw
    let answer = ''
    if (defaultMatch) {
      answer = defaultMatch[1].trim().replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim()
      text = raw.slice(0, defaultMatch.index).trim()
    }
    // Drop a dangling opening bracket left by "（默认：…）".
    text = text.replace(/[（(]\s*$/, '').trim()
    text = text.replace(/[，,；;：:]\s*$/, '').trim()
    if (!text && !answer) continue
    questions.push({ text: text || answer, default: answer })
  }
  return questions
}

/**
 * Append the person's answers as a final "## 已确认" section. Any existing
 * "## 已确认" section is replaced, so committing twice cannot duplicate it.
 *
 * @param {string} markdown
 * @param {Array<{ text?: string, question?: string, answer?: string, value?: string }>|Record<string, string>} answers
 * @returns {string}
 */
export function appendConfirmations(markdown, answers) {
  const base = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  const rows = []
  if (Array.isArray(answers)) {
    for (const entry of answers) {
      if (!entry || typeof entry !== 'object') continue
      const question = String(entry.text ?? entry.question ?? '').trim()
      const answer = String(entry.answer ?? entry.value ?? '').trim()
      if (!answer) continue
      rows.push(`- ${question ? `${question}：` : ''}${answer}`)
    }
  } else if (answers && typeof answers === 'object') {
    for (const [question, answer] of Object.entries(answers)) {
      const value = String(answer ?? '').trim()
      if (!value) continue
      rows.push(`- ${String(question).trim()}：${value}`)
    }
  }
  if (!rows.length) return base

  const withoutOld = base.replace(/\n#{1,6}\s*已确认[^\n]*[\s\S]*$/, '').replace(/\s+$/, '')
  return `${withoutOld}${withoutOld ? '\n\n' : ''}## 已确认\n\n${rows.join('\n')}\n`
}

/**
 * Split a decision-mode moderator output into its four parts. Missing parts
 * are empty strings; headings may be numbered and may use synonyms.
 *
 * @param {string} markdown
 * @returns {{ advice: string, reason: string, alternatives: string, risks: string }}
 */
export function splitDecision(markdown) {
  const out = { advice: '', reason: '', alternatives: '', risks: '' }
  const lines = normalize(markdown).split('\n')
  const buckets = []
  let current = null
  let fence = false

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) fence = !fence
    const heading = !fence ? headingText(raw) : null
    if (heading && heading.level <= 3) {
      current = { heading: heading.text, lines: [] }
      buckets.push(current)
      continue
    }
    if (current) current.lines.push(raw)
  }

  for (const bucket of buckets) {
    const body = trimBody(bucket.lines)
    if (!body) continue
    const heading = bucket.heading
    if (/建议/.test(heading) && !out.advice) out.advice = body
    else if (/理由/.test(heading) && !out.reason) out.reason = body
    else if (/备选|替代/.test(heading) && !out.alternatives) out.alternatives = body
    else if (/风险/.test(heading) && !out.risks) out.risks = body
  }
  return out
}

/** Chinese round word: 1 -> 第一轮. */
export function roundWord(n) {
  const value = Number(n)
  if (!Number.isFinite(value) || value < 1) return '下一轮'
  return `第${ZH_NUM[value] ?? value}轮`
}
