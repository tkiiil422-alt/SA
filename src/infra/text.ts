/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const IM_WORDS = 100
export const NOTE_WORDS = 30
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) throw new Error(`IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`)
  return text
}
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
/** Case-insensitive comparison for GitHub logins and repository names. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One leading list, quote, heading or ordinal marker (`#`, `>`, `*`, `+`, `-`, whitespace, `1.`, `1)`, `1、`). */
const LEADING_MARK = /^(?:[#>*+\-\s]+|\d+(?:[.)]\s+|[)、]\s*))/

/** Strips leading markers repeatedly, so `- # 1. text` becomes `text`. */
function stripLeadingMarks(line: string): string {
  let rest = line
  let previous: string
  do {
    previous = rest
    rest = rest.replace(LEADING_MARK, '')
  } while (rest !== previous)
  return rest
}

/**
 * A one-line title from a multi-line text: the first line with content after its leading markers are removed,
 * backticks dropped, whitespace collapsed. Falls back to the trimmed text when nothing is left. Cut to `max` characters
 * (not UTF-16 code units), with no ellipsis.
 */
export function plainTitle(text: string, max = 60): string {
  const clip = (value: string): string => Array.from(value).slice(0, max).join('')
  for (const line of text.split(/\r?\n/)) {
    const body = stripLeadingMarks(line)
    if (body.trim() === '') continue
    const marked = body !== line.trimStart()
    let title = body.replace(/`/g, '')
    // A trailing run of `*` or `#` is bold or heading closing marks, so it goes only when a leading mark was removed.
    if (marked) title = title.replace(/[*#]+$/, '')
    title = title.replace(/\s+/g, ' ').trim()
    if (title !== '') return clip(title)
    break
  }
  return clip(text.trim())
}
