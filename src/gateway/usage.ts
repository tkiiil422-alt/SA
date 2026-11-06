/**
 * Token-usage extraction for upstream responses. Non-streaming responses carry `usage` in their JSON body; streaming
 * responses (SSE) carry it in `data:` blocks. OpenAI and DeepSeek report it once, in the last block with usage; Anthropic
 * splits it across `message_start` (under `message`) and `message_delta`, so the SSE parser merges the raw counters before
 * normalizing them. The parser consumes chunks as they pass through the gateway, so callers keep streaming to the client.
 */
import { StringDecoder } from 'node:string_decoder'

/** Usage counters, normalized to DeepSeek/OpenAI names so pricing and the ledger need one shape. */
export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens: number
  prompt_cache_miss_tokens: number
}

type Raw = Record<string, unknown>

const numeric = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null

/** Anthropic counters carry `input_tokens` or `output_tokens`; OpenAI and DeepSeek counters carry neither. */
const isAnthropic = (usage: Raw): boolean => 'input_tokens' in usage || 'output_tokens' in usage

/** The `usage` object of a decoded JSON value, when it has one. */
function usageObject(value: unknown): Raw | undefined {
  if (!isRecord(value)) return undefined
  const source = value.usage
  return isRecord(source) ? source : undefined
}

/**
 * Normalize raw usage counters. Anthropic counters map cache reads to hits, and uncached input plus cache writes to
 * misses. Anything else is read as DeepSeek/OpenAI counters.
 *
 * For those, a missing `prompt_cache_miss_tokens` is derived from `prompt_tokens` minus cache hits, and a missing
 * `prompt_tokens` from the cache counters. Cache hits come from `prompt_cache_hit_tokens`, or from OpenAI-style
 * `prompt_tokens_details.cached_tokens` when a compatible upstream reports them that way.
 */
function normalize(usage: Raw): Usage {
  if (isAnthropic(usage)) {
    const hit = numeric(usage.cache_read_input_tokens) ?? 0
    const miss = (numeric(usage.input_tokens) ?? 0) + (numeric(usage.cache_creation_input_tokens) ?? 0)
    return {
      prompt_tokens: hit + miss,
      completion_tokens: numeric(usage.output_tokens) ?? 0,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: miss,
    }
  }
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
  const hit = numeric(usage.prompt_cache_hit_tokens) ?? numeric(details?.cached_tokens) ?? 0
  const prompt = numeric(usage.prompt_tokens)
  const miss = numeric(usage.prompt_cache_miss_tokens) ?? (prompt === undefined ? 0 : Math.max(prompt - hit, 0))
  return {
    prompt_tokens: prompt ?? hit + miss,
    completion_tokens: numeric(usage.completion_tokens) ?? 0,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
  }
}

/** Read usage from a decoded JSON value, or `undefined` when it has none. */
export function usageFrom(value: unknown): Usage | undefined {
  const usage = usageObject(value)
  return usage ? normalize(usage) : undefined
}

/** Read usage from a non-streaming JSON response body; `undefined` when the body is not JSON or has no usage. */
export function extractUsage(body: Buffer | string): Usage | undefined {
  try {
    return usageFrom(JSON.parse(typeof body === 'string' ? body : body.toString('utf8')))
  } catch {
    return undefined
  }
}

/** Incremental SSE usage reader; feed it every chunk on its way to the client, then call `flush` at the end. */
export interface SseUsageParser {
  push(chunk: Buffer | string): void
  /** Process a trailing line that arrived without a newline. */
  flush(): void
  /** The usage seen so far, with counters merged across events; `undefined` when none was seen. */
  usage(): Usage | undefined
}

/** Create a parser that decodes SSE lines across chunk boundaries and merges the usage counters it sees. */
export function createSseUsageParser(): SseUsageParser {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  /** Raw counters from the usage blocks seen so far. Anthropic blocks merge field by field; other blocks replace. */
  let merged: Raw | undefined

  const absorb = (source: Raw): void => {
    merged = merged && isAnthropic(merged) && isAnthropic(source) ? { ...merged, ...source } : source
  }

  const consume = (line: string): void => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') return
    try {
      const event: unknown = JSON.parse(payload)
      // Anthropic nests its first counters under `message` (message_start); later events carry them at top level.
      const sources = [usageObject(isRecord(event) ? event.message : undefined), usageObject(event)]
      for (const source of sources) {
        if (source) absorb(source)
      }
    } catch {
      // Not a JSON data line (or an event split across data lines); later lines may still carry usage.
    }
  }

  const drain = (text: string): void => {
    buffer += text
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      consume(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }

  return {
    push(chunk) {
      drain(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    },
    flush() {
      buffer += decoder.end()
      if (buffer) {
        consume(buffer)
        buffer = ''
      }
    },
    usage: () => (merged ? normalize(merged) : undefined),
  }
}
