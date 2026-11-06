import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ACKNOWLEDGEMENT, DirectAssessor } from '../src/assessor/direct.ts'
import {
  type AnalysisRecord,
  type AssessorConfig,
  FAILED_TEXT,
  type ModelCandidate,
  ModelAssessor,
  parseAnalysis,
} from '../src/assessor/model.ts'
import { callModel, type ModelCallResult, type ModelRequest, type ModelTarget } from '../src/assessor/model-call.ts'
import type { AssessmentOutcome, Candidate, EngineForMainSession, Outcome, Strength } from '../src/core/index.ts'
import { ModelChoices } from '../src/ledger/choices.ts'
import type { Assessment } from '../src/policy.ts'

const TEXT = '帮我修复登录页的验证码bug'

function trigger(id: string, text: string) {
  return {
    id,
    source: 'test',
    threads: [{ source: 'test', id: 'thread-1' }],
    actor: { source: 'test', id: 'alice' },
    human: true,
    addressed: 'mention',
    at: '2026-11-05T00:00:00.000Z',
    text,
    meta: {},
  }
}

function candidate(strength: 'explicit' | 'inferred' = 'explicit', text = TEXT): Candidate {
  return {
    evalId: 'eval-1',
    thread: { evaluating: { primary: 'trg-1' } },
    triggers: [trigger('trg-1', text)],
    strength,
    policyVersion: 'v1',
    tickets: [],
  } as unknown as Candidate
}

const TARGET: ModelTarget = { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'secret-key' }
const CANDIDATES: ModelCandidate[] = [{ ref: 'p1/m1', label: '模型一', description: '擅长写代码' }]
const VALID = JSON.stringify({ title: '修复验证码', scope: '修复登录页验证码', acknowledgement: '收到，去修。', model: null, reason: '' })

type Event = { kind: string; level: 'info' | 'warn'; text: string; data?: unknown }

function setup(overrides: Partial<AssessorConfig> = {}, reply: string | ModelCallResult = VALID) {
  const decisions: { triggerId: string; outcome: Outcome }[] = []
  const events: Event[] = []
  const records: AnalysisRecord[] = []
  const requests: { system: string; user: string }[] = []
  const errors: unknown[] = []
  const choices = new ModelChoices(new DatabaseSync(':memory:'))
  const config: AssessorConfig = {
    enabled: true,
    autoSelect: true,
    timeoutSec: 5,
    target: TARGET,
    model: 'analyst',
    provider: 'p0',
    candidates: CANDIDATES,
    ...overrides,
  }
  const call = vi.fn(async (_target: ModelTarget, request: ModelRequest): Promise<ModelCallResult> => {
    requests.push({ system: request.system, user: request.user })
    return typeof reply === 'string' ? { ok: true, status: 200, text: reply, latencyMs: 7 } : reply
  })
  const assessor = new ModelAssessor({
    engine: () => ({
      decide: (triggerId: string, outcome: Outcome) => {
        decisions.push({ triggerId, outcome })
      },
    }) as unknown as Pick<EngineForMainSession, 'decide'>,
    config: () => config,
    choices,
    record: entry => {
      records.push(entry)
    },
    event: input => {
      events.push(input)
    },
    call,
    onError: error => {
      errors.push(error)
    },
  })
  return { assessor, decisions, events, records, requests, errors, choices, call }
}

describe('ModelAssessor', () => {
  it('ignores an inferred candidate as explicitOnly, synchronously and without a model call', () => {
    const { assessor, decisions, call } = setup()
    assessor.request(candidate('inferred'))
    expect(decisions).toEqual([
      { triggerId: 'trg-1', outcome: { kind: 'ignore', reason: { code: 'explicitOnly' }, evalId: 'eval-1' } },
    ])
    expect(call).not.toHaveBeenCalled()
  })

  it('accepts at once when analysis is disabled', () => {
    const { assessor, decisions, call } = setup({ enabled: false })
    assessor.request(candidate())
    expect(decisions).toEqual([{
      triggerId: 'trg-1',
      outcome: {
        kind: 'accept',
        title: TEXT,
        scope: TEXT,
        reason: { code: 'operatorRequest' },
        acknowledgement: ACKNOWLEDGEMENT,
        evalId: 'eval-1',
      },
    }])
    expect(call).not.toHaveBeenCalled()
  })

  it('takes a clean title from a Markdown brief when accepting directly', () => {
    const decisions: { triggerId: string; outcome: Outcome }[] = []
    const assessor = new DirectAssessor({
      engine: () => ({
        decide: (triggerId: string, outcome: Outcome) => {
          decisions.push({ triggerId, outcome })
        },
      }) as unknown as Pick<EngineForMainSession, 'decide'>,
    })
    assessor.request(candidate('explicit', '# 标题\n\n## 目标\n正文'))
    expect(decisions[0]?.outcome).toMatchObject({ kind: 'accept', title: '标题' })
  })

  it('takes a clean title from a Markdown brief when analysis is disabled', () => {
    const { assessor, decisions } = setup({ enabled: false })
    assessor.request(candidate('explicit', '# 标题\n\n## 目标\n正文'))
    expect(decisions[0]?.outcome).toMatchObject({ kind: 'accept', title: '标题' })
  })

  it('accepts at once when analysis has no target', () => {
    const { assessor, decisions, call } = setup({ target: undefined })
    assessor.request(candidate())
    expect(decisions[0]?.outcome).toMatchObject({ kind: 'accept', reason: { code: 'operatorRequest' } })
    expect(call).not.toHaveBeenCalled()
  })

  it('takes title, scope, acknowledgement and an auto choice from the analysis', async () => {
    const reply = JSON.stringify({
      title: '修复验证码',
      scope: '修复登录页验证码',
      acknowledgement: '收到，去修。',
      model: 'p1/m1',
      reason: '擅长代码',
    })
    const { assessor, decisions, events, choices, records } = setup({}, reply)
    assessor.request(candidate())
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(decisions[0]?.outcome).toMatchObject({
      kind: 'accept',
      title: '修复验证码',
      scope: '修复登录页验证码',
      acknowledgement: '收到，去修。',
      reason: { code: 'operatorRequest' },
      audit: { analysis: { model: 'p0/analyst', chosen: 'p1/m1', reason: '擅长代码' } },
    })
    expect(choices.get('trg-1')).toMatchObject({ provider: 'p1', model: 'm1', source: 'auto', reason: '擅长代码' })
    expect(events).toEqual([expect.objectContaining({ kind: 'assessor.decided', level: 'info', text: '已分析：选用 模型一' })])
    expect(records).toEqual([expect.objectContaining({ provider: 'p0', model: 'analyst', ok: true, status: 200 })])
  })

  it('never overwrites a person choice and offers no candidates', async () => {
    const reply = JSON.stringify({ title: 't', scope: 's', acknowledgement: 'a', model: 'p1/m1', reason: 'r' })
    const { assessor, decisions, choices, requests } = setup({}, reply)
    choices.set('trg-1', { provider: 'p2', model: 'mx', source: 'person' })
    assessor.request(candidate())
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(requests[0]?.system).toContain('本次不选模型')
    expect(requests[0]?.system).not.toContain('p1/m1')
    expect(choices.get('trg-1')).toMatchObject({ provider: 'p2', model: 'mx', source: 'person' })
    expect(decisions[0]?.outcome.audit?.analysis).toEqual({ model: 'p0/analyst', latencyMs: expect.any(Number) })
  })

  it('ignores a model outside the candidate list', async () => {
    const reply = JSON.stringify({ title: 't', scope: 's', acknowledgement: 'a', model: 'p9/zzz', reason: 'r' })
    const { assessor, decisions, choices } = setup({}, reply)
    assessor.request(candidate())
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(choices.get('trg-1')).toBeUndefined()
    expect(decisions[0]?.outcome).toMatchObject({ kind: 'accept', title: 't', scope: 's' })
    expect(decisions[0]?.outcome.audit?.analysis).toEqual({ model: 'p0/analyst', latencyMs: expect.any(Number) })
  })

  it('falls back to the original text and warns when the call fails', async () => {
    const { assessor, decisions, events, records } = setup({}, { ok: false, text: '', latencyMs: 3, error: 'HTTP 500' })
    assessor.request(candidate())
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(decisions[0]?.outcome).toMatchObject({
      kind: 'accept',
      title: TEXT,
      scope: TEXT,
      reason: { code: 'operatorRequest' },
      acknowledgement: ACKNOWLEDGEMENT,
    })
    expect(events).toEqual([expect.objectContaining({ kind: 'assessor.failed', level: 'warn', text: FAILED_TEXT })])
    expect(records).toEqual([expect.objectContaining({ ok: false })])
  })

  it('falls back when the reply is not JSON', async () => {
    const { assessor, decisions, events } = setup({}, 'sorry, I cannot')
    assessor.request(candidate())
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(decisions[0]?.outcome).toMatchObject({ kind: 'accept', title: TEXT })
    expect(events[0]).toMatchObject({ kind: 'assessor.failed', level: 'warn' })
  })

  it('parses JSON inside a code fence', async () => {
    const reply = '```json\n{"title":"修复","scope":"范围","acknowledgement":"好","model":null,"reason":""}\n```'
    const { assessor, decisions } = setup({}, reply)
    assessor.request(candidate())
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(decisions[0]?.outcome).toMatchObject({ kind: 'accept', title: '修复', scope: '范围', acknowledgement: '好' })
  })

  it('analyses an eval once while it is in flight', async () => {
    const { assessor, decisions, call } = setup({}, VALID)
    assessor.request(candidate())
    assessor.request(candidate())
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(call).toHaveBeenCalledTimes(1)
    assessor.release('eval-1')
  })

  it('reports a throwing decide through onError instead of throwing', () => {
    const errors: unknown[] = []
    const assessor = new ModelAssessor({
      engine: () => ({
        decide: () => {
          throw new Error('policy changed')
        },
      }) as unknown as Pick<EngineForMainSession, 'decide'>,
      config: () => ({ enabled: false, autoSelect: false, timeoutSec: 5, model: 'a', provider: 'p', candidates: [] }),
      choices: new ModelChoices(new DatabaseSync(':memory:')),
      onError: error => {
        errors.push(error)
      },
    })
    expect(() => assessor.request(candidate())).not.toThrow()
    expect(errors).toEqual([expect.any(Error)])
  })
})

describe('ModelAssessor rule judgement', () => {
  const RULES = [{ id: 'copy', name: '文案修正', instruction: '明确要求修正错别字' }]
  const JUDGED = JSON.stringify({
    decision: 'accept',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: '明确要求修正错别字' }],
    direction: {
      implementation_requested: true,
      target_basis: 'specified',
      requires_design_decision: false,
      evidence: '把“登陆”改成“登录”',
    },
    title: '修正错别字',
    scope: '把登陆改为登录',
    reason: '命中文案规则',
    intent_evidence: '提出者要求修正错别字',
    acknowledgement: '收到，改成“登录”。',
    worktree_name: 'fix-typo',
  })
  const defaultAssess = (assessment: Assessment, _strength: Strength): AssessmentOutcome => ({
    kind: 'accept',
    title: assessment.title,
    scope: assessment.scope,
    reason: assessment.reason,
    rules: ['copy'],
    audit: {},
  })

  function judgeSetup(options: {
    reply?: string | ModelCallResult
    assess?: (assessment: Assessment, strength: Strength) => AssessmentOutcome
    rules?: { rules: { id: string; name: string; instruction: string }[]; mode: 'auto' | 'observe' | 'off' }
  } = {}) {
    const decisions: { triggerId: string; outcome: Outcome }[] = []
    const events: Event[] = []
    const records: AnalysisRecord[] = []
    const requests: { system: string; user: string }[] = []
    const errors: unknown[] = []
    const reply = options.reply ?? JUDGED
    const call = vi.fn(async (_target: ModelTarget, request: ModelRequest): Promise<ModelCallResult> => {
      requests.push({ system: request.system, user: request.user })
      return typeof reply === 'string' ? { ok: true, status: 200, text: reply, latencyMs: 7 } : reply
    })
    const assess = vi.fn(options.assess ?? defaultAssess)
    const assessor = new ModelAssessor({
      engine: () => ({
        decide: (triggerId: string, outcome: Outcome) => {
          decisions.push({ triggerId, outcome })
        },
      }) as unknown as Pick<EngineForMainSession, 'decide'>,
      config: () => ({ enabled: true, autoSelect: false, timeoutSec: 5, target: TARGET, model: 'analyst', provider: 'p0', candidates: [] }),
      choices: new ModelChoices(new DatabaseSync(':memory:')),
      record: entry => {
        records.push(entry)
      },
      event: input => {
        events.push(input)
      },
      call,
      rules: () => options.rules ?? { rules: RULES, mode: 'auto' },
      assess,
      onError: error => {
        errors.push(error)
      },
    })
    return { assessor, decisions, events, records, requests, errors, call, assess }
  }

  it('ignores a non-explicit candidate as explicitOnly when no rule is enabled', () => {
    const { assessor, decisions, call, assess } = judgeSetup({ rules: { rules: [], mode: 'auto' } })
    assessor.request(candidate('inferred'))
    expect(decisions).toEqual([
      { triggerId: 'trg-1', outcome: { kind: 'ignore', reason: { code: 'explicitOnly' }, evalId: 'eval-1' } },
    ])
    expect(call).not.toHaveBeenCalled()
    expect(assess).not.toHaveBeenCalled()
  })

  it('ignores a non-explicit candidate as explicitOnly when the rule mode is off', () => {
    const { assessor, decisions, call } = judgeSetup({ rules: { rules: RULES, mode: 'off' } })
    assessor.request(candidate('inferred'))
    expect(decisions[0]?.outcome).toEqual({ kind: 'ignore', reason: { code: 'explicitOnly' }, evalId: 'eval-1' })
    expect(call).not.toHaveBeenCalled()
  })

  it('judges a rule match and decides the outcome that assess returns', async () => {
    const { assessor, decisions, events, records, requests, assess } = judgeSetup()
    assessor.request(candidate('inferred'))
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(requests[0]?.user).toContain('copy｜文案修正')
    expect(assess).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'accept', title: '修正错别字', intent_evidence: '提出者要求修正错别字', worktree_name: 'fix-typo' }),
      'inferred',
    )
    expect(decisions[0]).toMatchObject({
      triggerId: 'trg-1',
      outcome: { kind: 'accept', title: '修正错别字', scope: '把登陆改为登录', evalId: 'eval-1', audit: { analysis: { model: 'p0/analyst', latencyMs: 7 } } },
    })
    expect(events).toEqual([expect.objectContaining({ kind: 'assessor.decided', level: 'info', text: '已按规则受理' })])
    expect(records).toEqual([expect.objectContaining({ provider: 'p0', model: 'analyst', ok: true })])
  })

  it('decides ignore when assess returns ignore, such as an unsettled direction', async () => {
    const { assessor, decisions, events } = judgeSetup({
      assess: () => ({ kind: 'ignore', reason: { code: 'directionUnsettled' }, audit: {} }),
    })
    assessor.request(candidate('inferred'))
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(decisions[0]?.outcome).toMatchObject({
      kind: 'ignore',
      reason: { code: 'directionUnsettled' },
      evalId: 'eval-1',
      audit: { analysis: { model: 'p0/analyst', latencyMs: 7 } },
    })
    expect(events).toEqual([expect.objectContaining({ kind: 'assessor.decided', level: 'info', text: '已判断：不受理' })])
  })

  it('ignores with a visible reason and warns when the reply is not JSON', async () => {
    const { assessor, decisions, events, assess } = judgeSetup({ reply: 'sorry, I cannot' })
    assessor.request(candidate('inferred'))
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(decisions[0]?.outcome).toEqual({
      kind: 'ignore',
      reason: { code: 'said', values: { text: '规则判断失败：回复不是合规 JSON' } },
      evalId: 'eval-1',
    })
    expect(events).toEqual([expect.objectContaining({ kind: 'assessor.failed', level: 'warn' })])
    expect(assess).not.toHaveBeenCalled()
  })

  it('ignores with a timeout reason when the call times out', async () => {
    const { assessor, decisions, events, records } = judgeSetup({
      reply: { ok: false, text: '', latencyMs: 50, error: 'timed out after 5000ms' },
    })
    assessor.request(candidate('inferred'))
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(decisions[0]?.outcome).toEqual({
      kind: 'ignore',
      reason: { code: 'said', values: { text: '规则判断失败：模型调用超时' } },
      evalId: 'eval-1',
    })
    expect(events).toEqual([expect.objectContaining({ kind: 'assessor.failed', level: 'warn' })])
    expect(records).toEqual([expect.objectContaining({ ok: false })])
  })

  it('ignores with a visible reason and warns when assess throws', async () => {
    const { assessor, decisions, events } = judgeSetup({
      assess: () => {
        throw new Error('规则覆盖不全')
      },
    })
    assessor.request(candidate('inferred'))
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(decisions[0]?.outcome).toEqual({
      kind: 'ignore',
      reason: { code: 'said', values: { text: '规则判断失败：规则覆盖不全' } },
      evalId: 'eval-1',
    })
    expect(events).toEqual([expect.objectContaining({ kind: 'assessor.failed', level: 'warn' })])
  })

  it('keeps explicit candidates on the explicit path, without judging them against rules', async () => {
    const { assessor, decisions, assess, requests } = judgeSetup({ reply: VALID })
    assessor.request(candidate('explicit'))
    await vi.waitFor(() => expect(decisions).toHaveLength(1))

    expect(assess).not.toHaveBeenCalled()
    expect(requests[0]?.system).not.toContain('规则判断员')
    expect(decisions[0]?.outcome).toMatchObject({ kind: 'accept', title: '修复验证码', reason: { code: 'operatorRequest' } })
  })
})

describe('parseAnalysis', () => {
  it('clamps the title by characters and treats a non-string model as null', () => {
    const parsed = parseAnalysis(JSON.stringify({ title: '字'.repeat(70), scope: 'x', acknowledgement: 'a', model: 5, reason: 'r' }))
    expect(parsed?.title).toBe('字'.repeat(60))
    expect(parsed?.model).toBeNull()
  })

  it('skips braces inside strings', () => {
    const parsed = parseAnalysis('{"title":"a } b","scope":"s","acknowledgement":"a","model":null,"reason":""}')
    expect(parsed?.title).toBe('a } b')
  })

  it('returns undefined without a JSON object', () => {
    expect(parseAnalysis('no json here')).toBeUndefined()
  })
})

describe('callModel', () => {
  interface Seen {
    method?: string
    url?: string
    headers: IncomingHttpHeaders
    body: unknown
  }

  let server: Server
  let base = ''
  let seen = {} as Seen
  let respond: (res: ServerResponse) => void = res => {
    res.end('{}')
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', chunk => {
        raw += chunk
      })
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
        respond(res)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const request: ModelRequest = { model: 'm', system: 'sys', user: 'hi', maxTokens: 50 }

  it('calls an OpenAI-compatible endpoint and reads the first choice', async () => {
    respond = res => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 },
      }))
    }
    const result = await callModel(
      { api: 'openai-completions', baseUrl: `${base}/v1/`, apiKey: 'sk-test', sessionHeader: 'x-session' },
      request,
      { timeoutMs: 2000, sessionId: 'ev-1' },
    )
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/v1/chat/completions')
    expect(seen.headers.authorization).toBe('Bearer sk-test')
    expect(seen.headers['x-session']).toBe('ev-1')
    expect(seen.body).toEqual({
      model: 'm',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      max_tokens: 50,
      stream: false,
    })
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      text: '你好',
      usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 },
    })
  })

  it('calls an Anthropic endpoint and joins its text blocks', async () => {
    respond = res => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        content: [{ type: 'text', text: 'A' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'B' }],
      }))
    }
    const result = await callModel({ api: 'anthropic-messages', baseUrl: base, apiKey: 'ak' }, request, {
      timeoutMs: 2000,
      sessionId: 'ev-2',
    })
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/v1/messages')
    expect(seen.headers['x-api-key']).toBe('ak')
    expect(seen.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen.headers['content-type']).toBe('application/json')
    expect(seen.headers['x-session']).toBeUndefined()
    expect(seen.body).toEqual({
      model: 'm',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
    })
    expect(result).toMatchObject({ ok: true, text: 'AB' })
  })

  it('marks an OpenAI reply cut at the output limit as truncated', async () => {
    respond = res => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: '半截' }, finish_reason: 'length' }] }))
    }
    const result = await callModel({ api: 'openai-completions', baseUrl: base, apiKey: 'k' }, request, { timeoutMs: 2000 })
    expect(result).toMatchObject({ ok: true, text: '半截', truncated: true })
  })

  it('omits the truncated key for an OpenAI reply that stopped normally', async () => {
    respond = res => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: '完整' }, finish_reason: 'stop' }] }))
    }
    const result = await callModel({ api: 'openai-completions', baseUrl: base, apiKey: 'k' }, request, { timeoutMs: 2000 })
    expect(result).toMatchObject({ ok: true, text: '完整' })
    expect(result).not.toHaveProperty('truncated')
  })

  it('marks an Anthropic reply with stop_reason max_tokens as truncated', async () => {
    respond = res => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ content: [{ type: 'text', text: '半截' }], stop_reason: 'max_tokens' }))
    }
    const result = await callModel({ api: 'anthropic-messages', baseUrl: base, apiKey: 'ak' }, request, { timeoutMs: 2000 })
    expect(result).toMatchObject({ ok: true, text: '半截', truncated: true })
  })

  it('omits the truncated key for an Anthropic reply that ended its turn', async () => {
    respond = res => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ content: [{ type: 'text', text: '完整' }], stop_reason: 'end_turn' }))
    }
    const result = await callModel({ api: 'anthropic-messages', baseUrl: base, apiKey: 'ak' }, request, { timeoutMs: 2000 })
    expect(result).toMatchObject({ ok: true, text: '完整' })
    expect(result).not.toHaveProperty('truncated')
  })

  it('returns ok:false on timeout', async () => {
    respond = res => {
      setTimeout(() => res.end('{}'), 300)
    }
    const result = await callModel({ api: 'openai-completions', baseUrl: base, apiKey: 'k' }, request, { timeoutMs: 50 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timed out/)
  })

  it('returns ok:false on HTTP errors without leaking the key', async () => {
    respond = res => {
      res.statusCode = 401
      res.end('bad key sk-leak-123')
    }
    const result = await callModel({ api: 'openai-completions', baseUrl: base, apiKey: 'sk-leak-123' }, request, {
      timeoutMs: 2000,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toContain('HTTP 401')
    expect(result.error).not.toContain('sk-leak-123')
  })
})

describe('ModelChoices', () => {
  const at = '2026-11-05T00:00:00.000Z'

  it('lets an auto choice fill in but never replace a person choice', () => {
    const choices = new ModelChoices(new DatabaseSync(':memory:'), () => new Date(at))
    choices.set('t', { provider: 'p1', model: 'a', source: 'auto', reason: 'why' })
    expect(choices.get('t')).toEqual({ provider: 'p1', model: 'a', source: 'auto', reason: 'why', at })

    choices.set('t', { provider: 'p2', model: 'b', source: 'person' })
    choices.set('t', { provider: 'p3', model: 'c', source: 'auto' })
    expect(choices.get('t')).toEqual({ provider: 'p2', model: 'b', source: 'person', at })
    expect(choices.get('missing')).toBeUndefined()
  })

  it('lets a person choice overwrite another person choice', () => {
    const choices = new ModelChoices(new DatabaseSync(':memory:'), () => new Date(at))
    choices.set('t', { provider: 'p1', model: 'a', source: 'person' })
    choices.set('t', { provider: 'p2', model: 'b', source: 'person' })
    expect(choices.get('t')).toMatchObject({ provider: 'p2', model: 'b', source: 'person' })
  })
})
