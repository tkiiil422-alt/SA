/**
 * The launcher's pure helpers: per-ticket Pi models.json and the model arguments.
 */
import { describe, expect, it } from 'vitest'
import { defaultOptions } from '../src/admin/options.ts'
import { buildPiModels, launchArgs, piProviderId } from '../src/executor/pi-models.ts'

const GATEWAY = 'http://127.0.0.1:4000'

describe('buildPiModels', () => {
  it('writes one sa-<id> provider per enabled provider, with the ticket token and gateway path', () => {
    const base = defaultOptions({}).models.providers[0]!
    const disabled = { ...base, id: 'off', enabled: false }
    const vision = { ...base, id: 'vis', models: [{ ...base.models[0]!, id: 'pic', vision: true, thinkingLevelMap: { high: 'high' } }] }
    const out = buildPiModels([base, disabled, vision], GATEWAY)

    expect(Object.keys(out).sort()).toEqual([piProviderId('default'), piProviderId('vis')].sort())
    expect(out['sa-default']).toMatchObject({
      baseUrl: `${GATEWAY}/p/default`,
      api: 'openai-completions',
      apiKey: '${SA_TICKET_TOKEN}',
    })
    expect(out['sa-default']!.models[0]).toMatchObject({ id: 'deepseek-v4.1-flash', input: ['text', 'image'] })
    expect(out['sa-default']!.models[0]).toHaveProperty('thinkingLevelMap')
    expect(out['sa-vis']!.models[0]).toMatchObject({ id: 'pic', input: ['text', 'image'], thinkingLevelMap: { high: 'high' } })
  })

  it('omits thinkingLevelMap and keeps text-only input when the model has no vision', () => {
    const base = defaultOptions({}).models.providers[0]!
    const { thinkingLevelMap: _drop, ...bare } = base.models[0]!
    const plain = { ...base, models: [{ ...bare, id: 'plain', vision: false }] }
    const entry = buildPiModels([plain], GATEWAY)['sa-default']!.models[0]!
    expect(entry.input).toEqual(['text'])
    expect(entry).not.toHaveProperty('thinkingLevelMap')
  })
})

describe('launchArgs', () => {
  it('removes every --provider and --model pair and appends the ticket model', () => {
    const base = ['--mode', 'rpc', '--provider', 'deepseek', '--model', 'deepseek-v4.1-flash', '--model=other', '--provider=x']
    const args = launchArgs(base, { provider: 'default', model: 'deepseek-v4.1-flash' }, false)
    expect(args).toEqual(['--mode', 'rpc', '--provider', 'sa-default', '--model', 'deepseek-v4.1-flash'])
  })

  it('adds --continue on resume exactly once', () => {
    const base = ['--mode', 'rpc', '--continue']
    const args = launchArgs(base, { provider: 'p', model: 'm/x' }, true)
    expect(args.filter(arg => arg === '--continue')).toHaveLength(1)
    expect(args.slice(-2)).toEqual(['--model', 'm/x'])
  })
})
