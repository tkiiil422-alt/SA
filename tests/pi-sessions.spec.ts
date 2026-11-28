import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyLatestSessionForFork, listPiSessionFiles, readLatestPiSession, readPiSession } from '../src/executor/pi-sessions.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-pi-sessions-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const SESSION_ID = '01a1dc0f-b347-727d-a3ce-e5138774bf5e'

/** 按 Pi 真实 jsonl 结构造一个会话：header、model_change、system、user、assistant(toolCall)、toolResult、assistant。 */
function writeSession(configDir: string, id = SESSION_ID, stamp = '2026-11-14T21-56-18-888Z'): string {
  const group = join(configDir, 'sessions', '--workspace--')
  mkdirSync(group, { recursive: true })
  const file = join(group, `${stamp}_${id}.jsonl`)
  const lines = [
    { type: 'session', version: 3, id, timestamp: '2026-11-14T21:56:18.888Z', cwd: '/workspace' },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-11-14T21:56:19.368Z', provider: 'sa-gw', modelId: 'gemini-3.8-flash' },
    { type: 'message', id: 's1', parentId: 'm1', timestamp: '2026-11-14T21:56:19.476Z', message: { role: 'system', content: '', sections: { preamble: '不应出现在历史里' } } },
    { type: 'message', id: 'u1', parentId: 's1', timestamp: '2026-11-14T21:56:20.000Z', message: { role: 'user', content: [{ type: 'text', text: '把导出功能做成 CSV' }] } },
    {
      type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-14T21:56:40.573Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考不该暴露' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls -la /workspace' } },
        ],
        model: 'gemini-3.8-flash',
      },
    },
    { type: 'message', id: 't1', parentId: 'a1', timestamp: '2026-11-14T21:56:41.000Z', message: { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'total 0' }] } },
    { type: 'message', id: 'a2', parentId: 't1', timestamp: '2026-11-14T21:56:50.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'CSV 导出已完成，文件在 output/export.csv' }], model: 'gemini-3.8-flash' } },
  ]
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return file
}

describe('pi session files', () => {
  it('lists session files newest first and ignores unrelated files', () => {
    const config = tempDir()
    writeSession(config, 'aaaa-1111', '2026-11-10T01-00-00-000Z')
    const latest = writeSession(config, 'bbbb-2222', '2026-11-12T01-00-00-000Z')
    writeFileSync(join(config, 'sessions', '--workspace--', 'notes.txt'), 'x')
    const files = listPiSessionFiles(config)
    expect(files).toHaveLength(2)
    expect(files.map(item => item.sessionId).sort()).toEqual(['aaaa-1111', 'bbbb-2222'])
    expect(files.every(item => item.file.endsWith('.jsonl'))).toBe(true)
    expect(latest).toContain('bbbb-2222')
    expect(listPiSessionFiles(join(config, 'missing'))).toEqual([])
  })

  it('reads a session into a summary and readable messages without system text or thinking', () => {
    const config = tempDir()
    const file = writeSession(config)
    const view = readPiSession(file, { includeTools: true })
    expect(view.summary).toMatchObject({
      sessionId: SESSION_ID, cwd: '/workspace', userMessages: 1, assistantMessages: 2, toolCalls: 1, partial: false,
    })
    expect(view.summary.models).toContain('sa-gw/gemini-3.8-flash')
    expect(view.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(view.messages[0]!.text).toBe('把导出功能做成 CSV')
    expect(view.messages[1]!.tools).toEqual(['bash(ls -la /workspace)'])
    expect(view.messages[2]).toMatchObject({ role: 'tool', toolName: 'bash', text: 'total 0' })
    expect(view.messages[3]!.text).toContain('CSV 导出已完成')
    const flat = JSON.stringify(view.messages)
    expect(flat).not.toContain('不应出现在历史里')
    expect(flat).not.toContain('内部思考不该暴露')
  })

  it('limits messages to the latest N, truncates long text and hides tool results by default', () => {
    const config = tempDir()
    const file = writeSession(config)
    const view = readPiSession(file, { limit: 1, maxChars: 80 })
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]!.role).toBe('assistant')
    const all = readPiSession(file)
    expect(all.messages.some(m => m.role === 'tool')).toBe(false)
    const group = join(config, 'sessions', '--workspace--')
    const longFile = join(group, `2026-11-15T00-00-00-000Z_long-3333.jsonl`)
    writeFileSync(longFile, `${JSON.stringify({ type: 'session', id: 'long-3333', cwd: '/workspace', timestamp: 't' })}\n${JSON.stringify({ type: 'message', id: 'u', timestamp: 't', message: { role: 'user', content: '长'.repeat(500) } })}\n`)
    const truncated = readPiSession(longFile, { maxChars: 100 })
    expect(truncated.messages[0]!.text).toContain('已截断')
  })

  it('reads the latest session of a ticket config directory', () => {
    const config = tempDir()
    expect(readLatestPiSession(config)).toBeUndefined()
    writeSession(config, 'aaaa-1111', '2026-11-10T01-00-00-000Z')
    writeSession(config, 'bbbb-2222', '2026-11-12T01-00-00-000Z')
    const view = readLatestPiSession(config)!
    expect(view.sessions).toBe(2)
    expect(view.summary.sessionId).toBe('bbbb-2222')
  })

  it('copies the latest session into a new ticket config directory for pi --fork, leaving the source intact', () => {
    const source = tempDir()
    const target = tempDir()
    writeSession(source, 'aaaa-1111', '2026-11-10T01-00-00-000Z')
    writeSession(source, 'bbbb-2222', '2026-11-12T01-00-00-000Z')
    const forked = copyLatestSessionForFork(source, target)!
    expect(forked.sessionId).toBe('bbbb-2222')
    expect(readdirSync(join(target, 'sessions', '--workspace--'))).toHaveLength(1)
    expect(listPiSessionFiles(target)[0]!.sessionId).toBe('bbbb-2222')
    expect(listPiSessionFiles(source)).toHaveLength(2)
    // 重复复制是幂等的
    expect(copyLatestSessionForFork(source, target)!.file).toBe(forked.file)
    expect(copyLatestSessionForFork(tempDir(), target)).toBeUndefined()
  })
})
