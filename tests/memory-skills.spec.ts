/** 三层长期记忆、可进化技能库与插件端到端集成测试。 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/memory/store.ts'
import { SkillStore } from '../src/skills/store.ts'
import { parseConfig } from '../src/config.ts'
import { createRuntime, type Runtime } from '../src/runtime.ts'

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))
process.env.SA_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'superagent-mem-backups-'))

const runtimes: Runtime[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const r of runtimes.splice(0)) { try { await r.stop() } catch { /* stopped */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('MemoryStore & SkillStore', () => {
  it('stores 3-layer memories, deduplicates by scope+project+title, and recalls with CJK/FTS + project isolation', () => {
    const db = new DatabaseSync(':memory:')
    const store = new MemoryStore(db)

    const pref = store.save({
      scope: 'user',
      kind: 'preference',
      title: '代码注释语言偏好',
      content: '所有核心逻辑与架构说明统一使用简体中文注释',
      tags: ['风格', '中文'],
      pinned: true,
    })
    const projA = store.save({
      scope: 'project',
      kind: 'pitfall',
      projectId: 'p_alpha',
      title: 'Podman 只读根与 HOME 挂载坑',
      content: '挂载 /home/node 时必须加 U 选项，否则 pip 和 uv 写入会报 Permission denied',
      tags: ['podman', 'python'],
    })
    store.save({
      scope: 'project',
      kind: 'pitfall',
      projectId: 'p_beta',
      title: 'Beta 专属部署坑',
      content: 'Podman 容器需要暴露 9090 端口',
      tags: ['podman'],
    })

    // 同作用域同标题再次保存自动合并而非重复建两条
    const merged = store.save({
      scope: 'user',
      kind: 'preference',
      title: '代码注释语言偏好',
      content: '所有核心逻辑与架构说明统一使用简体中文注释，函数名用英文',
      tags: ['规范'],
    })
    expect(merged.id).toBe(pref.id)
    expect(merged.tags).toEqual(['风格', '中文', '规范'])
    expect(store.stats().total).toBe(3)

    // 带 projectId=p_alpha 召回时，不应串台到 p_beta 的记忆
    const recalled = store.recall({ query: 'Podman pip 挂载权限报错', projectId: 'p_alpha', limit: 5, recordUse: true })
    expect(recalled.map(m => m.id)).toContain(projA.id)
    expect(recalled.some(m => m.projectId === 'p_beta')).toBe(false)
    expect(store.get(projA.id)!.useCount).toBe(1)
    expect(store.get(projA.id)!.lastUsedAt).not.toBeNull()
  })

  it('persists skills to SQLite and mirrors Markdown files with frontmatter, matching by triggers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-skills-'))
    dirs.push(dir)
    const db = new DatabaseSync(':memory:')
    const store = new SkillStore(db, dir)

    const sk = store.save({
      slug: 'deploy-debian',
      name: 'Debian 主机安全发布 SOP',
      description: '执行类型检查、构建前端并重启 systemd 服务',
      scope: 'both',
      triggers: ['部署', '上线', 'systemd'],
      tags: ['ops', 'deploy'],
      content: '1. 执行 pnpm check\n2. 跑 deploy/deploy.sh\n3. 验证 /api/health',
    })
    const mdFile = join(dir, 'deploy-debian.md')
    expect(existsSync(mdFile)).toBe(true)
    const mdText = readFileSync(mdFile, 'utf8')
    expect(mdText).toContain('slug: "deploy-debian"')
    expect(mdText).toContain('执行 pnpm check')

    const matched = store.match('帮我把这次改动部署上线到 Debian', 'worker', 3, true)
    expect(matched.length).toBe(1)
    expect(matched[0]!.id).toBe(sk.id)
    expect(store.get(sk.id)!.useCount).toBe(1)

    expect(store.delete(sk.id)).toBe(true)
    expect(existsSync(mdFile)).toBe(false)
  })
})

describe('Memory & Skills plugin end-to-end in Runtime', () => {
  it('exposes /api/plugins, /api/memories, /api/skills and records ticket retrospectives automatically', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-mem-rt-'))
    dirs.push(stateDir)
    const runtime = await createRuntime(parseConfig({
      stateDir,
      maxSlots: 2,
      operatorId: 'operator',
      launcher: {
        command: process.execPath,
        args: [FAKE_PI],
        env: { FAKE_PI_REPORT_READY: '1', FAKE_PI_RUN_MS: '30' },
      },
      policy: { policy: { sources: { cli: { allowed: [{ id: 'operator', name: 'Operator' }] } } }, eval: { mode: 'auto' } },
    }))
    runtimes.push(runtime)

    const token = readFileSync(join(stateDir, 'cli-token'), 'utf8').trim()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-sa-request': '1' }

    // 1. /api/plugins 返回包含 memory-skills 和 scheduler 在内的完整清单
    const pluginsRes = await fetch(`${runtime.adminUrl}/api/plugins`, { headers })
    expect(pluginsRes.status).toBe(200)
    const pluginsJson = await pluginsRes.json() as { items: { id: string; enabled: boolean }[] }
    expect(pluginsJson.items.map(p => p.id)).toEqual(expect.arrayContaining(['memory-skills', 'scheduler', 'novel', 'pentest']))

    // 2. 通过 HTTP API 读写记忆与技能
    const createMem = await fetch(`${runtime.adminUrl}/api/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope: 'user', kind: 'preference', title: '汇报风格', content: '优先给三行以内结论', pinned: true }),
    })
    expect(createMem.status).toBe(200)
    const { item: mem } = await createMem.json() as { item: { id: string; pinned: boolean } }
    expect(mem.pinned).toBe(true)

    const listMem = await fetch(`${runtime.adminUrl}/api/memories?pinned=1`, { headers })
    expect(listMem.status).toBe(200)
    expect(((await listMem.json()) as { items: unknown[] }).items.length).toBe(1)

    const createSkill = await fetch(`${runtime.adminUrl}/api/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '日志排障套路', description: '排查 systemd 报错', triggers: ['日志', '报错'], content: '先看 journalctl 再看事件表' }),
    })
    expect(createSkill.status).toBe(200)
    const { item: skill } = await createSkill.json() as { item: { id: string; slug: string } }
    expect(existsSync(join(stateDir, 'skills', `${skill.slug}.md`))).toBe(true)

    // 3. 跑完一张真实工单后，自动通过 ticket.ended 事件钩子沉淀复盘记忆
    const asked = await runtime.ask('测试自动复盘沉淀流程')
    expect(asked.ticketId).toBeDefined()
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const t = runtime.ticket(asked.ticketId!)
      if (t?.status === 'ended') break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(runtime.ticket(asked.ticketId!)?.status).toBe('ended')

    const retros = runtime.memories.list({ kind: 'retro' })
    expect(retros.items.length).toBeGreaterThanOrEqual(1)
    expect(retros.items[0]!.ticketId).toBe(asked.ticketId)

    // 4. 验证 Director 动态加载了插件工具枚举并可通过插件工具查询/写入记忆与定时任务
    const pluginPrompts = runtime.plugins.collectDirectorPromptSections({
      channel: 'web',
      userId: 'operator',
      userMessage: '汇报风格怎么写？',
    })
    expect(pluginPrompts.join('\n')).toContain('优先给三行以内结论')
    expect(pluginPrompts.join('\n')).toContain('日志排障套路')
  })
})
