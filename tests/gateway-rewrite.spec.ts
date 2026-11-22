/** The gateway's body rewrite for relays that fail on Pi's "coding agent harness" line. */
import { describe, expect, it } from 'vitest'
import { PI_HARNESS_PHRASE, PI_HARNESS_REPLACEMENT, rewriteHarnessPhrase } from '../src/gateway/rewrite.ts'

describe('harness phrase rewrite', () => {
  it('replaces the phrase and leaves the rest of the body byte-for-byte unchanged', () => {
    const body = JSON.stringify({ model: 'gemini-3.8-flash', system: [{ type: 'text', text: `You are a coding assistant ${PI_HARNESS_PHRASE}. Help users.`, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: '中文 ok' }] })
    const out = rewriteHarnessPhrase(Buffer.from(body, 'utf8'))!
    expect(out.toString('utf8')).toBe(body.replace(PI_HARNESS_PHRASE, PI_HARNESS_REPLACEMENT))
    expect(JSON.parse(out.toString('utf8')).system[0].text).toBe(`You are a coding assistant ${PI_HARNESS_REPLACEMENT}. Help users.`)
    // Deterministic: the same input always gives the same bytes, so the upstream prompt cache keeps hitting.
    expect(rewriteHarnessPhrase(Buffer.from(body, 'utf8'))!.equals(out)).toBe(true)
  })

  it('returns undefined when there is nothing to rewrite', () => {
    expect(rewriteHarnessPhrase(Buffer.from('{"model":"x","messages":[]}'))).toBeUndefined()
  })
})
