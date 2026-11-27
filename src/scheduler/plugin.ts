/**
 * 主动调度引擎子系统插件（Scheduler Plugin）。
 *
 * 通过 `SubsystemPlugin` 协议接入：
 * - HTTP API：`/api/schedules*` 与 `/api/schedules/preview-cron`
 * - Director 工具：自然语言增删改查、启停与立即运行定时/巡检任务
 * - 生命周期：`start()` 自动启动后台扫描与中断恢复，`stop()` 优雅停机
 */
import { z } from 'zod'
import type { SubsystemPlugin } from '../plugins/types.ts'
import type { SchedulerService } from './service.ts'
import { previewCronTimes } from './cron.ts'
import { issuesOf } from '../admin/http.ts'

const TriggerKindSchema = z.enum(['cron', 'interval', 'once'])
const ActionKindSchema = z.enum(['dispatch_ticket', 'director_prompt', 'http_watch'])

const ScheduleCreateSchema = z.object({
  name: z.string().trim().min(1, '请填写任务名称').max(120),
  description: z.string().trim().max(500).default(''),
  enabled: z.boolean().default(true),
  triggerKind: TriggerKindSchema,
  cronExpr: z.string().trim().max(100).nullable().optional(),
  intervalSec: z.number().int('必须是整数').min(30, '间隔不能小于 30 秒').max(2_592_000).nullable().optional(),
  runAt: z.string().trim().max(64).nullable().optional(),
  actionKind: ActionKindSchema,
  actionConfig: z.record(z.string(), z.unknown()).default({}),
  respectPause: z.boolean().default(true),
}).strict()

const ScheduleUpdateSchema = ScheduleCreateSchema.partial().strict()

const PreviewCronSchema = z.object({
  expr: z.string().trim().min(1, '请填写 Cron 表达式').max(100),
  count: z.number().int().min(1).max(20).optional(),
}).strict()

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export interface SchedulerPluginOpts {
  getTicketSummary?: (ticketId: string) => {
    outcome?: string
    acceptanceStatus?: 'met' | 'unmet' | 'not_checked'
  } | undefined
  afterCommit?: (fn: () => void) => void
}

export function createSchedulerPlugin(scheduler: SchedulerService, opts: SchedulerPluginOpts = {}): SubsystemPlugin {
  return {
    id: 'scheduler',
    name: '主动定时与巡检调度',
    description: '支持 5 段 Cron / 间隔 / 一次性触发，自动派单、唤醒总控巡检或零 Token HTTP 变更监控',
    version: '2.0.0',
    routesPrefix: '/schedules',

    start: () => scheduler.start(),
    stop: () => scheduler.stop(),

    handleRoute: async ctx => {
      const { req, res, url, method, route, sendJson, parseJsonBody, invalid, decodeSegment, clampInt, events } = ctx
      if (!route.startsWith('/schedules')) return false

      if (route === '/schedules/preview-cron' && method === 'POST') {
        const parsed = PreviewCronSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        try {
          const times = previewCronTimes(parsed.data.expr, parsed.data.count ?? 5)
          sendJson(res, 200, { ok: true, times })
        } catch (error) {
          sendJson(res, 400, { error: 'invalid_cron', message: error instanceof Error ? error.message : String(error) })
        }
        return true
      }

      if (route === '/schedules' && method === 'GET') {
        const items = scheduler.list()
        sendJson(res, 200, { items, total: items.length, now: new Date().toISOString() })
        return true
      }

      if (route === '/schedules' && method === 'POST') {
        const parsed = ScheduleCreateSchema.safeParse(await parseJsonBody(req))
        if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
        try {
          const item = scheduler.create(parsed.data)
          try {
            events.add({ kind: 'scheduler.created', level: 'info', text: `新建定时任务「${item.name}」`, data: { id: item.id, triggerKind: item.triggerKind, actionKind: item.actionKind } })
          } catch { /* ignore */ }
          sendJson(res, 200, { ok: true, item })
        } catch (error) {
          sendJson(res, 400, { error: 'invalid', message: error instanceof Error ? error.message : String(error) })
        }
        return true
      }

      const subMatch = /^\/schedules\/([^/]+)\/(run|runs)$/.exec(route)
      if (subMatch !== null) {
        const id = decodeSegment(subMatch[1] ?? '')
        const sub = subMatch[2]
        if (!id) { sendJson(res, 400, { error: 'invalid_path', message: '调度任务编号不合法。' }); return true }
        if (sub === 'runs' && method === 'GET') {
          if (!scheduler.get(id)) { sendJson(res, 404, { error: 'not_found', message: '找不到这个定时任务。' }); return true }
          const limit = clampInt(url.searchParams.get('limit'), 30, 1, 100)
          sendJson(res, 200, { items: scheduler.listRuns(id, limit) })
          return true
        }
        if (sub === 'run' && method === 'POST') {
          try {
            const run = await scheduler.runNow(id)
            sendJson(res, 200, { ok: true, run })
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            sendJson(res, msg.includes('找不到') ? 404 : 400, { error: 'run_failed', message: msg })
          }
          return true
        }
        sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
        return true
      }

      const idMatch = /^\/schedules\/([^/]+)$/.exec(route)
      if (idMatch !== null) {
        const id = decodeSegment(idMatch[1] ?? '')
        if (!id) { sendJson(res, 400, { error: 'invalid_path', message: '调度任务编号不合法。' }); return true }
        if (method === 'GET') {
          const item = scheduler.get(id)
          if (!item) { sendJson(res, 404, { error: 'not_found', message: '找不到这个定时任务。' }); return true }
          sendJson(res, 200, { item, runs: scheduler.listRuns(id, 20) })
          return true
        }
        if (method === 'PUT') {
          const parsed = ScheduleUpdateSchema.safeParse(await parseJsonBody(req))
          if (!parsed.success) { invalid(res, issuesOf(parsed.error)); return true }
          try {
            const item = scheduler.update(id, parsed.data)
            if (!item) { sendJson(res, 404, { error: 'not_found', message: '找不到这个定时任务。' }); return true }
            sendJson(res, 200, { ok: true, item })
          } catch (error) {
            sendJson(res, 400, { error: 'invalid', message: error instanceof Error ? error.message : String(error) })
          }
          return true
        }
        if (method === 'DELETE') {
          if (!scheduler.delete(id)) { sendJson(res, 404, { error: 'not_found', message: '找不到这个定时任务。' }); return true }
          sendJson(res, 200, { ok: true })
          return true
        }
        sendJson(res, 404, { error: 'not_found', message: '没有这个接口。' })
        return true
      }

      return false
    },

    directorQueries: {
      schedules_list: args => {
        const onlyEnabled = args.onlyEnabled === true
        const includeFullPrompt = args.includeFullPrompt === true
        const allItems = scheduler.list()
        const filtered = onlyEnabled ? allItems.filter(item => item.enabled) : allItems
        const items = includeFullPrompt
          ? filtered
          : filtered.map(item => {
              const prompt = item.actionConfig?.prompt
              if (typeof prompt !== 'string' || prompt.length <= 200) return item
              return {
                ...item,
                actionConfig: {
                  ...item.actionConfig,
                  prompt: `${prompt.slice(0, 200)}…（共 ${prompt.length} 字，完整内容请调用 schedule_detail）`,
                  promptLength: prompt.length,
                },
              }
            })
        return { items, total: allItems.length, shown: items.length }
      },
      schedule_detail: args => {
        const id = str(args.id)
        if (!id) return { ok: false, error: '缺少定时任务 id' }
        const item = scheduler.get(id)
        if (!item) return { ok: false, error: `找不到定时任务 ${id}` }
        return { ok: true, item, runs: scheduler.listRuns(id, 15) }
      },
    },

    directorActions: {
      schedule_create: (args, ctx) => {
        const name = str(args.name)
        const triggerKind = args.triggerKind === 'cron' || args.triggerKind === 'interval' || args.triggerKind === 'once'
          ? args.triggerKind
          : (str(args.cronExpr) ? 'cron' : args.intervalSec ? 'interval' : 'once')
        const actionKind = args.actionKind === 'dispatch_ticket' || args.actionKind === 'director_prompt' || args.actionKind === 'http_watch'
          ? args.actionKind
          : 'director_prompt'
        const rawCfg = typeof args.actionConfig === 'object' && args.actionConfig !== null && !Array.isArray(args.actionConfig)
          ? { ...(args.actionConfig as Record<string, unknown>) }
          : {}
        // 允许直接平铺常用字段（prompt / url / projectId）降低 LLM 传参出错率
        if (!rawCfg.prompt && str(args.prompt)) rawCfg.prompt = str(args.prompt)
        if (!rawCfg.url && str(args.url)) rawCfg.url = str(args.url)
        if (!rawCfg.projectId && str(args.projectId)) rawCfg.projectId = str(args.projectId)
        if (actionKind === 'director_prompt') {
          if (!rawCfg.channel) rawCfg.channel = ctx.channel
          if (!rawCfg.userId) rawCfg.userId = ctx.userId
        }
        const enabled = typeof args.enabled === 'boolean' ? args.enabled : true
        const respectPause = typeof args.respectPause === 'boolean' ? args.respectPause : true
        const cronExpr = str(args.cronExpr) || null
        const intervalSec = args.intervalSec !== undefined ? Number(args.intervalSec) : null
        const runAt = str(args.runAt) || null
        // 防止总控/LLM 因工具调用异常重复创建同名周期定时任务
        if (enabled && args.allowDuplicate !== true && (triggerKind === 'interval' || triggerKind === 'cron')) {
          const existing = scheduler.list().find(s =>
            s.enabled && s.name.trim() === name.trim() && (s.triggerKind === 'interval' || s.triggerKind === 'cron'),
          )
          if (existing) {
            const updated = scheduler.update(existing.id, {
              description: str(args.description) || existing.description,
              enabled: true,
              triggerKind,
              cronExpr,
              intervalSec,
              runAt,
              actionKind,
              actionConfig: rawCfg,
              respectPause,
            })
            return { ok: true, item: updated ?? existing, deduplicated: true }
          }
        }
        const item = scheduler.create({
          name,
          description: str(args.description),
          enabled,
          triggerKind,
          cronExpr,
          intervalSec,
          runAt,
          actionKind,
          actionConfig: rawCfg,
          respectPause,
        })
        return { ok: true, item }
      },
      schedule_update: args => {
        const id = str(args.id)
        if (!id) throw new Error('schedule_update 缺少 id')
        const patch: Record<string, unknown> = {}
        for (const k of ['name', 'description', 'enabled', 'triggerKind', 'cronExpr', 'intervalSec', 'runAt', 'actionKind', 'actionConfig', 'respectPause']) {
          if (args[k] !== undefined) patch[k] = args[k]
        }
        const item = scheduler.update(id, patch)
        if (!item) throw new Error(`找不到定时任务 ${id}`)
        return { ok: true, item }
      },
      schedule_toggle: args => {
        const id = str(args.id)
        if (!id || typeof args.enabled !== 'boolean') throw new Error('schedule_toggle 需要 id 与 enabled(boolean)')
        const item = scheduler.update(id, { enabled: args.enabled })
        if (!item) throw new Error(`找不到定时任务 ${id}`)
        return { ok: true, item }
      },
      schedule_run_now: async args => {
        const id = str(args.id)
        if (!id) throw new Error('schedule_run_now 缺少 id')
        const run = await scheduler.runNow(id)
        return { ok: true, run }
      },
      schedule_delete: args => {
        const id = str(args.id)
        if (!id) throw new Error('schedule_delete 缺少 id')
        return { ok: scheduler.delete(id), id }
      },
    },

    directorPromptSection: () => {
      const items = scheduler.list()
      const active = items.filter(s => s.enabled)
      const lines: string[] = [
        '## 主动定时与巡检调度（已启用）',
        '- 查询动作（`platform_query`）：`schedules_list`、`schedule_detail({id})`',
        '- 管理动作（`subsystem_action`）：`schedule_create({name,triggerKind:"cron"|"interval"|"once",cronExpr?,intervalSec?,runAt?,actionKind:"director_prompt"|"dispatch_ticket"|"http_watch",prompt?,url?,actionConfig?})`、`schedule_toggle({id,enabled})`、`schedule_update`、`schedule_run_now({id})`、`schedule_delete({id})`',
        '- 当主人说“每天/每周/每隔几小时帮我巡检/拉数据/检查某网站”时，直接调用 `schedule_create` 落盘，无需口头答应。',
      ]
      if (active.length > 0) {
        lines.push('', `### 当前已启用的计划任务（共 ${active.length} 项）`)
        for (const s of active.slice(0, 8)) {
          const trig = s.triggerKind === 'cron' ? `cron(${s.cronExpr})` : s.triggerKind === 'interval' ? `每 ${s.intervalSec}s` : `单次(${s.runAt})`
          lines.push(`- \`${s.id}\` **${s.name}** [${trig} · ${s.actionKind}] 下次：${s.nextRunAt ?? '—'}`)
        }
      }
      return lines.join('\n')
    },

    onDomainEvent: event => {
      if (event.type !== 'ticket.ended' || !opts.getTicketSummary) return
      const sync = (): void => {
        const info = opts.getTicketSummary?.(event.data.ticketId)
        if (!info) return
        scheduler.onTicketSettled(event.data.ticketId, info.outcome ?? 'closed', info.acceptanceStatus ?? 'not_checked')
      }
      if (opts.afterCommit) opts.afterCommit(sync)
      else sync()
    },
  }
}
