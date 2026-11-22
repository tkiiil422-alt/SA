/** 主动调度引擎（Cron 解析、定时派单、总控巡检、零 Token HTTP 监控与插件 API）测试。 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextCronTime, parseCron, previewCronTimes } from '../src/scheduler/cron.ts'
import { SchedulerStore } from '../src/scheduler/store.ts'
import { SchedulerService } from '../src/scheduler/service.ts'
import { EventLog } from '../src/ledger/events.ts'
import { parseConfig } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-sched-backups-'))

const runtimes: Runtime[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const r of runtimes.splice(0)) { try { await r.stop() } catch { /* stopped */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Cron parser', () => {
  it('parses standard 5-field expressions, macros, step ranges, and Sunday as 0 or 7', () => {
    const base = new Date(2026, 10, 22, 8, 15, 0) // 2026-11-22 08:15 (Sunday)
    const next1 = nextCronTime('30 8 * * *', base)
    expect(next1.getHours()).toBe(8)
    expect(next1.getMinutes()).toBe(30)
    expect(next1.getDate()).toBe(22)

    const nextStep = nextCronTime('*/15 * * * *', base)
    expect(nextStep.getMinutes()).toBe(30)

    const sun = parseCron('0 9 * * 7')
    expect(sun.daysOfWeek.has(0)).toBe(true)

    const previews = previewCronTimes('@daily', 3, base)
    expect(previews).toHaveLength(3)
    expect(Date.parse(previews[1]!) - Date.parse(previews[0]!)).toBe(86_400_000)

    expect(() => parseCron('bad cron')).toThrow(/5 段/)
    expect(() => parseCron('65 * * * *')).toThrow(/取值不合法|超出范围/)
  })
})

describe('SchedulerService execution modes', () => {
  it('dispatches tickets, respects global pause, and auto-disables once schedules', async () => {
    const db = new DatabaseSync(':memory:')
    const store = new SchedulerStore(db)
    const events = new EventLog(db)
    let now = new Date('2026-11-22T08:00:00.000Z')
    let paused = false
    const dispatched: string[] = []

    const svc = new SchedulerService({
      store,
      events,
      isPaused: () => paused,
      now: () => now,
      dispatchTicket: async input => {
        dispatched.push(input.text)
        return { ticketId: `t_${dispatched.length}`, triggerId: `tr_${dispatched.length}` }
      },
    })

    const intervalJob = svc.create({
      name: '每分钟心跳任务',
      triggerKind: 'interval',
      intervalSec: 60,
      actionKind: 'dispatch_ticket',
      actionConfig: { prompt: '检查队列状态' },
      respectPause: true,
    })
    const onceJob = svc.create({
      name: '一次性提醒',
      triggerKind: 'once',
      runAt: '2026-11-22T08:00:30.000Z',
      actionKind: 'dispatch_ticket',
      actionConfig: { prompt: '执行一次性数据迁移' },
      respectPause: false,
    })

    // 未到期前不触发
    expect(await svc.tick()).toHaveLength(0)

    // 系统暂停时：respectPause=true 跳过，respectPause=false 仍执行且 once 自动停用
    paused = true
    now = new Date('2026-11-22T08:01:05.000Z')
    const runs = await svc.tick()
    expect(runs).toHaveLength(2)
    expect(runs.find(r => r.scheduleId === intervalJob.id)?.status).toBe('skipped')
    expect(runs.find(r => r.scheduleId === onceJob.id)?.status).toBe('ok')
    expect(svc.get(onceJob.id)?.enabled).toBe(false)
    expect(dispatched).toHaveLength(1)

    // 恢复接单并推进时间，interval 任务正常派单
    paused = false
    now = new Date('2026-11-22T08:02:10.000Z')
    const runs2 = await svc.tick()
    expect(runs2).toHaveLength(1)
    expect(runs2[0]!.status).toBe('ok')
    expect(runs2[0]!.ticketId).toBe('t_2')
  })

  it('runs http_watch with zero alerts when unchanged and triggers alert + ticket only on change/error', async () => {
    const db = new DatabaseSync(':memory:')
    const store = new SchedulerStore(db)
    const events = new EventLog(db)
    let pageBody = 'release v1.0.0'
    let statusCode = 200
    const dispatched: string[] = []
    const alerts: string[] = []

    const svc = new SchedulerService({
      store,
      events,
      isPaused: () => false,
      fetchImpl: (async () => new Response(pageBody, { status: statusCode })) as unknown as typeof fetch,
      dispatchTicket: async input => {
        dispatched.push(input.text)
        return { ticketId: `t_watch_${dispatched.length}`, triggerId: 'tr_w' }
      },
      notifyAlert: async a => { alerts.push(a.text) },
    })

    const watch = svc.create({
      name: '版本页监控',
      triggerKind: 'interval',
      intervalSec: 300,
      actionKind: 'http_watch',
      actionConfig: {
        url: 'https://example.test/releases',
        expectStatus: 200,
        detectChange: true,
        onChangePrompt: '总结新版发布日志',
      },
    })

    // 1. 首次建立基准：不告警不派单
    const r1 = await svc.runNow(watch.id)
    expect(r1.status).toBe('ok')
    expect(dispatched).toHaveLength(0)

    // 2. 内容无变化：零派单
    const r2 = await svc.runNow(watch.id)
    expect(r2.status).toBe('ok')
    expect(dispatched).toHaveLength(0)

    // 3. 内容发生变化：自动开单
    pageBody = 'release v2.0.0 - big upgrade!'
    const r3 = await svc.runNow(watch.id)
    expect(r3.status).toBe('changed')
    expect(r3.ticketId).toBe('t_watch_1')
    expect(dispatched[0]).toContain('内容指纹发生变化')

    // 4. 状态码异常
    statusCode = 503
    const r4 = await svc.runNow(watch.id)
    expect(r4.status).toBe('changed')
    expect(dispatched[1]).toContain('状态码异常')
    expect(alerts).toHaveLength(0) // 配置了 onChangePrompt 优先走自动处理
  })
})

describe('Scheduler plugin HTTP API in Runtime', () => {
  it('supports CRUD, preview-cron, and manual runNow through /api/schedules', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-sched-rt-'))
    dirs.push(stateDir)
    const runtime = await createRuntime(parseConfig({
      stateDir,
      maxSlots: 2,
      operatorId: 'operator',
      launcher: { command: process.execPath, args: [FAKE_PI], env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '20' } },
      policy: { policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } }, eval: { mode: 'auto' } },
    }))
    runtimes.push(runtime)

    const token = readFileSync(join(stateDir, 'cli-token'), 'utf8').trim()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-sa-request': '1' }

    // 预览 Cron
    const prev = await fetch(`${runtime.adminUrl}/api/schedules/preview-cron`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expr: '30 8 * * 1-5', count: 3 }),
    })
    expect(prev.status).toBe(200)
    expect(((await prev.json()) as { times: string[] }).times).toHaveLength(3)

    // 创建定时派单任务并立即执行一次
    const created = await fetch(`${runtime.adminUrl}/api/schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '每日早报巡检',
        triggerKind: 'cron',
        cronExpr: '30 8 * * *',
        actionKind: 'dispatch_ticket',
        actionConfig: { prompt: '整理今日工作摘要' },
      }),
    })
    expect(created.status).toBe(200)
    const { item } = await created.json() as { item: { id: string; nextRunAt: string | null } }
    expect(item.nextRunAt).not.toBeNull()

    const ran = await fetch(`${runtime.adminUrl}/api/schedules/${item.id}/run`, { method: 'POST', headers, body: '{}' })
    expect(ran.status).toBe(200)
    const ranJson = await ran.json() as { ok: boolean; run: { status: string; ticketId: string } }
    expect(ranJson.ok).toBe(true)
    expect(ranJson.run.status).toBe('ok')
    expect(ranJson.run.ticketId).toBeTruthy()

    // 查询运行历史并删除
    const runsRes = await fetch(`${runtime.adminUrl}/api/schedules/${item.id}/runs`, { headers })
    expect(runsRes.status).toBe(200)
    expect(((await runsRes.json()) as { items: unknown[] }).items).toHaveLength(1)

    const delRes = await fetch(`${runtime.adminUrl}/api/schedules/${item.id}`, { method: 'DELETE', headers, body: '{}' })
    expect(delRes.status).toBe(200)
  })
})
