import { describe, expect, it } from 'vitest'
import { ActivityLog, argsSummary, resultText } from '../src/executor/activity.ts'

describe('activity log', () => {
  it('records a tool call as one step that moves forward when it finishes, keeping its id', () => {
    let t = 0
    const log = new ActivityLog(() => new Date(Date.UTC(2026, 10, 6, 0, 0, 0, t)))
    log.record('t1', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls -la /workspace' } })
    const started = log.list('t1')
    expect(started.items).toHaveLength(1)
    expect(started.items[0]).toMatchObject({ kind: 'tool', tool: 'bash', summary: 'ls -la /workspace', status: 'running' })
    const id = started.items[0]!.id
    t = 1500
    log.record('t1', { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a\nb\n' }] } })
    const after = log.list('t1', started.last)
    expect(after.items).toHaveLength(1)
    expect(after.items[0]).toMatchObject({ id, status: 'done', detail: 'a\nb', ms: 1500 })
    expect(after.last).toBeGreaterThan(started.last)
  })

  it('keeps what the worker said and thought, ignores deltas, and marks open tools failed at the end of a turn', () => {
    const log = new ActivityLog()
    log.record('t1', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })
    log.record('t1', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '先看目录' }, { type: 'text', text: '好的，开始' }] } })
    log.record('t1', { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'read', args: { path: 'a.png' } })
    log.record('t1', { type: 'agent_settled' })
    const kinds = log.list('t1').items.map(item => `${item.kind}:${item.status}`)
    expect(kinds).toEqual(['think:done', 'say:done', 'tool:error', 'turn:done'])
  })

  it('never stores image bytes and caps the log', () => {
    expect(resultText({ content: [{ type: 'text', text: 'Read image' }, { type: 'image', data: 'AAAA' }] })).toBe('Read image\n[图片]')
    expect(argsSummary({ url: 'http://x' })).toBe('http://x')
    const log = new ActivityLog()
    for (let index = 0; index < 400; index += 1) log.note('t1', `step ${index}`)
    const view = log.list('t1', 0, 300)
    expect(view.items).toHaveLength(300)
    expect(view.items.at(-1)!.summary).toBe('step 399')
    expect(log.list('other').items).toEqual([])
  })
})

import { DatabaseSync } from 'node:sqlite'
describe('ActivityLog persistence', () => {
  it('keeps steps across a restart and marks a dangling running step as error', () => {
    const db = new DatabaseSync(':memory:')
    const a = new ActivityLog(undefined, db)
    a.record('t1', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } } as never)
    a.note('t1', 'hello')
    const b = new ActivityLog(undefined, db)
    const view = b.list('t1')
    expect(view.items.map(i => i.summary)).toEqual(['ls', 'hello'])
    expect(view.items[0]?.status).toBe('error')
    b.note('t1', 'next')
    expect(b.list('t1').last).toBeGreaterThan(view.last)
    b.forget('t1')
    expect(new ActivityLog(undefined, db).list('t1').items).toEqual([])
  })
})
