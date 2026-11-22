/** 子系统插件注册中心（PluginRegistry）核心能力与安全隔离测试。 */
import { describe, expect, it, vi } from 'vitest'
import { PluginRegistry } from '../src/plugins/registry.ts'
import type { SubsystemPlugin } from '../src/plugins/types.ts'

describe('PluginRegistry', () => {
  it('registers plugins, rejects duplicate ids, and lists enabled state', () => {
    const registry = new PluginRegistry()
    let on = true
    registry.register({
      id: 'alpha',
      name: 'Alpha 插件',
      description: '测试插件',
      version: '1.0.0',
      routesPrefix: '/alpha',
      enabled: () => on,
      directorQueries: { alpha_get: () => ({ ok: true }) },
      directorActions: { alpha_run: () => ({ ok: true }) },
      directorHighRiskActions: {
        alpha_drop: { summary: () => '删除 alpha', execute: () => ({ ok: true }) },
      },
    })
    expect(() => registry.register({ id: 'alpha', name: 'Dup', description: '', version: '1.0.0' })).toThrow(/已注册/)
    expect(registry.list()).toEqual([
      {
        id: 'alpha',
        name: 'Alpha 插件',
        description: '测试插件',
        version: '1.0.0',
        enabled: true,
        routesPrefix: '/alpha',
        directorActions: ['alpha_get', 'alpha_run', 'alpha_drop'],
        workerTools: [],
      },
    ])
    on = false
    expect(registry.list()[0]!.enabled).toBe(false)
  })

  it('dispatches director queries, actions, high-risk handlers and skips disabled plugins', async () => {
    const registry = new PluginRegistry()
    let enabled = true
    registry.register({
      id: 'demo',
      name: 'Demo',
      description: 'demo',
      version: '1.0.0',
      enabled: () => enabled,
      directorQueries: { demo_q: args => ({ echo: args.x }) },
      directorActions: { demo_a: args => ({ ran: args.y }) },
      directorHighRiskActions: {
        demo_hr: {
          summary: args => `高危操作 ${String(args.id)}`,
          execute: args => ({ done: args.id }),
        },
      },
      directorPromptSection: ctx => `提示词片段(${ctx.channel})`,
      workerPromptSection: ctx => `工单注入(${ctx.ticketId})`,
    })

    const ctx = { sessionId: 's1', channel: 'web' as const, userId: 'u1' }
    expect(await registry.dispatchDirectorQuery('demo_q', { x: 42 }, ctx)).toEqual({ matched: true, result: { echo: 42 } })
    expect(await registry.dispatchDirectorAction('demo_a', { y: 'ok' }, ctx)).toEqual({ matched: true, result: { ran: 'ok' } })
    const hr = registry.findDirectorHighRisk('demo_hr')
    expect(hr?.handler.summary({ id: '99' })).toBe('高危操作 99')
    expect(await hr?.handler.execute({ id: '99' }, ctx)).toEqual({ done: '99' })
    expect(registry.collectDirectorPromptSections({ channel: 'feishu', userId: 'u1' })).toEqual(['提示词片段(feishu)'])
    expect(registry.collectWorkerPromptSections({ ticketId: 't_1' })).toEqual(['工单注入(t_1)'])

    enabled = false
    expect(await registry.dispatchDirectorQuery('demo_q', {}, ctx)).toEqual({ matched: false })
    expect(registry.findDirectorHighRisk('demo_hr')).toBeUndefined()
    expect(registry.collectDirectorPromptSections({ channel: 'feishu', userId: 'u1' })).toEqual([])
  })

  it('isolates plugin hook errors and stops plugins in reverse startup order', async () => {
    const errors: string[] = []
    const order: string[] = []
    const registry = new PluginRegistry({ onError: (id, phase) => errors.push(`${id}:${phase}`) })

    const make = (id: string, throwOnEvent = false): SubsystemPlugin => ({
      id,
      name: id,
      description: id,
      version: '1.0.0',
      start: () => { order.push(`start:${id}`) },
      stop: () => { order.push(`stop:${id}`) },
      onDomainEvent: () => {
        if (throwOnEvent) throw new Error('boom')
        order.push(`event:${id}`)
      },
    })

    registry.register(make('first', true))
    registry.register(make('second', false))

    await registry.startAll()
    registry.emitDomainEvent({ type: 'ticket.ended', at: new Date().toISOString(), data: { ticketId: 't_1', outcome: 'completed' } } as never)
    await registry.stopAll()

    expect(order).toEqual(['start:first', 'start:second', 'event:second', 'stop:second', 'stop:first'])
    expect(errors).toEqual(['first:onDomainEvent(ticket.ended)'])
  })
})
