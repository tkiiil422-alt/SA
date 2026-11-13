import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OptionsError, OptionsStore, defaultOptions, findModel, formatRef, parseRef,
  type Options, type OptionsSection,
} from '../src/admin/options.ts'
import { defaultCouncilRoles } from '../src/council/roles.ts'
import { defaultCollabRoles } from '../src/executor/collab.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function optionsFile(): string {
  return join(tempDir(), 'options.json')
}

function store(file = optionsFile(), defaults: Options = defaultOptions({})): OptionsStore {
  return new OptionsStore(file, defaults)
}

const chinese = /[一-龥]/
const PRICE = { input: 1, cacheRead: 0.1, output: 2 }

/** A provider literal in the shape the console sends. Extra fields override the defaults. */
function provider(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Provider ${id}`,
    api: 'openai-completions',
    baseUrl: 'https://example.com/v1',
    apiKey: '',
    sessionHeader: '',
    enabled: true,
    models: [{ id: 'm1', price: PRICE }],
    ...extra,
  }
}

/** A models section literal. Routing defaults to provider `a`, model `m1`, assessor disabled. */
function models(providers: Record<string, unknown>[], routing: Record<string, unknown> = {}): Record<string, unknown> {
  // The assessor follows the worker unless a test overrides it, so overriding only the worker stays valid.
  const worker = (routing.worker ?? { provider: 'a', model: 'm1' }) as { provider: string; model: string }
  return {
    providers,
    routing: {
      worker,
      assessor: { enabled: false, ...worker, timeoutSec: 30 },
      autoSelect: false,
      ...routing,
    },
  }
}

/** Run fn, which must throw an OptionsError, and return that error. */
function capture(fn: () => unknown): OptionsError {
  try {
    fn()
  } catch (error) {
    if (error instanceof OptionsError) return error
    throw error
  }
  throw new Error('expected OptionsError')
}

describe('defaultOptions', () => {
  it('provides one DeepSeek provider with flash metadata and routes the worker to it', () => {
    const options = defaultOptions({})
    expect(options).toEqual({
      executor: { maxWorkers: 2, cpus: '2', memory: '6g', image: 'localhost/superagent-pi:1.5.0' },
      models: {
        providers: [{
          id: 'default',
          name: '默认服务',
          api: 'openai-completions',
          baseUrl: 'https://api.deepseek.com',
          apiKey: '',
          sessionHeader: '',
          enabled: true,
          models: [{
            id: 'deepseek-v4.1-flash',
            label: '',
            description: '',
            reasoning: true,
            vision: true,
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            autoPick: true,
            price: { input: 0.3, cacheRead: 0.006, output: 1.2 },
            thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
          }],
        }],
        routing: {
          worker: { provider: 'default', model: 'deepseek-v4.1-flash' },
          assessor: { enabled: false, provider: 'default', model: 'deepseek-v4.1-flash', timeoutSec: 30 },
          autoSelect: false,
        },
      },
      budget: { enabled: true, perTicketUsd: 0.5, dailyUsd: 5 },
      feishu: { enabled: false, mode: 'webhook', appId: '', appSecret: '', verificationToken: '', encryptKey: '', apiBase: 'https://open.feishu.cn', groupMode: 'mention' },
      preview: { enabled: true, portStart: 19000, portEnd: 19199, perTicket: 2, publicBase: '' },
      projects: { maxUploadMb: 4096, maxExtractMb: 12288, maxFiles: 300000 },
      github: { enabled: false, repos: [], defaultBase: 'main', apiBase: 'https://api.github.com' },
      email: { enabled: false, address: '', displayName: '', allowedSenders: [], pollSeconds: 60, maxAttachmentMb: 20 },
      council: {
        enabled: true,
        defaultOn: false,
        rounds: 2,
        maxCharsPerTurn: 600,
        moderator: null,
        roles: defaultCouncilRoles(),
      },
      novel: {
        enabled: false,
        models: { planner: null, writer: null, reviewer: null, extractor: null },
        chapterChars: [2500, 3500],
        maxRevisions: 2,
        minScore: 6,
        dailyUsd: 0,
        arcUsd: 0,
        bookUsd: 0,
        maxActiveBooks: 1,
        extraBanned: [],
      },
      collab: { enabled: true, maxConcurrent: 2, maxCalls: 20, roles: defaultCollabRoles() },
      goal: { maxRounds: 8, maxUsd: 3, maxHours: 6, commandTimeoutSec: 600, judge: null },
    })
  })

  it('seeds the provider from the environment', () => {
    const options = defaultOptions({
      SA_DEEPSEEK_UPSTREAM: 'https://opencode.ai/inference/go/openai/v1',
      SA_UPSTREAM_SESSION_HEADER: 'x-opencode-session',
      DEEPSEEK_API_KEY: 'sk-env-value-1234',
    })
    expect(options.models.providers[0]).toMatchObject({
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      sessionHeader: 'x-opencode-session',
      apiKey: 'sk-env-value-1234',
    })
  })
})

describe('OptionsStore loading', () => {
  it('starts from defaults when the file does not exist and does not create it', () => {
    const file = optionsFile()
    const options = store(file).get()
    expect(options.budget.dailyUsd).toBe(5)
    expect(existsSync(file)).toBe(false)
  })

  it('deep merges a partial file over the defaults for executor and budget', () => {
    const file = optionsFile()
    writeFileSync(file, JSON.stringify({ budget: { dailyUsd: 9 } }))
    const options = store(file).get()
    expect(options.budget).toEqual({ enabled: true, perTicketUsd: 0.5, dailyUsd: 9 })
    expect(options.executor.image).toBe('localhost/superagent-pi:1.5.0')
    expect(options.models.providers[0]?.id).toBe('default')
  })

  it('replaces the models section wholesale instead of merging default providers into it', () => {
    const file = optionsFile()
    writeFileSync(file, JSON.stringify({ models: models([provider('a')]) }))
    const options = store(file).get()
    expect(options.models.providers.map(p => p.id)).toEqual(['a'])
    expect(options.models.routing.worker).toEqual({ provider: 'a', model: 'm1' })
  })

  it('throws an error naming the file when the JSON is corrupted', () => {
    const file = optionsFile()
    writeFileSync(file, '{ not json')
    expect(() => store(file)).toThrow(/options\.json/)
  })

  it('throws an error naming the file when the merged content fails validation', () => {
    const file = optionsFile()
    writeFileSync(file, JSON.stringify({ executor: { maxWorkers: 99 } }))
    expect(() => store(file)).toThrow(/options\.json/)
    expect(() => store(file)).toThrow(chinese)
  })

  it('rejects unknown fields instead of silently dropping them', () => {
    const file = optionsFile()
    writeFileSync(file, JSON.stringify({ executor: { maxWorkers: 2, cpus: '2', memory: '6g', image: 'x', extra: true } }))
    expect(() => store(file)).toThrow(/options\.json/)
  })
})

describe('OptionsStore migration from upstream', () => {
  const legacyFile = (): string => {
    const file = optionsFile()
    writeFileSync(file, JSON.stringify({
      upstream: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4.1-flash',
        sessionHeader: 'x-s',
        apiKey: 'sk-legacy-key-5678',
      },
      budget: { dailyUsd: 7 },
    }))
    return file
  }

  it('converts an old upstream section into a default provider with DeepSeek flash metadata', () => {
    const options = store(legacyFile()).get()
    expect(options.models.providers).toHaveLength(1)
    expect(options.models.providers[0]).toMatchObject({
      id: 'default',
      name: '默认服务',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-legacy-key-5678',
      sessionHeader: 'x-s',
      enabled: true,
    })
    expect(options.models.providers[0]?.models[0]).toMatchObject({
      id: 'deepseek-v4.1-flash',
      reasoning: true,
      vision: true,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      price: { input: 0.3, cacheRead: 0.006, output: 1.2 },
    })
    expect(options.models.routing).toEqual({
      worker: { provider: 'default', model: 'deepseek-v4.1-flash' },
      assessor: { enabled: false, provider: 'default', model: 'deepseek-v4.1-flash', timeoutSec: 30 },
      autoSelect: false,
    })
    expect(options.budget.dailyUsd).toBe(7)
  })

  it('gives an unknown legacy model id default metadata with zero prices', () => {
    const file = optionsFile()
    writeFileSync(file, JSON.stringify({
      upstream: { baseUrl: 'https://x.example.com', model: 'other-model', sessionHeader: '', apiKey: '' },
    }))
    const options = store(file).get()
    expect(options.models.providers[0]?.models[0]).toMatchObject({
      id: 'other-model',
      reasoning: false,
      vision: false,
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      autoPick: true,
      price: { input: 0, cacheRead: 0, output: 0 },
    })
    expect(options.models.routing.worker).toEqual({ provider: 'default', model: 'other-model' })
  })

  it('rewrites the file with models and without upstream', () => {
    const file = legacyFile()
    store(file)
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(persisted).toHaveProperty('models')
    expect(persisted).not.toHaveProperty('upstream')
    expect(JSON.stringify(persisted)).toContain('sk-legacy-key-5678')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })
})

describe('OptionsStore views', () => {
  it('returns a deep copy from get()', () => {
    const options = store()
    const first = options.get()
    first.budget.dailyUsd = 42
    first.executor.image = 'changed'
    expect(options.get().budget.dailyUsd).toBe(5)
    expect(options.get().executor.image).toBe('localhost/superagent-pi:1.5.0')
  })

  it('hides the API key in the public view, exposing only presence and the last four characters', () => {
    const options = store()
    options.updateModels(models([provider('a', { apiKey: 'sk-super-secret-value-1234' })]))
    const publicView = options.getPublic()
    expect(JSON.stringify(publicView)).not.toContain('sk-super-secret-value-1234')
    const first = publicView.models.providers[0]
    expect(first).toBeDefined()
    expect(first && 'apiKey' in first).toBe(false)
    expect(first).toMatchObject({ id: 'a', apiKeySet: true, apiKeyTail: '1234' })
    expect(publicView.models.routing.worker).toEqual({ provider: 'a', model: 'm1' })
  })

  it('reports an empty tail for short keys and apiKeySet false while unset', () => {
    const options = store()
    expect(options.getPublic().models.providers[0]).toMatchObject({ apiKeySet: false, apiKeyTail: '' })
    options.updateModels(models([provider('default', { apiKey: '12345678' })], { worker: { provider: 'default', model: 'm1' } }))
    expect(options.getPublic().models.providers[0]).toMatchObject({ apiKeySet: true, apiKeyTail: '' })
  })
})

describe('OptionsStore update', () => {
  it('replaces a whole section, reports changed paths, and persists the result', () => {
    const file = optionsFile()
    const options = store(file)
    const result = options.update('budget', { enabled: true, perTicketUsd: 0.5, dailyUsd: 4.25 })
    expect(result.changed).toEqual(['budget.dailyUsd'])
    expect(options.get().budget.dailyUsd).toBe(4.25)
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Options
    expect(persisted.budget.dailyUsd).toBe(4.25)
  })

  it('reports every changed field in a section', () => {
    const options = store()
    const result = options.update('executor', { maxWorkers: 3, cpus: '1.5', memory: '2g', image: 'example/image:1' })
    expect(result.changed).toEqual(['executor.maxWorkers', 'executor.cpus', 'executor.memory', 'executor.image'])
  })

  it('does not write or notify when nothing changed', () => {
    const file = optionsFile()
    const options = store(file)
    options.update('budget', { enabled: true, perTicketUsd: 0.5, dailyUsd: 4 })
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`)
    const sizeBefore = statSync(file).size
    let calls = 0
    options.onChange(() => { calls += 1 })
    const result = options.update('budget', { enabled: true, perTicketUsd: 0.5, dailyUsd: 4 })
    expect(result.changed).toEqual([])
    expect(calls).toBe(0)
    expect(statSync(file).size).toBe(sizeBefore)
  })

  it('throws OptionsError with Chinese messages and field paths for executor problems', () => {
    const options = store()
    const error = capture(() => options.update('executor', { maxWorkers: 0, cpus: 'many', memory: '6gb', image: '' }))
    const issues = error.issues
    expect(issues.map(issue => issue.path)).toEqual(
      expect.arrayContaining(['executor.maxWorkers', 'executor.cpus', 'executor.memory', 'executor.image']),
    )
    for (const issue of issues) expect(issue.message).toMatch(chinese)
  })

  it('throws OptionsError for budget problems, including missing required fields', () => {
    const options = store()
    const error = capture(() => options.update('budget', { enabled: true }))
    const paths = error.issues.map(issue => issue.path)
    expect(paths).toEqual(expect.arrayContaining(['budget.perTicketUsd', 'budget.dailyUsd']))
    expect(() => options.update('budget', { enabled: true, perTicketUsd: -1, dailyUsd: 200000 }))
      .toThrow(OptionsError)
  })

  it('never returns or reports the API key value in changed paths or errors', () => {
    const options = store()
    const secret = 'sk-do-not-leak-this-9999'
    const next = options.get().models
    next.providers[0] = { ...next.providers[0]!, apiKey: secret }
    const result = options.updateModels(next)
    expect(result.changed).toEqual(['models.providers.0.apiKey'])
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(options.getPublic())).not.toContain(secret)
  })

  it('writes the file atomically with mode 0600 and leaves no temporary files', () => {
    const dir = tempDir()
    const file = join(dir, 'nested', 'options.json')
    const options = new OptionsStore(file, defaultOptions({}))
    options.update('budget', { enabled: true, perTicketUsd: 0.5, dailyUsd: 3 })
    expect(existsSync(file)).toBe(true)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['options.json'])
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })
})

describe('OptionsStore updateModels', () => {
  it('keeps the previous key per provider id when apiKey is undefined or empty, and a new id starts empty', () => {
    const options = store()
    options.updateModels(models([
      provider('a', { apiKey: 'sk-a-secret-1111' }),
      provider('b', { apiKey: 'sk-b-secret-2222' }),
    ]))

    options.updateModels(models([
      provider('a', { apiKey: undefined }),
      provider('b', { apiKey: '' }),
      provider('c', { apiKey: undefined }),
    ]))

    const providers = options.get().models.providers
    expect(providers.map(p => [p.id, p.apiKey])).toEqual([
      ['a', 'sk-a-secret-1111'],
      ['b', 'sk-b-secret-2222'],
      ['c', ''],
    ])
  })

  it('does not carry a key over to a provider with a different id', () => {
    const options = store()
    options.updateModels(models([provider('a', { apiKey: 'sk-a-secret-1111' })]))
    options.updateModels(models([provider('z', { apiKey: undefined })], { worker: { provider: 'z', model: 'm1' } }))
    expect(options.get().models.providers[0]?.apiKey).toBe('')
  })

  it('persists the models section and notifies with models-prefixed changed paths', () => {
    const file = optionsFile()
    const options = store(file)
    const seen: string[][] = []
    options.onChange((section, _next, changed) => {
      if (section === 'models') seen.push(changed)
    })
    options.updateModels(models([provider('a', { name: 'Renamed' })]))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(expect.arrayContaining(['models.providers.0.name']))
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Options
    expect(persisted.models.providers[0]?.name).toBe('Renamed')
  })
})

describe('OptionsStore models cross-checks', () => {
  it('rejects a worker that points at a disabled provider', () => {
    const options = store()
    const error = capture(() => options.updateModels(models(
      [provider('a'), provider('b', { enabled: false })],
      { worker: { provider: 'b', model: 'm1' } },
    )))
    const issue = error.issues.find(item => item.path === 'models.routing.worker')
    expect(issue?.message).toMatch(chinese)
  })

  it('rejects a worker that points at a missing model', () => {
    const options = store()
    const error = capture(() => options.updateModels(models([provider('a')], { worker: { provider: 'a', model: 'nope' } })))
    expect(error.issues.map(issue => issue.path)).toContain('models.routing.worker')
  })

  it('rejects an assessor pointing at a missing model even when the assessor is disabled', () => {
    const options = store()
    const error = capture(() => options.updateModels(models([provider('a')], {
      assessor: { enabled: false, provider: 'a', model: 'nope', timeoutSec: 30 },
    })))
    expect(error.issues.map(issue => issue.path)).toContain('models.routing.assessor')
  })

  it('accepts a disabled assessor whose provider is disabled, as long as the model exists', () => {
    const options = store()
    expect(() => options.updateModels(models(
      [provider('a'), provider('b', { enabled: false })],
      { assessor: { enabled: false, provider: 'b', model: 'm1', timeoutSec: 30 } },
    ))).not.toThrow()
  })

  it('rejects an enabled assessor whose provider is disabled', () => {
    const options = store()
    const error = capture(() => options.updateModels(models(
      [provider('a'), provider('b', { enabled: false })],
      { assessor: { enabled: true, provider: 'b', model: 'm1', timeoutSec: 30 } },
    )))
    expect(error.issues.map(issue => issue.path)).toContain('models.routing.assessor')
  })
})

describe('parseRef, formatRef and findModel', () => {
  it('splits at the first slash so model ids may contain slashes', () => {
    expect(parseRef('a/b')).toEqual({ provider: 'a', model: 'b' })
    expect(parseRef('openrouter/org/model-x')).toEqual({ provider: 'openrouter', model: 'org/model-x' })
  })

  it('returns undefined for malformed references', () => {
    expect(parseRef('nosep')).toBeUndefined()
    expect(parseRef('/model')).toBeUndefined()
    expect(parseRef('provider/')).toBeUndefined()
    expect(parseRef('')).toBeUndefined()
  })

  it('formats a reference back to its text form', () => {
    expect(formatRef({ provider: 'openrouter', model: 'org/model-x' })).toBe('openrouter/org/model-x')
    expect(parseRef(formatRef({ provider: 'p', model: 'x/y' }))).toEqual({ provider: 'p', model: 'x/y' })
  })

  it('finds models by reference, honouring enabledOnly', () => {
    const options = store()
    options.updateModels(models(
      [
        provider('a', { models: [{ id: 'org/model-x', price: PRICE }] }),
        provider('b', { enabled: false, models: [{ id: 'm2', price: PRICE }] }),
      ],
      { worker: { provider: 'a', model: 'org/model-x' } },
    ))
    const cfg = options.get().models

    expect(findModel(cfg, { provider: 'a', model: 'org/model-x' })?.model.id).toBe('org/model-x')
    expect(findModel(cfg, { provider: 'b', model: 'm2' })?.provider.id).toBe('b')
    expect(findModel(cfg, { provider: 'b', model: 'm2' }, { enabledOnly: true })).toBeUndefined()
    expect(findModel(cfg, { provider: 'a', model: 'nope' })).toBeUndefined()
    expect(findModel(cfg, { provider: 'zzz', model: 'm1' })).toBeUndefined()
  })
})

describe('OptionsStore change listeners', () => {
  it('notifies every listener and supports unsubscribing', () => {
    const options = store()
    const seen: { section: OptionsSection; changed: string[] }[] = []
    const first = options.onChange((section, next, changed) => {
      seen.push({ section, changed })
      expect(next.budget.dailyUsd).toBe(8)
    })
    options.onChange((section, _next, changed) => {
      seen.push({ section, changed })
    })

    options.update('budget', { enabled: true, perTicketUsd: 0.5, dailyUsd: 8 })
    expect(seen).toEqual([
      { section: 'budget', changed: ['budget.dailyUsd'] },
      { section: 'budget', changed: ['budget.dailyUsd'] },
    ])

    first()
    options.update('budget', { enabled: true, perTicketUsd: 0.5, dailyUsd: 7 })
    expect(seen).toHaveLength(3)
  })

  it('isolates a throwing listener from persistence and the other listeners', () => {
    const file = optionsFile()
    const options = store(file)
    let secondCalled = false
    options.onChange(() => { throw new Error('boom') })
    options.onChange(() => { secondCalled = true })

    expect(() => options.update('budget', { enabled: false, perTicketUsd: 0.5, dailyUsd: 2 })).not.toThrow()
    expect(secondCalled).toBe(true)
    expect((JSON.parse(readFileSync(file, 'utf8')) as Options).budget.enabled).toBe(false)
  })
})
