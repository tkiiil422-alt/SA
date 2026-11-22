/**
 * Request-body rewrites applied by the gateway before a call goes upstream.
 *
 * Measured 2026-11-15 on the `gw` relay with `gemini-3.8-flash`: any request whose system prompt contains Pi's opening
 * line "running inside pi, a coding agent harness" hangs about 140 s and then comes back as HTTP 200 with the text
 * "RESOURCE_EXHAUSTED (code 429)". The same request with that phrase replaced answers in 6 s. Plain direct calls, the
 * tool list, headers, `?beta=true` and `max_tokens` made no difference.
 *
 * The rewrite is a byte-level string replace on the JSON body: the phrase contains no characters JSON escapes, so the
 * rest of the body (and therefore the upstream prompt-cache prefix) stays byte-for-byte stable from call to call.
 */

export const PI_HARNESS_PHRASE = 'running inside pi, a coding agent harness'
export const PI_HARNESS_REPLACEMENT = 'running in a container'

/** The body with Pi's harness phrase replaced, or undefined when it does not contain it. */
export function rewriteHarnessPhrase(body: Buffer): Buffer | undefined {
  const text = body.toString('utf8')
  if (!text.includes(PI_HARNESS_PHRASE)) return undefined
  return Buffer.from(text.split(PI_HARNESS_PHRASE).join(PI_HARNESS_REPLACEMENT), 'utf8')
}
