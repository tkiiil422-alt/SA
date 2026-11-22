/**
 * Stage 3（V2.2 — 可靠编排、中断恢复、智能升级与远程执行节点）阶段验收测试：
 * 1. 完整 DAG：“出方案 → 并行两个子任务 → 汇总测试 → 人工批准”，含实体产物/SHA 交接。
 * 2. 中断恢复：模拟“已派单但尚未写回 ticketId 时进程退出”，重启对账找回原工单零重复派单。
 * 3. 人工审批：绑定真实用户、节点与计划版本；同一批准提交两次严格幂等；过期计划版本拒绝批准。
 * 4. 失败分类与预算内模型升级：need_info 提问、env_error 引导修环境、reasoning_blocked 预算内升级并带交接上下文。
 * 5. 远程节点本地闭环：能力路由、租约领取、心跳、断线超时重连、取消信号、产物 SHA-256 回传与 callId 去重结算。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MissionStore } from '../src/missions/store.ts'
import { MissionService, type TicketHandoffInfo } from '../src/missions/service.ts'
import { GoalService, resolveGoal } from '../src/goal/service.ts'
import { RemoteStore } from '../src/remote/store.ts'
import { RemoteNodeService } from '../src/remote/service.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { EventLog } from '../src/ledger/events.ts'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Stage 3 — V2.2 可靠编排、中断恢复、模型升级与远程节点', () => {
  it('完整 DAG 流程 + 派单中途崩溃恢复（零重复派单）+ 实体产物/SHA 交接 + 幂等版本审批', async () => {
    const dbPath = join(tempDir('sa-dag-'), 'mission.sqlite')
    const db1 = new DatabaseSync(dbPath)
    const events1 = new EventLog(db1)
    const store1 = new MissionStore(db1)

    // 模拟持久化在外部工单表里的记录（即使主控崩溃重启也存在）
    const externalTickets = new Map<string, { ticketId: string; executionId: string; text: string; ended: boolean; outcome?: string; summary?: string; artifacts?: string[]; commitSha?: string }>()
    let dispatchCount = 0
    let crashOnSubB = true

    const makeService = (db: DatabaseSync, events: EventLog, store: MissionStore) => new MissionService({
      store,
      events,
      dispatchTicket: async input => {
        dispatchCount += 1
        const ticketId = `t_dag_${dispatchCount}`
        externalTickets.set(input.executionId, {
          ticketId,
          executionId: input.executionId,
          text: input.text,
          ended: false,
        })
        // 故意在 sub_b 已创建外部工单后、尚未写回 mission_nodes.ticket_id 前模拟进程崩溃！
        if (crashOnSubB && input.executionId.includes('_sub_b_')) {
          crashOnSubB = false
          throw new Error('SIMULATED_PROCESS_CRASH_BEFORE_WRITEBACK')
        }
        return { ticketId, triggerId: `trg_${dispatchCount}` }
      },
      reconcileTicketByExecutionId: executionId => {
        const hit = externalTickets.get(executionId)
        if (!hit) return undefined
        const info: TicketHandoffInfo = {
          ticketId: hit.ticketId,
          ended: hit.ended,
          ...(hit.outcome ? { outcome: hit.outcome } : {}),
          ...(hit.summary ? { summary: hit.summary } : {}),
          ...(hit.artifacts ? { artifacts: hit.artifacts } : {}),
          ...(hit.commitSha ? { commitSha: hit.commitSha } : {}),
        }
        return info
      },
      getTicketHandoff: ticketId => {
        const hit = [...externalTickets.values()].find(t => t.ticketId === ticketId)
        if (!hit) return undefined
        return {
          ticketId: hit.ticketId,
          ended: hit.ended,
          ...(hit.outcome ? { outcome: hit.outcome } : {}),
          ...(hit.summary ? { summary: hit.summary } : {}),
          ...(hit.artifacts ? { artifacts: hit.artifacts } : {}),
          ...(hit.commitSha ? { commitSha: hit.commitSha } : {}),
        }
      },
      runDirectorNode: async input => ({
        reply: '已完成技术方案拆解，划分为前端改造与后端接口两个并行子任务。',
        artifacts: ['docs/plan-v1.md'],
      }),
    })

    const svc1 = makeService(db1, events1, store1)
    const mission = await svc1.create({
      title: '订单页改造与上线',
      goal: '完成方案、并行开发、汇总测试并在人工批准后收尾',
      autoStart: true,
      nodes: [
        { key: 'plan', title: '出方案', kind: 'director', prompt: '输出改造方案文档' },
        { key: 'sub_a', title: '前端子任务', kind: 'ticket', prompt: '改造前端表单页面', dependsOn: ['plan'] },
        { key: 'sub_b', title: '后端子任务', kind: 'ticket', prompt: '新增持久化保存接口', dependsOn: ['plan'] },
        { key: 'aggregate', title: '汇总测试', kind: 'ticket', prompt: '联合验收前后端产物', dependsOn: ['sub_a', 'sub_b'] },
        { key: 'approve', title: '人工上线批准', kind: 'approval', prompt: '请主人确认测试结果并批准发布', dependsOn: ['aggregate'] },
      ],
    })

    // 模拟真实崩溃现场：把 sub_b 强制还原为“已落盘 dispatching + executionId，尚未写回 ticketId 就进程退出”
    const subBExecId = mission.nodes.find(n => n.key === 'sub_b')!.executionId!
    expect(subBExecId).toBeTruthy()
    expect(externalTickets.has(subBExecId)).toBe(true)
    db1.prepare(`UPDATE mission_nodes SET status = 'dispatching', ticket_id = NULL, error = NULL, finished_at = NULL WHERE mission_id = ? AND node_key = 'sub_b'`)
      .run(mission.id)
    db1.prepare(`UPDATE missions SET status = 'running' WHERE id = ?`).run(mission.id)
    db1.close()

    // === 模拟主控重启：打开同一 SQLite，新建 MissionService 并执行 recoverInterrupted() ===
    const db2 = new DatabaseSync(dbPath)
    const events2 = new EventLog(db2)
    const store2 = new MissionStore(db2)
    const svc2 = makeService(db2, events2, store2)

    const dispatchesBeforeRecover = dispatchCount
    const rec = await svc2.recoverInterrupted()
    expect(rec.reconciledTickets).toBe(1)
    // 核心断言：重启恢复找回了原工单，绝对没有为 sub_b 重复派单！
    expect(dispatchCount).toBe(dispatchesBeforeRecover)

    const afterRecover = svc2.get(mission.id)!
    const subA = afterRecover.nodes.find(n => n.key === 'sub_a')!
    const subB = afterRecover.nodes.find(n => n.key === 'sub_b')!
    expect(subA.status).toBe('running')
    expect(subB.status).toBe('running')
    expect(subB.ticketId).toBe(externalTickets.get(subBExecId)!.ticketId)

    // 两个并行子任务分别完成，并交接真实文件产物与提交 SHA
    await svc2.onTicketEnded(subA.ticketId!, 'completed', '前端表单改造完成', {
      artifacts: ['web/order-form.html', 'output/browser-verify/shot.png'],
      commitSha: 'aaaa1111bbbb2222',
    })
    await svc2.onTicketEnded(subB.ticketId!, 'completed', '后端保存接口完成', {
      artifacts: ['server/orders.ts'],
      commitSha: 'cccc3333dddd4444',
    })

    // 汇总测试节点应自动启动，且收到的 Prompt 完整包含两个并行子任务的实际文件路径与 commit SHA！
    const mAfterSubs = svc2.get(mission.id)!
    const aggNode = mAfterSubs.nodes.find(n => n.key === 'aggregate')!
    expect(aggNode.status).toBe('running')
    const aggTicket = externalTickets.get(aggNode.executionId!)!
    expect(aggTicket.text).toContain('aaaa1111bbbb2222')
    expect(aggTicket.text).toContain('cccc3333dddd4444')
    expect(aggTicket.text).toContain('web/order-form.html')
    expect(aggTicket.text).toContain('server/orders.ts')

    // 汇总测试完成 → 自动停在人工审批卡点 `approve`
    await svc2.onTicketEnded(aggNode.ticketId!, 'completed', '联调测试 100% 通过', {
      artifacts: ['output/integration-report.json'],
    })
    const mWaitApprove = svc2.get(mission.id)!
    expect(mWaitApprove.nodes.find(n => n.key === 'approve')?.status).toBe('waiting_approval')

    // 1) 版本失配防护：传入错误 planVersion 必须被拒绝
    await expect(
      svc2.approveNode(mission.id, 'approve', { actorId: 'feishu:ou_owner', planVersion: 99 }),
    ).rejects.toThrow('审批版本不匹配')

    // 2) 首次审批成功，绑定真实操作人与计划版本
    const ap1 = await svc2.approveNode(mission.id, 'approve', {
      actorId: 'feishu:ou_owner',
      planVersion: 1,
      idempotencyKey: 'idem_approve_001',
      note: '测试报告无误，批准发布',
    })
    expect(ap1.idempotent).toBe(false)
    expect(ap1.item.status).toBe('completed')
    const approvedNode = ap1.item.nodes.find(n => n.key === 'approve')!
    expect(approvedNode.approvedBy).toBe('feishu:ou_owner')
    expect(approvedNode.approvedPlanVersion).toBe(1)

    // 3) 同一批准被提交两次：严格幂等返回，不重复触发任何下游动作或抛错！
    const ap2 = await svc2.approveNode(mission.id, 'approve', {
      actorId: 'feishu:ou_owner',
      planVersion: 1,
      idempotencyKey: 'idem_approve_001',
      note: '测试报告无误，批准发布',
    })
    expect(ap2.idempotent).toBe(true)
    expect(ap2.item.status).toBe('completed')
    db2.close()
  })

  it('智能模型升级：先分类根因（信息不足提问 / 环境错误修环境 / 推理受阻预算内升级带交接上下文）', async () => {
    // 场景 A：信息不足（need_info）→ 暂停向主人提问，绝不调用 escalateModel
    const dbA = new DatabaseSync(':memory:')
    let escalateCalledA = 0
    const goalsA = new GoalService({
      db: dbA,
      ticket: id => ({ triggerId: `trg_${id}`, ended: false, waitsForPerson: false, undelivered: 0 }),
      spend: () => 0.2,
      settings: () => ({ maxRounds: 5, maxUsd: 5, maxHours: 2, commandTimeoutSec: 30, judge: null }),
      run: async () => ({ command: 'test', code: 1, ms: 5, tail: 'missing API_KEY: 请提供凭据后重试' }),
      judge: async () => ({ ok: true, verdict: { met: false, evidence: [], missing: ['缺少 API_KEY 凭据'], summary: '缺少凭据' } }),
      report: () => undefined,
      escalateModel: () => { escalateCalledA += 1; return { from: 'a', to: 'b' } },
    })
    goalsA.set('t_info', resolveGoal({ text: '调用外部账单接口', commands: ['node sync.js'], mode: 'commands' }, { maxRounds: 5, maxUsd: 5, maxHours: 2 }))
    await goalsA.gate('t_info', { state: 'ready', summary: '第1次尝试' })
    const g2 = await goalsA.gate('t_info', { state: 'ready', summary: '第2次尝试' })
    expect(escalateCalledA).toBe(0)
    expect(g2.action).toBe('replace')
    if (g2.action === 'replace') {
      expect(g2.report.state).toBe('blocked')
      expect(g2.report.question).toContain('信息/凭据')
    }
    dbA.close()

    // 场景 B：环境出错（env_error）→ 提示修环境，不换模型
    const dbB = new DatabaseSync(':memory:')
    let escalateCalledB = 0
    const goalsB = new GoalService({
      db: dbB,
      ticket: id => ({ triggerId: `trg_${id}`, ended: false, waitsForPerson: false, undelivered: 0 }),
      spend: () => 0.2,
      settings: () => ({ maxRounds: 5, maxUsd: 5, maxHours: 2, commandTimeoutSec: 30, judge: null }),
      run: async () => ({ command: 'pytest', code: 127, ms: 5, tail: 'bash: pytest: command not found (ENOENT)' }),
      judge: async () => ({ ok: true, verdict: { met: false, evidence: [], missing: [], summary: '' } }),
      report: () => undefined,
      escalateModel: () => { escalateCalledB += 1; return { from: 'a', to: 'b' } },
    })
    goalsB.set('t_env', resolveGoal({ text: '运行测试', commands: ['pytest'], mode: 'commands' }, { maxRounds: 5, maxUsd: 5, maxHours: 2 }))
    await goalsB.gate('t_env', { state: 'ready', summary: '第1次' })
    const envRes = await goalsB.gate('t_env', { state: 'ready', summary: '第2次' })
    expect(escalateCalledB).toBe(0)
    if (envRes.action === 'replace') {
      expect(envRes.reply).toContain('环境/依赖异常')
    }
    dbB.close()

    // 场景 C：推理受阻（reasoning_blocked）且在预算内 → 升级更强模型并传入完整交接上下文
    const dbC = new DatabaseSync(':memory:')
    let spentC = 0
    let handoffCaptured: { remainingUsd: number; previousAttempts: string[]; evidences: unknown[]; latestSummary: string } | undefined
    const goalsC = new GoalService({
      db: dbC,
      ticket: id => ({ triggerId: `trg_${id}`, ended: false, waitsForPerson: false, undelivered: 0 }),
      spend: () => spentC,
      settings: () => ({ maxRounds: 5, maxUsd: 5, maxHours: 2, commandTimeoutSec: 30, judge: null }),
      run: async () => ({ command: 'pnpm test', code: 1, ms: 10, tail: 'AssertionError: expected 350.75 to equal 350.80' }),
      judge: async () => ({ ok: true, verdict: { met: false, evidence: [], missing: [], summary: '' } }),
      report: () => undefined,
      escalateModel: (_id, ctx) => {
        handoffCaptured = {
          remainingUsd: ctx.remainingUsd,
          previousAttempts: ctx.previousAttempts,
          evidences: ctx.evidences,
          latestSummary: ctx.latestSummary,
        }
        return { from: 'deepseek/deepseek-chat', to: 'deepseek/deepseek-reasoner' }
      },
    })
    goalsC.set('t_reason', resolveGoal({ text: '修复复杂税率四舍五入算法', commands: ['pnpm test'], mode: 'commands', maxUsd: 5 }, { maxRounds: 5, maxUsd: 5, maxHours: 2 }))
    spentC = 1.0
    await goalsC.gate('t_reason', { state: 'ready', summary: '已修改 rounding.ts 第 1 版' })
    const escRes = await goalsC.gate('t_reason', { state: 'ready', summary: '已修改 rounding.ts 第 2 版' })
    expect(handoffCaptured).toBeDefined()
    expect(handoffCaptured!.remainingUsd).toBeCloseTo(4.0, 2)
    expect(handoffCaptured!.previousAttempts.length).toBeGreaterThanOrEqual(2)
    expect(handoffCaptured!.evidences.length).toBeGreaterThanOrEqual(2)
    expect(handoffCaptured!.latestSummary).toContain('rounding.ts')
    if (escRes.action === 'replace') {
      expect(escRes.reply).toContain('deepseek/deepseek-reasoner')
    }
    expect(goalsC.view('t_reason')?.escalatedTo).toBe('deepseek/deepseek-reasoner')

    // 场景 D：推理受阻但剩余预算不足（<= $0.05）→ 绝不超预算升级模型
    let escalateLowBudget = 0
    let spentD = 0
    const goalsD = new GoalService({
      db: dbC,
      ticket: id => ({ triggerId: `trg_${id}`, ended: false, waitsForPerson: false, undelivered: 0 }),
      spend: () => spentD,
      settings: () => ({ maxRounds: 5, maxUsd: 1, maxHours: 2, commandTimeoutSec: 30, judge: null }),
      run: async () => ({ command: 'pnpm test', code: 1, ms: 10, tail: 'AssertionError: mismatch' }),
      judge: async () => ({ ok: true, verdict: { met: false, evidence: [], missing: [], summary: '' } }),
      report: () => undefined,
      escalateModel: () => { escalateLowBudget += 1; return { from: 'a', to: 'b' } },
    })
    goalsD.set('t_low_budget', resolveGoal({ text: '修复算法', commands: ['pnpm test'], mode: 'commands', maxUsd: 1 }, { maxRounds: 5, maxUsd: 1, maxHours: 2 }))
    spentD = 0.98
    await goalsD.gate('t_low_budget', { state: 'ready', summary: '第1次' })
    await goalsD.gate('t_low_budget', { state: 'ready', summary: '第2次' })
    expect(escalateLowBudget).toBe(0)
    dbC.close()
  })

  it('远程执行节点本地闭环：能力领取、心跳、断线重连、取消、产物 SHA-256 回传与 callId 去重结算', () => {
    const root = tempDir('sa-remote-')
    const db = new DatabaseSync(':memory:')
    const ledger = new Ledger(db)
    const events = new EventLog(db)
    const store = new RemoteStore(db)
    let nowMs = Date.parse('2026-11-22T10:00:00.000Z')

    const remote = new RemoteNodeService({
      store,
      ledger,
      events,
      stateDir: join(root, 'state'),
      workspaceRoot: join(root, 'ws'),
      gatewayUrl: () => 'http://127.0.0.1:43210',
      leaseSec: 30,
      heartbeatTimeoutSec: 45,
      now: () => new Date(nowMs),
    })

    // 1. 注册两台不同能力的节点：cpu-node（无 GPU）与 gpu-node（有 GPU + 关联 SSH 配置）
    const cpuNode = remote.registerNode({ id: 'rn_cpu', name: 'CPU 小主机', capabilities: ['linux-amd64'] })
    const gpuNode = remote.registerNode({ id: 'rn_gpu', name: 'GPU 训练机', sshConnection: 'gpu-lab', capabilities: ['linux-amd64', 'gpu'] })

    // 2. 入队一个确实需要 GPU 的作业（重复同 executionId 应幂等不建第二个）
    const enq1 = remote.enqueueJob({
      executionId: 'rexec_train_001',
      ticketId: 't_gpu_1',
      requiredCapabilities: ['gpu'],
      payload: { task: 'run-whisper-transcribe', file: 'audio.wav' },
    })
    const enq2 = remote.enqueueJob({
      executionId: 'rexec_train_001',
      ticketId: 't_gpu_1',
      requiredCapabilities: ['gpu'],
      payload: { task: 'run-whisper-transcribe', file: 'audio.wav' },
    })
    expect(enq1.created).toBe(true)
    expect(enq2.created).toBe(false)
    expect(enq2.job.id).toBe(enq1.job.id)

    // CPU 节点不满足能力要求，领不到该作业；GPU 节点成功领取并拿到主控模型网关地址
    expect(remote.claim(cpuNode.id).job).toBeNull()
    const claimed = remote.claim(gpuNode.id)
    expect(claimed.job?.id).toBe(enq1.job.id)
    expect(claimed.gatewayUrl).toBe('http://127.0.0.1:43210')

    // 3. 心跳正常续租
    nowMs += 15_000
    const hb1 = remote.heartbeat(gpuNode.id, [enq1.job.executionId])
    expect(hb1.renewedJobIds).toContain(enq1.job.id)

    // 4. 模拟网络断线超时（前进 60s > 租约 30s & 心跳 45s）→ 巡检标记离线并释放作业回队列
    nowMs += 60_000
    const swept = remote.sweepExpired()
    expect(swept.offlineNodes).toContain(gpuNode.id)
    expect(swept.requeuedJobs).toContain(enq1.job.id)
    expect(remote.getJob(enq1.job.id)?.status).toBe('queued')

    // 5. 节点断线重连并重新领取同一作业
    const reclaimed = remote.claim(gpuNode.id)
    expect(reclaimed.job?.id).toBe(enq1.job.id)
    expect(reclaimed.job?.attempts).toBe(2)

    // 6. 产物回传（含 SHA-256 校验与防路径穿越）
    const payloadBuf = Buffer.from('transcription: hello superagent\n', 'utf8')
    const sha = createHash('sha256').update(payloadBuf).digest('hex')
    const uploaded = remote.uploadArtifact(enq1.job.id, {
      filename: '../../transcript.txt',
      contentBase64: payloadBuf.toString('base64'),
      expectedSha256: sha,
    })
    expect(uploaded.path).toBe('output/remote/transcript.txt')
    const savedOnDisk = join(root, 'ws', 't_gpu_1', 'output', 'remote', 'transcript.txt')
    expect(existsSync(savedOnDisk)).toBe(true)
    expect(readFileSync(savedOnDisk, 'utf8')).toBe('transcription: hello superagent\n')

    // 7. 去重结算：同一 callId 上报两次，Ledger 只扣一次钱！
    const u1 = remote.reportUsage(enq1.job.id, {
      callId: 'rcall_unique_777',
      provider: 'deepseek',
      model: 'deepseek-chat',
      completion: 500,
      costUsd: 0.042,
    })
    const u2 = remote.reportUsage(enq1.job.id, {
      callId: 'rcall_unique_777',
      provider: 'deepseek',
      model: 'deepseek-chat',
      completion: 500,
      costUsd: 0.042,
    })
    expect(u1.deduplicated).toBe(false)
    expect(u2.deduplicated).toBe(true)
    expect(ledger.ticketTotals('t_gpu_1').usd).toBeCloseTo(0.042, 6)
    expect(ledger.ticketTotals('t_gpu_1').calls).toBe(1)

    // 8. 结算完成 & 另一个作业验证取消信号下发
    const done = remote.completeJob(enq1.job.id, { ok: true, summary: '转写完成并已回传 transcript.txt' })
    expect(done.status).toBe('completed')

    const cancelJob = remote.enqueueJob({
      executionId: 'rexec_cancel_002',
      requiredCapabilities: ['gpu'],
      payload: { task: 'long-job' },
    }).job
    remote.claim(gpuNode.id)
    remote.cancelJob(cancelJob.id, '主人手动取消')
    const hbCancel = remote.heartbeat(gpuNode.id, [cancelJob.executionId])
    expect(hbCancel.cancelledJobIds).toContain(cancelJob.id)

    db.close()
  })
})
