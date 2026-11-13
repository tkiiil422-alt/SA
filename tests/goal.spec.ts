/** Ticket goals: the gate in front of `sa_report`, pushes after idle turns, caps, a person's reply, and persistence. */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalError, GoalService, resolveGoal, type GoalSettings, type GoalTicket, type JudgeResult } from '../src/goal/service.ts'
import { judgeUser, parseVerdict } from '../src/goal/judge.ts'
import { localRunner } from '../src/goal/runner.ts'

const SETTINGS: GoalSettings = { maxRounds: 3, maxUsd: 1, maxHours: 1, commandTimeoutSec: 5, judge: null }
const T0 = Date.parse('2026-11-13T00:00:00.000Z')

function harness(settings: GoalSettings = SETTINGS, db = new DatabaseSync(':memory:')) {
  const tickets = new Map<string, GoalTicket>()
  const codes = new Map<string, number[]>()
  const verdicts: JudgeResult[] = []
  const reports: { id: string; report: any }[] = []
  const steps: string[] = []
  const notes: string[] = []
  const runs: string[] = []
  const state = { spend: 0, clock: T0, judged: 0, gateRun: undefined as Promise<void> | undefined }
  const svc = new GoalService({
    db,
    ticket: id => tickets.get(id),
    spend: () => state.spend,
    settings: () => settings,
    run: async (_id, command) => {
      runs.push(command)
      if (state.gateRun) await state.gateRun
      const queue = codes.get(command) ?? []
      const code = queue.length ? queue.shift()! : 0
      return { command, code, ms: 10, tail: code ? `FAIL: ${command}` : 'ok' }
    },
    judge: async () => {
      state.judged += 1
      return verdicts.shift() ?? { ok: true, verdict: { met: true, evidence: ['看过了'], missing: [], summary: '达成' } }
    },
    report: (id, report) => reports.push({ id, report }),
    step: (_id, summary) => steps.push(summary),
    notify: (_id, text) => notes.push(text),
    now: () => new Date(state.clock),
  })
  const ticket = (id: string, triggerId: string, over: Partial<GoalTicket> = {}): GoalTicket => {
    const value: GoalTicket = { triggerId, ended: false, waitsForPerson: false, undelivered: 0, ...over }
    tickets.set(id, value)
    return value
  }
  const tick = (ms = 1000): string => { state.clock += ms; return new Date(state.clock).toISOString() }
  return { svc, tickets, codes, verdicts, reports, steps, notes, runs, state, ticket, tick, db }
}

describe('resolveGoal', () => {
  it('fills limits from the settings and picks the mode from the commands', () => {
    expect(resolveGoal({ text: ' 跑通 ', commands: [' pnpm test ', ''] }, SETTINGS)).toEqual({
      text: '跑通', commands: ['pnpm test'], mode: 'commands+ai', maxRounds: 3, maxUsd: 1, maxHours: 1,
    })
    expect(resolveGoal({ text: '写好文档', maxRounds: 9 }, SETTINGS)).toMatchObject({ mode: 'ai', commands: [], maxRounds: 9 })
    expect(resolveGoal({ text: 'x', commands: ['a'], mode: 'ai' }, SETTINGS).commands).toEqual([])
  })

  it('refuses an empty goal and a command mode without commands', () => {
    expect(() => resolveGoal({ text: '  ' }, SETTINGS)).toThrow(GoalError)
    try {
      resolveGoal({ text: 'x', mode: 'commands' }, SETTINGS)
      expect.unreachable()
    } catch (error) {
      expect((error as GoalError).field).toBe('commands')
    }
  })
})

describe('goal gate', () => {
  it('lets every report through when the ticket has no goal, and progress, waiting and questions through when it has one', async () => {
    const h = harness()
    h.ticket('t1', 'tr1')
    expect(await h.svc.gate('t1', { state: 'ready', summary: 'x' })).toEqual({ action: 'pass' })
    h.svc.setPending('tr1', resolveGoal({ text: '目标', commands: ['test'] }, SETTINGS))
    for (const report of [{ state: 'progress', summary: 'x' }, { state: 'waiting', summary: 'x' }, { state: 'blocked', summary: 'x', question: '用哪个库？' }] as const) {
      expect(await h.svc.gate('t1', report)).toEqual({ action: 'pass' })
    }
    expect(h.runs).toEqual([])
  })

  it('holds a ready report back while a command fails, and lets it through once they pass', async () => {
    const h = harness()
    h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '测试全过', commands: ['pnpm test', 'pnpm lint'], mode: 'commands' }, SETTINGS))
    h.codes.set('pnpm test', [1])
    const held = await h.svc.gate('t1', { state: 'ready', summary: '做完了' })
    expect(held.action).toBe('replace')
    if (held.action !== 'replace') return
    expect(held.report).toMatchObject({ state: 'progress' })
    expect(held.reply).toContain('第 1/3 轮')
    expect(held.reply).toContain('✗ pnpm test（退出码 1')
    expect(held.reply).toContain('FAIL: pnpm test')
    expect(held.reply).toContain('✓ pnpm lint')
    expect(h.svc.view('t1')).toMatchObject({ status: 'active', rounds: 1, roundCap: 3, last: { met: false, kind: 'check' } })
    h.tick()
    expect(await h.svc.gate('t1', { state: 'ready', summary: '修好了' })).toEqual({ action: 'pass' })
    expect(h.svc.view('t1')).toMatchObject({ status: 'met', rounds: 1 })
    expect(h.steps.some(step => step.startsWith('目标检查：已达成'))).toBe(true)
    // Met goals no longer gate anything.
    expect(await h.svc.gate('t1', { state: 'failed', summary: 'x' })).toEqual({ action: 'pass' })
  })

  it('checks a give-up too, and turns it into ready when the goal is in fact met', async () => {
    const h = harness()
    h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '目标', commands: ['ok'], mode: 'commands' }, SETTINGS))
    const decided = await h.svc.gate('t1', { state: 'failed', summary: '我放弃' })
    expect(decided).toMatchObject({ action: 'replace', report: { state: 'ready', summary: '我放弃' } })
  })

  it('asks the judge after the commands pass, retries it once, and treats two failures as not met', async () => {
    const h = harness()
    h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '写好 README', commands: ['ls'] }, SETTINGS))
    h.verdicts.push({ ok: true, verdict: { met: false, evidence: [], missing: ['README 没写用法'], summary: '还差用法' } })
    const first = await h.svc.gate('t1', { state: 'ready', summary: 'done' })
    expect(first.action === 'replace' && first.reply).toContain('README 没写用法')
    h.verdicts.push({ ok: false, error: 'timeout' }, { ok: false, error: '502' })
    const second = await h.svc.gate('t1', { state: 'ready', summary: 'done' })
    expect(h.state.judged).toBe(3)
    expect(second.action === 'replace' && second.reply).toContain('判定模型出错')
    expect(h.svc.view('t1')?.last).toMatchObject({ met: false, error: '502' })
    // A failing command never reaches the judge.
    h.codes.set('ls', [2])
    await h.svc.gate('t1', { state: 'ready', summary: 'done' })
    expect(h.state.judged).toBe(3)
  })

  it('answers a second report while a check runs instead of checking twice', async () => {
    const h = harness()
    h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '目标', commands: ['slow'], mode: 'commands' }, SETTINGS))
    let release!: () => void
    h.state.gateRun = new Promise(resolve => { release = resolve })
    const first = h.svc.gate('t1', { state: 'ready', summary: 'a' })
    await new Promise(resolve => setImmediate(resolve))
    expect(h.svc.isChecking('t1')).toBe(true)
    expect(h.svc.view('t1')?.checking).toBe(true)
    const second = await h.svc.gate('t1', { state: 'ready', summary: 'b' })
    expect(second).toMatchObject({ action: 'reply' })
    release()
    expect(await first).toEqual({ action: 'pass' })
    expect(h.svc.isChecking('t1')).toBe(false)
    expect(h.runs).toEqual(['slow'])
  })
})

describe('goal caps and a person reply', () => {
  it('stops at the round cap to ask a person, and goes on with another batch after the reply', async () => {
    const settings = { ...SETTINGS, maxRounds: 2 }
    const h = harness(settings)
    const t = h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '测试全过', commands: ['pnpm test'], mode: 'commands' }, settings))
    h.codes.set('pnpm test', [1, 1, 1])
    expect((await h.svc.gate('t1', { state: 'ready', summary: 'a' })).action).toBe('replace')
    h.tick()
    const capped = await h.svc.gate('t1', { state: 'ready', summary: 'b' })
    expect(capped.action).toBe('replace')
    if (capped.action !== 'replace') return
    expect(capped.report.state).toBe('blocked')
    expect(capped.report.question).toContain('目标还没达成')
    expect(capped.report.question).toContain('回复“继续”')
    expect(h.svc.view('t1')).toMatchObject({ status: 'paused', rounds: 2, roundCap: 2 })
    // Paused: reports are not checked and pushes stop.
    expect(await h.svc.gate('t1', { state: 'ready', summary: 'c' })).toMatchObject({ action: 'reply' })
    expect(h.svc.afterTurn('t1', h.tick())).toBeUndefined()
    expect(h.svc.systemPrompt('t1')).toBeUndefined()

    // A person replies; core keeps the old question open until the next report, and that does not stop the goal.
    t.question = capped.report.question as string
    expect(h.svc.personReplied('t1')).toBe(true)
    expect(h.svc.personReplied('t1')).toBe(false)
    expect(h.svc.view('t1')).toMatchObject({ status: 'active', rounds: 2, roundCap: 4 })
    const turnAt = h.tick()
    h.tick()
    // The next check clears the stale question it asked when it stopped.
    const next = await h.svc.gate('t1', { state: 'ready', summary: 'd' })
    expect(next).toMatchObject({ action: 'replace', report: { state: 'progress', question: null } })
    // The push after that same turn costs no second round, and the stale question does not stop it.
    expect(h.svc.afterTurn('t1', turnAt)).toContain('第 3/4 轮')
    expect(h.svc.view('t1')?.rounds).toBe(3)
    // A new question from the worker does stop the pushes.
    t.question = '要不要删旧文件？'
    expect(h.svc.afterTurn('t1', h.tick())).toBeUndefined()
  })

  it('stops when the goal spent its money, counting only spend since the goal was set', async () => {
    const h = harness()
    h.ticket('t1', 'tr1')
    h.state.spend = 5
    h.svc.set('t1', resolveGoal({ text: '目标', commands: ['x'], mode: 'commands', maxUsd: 0.5 }, SETTINGS))
    expect(h.notes[0]).toContain('人给这张任务设了目标')
    h.codes.set('x', [1, 1])
    expect(await h.svc.gate('t1', { state: 'ready', summary: 'a' })).toMatchObject({ report: { state: 'progress' } })
    h.state.spend = 5.6
    const capped = await h.svc.gate('t1', { state: 'ready', summary: 'b' })
    expect(capped).toMatchObject({ report: { state: 'blocked' } })
    expect(h.svc.view('t1')?.last?.paused).toContain('上限 $0.500')
  })

  it('stops at the deadline', async () => {
    const h = harness()
    h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '目标', commands: ['x'], mode: 'commands', maxHours: 1 }, SETTINGS))
    h.codes.set('x', [1])
    h.tick(2 * 3_600_000)
    expect(await h.svc.gate('t1', { state: 'ready', summary: 'a' })).toMatchObject({ report: { state: 'blocked' } })
    expect(h.svc.view('t1')?.last?.paused).toContain('时限')
  })
})

describe('goal pushes after a turn', () => {
  it('pushes a worker that ended a turn without delivering, but not one that waits, asked or has work queued', () => {
    const h = harness()
    const t = h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '目标' }, SETTINGS))
    t.report = { state: 'progress', at: new Date(T0).toISOString() }
    const push = h.svc.afterTurn('t1', h.tick())
    expect(push).toContain('目标还没达成')
    expect(push).toContain('第 1/3 轮')
    for (const over of [{ undelivered: 1 }, { waitsForPerson: true }, { question: '问题' }, { ended: true }, { report: { state: 'waiting', at: new Date(T0).toISOString() } }]) {
      h.ticket('t1', 'tr1', { ...t, ...over })
      expect(h.svc.afterTurn('t1', h.tick()), JSON.stringify(over)).toBeUndefined()
    }
    // A final report made in this very turn already went through the gate.
    const turnAt = h.tick()
    h.ticket('t1', 'tr1', { report: { state: 'ready', at: h.tick() } })
    expect(h.svc.afterTurn('t1', turnAt)).toBeUndefined()
  })

  it('does not spend a second round on a turn that already got a check', async () => {
    const h = harness()
    const t = h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '目标', commands: ['x'], mode: 'commands' }, SETTINGS))
    h.codes.set('x', [1])
    const turnAt = h.tick()
    h.tick()
    await h.svc.gate('t1', { state: 'ready', summary: 'a' })
    t.report = { state: 'progress', at: new Date(h.state.clock).toISOString() }
    expect(h.svc.afterTurn('t1', turnAt)).toBeDefined()
    expect(h.svc.view('t1')?.rounds).toBe(1)
  })

  it('stops to ask a person when a push hits the cap', () => {
    const h = harness({ ...SETTINGS, maxRounds: 1 })
    const t = h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '目标', maxRounds: 1 }, SETTINGS))
    t.report = { state: 'progress', at: new Date(T0).toISOString() }
    expect(h.svc.afterTurn('t1', h.tick())).toBeUndefined()
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]!.report).toMatchObject({ state: 'blocked' })
    expect(h.svc.view('t1')?.status).toBe('paused')
  })
})

describe('goal lifecycle', () => {
  it('tells the worker its goal, can be cancelled, and survives a restart', () => {
    const db = new DatabaseSync(':memory:')
    const h = harness(SETTINGS, db)
    h.ticket('t1', 'tr1')
    h.svc.setPending('tr1', resolveGoal({ text: '让 /health 返回 ok', commands: ['curl -f localhost:3000/health'] }, SETTINGS))
    const prompt = h.svc.systemPrompt('t1')!
    expect(prompt).toContain('让 /health 返回 ok')
    expect(prompt).toContain('- curl -f localhost:3000/health')
    expect(prompt).toContain('最多 3 轮')
    expect(h.svc.brief('t1')).toEqual({ status: 'active', rounds: 0, roundCap: 3 })

    const again = harness(SETTINGS, db)
    again.ticket('t1', 'tr1')
    expect(again.svc.view('t1')).toMatchObject({ text: '让 /health 返回 ok', status: 'active' })
    expect(again.svc.cancel('t1')).toBe(true)
    expect(again.svc.cancel('t1')).toBe(false)
    expect(again.notes[0]).toContain('取消了这张任务的目标')
    expect(again.svc.systemPrompt('t1')).toBeUndefined()
    expect(again.svc.view('t2')).toBeUndefined()
  })
})

describe('goal judge', () => {
  it('reads the verdict JSON even with words or a fence around it', () => {
    expect(parseVerdict('```json\n{"met": true, "evidence": ["测试过了"], "missing": [], "summary": "好"}\n```')).toEqual({
      met: true, evidence: ['测试过了'], missing: [], summary: '好',
    })
    expect(parseVerdict('结论：{"met": false, "summary": "差一点"}')).toMatchObject({ met: false, missing: ['判定模型认为还没达成，但没说差什么'] })
    expect(parseVerdict('没有 JSON')).toBeUndefined()
    expect(parseVerdict('{"met": "yes"}')).toBeUndefined()
  })

  it('puts the goal, the summary and the real command results in front of the judge', () => {
    const text = judgeUser({
      ticketId: 't1', goal: resolveGoal({ text: '测试全过', commands: ['pnpm test'] }, SETTINGS), summary: '我说做完了',
      commands: [{ command: 'pnpm test', code: 0, ms: 1200, tail: '12 passed' }], context: 'src/a.ts',
    })
    expect(text).toContain('## 目标\n测试全过')
    expect(text).toContain('$ pnpm test\n退出码 0，1.2 秒\n12 passed')
    expect(text).toContain('## 工作区概况\nsrc/a.ts')
  })
})

describe('local command runner', () => {
  const dirs: string[] = []
  // A killed process tree can hold the directory for a moment on Windows; retry the cleanup for a few seconds.
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true })
          break
        } catch (error) {
          if (attempt >= 40) throw error
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
    }
  })

  it('runs in the ticket workspace and reports the exit code, the output and a timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sa-goal-run-'))
    dirs.push(root)
    const run = localRunner(id => join(root, id))
    const ok = await run('t1', 'node -e "require(\'fs\').writeFileSync(\'x.txt\', \'1\'); console.log(process.cwd())"', 10)
    expect(ok.code).toBe(0)
    expect(ok.tail).toContain('t1')
    const bad = await run('t1', 'node -e "console.error(\'boom\'); process.exit(3)"', 10)
    expect(bad).toMatchObject({ code: 3 })
    expect(bad.tail).toContain('boom')
    // The program the shell started is killed with it: it never gets to write its file.
    const slow = await run('t1', 'node -e "setTimeout(() => require(\'fs\').writeFileSync(\'late.txt\', \'1\'), 3000)"', 1)
    expect(slow.code).toBe(124)
    expect(slow.tail).toContain('超过 1 秒')
    await new Promise(resolve => setTimeout(resolve, 3500))
    expect(existsSync(join(root, 't1', 'late.txt'))).toBe(false)
  }, 20_000)
})
