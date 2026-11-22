/**
 * Model pricing for the gateway ledger. Prices are US dollars per million tokens. The legacy DeepSeek table (`cost`,
 * `isPeak`, `DEFAULT_PRICING`) charges peak hours and halves off-peak; `costOf` is the per-provider price used by the
 * gateway and has no time-of-day discount. Peak hours are UTC weekdays 01:00-04:00 and 06:00-10:00 (start inclusive,
 * end exclusive); weekends are off-peak.
 */
import type { Usage } from './usage.ts'

/** Peak-hour rates in USD per million tokens for one model. */
export interface ModelPrice {
  /** Cached prompt tokens (`prompt_cache_hit_tokens`). */
  cacheHit: number
  /** Uncached prompt tokens (`prompt_cache_miss_tokens`). */
  cacheMiss: number
  /** Generated tokens (`completion_tokens`). */
  output: number
}

/** A price table keyed by the model name the request asks for; callers may supply their own. */
export type PricingTable = Readonly<Record<string, ModelPrice>>

/** Default DeepSeek prices, in USD per million tokens at peak hours. */
export const DEFAULT_PRICING: PricingTable = {
  // OpenCode Go serves the same model as `deepseek-v4.1-flash` at the same list price.
  'deepseek-v4.1-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  'deepseek-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
}

/** Peak windows as UTC hours, `[start, end)`. */
const PEAK_WINDOWS: readonly (readonly [number, number])[] = [[1, 4], [6, 10]]

/** Whether `at` falls in a peak window: a UTC weekday inside 01:00-04:00 or 06:00-10:00. */
export function isPeak(at: Date): boolean {
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = at.getUTCHours()
  return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Cost in USD of one call: cache hits, cache misses, and output tokens at the model's rates, halved off-peak.
 * @throws when `model` has no entry in `pricing`.
 */
export function cost(model: string, usage: Usage, at: Date, pricing: PricingTable = DEFAULT_PRICING): number {
  const price = pricing[model]
  if (!price) throw new Error(`No price configured for model: ${model}`)
  const factor = isPeak(at) ? 1 : 0.5
  return (usage.prompt_cache_hit_tokens * price.cacheHit
    + usage.prompt_cache_miss_tokens * price.cacheMiss
    + usage.completion_tokens * price.output) / 1_000_000 * factor
}

/** One model's price at one provider, in USD per million tokens. `input` is the uncached prompt price. */
export interface Price {
  input: number
  cacheRead: number
  output: number
}

/**
 * Cost in USD of one call at `price`: uncached prompt tokens, cache-read tokens and output tokens at their own rates.
 * There is no time-of-day discount.
 */
export function costOf(price: Price, usage: Usage): number {
  return (usage.prompt_cache_miss_tokens * price.input
    + usage.prompt_cache_hit_tokens * price.cacheRead
    + usage.completion_tokens * price.output) / 1_000_000
}
