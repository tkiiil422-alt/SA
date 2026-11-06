import { describe, expect, it } from 'vitest'
import { createSseUsageParser, extractUsage, usageFrom } from '../src/gateway/usage.ts'

describe('anthropic usage', () => {
  it('reads usage from a non-streaming Messages response', () => {
    const body = JSON.stringify({
      id: 'msg_1',
      type: 'message',
      usage: { input_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 50, output_tokens: 20 },
    })

    expect(extractUsage(body)).toEqual({
      prompt_tokens: 450,
      completion_tokens: 20,
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 150,
    })
  })

  it('merges message_start and message_delta usage in an SSE stream', () => {
    const parser = createSseUsageParser()
    parser.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":300,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n')
    parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n')
    parser.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n')
    parser.flush()

    expect(parser.usage()).toEqual({
      prompt_tokens: 400,
      completion_tokens: 42,
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 100,
    })
  })

  it('merges Anthropic usage correctly when SSE lines are split across chunks', () => {
    const stream = 'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":3,"output_tokens":1}}}\n\n'
      + 'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n'
    const bytes = Buffer.from(stream, 'utf8')
    const parser = createSseUsageParser()
    const cut = Math.floor(bytes.length / 2)
    parser.push(bytes.subarray(0, cut))
    parser.push(bytes.subarray(cut))
    parser.flush()

    expect(parser.usage()).toEqual({
      prompt_tokens: 10,
      completion_tokens: 9,
      prompt_cache_hit_tokens: 3,
      prompt_cache_miss_tokens: 7,
    })
  })
})

describe('openai usage', () => {
  it('still reads cache hits from prompt_tokens_details.cached_tokens', () => {
    expect(usageFrom({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_cache_hit_tokens: 4,
      prompt_cache_miss_tokens: 6,
    })
  })

  it('takes the last OpenAI-style usage block in an SSE stream rather than merging it', () => {
    const parser = createSseUsageParser()
    parser.push('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":3}}\n\n')
    parser.push('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"prompt_cache_hit_tokens":5,"prompt_cache_miss_tokens":6}}\n\n')
    parser.push('data: [DONE]\n\n')

    expect(parser.usage()).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      prompt_cache_hit_tokens: 5,
      prompt_cache_miss_tokens: 6,
    })
  })
})
