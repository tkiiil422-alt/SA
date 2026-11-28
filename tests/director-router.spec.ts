import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdminHost, TicketDetailView, TicketSummaryView } from '../src/admin/host.ts'
import {
  adviseTaskRouting,
  formatRoutingAdvice,
  routeTask,
  tokenize,
  type RoutingTicket,
} from '../src/director/router.ts'

const NOW = new Date('2026-11-28T12:00:00.000Z')
const HEX_ID = '0162072651cca998f14768623c81c8f6'

function ticket(id: string, title: string, requestText: string, overrides: Partial<RoutingTicket> = {}): RoutingTicket {
  return {
    id,
    title,
    status: 'ended',
    state: 'ended',
    updatedAt: '2026-11-28T11:50:00.000Z',
    requestText,
    workspaceExists: true,
    hasSession: true,
    ...overrides,
  }
}

const todo = ticket('t_todo', '做一个待办事项网页', '请做一个待办事项网页，支持添加和删除任务，样式要简洁')
const report = ticket('t_report', '导出销售报表为 CSV', '把销售报表按月份导出成 CSV 文件', { updatedAt: '2026-11-20T08:00:00.000Z' })

describe('tokenize', () => {
  it('keeps meaningful Chinese bigrams and English words, dropping filler words', () => {
    const tokens = tokenize('帮我做一个 Dashboard 导出报表')
    expect(tokens.has('导出')).toBe(true)
    expect(tokens.has('报表')).toBe(true)
    expect(tokens.has('dashboard')).toBe(true)
    expect(tokens.has('帮我')).toBe(false)
    expect(tokens.has('一个')).toBe(false)
  })
})

describe('adviseTaskRouting', () => {
  it('continues the focus ticket in place when the message sounds like a follow-up, and may auto-execute', () => {
    const advice = adviseTaskRouting({ text: '刚才那个任务再加一个深色模式', tickets: [todo, report], focusTicketId: 't_todo', now: NOW })
    expect(advice).toMatchObject({ action: 'continue', ticketId: 't_todo', autoExecute: true, followUpCue: true })
    expect(advice.confidence).toBeGreaterThanOrEqual(0.6)
  })

  it('finds the older ticket by content even without a focus ticket', () => {
    const advice = adviseTaskRouting({ text: '给待办事项网页加一个深色模式', tickets: [todo, report], now: NOW })
    expect(advice.action).toBe('continue')
    expect(advice.ticketId).toBe('t_todo')
    expect(advice.autoExecute).toBe(true)
    expect(advice.candidates[0]!.reasons.join('')).toContain('内容相关度')
  })

  it('asks with clickable options when several tickets are equally plausible', () => {
    const a = ticket('t_a', '待办事项网页', '待办事项网页')
    const b = ticket('t_b', '待办事项网页', '待办事项网页')
    const advice = adviseTaskRouting({ text: '把待办事项网页的按钮改成圆角', tickets: [a, b], now: NOW })
    expect(advice.action).toBe('ask')
    expect(advice.autoExecute).toBe(false)
    expect(advice.askLine).toMatch(/^请回复「续做 t_[ab]」或「续做 t_[ab]」或「新建任务」$/)
  })

  it('treats an unrelated request as a brand-new task and auto-executes it', () => {
    const advice = adviseTaskRouting({ text: '帮我查一下服务器磁盘使用率并写成周报', tickets: [todo, report], now: NOW })
    expect(advice).toMatchObject({ action: 'new', autoExecute: true })
    expect(advice.candidates).toEqual([])
  })

  it('forks when the workspace was cleaned but the Pi session remains, and starts fresh when neither remains', () => {
    const cleaned = ticket(HEX_ID, '旧报表任务', '导出报表', { workspaceExists: false, hasSession: true })
    const fork = adviseTaskRouting({ text: `接着 ${HEX_ID.slice(0, 8)} 再补一个汇总页`, tickets: [cleaned, todo], now: NOW })
    expect(fork).toMatchObject({ action: 'fork', ticketId: HEX_ID, autoExecute: true })

    const gone = ticket(HEX_ID, '旧报表任务', '导出报表', { workspaceExists: false, hasSession: false })
    const fresh = adviseTaskRouting({ text: `接着 ${HEX_ID.slice(0, 8)} 再补一个汇总页`, tickets: [gone], now: NOW })
    expect(fresh).toMatchObject({ action: 'new', ticketId: HEX_ID })
  })

  it('never silently reopens a ticket the owner stopped by hand', () => {
    const stopped = ticket('t_stop', '待办事项网页', '待办事项网页', { state: 'stopped' })
    const advice = adviseTaskRouting({ text: '刚才那个待办事项网页继续做', tickets: [stopped], focusTicketId: 't_stop', now: NOW })
    expect(advice.action).toBe('ask')
    expect(advice.autoExecute).toBe(false)
    expect(advice.reason).toContain('手动停止')
  })

  it('keeps the routing but refuses to auto-execute when the request carries a high-risk action', () => {
    const advice = adviseTaskRouting({ text: '刚才那个任务顺便把生产环境的旧数据删除', tickets: [todo], focusTicketId: 't_todo', now: NOW })
    expect(advice.action).toBe('continue')
    expect(advice.risk).toBe(true)
    expect(advice.autoExecute).toBe(false)
    const text = formatRoutingAdvice(advice, [todo])
    expect(text).toContain('高风险')
  })

  it('an explicit "new task" wording pulls scores down toward a new ticket', () => {
    const advice = adviseTaskRouting({ text: '另外新建一个任务，做待办事项网页的英文版', tickets: [todo], now: NOW })
    expect(advice.newCue).toBe(true)
    expect(advice.action).not.toBe('continue')
  })

  it('asks which ticket is meant when the wording says "that one from before" but nothing matches', () => {
    const advice = adviseTaskRouting({ text: '接着之前那个做下去', tickets: [todo, report], now: NOW })
    expect(advice.action).toBe('ask')
    expect(advice.askLine).toContain('新建任务')
  })

  it('answers a button reply such as "续做 <short id>" by continuing that exact ticket', () => {
    const other = ticket('t_other', '待办事项网页', '待办事项网页')
    const target = ticket(HEX_ID, '待办事项网页', '待办事项网页')
    const advice = adviseTaskRouting({ text: `续做 ${HEX_ID.slice(0, 8)}`, tickets: [other, target], now: NOW })
    expect(advice).toMatchObject({ action: 'continue', ticketId: HEX_ID, autoExecute: true })
  })

  it('renders an "ask" advice with the clickable line and a "do it now" advice with the report-afterwards rule', () => {
    const ask = adviseTaskRouting({ text: '接着之前那个做下去', tickets: [todo, report], now: NOW })
    expect(formatRoutingAdvice(ask, [todo, report])).toContain('不要擅自执行')
    const go = adviseTaskRouting({ text: '刚才那个任务再加一个深色模式', tickets: [todo], focusTicketId: 't_todo', now: NOW })
    const rendered = formatRoutingAdvice(go, [todo])
    expect(rendered).toContain('直接执行')
    expect(rendered).toContain('原地续做')
  })
})

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('routeTask', () => {
  it('reads recent tickets from the host, fills workspace/session facts, and recommends continuing', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'sa-route-'))
    dirs.push(cfg)
    const group = join(cfg, 'sessions', '--workspace--')
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, '2026-11-14T21-56-18-888Z_sess-1.jsonl'), `${JSON.stringify({ type: 'session', id: 'sess-1', cwd: '/workspace', timestamp: 't' })}\n`)

    const summaries: TicketSummaryView[] = [
      { id: 't_todo', title: '做一个待办事项网页', status: 'ended', stage: { stage: 'ended' } as TicketSummaryView['stage'], needsPerson: false, outcome: 'completed', createdAt: '2026-11-28T10:00:00.000Z', updatedAt: '2026-11-28T11:30:00.000Z', costUsd: 0.2 },
      { id: 't_misc', title: '清理旧日志', status: 'ended', stage: { stage: 'ended' } as TicketSummaryView['stage'], needsPerson: false, outcome: 'completed', createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T11:30:00.000Z', costUsd: 0.1 },
    ]
    const host = {
      listTickets: () => ({ total: summaries.length, items: summaries }),
      ticket: (id: string) => ({
        ...summaries.find(s => s.id === id)!,
        prompt: { text: '请做一个待办事项网页，支持添加和删除任务', at: 't' },
        workspace: { path: '/ws', exists: id === 't_todo', fileCount: 3 },
      }) as unknown as TicketDetailView,
      piConfigDir: (id: string) => (id === 't_todo' ? cfg : undefined),
    } as unknown as Pick<AdminHost, 'listTickets' | 'ticket' | 'piConfigDir'>

    const result = routeTask({ host, text: '在待办事项网页的基础上再加一个深色模式', now: NOW, linkedTicketIds: ['t_todo'] })
    expect(result.advice).toMatchObject({ action: 'continue', ticketId: 't_todo', autoExecute: true })
    const picked = result.tickets.find(t => t.id === 't_todo')!
    expect(picked).toMatchObject({ workspaceExists: true, hasSession: true, state: 'ended' })
    expect(result.prompt).toContain('t_todo')
  })
})
