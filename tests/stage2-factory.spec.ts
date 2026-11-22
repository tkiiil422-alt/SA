/**
 * Stage 2（V2.1 — 研发工厂）阶段验收测试：
 * 1. 两张工单并行在 worktree 模式修改同一 Git 仓库：完整审查（含未追踪新增文件）、行级批注、一键返工、
 *    审查后代码变化触发复检、合并回主分支、故意制造合并冲突验证主分支完好无损。
 * 2. 无 Git 历史项目自动降级为副本模式。
 * 3. 浏览器自检 `browser_verify` 真实表单“提交后刷新数据仍在” + 故意断言失败触发 Goal 拦截与 trace 落盘。
 * 4. 多执行器契约：0 Token 注册脚本（防任意命令注入）+ Claude Code / OpenCode 适配器超时、取消、费用与产物。
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectService } from '../src/projects/service.ts'
import { GoalService, resolveGoal } from '../src/goal/service.ts'
import { runBrowserVerify } from '../src/verify/browser.ts'
import { PiRunnerDescriptor, RegisteredScriptRunner, RunnerRegistry } from '../src/executor/runner.ts'
import { ClaudeCodeRunner, OpenCodeRunner } from '../src/executor/adapters.ts'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Stage 2 — V2.1 研发工厂验收', () => {
  it('两张工单并发 worktree 修改同一仓库：审查未追踪新文件、批注返工、变更复检、合并与冲突保护', async () => {
    const root = tempDir('sa-wt-proj-')
    const wsRoot = tempDir('sa-wt-ws-')
    const db = new DatabaseSync(':memory:')
    const projects = new ProjectService({
      db,
      root,
      workspaceRoot: wsRoot,
      limits: () => ({ maxUploadMb: 50, maxExtractMb: 50, maxFiles: 2000 }),
    })

    // 准备一个带真实 Git 历史的导入目录
    const importsDir = join(root, '.imports', 'demo-repo')
    mkdirSync(importsDir, { recursive: true })
    writeFileSync(join(importsDir, 'app.txt'), 'line1: base\nline2: hello\n', 'utf8')
    git(importsDir, 'init', '-b', 'main')
    git(importsDir, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'add', '-A')
    git(importsDir, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'init')

    const imported = await projects.importDirectory({ sourceDir: importsDir, name: 'DemoRepo' })
    const projectId = imported.projectId
    const mainTree = join(root, projectId, 'tree')

    // 两张工单并行以 worktree 模式绑定同一项目
    projects.setPending('trg_a', projectId, 'worktree')
    projects.setPending('trg_b', projectId, 'worktree')
    await projects.prepareWorkspace('t_a', ['trg_a'])
    await projects.prepareWorkspace('t_b', ['trg_b'])

    const dirA = join(wsRoot, 't_a', 'project')
    const dirB = join(wsRoot, 't_b', 'project')
    expect(git(dirA, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sa/t_a')
    expect(git(dirB, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sa/t_b')

    // 工单 A 修改已有文件并新增未追踪文件
    writeFileSync(join(dirA, 'app.txt'), 'line1: feature-A\nline2: hello\n', 'utf8')
    mkdirSync(join(dirA, 'docs'), { recursive: true })
    writeFileSync(join(dirA, 'docs', 'guide.md'), '# 初版文档\n需要补充示例\n', 'utf8')

    // 审查 Diff：必须包含未追踪新文件 docs/guide.md 的完整新增内容
    const diffA1 = await projects.ticketDiff('t_a')
    expect(diffA1.available).toBe(true)
    expect(diffA1.mode).toBe('worktree')
    expect(diffA1.files.some(f => f.path === 'docs/guide.md' && f.status === 'A' && f.additions === 2)).toBe(true)
    expect(diffA1.diff).toContain('+++ b/docs/guide.md')
    expect(diffA1.diff).toContain('+# 初版文档')

    // 添加绑定文件、行号与 commit SHA 的行级批注并发起一键返工
    const comment = await projects.addReviewComment('t_a', {
      file: 'docs/guide.md',
      line: 2,
      comment: '请补充可执行的命令行示例',
    })
    expect(comment.commitSha).toBe(diffA1.headSha)
    const rw = await projects.requestRework('t_a', '补完后再提交审查')
    expect(rw.openCount).toBe(1)
    expect(rw.prompt).toContain('docs/guide.md:2')
    expect(rw.prompt).toContain('请补充可执行的命令行示例')

    // 模拟 Worker 返工更新后，审查签核通过
    writeFileSync(join(dirA, 'docs', 'guide.md'), '# 正式文档\n示例：`pnpm test`\n', 'utf8')
    const approved = await projects.approveReview('t_a', '看起来没问题')
    expect(approved.decision).toBe('approved')

    // 审查后故意再修改一行代码 → 必须触发 needsReverify，拦截未经复审的直接合并！
    writeFileSync(join(dirA, 'docs', 'guide.md'), '# 正式文档\n示例：`pnpm test`\n未审新增行\n', 'utf8')
    const staleDiff = await projects.ticketDiff('t_a')
    expect(staleDiff.needsReverify).toBe(true)
    expect(staleDiff.staleReason).toContain('重新校验')

    const blockedMerge = await projects.mergeTicketWorktree('t_a', () => false)
    expect(blockedMerge.ok).toBe(false)
    if (!blockedMerge.ok) expect(blockedMerge.needsReverify).toBe(true)

    // 重新校验审查通过后，成功合并回主分支！
    await projects.approveReview('t_a', '复审通过')
    const mergedA = await projects.mergeTicketWorktree('t_a', () => false)
    expect(mergedA.ok).toBe(true)
    expect(readFileSync(join(mainTree, 'app.txt'), 'utf8')).toContain('feature-A')
    expect(existsSync(join(mainTree, 'docs', 'guide.md'))).toBe(true)

    // 工单 B 在同一行故意制造与工单 A 的合并冲突
    writeFileSync(join(dirB, 'app.txt'), 'line1: conflicting-B\nline2: hello\n', 'utf8')
    const mergedB = await projects.mergeTicketWorktree('t_b', () => false)
    expect(mergedB.ok).toBe(false)
    if (!mergedB.ok) {
      expect(mergedB.conflicts).toContain('app.txt')
      expect(mergedB.message).toContain('冲突')
    }
    // 验证冲突自动 abort，主分支保持完全干净且内容仍是工单 A 合并后的完好状态
    expect(git(mainTree, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(mainTree, 'app.txt'), 'utf8')).toContain('feature-A')

    // 额外验证：无有效 Git 历史的项目在 worktree 模式下自动降级为 copy 模式
    const nonGitSrc = join(root, '.imports', 'plain-dir')
    mkdirSync(nonGitSrc, { recursive: true })
    writeFileSync(join(nonGitSrc, 'readme.txt'), 'plain project', 'utf8')
    const plain = await projects.importDirectory({ sourceDir: nonGitSrc, name: 'Plain' })
    projects.setPending('trg_plain', plain.projectId, 'worktree')
    const prep = await projects.prepareWorkspace('t_plain', ['trg_plain'])
    expect(prep.warning).toContain('降级为隔离副本')
    expect(existsSync(join(wsRoot, 't_plain', 'project', 'readme.txt'))).toBe(true)

    projects.close()
    db.close()
  }, 30_000)

  it('browser_verify：验证“提交表单后刷新数据仍在”并通过 Goal；故意断言失败时拦截通过并输出 trace', async () => {
    const outDir = tempDir('sa-bv-')
    const db = new DatabaseSync(':memory:')

    // 启动真实本地有状态表单 Web 应用（Cookie + 服务端持久记录）
    let savedNote = ''
    const srv = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/save') {
        let body = ''
        req.on('data', c => { body += String(c) })
        req.on('end', () => {
          const params = new URLSearchParams(body)
          savedNote = params.get('note') ?? ''
          res.writeHead(303, { location: '/', 'set-cookie': 'sa_demo=ok; Path=/' })
          res.end()
        })
        return
      }
      const escaped = savedNote.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body>
        <h1>记事本</h1>
        <form method="POST" action="/save">
          <input name="note" value="${escaped}" />
          <button type="submit">保存</button>
        </form>
        <div id="saved-display">${escaped || '暂无内容'}</div>
      </body></html>`)
    })

    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
    const addr = srv.address() as { port: number }
    const baseUrl = `http://127.0.0.1:${addr.port}/`

    try {
      const goals = new GoalService({
        db,
        ticket: id => ({ triggerId: `trg_${id}`, ended: false, waitsForPerson: false, undelivered: 0 }),
        spend: () => 0.05,
        settings: () => ({ maxRounds: 4, maxUsd: 5, maxHours: 2, commandTimeoutSec: 30, judge: null }),
        run: async (_id, cmd) => ({ command: cmd, code: 0, ms: 5, tail: 'ok' }),
        judge: async () => ({ ok: true, verdict: { met: true, evidence: ['已核对页面持久化和浏览器自检结果'], missing: [], summary: '已达成' } }),
        report: () => undefined,
      })

      const spec = resolveGoal({
        text: '确保表单提交后刷新页面数据仍然存在',
        mode: 'ai',
        criteria: [{ id: 'c_persist', text: '表单提交刷新后数据持久化保留', required: true }],
      }, { maxRounds: 4, maxUsd: 5, maxHours: 2 })
      goals.set('t_web', spec)

      // 1. 故意执行一条失败的浏览器断言 → 验证返回 ok:false、产出 trace，且 Goal 绝不放行！
      const failRes = await runBrowserVerify({
        url: baseUrl,
        outputDir: outDir,
        preferPlaywright: false,
        ticketId: 't_web',
        criterionId: 'c_persist',
        artifactVersion: 'rev-1',
        goals,
        steps: [
          { action: 'assertText', text: '绝不存在的错误断言文案' },
        ],
      })
      expect(failRes.ok).toBe(false)
      expect(failRes.tracePath && existsSync(failRes.tracePath)).toBe(true)

      const gateBlocked = await goals.gate('t_web', { state: 'ready', summary: '我改好了' })
      expect(gateBlocked.action).toBe('replace')
      if (gateBlocked.action === 'replace') {
        expect(gateBlocked.reply).toContain('浏览器自检')
      }

      // 2. 完整执行“填写表单 → 提交 → 刷新页面 → 断言文本与输入框值仍在”
      const passRes = await runBrowserVerify({
        url: baseUrl,
        outputDir: outDir,
        preferPlaywright: false,
        ticketId: 't_web',
        criterionId: 'c_persist',
        artifactVersion: 'rev-2',
        goals,
        steps: [
          { action: 'fill', name: 'note', value: '持久化校验_2026' },
          { action: 'submit' },
          { action: 'reload' },
          { action: 'assertStatus', status: 200 },
          { action: 'assertVisible', selector: '#saved-display' },
          { action: 'assertText', text: '持久化校验_2026' },
          { action: 'assertValue', name: 'note', value: '持久化校验_2026' },
        ],
      })
      expect(passRes.ok).toBe(true)
      expect(passRes.consoleErrors).toHaveLength(0)
      expect(passRes.screenshots.length).toBeGreaterThan(0)
      expect(existsSync(passRes.screenshots[0]!)).toBe(true)

      const gatePassed = await goals.gate('t_web', { state: 'ready', summary: '已通过浏览器提交刷新持久化验收' })
      expect(gatePassed.action).toBe('pass')
      expect(goals.view('t_web')?.status).toBe('met')
    } finally {
      await new Promise<void>(r => srv.close(() => r()))
      db.close()
    }
  })

  it('多执行器契约：0 Token 注册脚本 + Claude Code / OpenCode 适配器统一超时、取消、费用与产物', async () => {
    const ws = tempDir('sa-runners-')
    const scriptRunner = new RegisteredScriptRunner()
    const registry = new RunnerRegistry()
      .register(new PiRunnerDescriptor())
      .register(scriptRunner)

    // 1. 零 Token 注册脚本拒绝未登记 scriptId
    const badRes = await scriptRunner.runOnce({ id: 'r0', cwd: ws, scriptId: 'rm-rf-arbitrary' })
    expect(badRes.ok).toBe(false)
    expect(badRes.costUsd).toBe(0)

    // 2. 运行内置确定性脚本 `sales-report-check`（0 Token）
    writeFileSync(
      join(ws, 'orders.csv'),
      'order_id,created_at,paid_at,channel,amount\n1,2026-11-18,2026-11-20,线上,100.50\n2,2026-11-19,2026-11-21,门店,250.25\n3,2026-11-20,,线上,99.00\n',
      'utf8',
    )
    const scrRes = await scriptRunner.runOnce({
      id: 'sales1',
      cwd: ws,
      scriptId: 'sales-report-check',
      scriptParams: { inputFile: 'orders.csv', dateField: 'paid_at', decimals: 2 },
      recoveryId: 'exec_sales_1',
    })
    expect(scrRes.ok).toBe(true)
    expect(scrRes.costUsd).toBe(0)
    expect(scrRes.recoveryId).toBe('exec_sales_1')
    expect(scrRes.artifacts).toContain('sales-report.md')
    expect(scrRes.data?.totalFormatted).toBe('350.75')
    expect(scrRes.data?.matchedRows).toBe(2)

    // 3. Claude Code CLI 适配器契约验证（输出费用、写入产物、恢复标识）
    const fakeCli = join(ws, 'fake-cli.mjs')
    writeFileSync(fakeCli, `
      import { writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      const mode = process.argv[2]
      if (mode === 'slow') {
        setTimeout(() => process.exit(0), 10000)
      } else {
        writeFileSync(join(process.env.SA_ARTIFACTS_DIR, 'result.txt'), 'artifact-ok:' + process.env.SA_RECOVERY_ID)
        console.log(JSON.stringify({ ok: true, total_cost_usd: 0.1234 }))
      }
    `, 'utf8')

    const claude = new ClaudeCodeRunner({ command: process.execPath, extraArgs: [fakeCli] })
    const opencode = new OpenCodeRunner({ command: process.execPath, extraArgs: [fakeCli] })
    registry.register(claude).register(opencode)
    expect(registry.resolve('claude-code')?.id).toBe('claude-code')
    expect(registry.resolve('unknown-id')?.id).toBe('pi')

    const cOk = await claude.runOnce({ id: 'c1', cwd: ws, prompt: 'run', recoveryId: 'rec_c1' })
    expect(cOk.ok).toBe(true)
    expect(cOk.costUsd).toBeCloseTo(0.1234, 4)
    expect(cOk.artifacts).toContain('result.txt')
    expect(cOk.recoveryId).toBe('rec_c1')

    // 超时控制
    const cTimeout = await opencode.runOnce({ id: 'o_to', cwd: ws, prompt: 'slow', timeoutMs: 300 })
    expect(cTimeout.ok).toBe(false)
    expect(cTimeout.timedOut).toBe(true)

    // AbortSignal 取消控制
    const ctl = new AbortController()
    const cancelPromise = opencode.runOnce({ id: 'o_cancel', cwd: ws, prompt: 'slow', timeoutMs: 10_000, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 120)
    const cCancel = await cancelPromise
    expect(cCancel.ok).toBe(false)
    expect(cCancel.cancelled).toBe(true)
  })
})
