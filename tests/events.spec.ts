import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { EventLog, describeDomainEvent } from '../src/ledger/events.ts'
import type { DomainEvent } from '../src/core/ports.ts'

const AT = '2026-09-23T12:00:00.000Z'
const ev = (type: DomainEvent['type'], data: unknown): DomainEvent => ({ type, at: AT, data } as unknown as DomainEvent)

function logger(keep?: number): EventLog {
  return new EventLog(new DatabaseSync(':memory:'), { now: () => new Date(AT), ...(keep === undefined ? {} : { keep }) })
}

describe('event log', () => {
  it('stores events newest first with a default level and JSON data', () => {
    const log = logger()
    log.add({ kind: 'admin.settings', text: '设置已更新', level: 'warn', ticketId: 't1', data: { fields: ['budget'] } })
    log.add({ kind: 'ticket.created', text: '新任务已受理', ticketId: 't1' })
    log.add({ kind: 'budget.denied', text: '预算已拦截', level: 'error', ticketId: 't2' })

    const all = log.list()
    expect(all.map(item => item.id)).toEqual([3, 2, 1])
    expect(all[2]).toEqual({
      id: 1,
      at: AT,
      kind: 'admin.settings',
      ticketId: 't1',
      level: 'warn',
      text: '设置已更新',
      data: { fields: ['budget'] },
    })
    expect(all[1]?.level).toBe('info')
    expect(all[1]).not.toHaveProperty('data')
    expect(all[1]).not.toHaveProperty('ticketId', undefined)
    expect(log.list()[0]).toMatchObject({ kind: 'budget.denied', level: 'error', ticketId: 't2' })
  })

  it('filters by ticket, level and id cursor', () => {
    const log = logger()
    log.add({ kind: 'admin.settings', text: '设置已更新', level: 'warn', ticketId: 't1', data: { fields: ['budget'] } })
    log.add({ kind: 'ticket.created', text: '新任务已受理', ticketId: 't1' })
    log.add({ kind: 'budget.denied', text: '预算已拦截', level: 'error', ticketId: 't2' })

    expect(log.list({ ticketId: 't1' }).map(item => item.id)).toEqual([2, 1])
    expect(log.list({ level: 'warn' }).map(item => item.id)).toEqual([1])
    expect(log.list({ level: 'error', ticketId: 't2' }).map(item => item.id)).toEqual([3])
    expect(log.list({ limit: 2, before: 3 }).map(item => item.id)).toEqual([2, 1])
    expect(log.list({ limit: 1 }).map(item => item.id)).toEqual([3])
    expect(log.recent(2).map(item => item.id)).toEqual([3, 2])
    expect(log.recent().map(item => item.id)).toEqual([3, 2, 1])

    expect(log.count()).toBe(3)
    expect(log.count('warn')).toBe(1)
    expect(log.count(undefined, AT)).toBe(3)
    expect(log.count(undefined, '2026-09-23T12:00:01.000Z')).toBe(0)
  })

  it('trims older events on the write cadence', () => {
    const log = logger(3)
    for (let index = 0; index < 200; index += 1) log.add({ kind: 'test', text: `事件 ${index}` })

    expect(log.count()).toBe(3)
    expect(log.list().map(item => item.text)).toEqual(['事件 199', '事件 198', '事件 197'])
  })
})

describe('describeDomainEvent', () => {
  it('describes ticket lifecycle events', () => {
    const created = describeDomainEvent(ev('ticket.created', { ticketId: 't1', decisionId: 'd1', strength: 'explicit' }))
    expect(created).toMatchObject({ kind: 'ticket.created', text: '新任务已受理', ticketId: 't1', level: 'info' })
    expect(created?.data).toEqual({ ticketId: 't1', decisionId: 'd1', strength: 'explicit' })

    expect(describeDomainEvent(ev('ticket.resumed', { ticketId: 't1', triggerId: 'x1' })))
      .toMatchObject({ kind: 'ticket.resumed', text: '任务继续执行', ticketId: 't1', level: 'info' })

    const outcomes = [
      ['completed', '任务完成'],
      ['merged', '任务完成，改动已合并'],
      ['closed', '任务结束，改动未合并'],
      ['dropped', '任务被放弃，无事可做'],
      ['stopped', '任务被停止'],
    ] as const
    for (const [outcome, text] of outcomes) {
      expect(describeDomainEvent(ev('ticket.ended', { ticketId: 't1', by: 'executor', outcome })))
        .toMatchObject({ kind: 'ticket.ended', text, ticketId: 't1', level: 'info' })
    }
    expect(describeDomainEvent(ev('ticket.ended', { ticketId: 't1', by: 'human', outcome: 'stopped', reason: '人要求停止' })))
      .toMatchObject({ text: '任务被停止：人要求停止', level: 'info' })
  })

  it('describes assignment events and warns on failure reasons', () => {
    expect(describeDomainEvent(ev('assignment.started', { ticketId: 't1', assignmentId: 'a1' })))
      .toMatchObject({ kind: 'assignment.started', text: '开始执行', ticketId: 't1', level: 'info' })
    expect(describeDomainEvent(ev('assignment.ended', { ticketId: 't1', assignmentId: 'a1', reason: 'finished' })))
      .toMatchObject({ kind: 'assignment.ended', text: '执行结束：finished', ticketId: 't1', level: 'info' })
    expect(describeDomainEvent(ev('assignment.ended', { ticketId: 't1', assignmentId: 'a1', reason: 'worker failed: timeout' })))
      .toMatchObject({ text: '执行结束：worker failed: timeout', level: 'warn' })
  })

  it('describes decisions, policy changes and unsubscriptions', () => {
    const decisions = [
      ['unavailable', '判断失败', 'warn'],
      ['accept', '决定受理', 'info'],
      ['ignore', '决定忽略', 'info'],
      ['stop', '决定停止', 'info'],
      ['reopen', '决定重新打开', 'info'],
    ] as const
    for (const [kind, text, level] of decisions) {
      expect(describeDomainEvent(ev('decision.recorded', { decisionId: 'd1', kind, threadKey: 'chat:t1' })))
        .toMatchObject({ kind: 'decision.recorded', text, level })
    }

    expect(describeDomainEvent(ev('policy.changed', { from: 'v1', to: 'v2' })))
      .toMatchObject({ kind: 'policy.changed', text: '受理规则或配置已更新', level: 'info' })
    expect(describeDomainEvent(ev('thread.unsubscribed', { threadKey: 'chat:t1', ticketId: 't1', by: 'person' })))
      .toMatchObject({ text: '已取消关注该会话', ticketId: 't1', level: 'info' })
    expect(describeDomainEvent(ev('thread.unsubscribed', { threadKey: 'chat:t1', ticketId: 't1', by: 'executor' })))
      .toMatchObject({ text: '执行端已取消关注该会话', ticketId: 't1' })
  })

  it('returns undefined for events not worth recording', () => {
    expect(describeDomainEvent(ev('trigger.received', { triggerId: 'x1', threads: ['chat:t1'] }))).toBeUndefined()
    expect(describeDomainEvent(ev('eval.started', { evalId: 'e1', threadKey: 'chat:t1', triggerIds: [], strength: 'explicit' })))
      .toBeUndefined()
    expect(describeDomainEvent(ev('trigger.requeued', { triggerId: 'x1' }))).toBeUndefined()
    expect(describeDomainEvent(ev('trigger.followup', { triggerId: 'x1' }))).toBeUndefined()
    expect(describeDomainEvent(ev('thread.subscribed', { threadKey: 'chat:t1', ticketId: 't1' }))).toBeUndefined()
  })
})
