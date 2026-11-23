import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildOwnerIntentProfile, detectIntentSignals } from '../src/director/intent-learner.ts'
import {
  buildCouncilCompletedCard,
  buildNoticeCard,
  buildTicketAttentionCard,
  buildTicketCompletedCard,
  parseFeishuCardActionEvent,
} from '../src/sources/feishu-cards.ts'
import { splitForFeishu } from '../src/sources/feishu.ts'
import { cleanSharedCache, inspectSharedEnv } from '../src/executor/dev-env.ts'
import { SkillStore } from '../src/skills/store.ts'
import { SkillEvolutionService } from '../src/skills/evolution.ts'
import { SkillAutoObserver } from '../src/skills/auto-observer.ts'
import type { EventLog } from '../src/ledger/events.ts'
import type { MemoryRecord } from '../src/shared/api-types.ts'

describe('Owner Intent Learner (0-token preference & profile synthesis)', () => {
  it('detects explicit habits, redlines, and standards while ignoring questions and constraint blocks', () => {
    const text = [
      '[需求上下文约束]',
      '目标项目：p_demo',
      '',
      '以后都默认使用 pnpm 而不是 npm。',
      '不要再直接修改 main 分支，必须先走 worktree。',
      '请问今天的预算还剩多少？',
      '按这个口径：所有接口错误都返回中文提示和 error 字段。',
    ].join('\n')

    const signals = detectIntentSignals(text)
    expect(signals.length).toBe(3)
    expect(signals[0]?.kind).toBe('preference')
    expect(signals[0]?.tags).toContain('auto_intent')
    expect(signals[0]?.pinned).toBe(true)
    expect(signals[1]?.kind).toBe('pitfall')
    expect(signals[1]?.tags).toContain('redline')
    expect(signals[2]?.kind).toBe('decision')
    expect(signals[2]?.tags).toContain('standard')
  })

  it('ignores slash commands and pure questions', () => {
    expect(detectIntentSignals('/确认 abc123')).toEqual([])
    expect(detectIntentSignals('以后是不是要升级 Node 版本？')).toEqual([])
  })

  it('builds Owner Intent Profile prioritizing active pinned preferences, pitfalls, and decisions', () => {
    const mk = (partial: Partial<MemoryRecord>): MemoryRecord => ({
      id: partial.id ?? 'm_1',
      scope: partial.scope ?? 'user',
      kind: partial.kind ?? 'preference',
      projectId: null,
      ticketId: null,
      title: partial.title ?? '偏好',
      content: partial.content ?? '默认 pnpm',
      tags: partial.tags ?? [],
      confidence: partial.confidence ?? 0.9,
      pinned: partial.pinned ?? false,
      useCount: partial.useCount ?? 1,
      lastUsedAt: null,
      source: partial.source ?? 'auto_intent',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: partial.updatedAt ?? '2026-01-02T00:00:00.000Z',
      ...(partial.supersededBy ? { supersededBy: partial.supersededBy } : {}),
    })

    const profile = buildOwnerIntentProfile([
      mk({ id: 'm_old', title: '旧偏好', content: '用 yarn', supersededBy: 'm_new' }),
      mk({ id: 'm_new', title: '主人偏好：默认 pnpm', content: '以后都默认用 pnpm', pinned: true }),
      mk({ id: 'm_red', kind: 'pitfall', title: '红线：不直改 main', content: '不要直接改 main 分支', pinned: true }),
      mk({ id: 'm_dec', kind: 'decision', title: '接口口径', content: '统一返回中文错误提示' }),
    ])

    expect(profile.totalActive).toBe(3)
    expect(profile.autoLearnedCount).toBe(3)
    expect(profile.preferences.map(m => m.id)).toEqual(['m_new'])
    expect(profile.pitfalls.map(m => m.id)).toEqual(['m_red'])
    expect(profile.decisions.map(m => m.id)).toEqual(['m_dec'])
    expect(profile.promptBlock).toContain('主人意图画像与偏好档案')
    expect(profile.promptBlock).toContain('默认 pnpm')
    expect(profile.promptBlock).not.toContain('用 yarn')
  })
})

describe('Feishu Markdown chunking & Card 2.0 builders', () => {
  it('preserves fenced code blocks cleanly when splitting long Markdown', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `const line_${i} = "${'x'.repeat(60)}"`)
    const md = `## 变更说明\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\`\n\n完成。`
    const chunks = splitForFeishu(md, 700)
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      const fences = chunk.match(/```/g) ?? []
      expect(fences.length % 2).toBe(0)
    }
  })

  it('builds structured Card 2.0 payloads for completed ticket, attention, council, and notice', () => {
    const completed = buildTicketCompletedCard({
      ticketId: 't_abc',
      title: '前端升级与飞书卡片重构',
      summary: '已完成全部页面重构并通过测试。',
      outcome: 'completed',
      costUsd: 0.42,
      previews: [{ title: '在线预览', url: 'https://preview.example.test/t_abc' }],
    })
    expect(completed.schema).toBe('2.0')
    expect((completed.header as { template: string }).template).toBe('green')
    expect(JSON.stringify((completed.body as { elements: unknown[] }).elements)).toContain('t_abc')
    expect(JSON.stringify((completed.body as { elements: unknown[] }).elements)).toContain('https://preview.example.test/t_abc')

    const attention = buildTicketAttentionCard({
      ticketId: 't_need',
      title: '发布前确认',
      kind: 'waiting_reply',
      question: '是否需要同时迁移生产数据库？',
    })
    expect((attention.header as { template: string }).template).toBe('orange')
    expect(JSON.stringify((attention.body as { elements: unknown[] }).elements)).toContain('是否需要同时迁移生产数据库')

    const council = buildCouncilCompletedCard({
      councilId: 'cn_1',
      topic: '重构调度引擎架构',
      status: 'done',
      brief: '建议采用插件化并行执行器。',
      canCommit: true,
    })
    expect((council.header as { template: string }).template).toBe('purple')
    const raw = JSON.stringify((council.body as { elements: unknown[] }).elements)
    expect(raw).toContain('council_commit')
    expect(raw).toContain('按结论一键开工')

    const parsed = parseFeishuCardActionEvent({
      action: { value: { kind: 'council_commit', councilId: 'cn_1', title: '重构调度引擎架构' } },
      operator: { open_id: 'ou_123' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
    })
    expect(parsed?.actionValue).toEqual({ kind: 'council_commit', councilId: 'cn_1', title: '重构调度引擎架构' })

    const notice = buildNoticeCard({
      title: '预算提醒',
      template: 'orange',
      markdown: '今日额度已用 85%',
      meta: [{ label: '额度', value: '$8.5 / $10' }],
    })
    expect((notice.header as { template: string }).template).toBe('orange')
    expect(JSON.stringify((notice.body as { elements: unknown[] }).elements)).toContain('$8.5 / $10')
  })
})

describe('Shared DevEnv Cache & Tools inspection and safe cleanup', () => {
  it('inspects cache buckets and global tools and safely cleans only allowlisted cache buckets', () => {
    const root = mkdtempSync(join(tmpdir(), 'sa-shared-env-'))
    try {
      const cacheDir = join(root, 'cache')
      const toolsDir = join(root, 'tools')
      mkdirSync(join(cacheDir, 'npm'), { recursive: true })
      mkdirSync(join(cacheDir, 'go-mod'), { recursive: true })
      mkdirSync(join(toolsDir, 'bin'), { recursive: true })
      mkdirSync(join(toolsDir, 'go', 'bin'), { recursive: true })

      writeFileSync(join(cacheDir, 'npm', 'pkg.tgz'), 'a'.repeat(4096))
      writeFileSync(join(cacheDir, 'go-mod', 'mod.zip'), 'b'.repeat(2048))
      writeFileSync(join(toolsDir, 'bin', 'ruff'), '#!/bin/sh\n')
      writeFileSync(join(toolsDir, 'go', 'bin', 'gopls'), '#!/bin/sh\n')

      const info = inspectSharedEnv(cacheDir, toolsDir)
      expect(info.totalCacheBytes).toBe(6144)
      expect(info.tools).toEqual(['gopls', 'ruff'])
      expect(info.buckets.find(b => b.id === 'npm')?.bytes).toBe(4096)
      expect(info.buckets.find(b => b.id === 'go-mod')?.bytes).toBe(2048)

      // Path traversal / invalid bucket rejected
      expect(() => cleanSharedCache(cacheDir, '../tools')).toThrow(/不允许清理/)

      // Cleaning npm frees 4096 bytes and leaves go-mod & tools intact
      const cleaned = cleanSharedCache(cacheDir, 'npm')
      expect(cleaned.cleaned).toEqual(['npm'])
      expect(cleaned.freedBytes).toBe(4096)

      const after = inspectSharedEnv(cacheDir, toolsDir)
      expect(after.totalCacheBytes).toBe(2048)
      expect(after.tools).toEqual(['gopls', 'ruff'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('SkillAutoObserver rework streak reset on clean verified success', () => {
  it('resets consecutive rework counter after a verified completed ticket', () => {
    const root = mkdtempSync(join(tmpdir(), 'sa-observer-'))
    const db = new DatabaseSync(':memory:')
    try {
      const skills = new SkillStore(db, root)
      const evolution = new SkillEvolutionService(skills)
      const events = { add: () => undefined } as unknown as EventLog
      const observer = new SkillAutoObserver({ skills, evolution, events, reworkThreshold: 2 })

      const sk = skills.save({ name: 'Deploy SOP', description: '部署流程', content: '步骤1：构建' })
      skills.recordTicketUse('t1', sk)
      skills.recordTicketUse('t2', sk)
      skills.recordTicketUse('t3', sk)

      // 1st rework -> no candidate yet
      expect(observer.onTicketEnded({ ticketId: 't1', outcome: 'failed', acceptanceStatus: 'unmet', summary: '失败1' })).toHaveLength(0)
      // Clean verified success -> resets streak
      expect(observer.onTicketEnded({ ticketId: 't2', outcome: 'completed', acceptanceStatus: 'met', summary: '成功' })).toHaveLength(0)
      // Another single rework -> count is 1 again, still below threshold 2
      expect(observer.onTicketEnded({ ticketId: 't3', outcome: 'failed', acceptanceStatus: 'unmet', summary: '偶发失败' })).toHaveLength(0)
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Director new conversation channel API (POST /api/director/sessions)', () => {
  it('creates distinct web conversations and binds/resets feishu conversations cleanly', async () => {
    const { readFileSync } = await import('node:fs')
    const { parseConfig } = await import('../src/config.ts')
    const { createRuntime } = await import('../src/runtime.ts')
    const stateDir = mkdtempSync(join(tmpdir(), 'sa-dir-chan-'))
    const runtime = await createRuntime(parseConfig({ stateDir, maxSlots: 2, operatorId: 'operator' }))
    try {
      const token = readFileSync(join(stateDir, 'cli-token'), 'utf8').trim()
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-sa-request': '1' }

      // 1. Create a fresh web conversation
      const webRes = await fetch(`${runtime.adminUrl}/api/director/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'web', title: '网页前端规划' }),
      })
      expect(webRes.status).toBe(201)
      const webData = await webRes.json() as { ok: boolean; session: { id: string; channel: string; title: string } }
      expect(webData.ok).toBe(true)
      expect(webData.session.channel).toBe('web')
      expect(webData.session.title).toBe('网页前端规划')

      // 2. Create a feishu conversation bound to an open_id
      const fsRes = await fetch(`${runtime.adminUrl}/api/director/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'feishu', userId: 'ou_test_feishu_01', title: '飞书每日调度', resetIfExists: true }),
      })
      expect(fsRes.status).toBe(201)
      const fsData = await fsRes.json() as { ok: boolean; session: { id: string; channel: string; userId: string; title: string } }
      expect(fsData.ok).toBe(true)
      expect(fsData.session.channel).toBe('feishu')
      expect(fsData.session.userId).toBe('ou_test_feishu_01')

      // 3. Listing sessions returns both web and feishu sessions
      const listRes = await fetch(`${runtime.adminUrl}/api/director/sessions`, { headers })
      expect(listRes.status).toBe(200)
      const listData = await listRes.json() as { items: { id: string; channel: string }[] }
      expect(listData.items.some(s => s.id === webData.session.id && s.channel === 'web')).toBe(true)
      expect(listData.items.some(s => s.id === fsData.session.id && s.channel === 'feishu')).toBe(true)
    } finally {
      await runtime.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

