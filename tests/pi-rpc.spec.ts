import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { PiRpcClient, PiRpcError } from '../src/executor/pi-rpc.ts'
import type { PiProcessExit } from '../src/executor/pi-rpc.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
// Must match `deltas` in tests/fixtures/fake-pi.mjs, including the separators.
const DELTAS = ['first\u2028record', 'still\u2029one', 'third delta', 'last\u2028one']

const clients: PiRpcClient[] = []

function createClient(env: Record<string, string> = {}, requestTimeoutMs = 3000): PiRpcClient {
  const client = new PiRpcClient({ command: process.execPath, args: [FAKE_PI], env, requestTimeoutMs })
  clients.push(client)
  return client
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

afterEach(async () => {
  const open = clients.splice(0)
  await Promise.all(open.map(client => client.close({ graceMs: 500 })))
})

describe('PiRpcClient', () => {
  it('correlates concurrent responses by id even when they arrive out of order', async () => {
    const client = createClient()
    await client.start()

    const order: string[] = []
    const delayed = client.sendCommand({ type: 'get_state', delayMs: 60 }).then(response => {
      order.push('delayed')
      return response
    })
    const immediate = client.sendCommand({ type: 'get_state' }).then(response => {
      order.push('immediate')
      return response
    })

    const [delayedResponse, immediateResponse] = await Promise.all([delayed, immediate])

    expect((delayedResponse.data as { messageCount: number }).messageCount).toBe(1)
    expect((immediateResponse.data as { messageCount: number }).messageCount).toBe(2)
    expect(order).toEqual(['immediate', 'delayed'])
  })

  it('promptAndWait resolves only after agent_settled', async () => {
    const client = createClient()
    await client.start()
    const streamed: string[] = []
    client.onEvent(event => streamed.push(event.type))

    const result = await client.promptAndWait('hello')

    const types = result.events.map(event => event.type)
    expect(result.disposition).toBe('started')
    expect(types[0]).toBe('agent_start')
    expect(types.filter(type => type === 'message_update')).toHaveLength(DELTAS.length)
    expect(types.slice(-2)).toEqual(['agent_end', 'agent_settled'])
    expect(streamed).toEqual(types)
  })

  it('keeps U+2028 and U+2029 inside records instead of splitting them', async () => {
    const client = createClient()
    await client.start()

    const received: string[] = []
    let messageEndText = ''
    client.onEvent(event => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
        if (update?.type === 'text_delta' && update.delta !== undefined) received.push(update.delta)
      }
      if (event.type === 'message_end') {
        const message = event.message as { content?: Array<{ text?: string }> } | undefined
        messageEndText = message?.content?.[0]?.text ?? ''
      }
    })

    await client.promptAndWait('split me')

    expect(received).toEqual(DELTAS)
    expect(received.some(delta => delta.includes('\u2028'))).toBe(true)
    expect(messageEndText).toBe(DELTAS.join(''))
  })

  it('accepts steer while a run is streaming', async () => {
    const client = createClient({ FAKE_PI_RUN_MS: '400' })
    await client.start()

    let notifyStarted: () => void = () => {}
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve
    })
    const unsubscribe = client.onEvent(event => {
      if (event.type === 'agent_start') notifyStarted()
    })

    const running = client.promptAndWait('long run')
    await started
    const disposition = await client.steer('change direction')
    unsubscribe()

    expect(disposition).toBe('queued')
    const result = await running
    expect(result.disposition).toBe('started')
  })

  it('throws the error text of a failed response', async () => {
    const client = createClient()
    await client.start()

    await expect(client.sendCommand({ type: 'not_a_command' })).rejects.toThrow('Unknown command: not_a_command')

    const caught = await client.sendCommand({ type: 'not_a_command' }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(PiRpcError)
    expect(caught).toMatchObject({ code: 'command_failed' })
  })

  it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
    'does not lose agent_settled when the child exits right after writing it (run %i)',
    async () => {
      const client = createClient({ FAKE_PI_EXIT_AFTER_SETTLED: '1' })
      await client.start()

      let exits = 0
      const exitReported = new Promise<PiProcessExit>(resolve => {
        client.onExit(info => {
          exits += 1
          resolve(info)
        })
      })

      const result = await client.promptAndWait('one shot')
      expect(result.disposition).toBe('started')
      expect(result.events.map(event => event.type)).toContain('agent_settled')

      const exit = await exitReported
      expect(exit.code).toBe(0)
      expect(exits).toBe(1)
      expect(client.isRunning).toBe(false)
    },
  )

  it('rejects pending requests and reports the exit when the child crashes', async () => {
    const client = createClient({ FAKE_PI_CRASH: '1' })
    await client.start()

    const exitReported = new Promise<PiProcessExit>(resolve => {
      client.onExit(resolve)
    })
    // Attach the rejection handlers immediately so a crash cannot surface as
    // an unhandled rejection while another assertion is running.
    const pending = expect(client.sendCommand({ type: 'get_state', delayMs: 5000 })).rejects.toThrow(/exited/i)
    const run = expect(client.promptAndWait('crash please')).rejects.toThrow(/exited/i)

    await run
    await pending
    const exit = await exitReported

    expect(exit.code).toBe(3)
    expect(exit.stderr.some(line => line.includes('simulated crash'))).toBe(true)
  })

  it('escalates shutdown and still returns when the child ignores stdin close', async () => {
    const client = createClient({ FAKE_PI_IGNORE_STDIN_CLOSE: '1' })
    await client.start()

    const pid = client.pid
    if (pid === undefined) throw new Error('fake Pi did not report a pid')
    await client.getState()

    const startedAt = Date.now()
    await client.close({ graceMs: 300 })
    const elapsed = Date.now() - startedAt

    // Windows terminates on any signal, so the first SIGTERM ends the child and
    // close waits one full stdin-close grace. POSIX ignores SIGTERM here, so it
    // waits through a second grace before SIGKILL.
    const minimum = process.platform === 'win32' ? 250 : 550
    expect(elapsed).toBeGreaterThanOrEqual(minimum)
    expect(isProcessAlive(pid)).toBe(false)
  })

  it('exits promptly when the child honors stdin close', async () => {
    const client = createClient()
    await client.start()

    const startedAt = Date.now()
    await client.close({ graceMs: 2000 })

    expect(Date.now() - startedAt).toBeLessThan(1500)
    expect(client.isRunning).toBe(false)
  })
})
