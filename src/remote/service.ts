/**
 * 远程执行节点编排服务（RemoteNodeService）。
 *
 * 复用主控现有的 SSH 连接、凭据管理、模型网关地址与预算账本（`Ledger`），完整覆盖：
 * - 节点注册与能力路由
 * - 作业领取、租约心跳与取消信号下发
 * - 断线超时检测、作业重放与断线重连续认
 * - 带 SHA-256 校验与防路径穿越保护的产物回传
 * - 基于 `callId` 严格去重的预算账本结算
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { EventLog } from '../ledger/events.ts'
import type { Ledger } from '../ledger/ledger.ts'
import type { RemoteJobRecord, RemoteNodeRecord, RemoteStore } from './store.ts'

export interface RemoteServiceDeps {
  store: RemoteStore
  ledger: Ledger
  events: EventLog
  stateDir: string
  workspaceRoot: string
  /** 主控模型网关地址，供远程节点共享同一套代理鉴权与计费通道。 */
  gatewayUrl?: () => string
  leaseSec?: number
  heartbeatTimeoutSec?: number
  now?: () => Date
}

export class RemoteNodeService {
  private readonly leaseSec: number
  private readonly heartbeatTimeoutSec: number
  private readonly doNow: () => Date
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: RemoteServiceDeps) {
    this.leaseSec = Math.max(10, deps.leaseSec ?? 60)
    this.heartbeatTimeoutSec = Math.max(15, deps.heartbeatTimeoutSec ?? 90)
    this.doNow = deps.now ?? (() => new Date())
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.sweepExpired()
    }, 15_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  registerNode(input: {
    id?: string
    name: string
    sshConnection?: string | null
    capabilities?: string[]
    maxJobs?: number
  }): RemoteNodeRecord {
    const node = this.deps.store.upsertNode(input, this.doNow())
    try {
      this.deps.events.add({
        kind: 'remote.node_registered',
        level: 'info',
        text: `远程节点「${node.name}」已上线（能力：${node.capabilities.join(', ') || '通用'}）`,
        data: { nodeId: node.id, capabilities: node.capabilities, sshConnection: node.sshConnection },
      })
    } catch { /* ignore */ }
    return node
  }

  listNodes(): RemoteNodeRecord[] {
    return this.deps.store.listNodes()
  }

  listJobs(filter?: { status?: RemoteJobRecord['status']; nodeId?: string }): RemoteJobRecord[] {
    return this.deps.store.listJobs(filter)
  }

  getJob(jobId: string): RemoteJobRecord | undefined {
    return this.deps.store.getJob(jobId)
  }

  enqueueJob(input: {
    executionId: string
    ticketId?: string | null
    requiredCapabilities?: string[]
    payload: Record<string, unknown>
  }): { job: RemoteJobRecord; created: boolean } {
    return this.deps.store.enqueueJob(input, this.doNow())
  }

  claim(nodeId: string): { job: RemoteJobRecord | null; gatewayUrl?: string; leaseSec: number } {
    const node = this.deps.store.touchNodeHeartbeat(nodeId, this.doNow())
    if (!node) throw new Error(`找不到远程节点 ${nodeId}`)
    const job = this.deps.store.claimNextJob(node, this.leaseSec, this.doNow()) ?? null
    const gw = this.deps.gatewayUrl?.()
    return { job, leaseSec: this.leaseSec, ...(gw ? { gatewayUrl: gw } : {}) }
  }

  /**
   * 节点心跳与断线重连续租：
   * - 刷新节点在线状态；
   * - 对节点汇报的正在执行 `activeExecutionIds` 进行续租或对账，并返回已被取消/已结束的作业清单以便节点清理。
   */
  heartbeat(nodeId: string, activeExecutionIds: readonly string[] = []): {
    ok: true
    node: RemoteNodeRecord
    renewedJobIds: string[]
    cancelledJobIds: string[]
    alreadyFinishedIds: string[]
  } {
    const node = this.deps.store.touchNodeHeartbeat(nodeId, this.doNow())
    if (!node) throw new Error(`找不到远程节点 ${nodeId}`)
    const renewedJobIds: string[] = []
    const cancelledJobIds: string[] = []
    const alreadyFinishedIds: string[] = []

    for (const execId of activeExecutionIds) {
      const job = this.deps.store.getJobByExecutionId(execId)
      if (!job) continue
      if (job.status === 'cancelled') {
        cancelledJobIds.push(job.id)
      } else if (job.status === 'completed' || job.status === 'failed') {
        alreadyFinishedIds.push(job.id)
      } else {
        this.deps.store.renewJobLease(job.id, nodeId, this.leaseSec, this.doNow())
        renewedJobIds.push(job.id)
      }
    }
    return { ok: true, node, renewedJobIds, cancelledJobIds, alreadyFinishedIds }
  }

  /** 扫描失联节点与超时租约，将未完成作业放回队列等待健康节点或重连节点接手。 */
  sweepExpired(): { offlineNodes: string[]; requeuedJobs: string[] } {
    const res = this.deps.store.sweepExpired(this.heartbeatTimeoutSec, this.doNow())
    if (res.offlineNodes.length > 0 || res.requeuedJobs.length > 0) {
      try {
        this.deps.events.add({
          kind: 'remote.lease_swept',
          level: 'warn',
          text: `远程心跳巡检：${res.offlineNodes.length} 个节点失联，${res.requeuedJobs.length} 个超时作业已重新入队`,
          data: res,
        })
      } catch { /* ignore */ }
    }
    return res
  }

  cancelJob(jobId: string, reason?: string): RemoteJobRecord {
    const job = this.deps.store.cancelJob(jobId, reason, this.doNow())
    if (!job) throw new Error(`找不到远程作业 ${jobId}`)
    return job
  }

  /** 接收远程节点回传产物：校验路径安全与 SHA-256，写入工单 `output/remote/` 或独立产物目录。 */
  uploadArtifact(jobId: string, input: { filename: string; contentBase64: string; expectedSha256?: string }): {
    path: string
    sha256: string
    bytes: number
    job: RemoteJobRecord
  } {
    const job = this.deps.store.getJob(jobId)
    if (!job) throw new Error(`找不到远程作业 ${jobId}`)
    const safeName = basename(input.filename.trim()).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_')
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('非法的产物文件名')

    const buf = Buffer.from(input.contentBase64, 'base64')
    const sha256 = createHash('sha256').update(buf).digest('hex')
    if (input.expectedSha256 && input.expectedSha256.trim().toLowerCase() !== sha256) {
      throw new Error(`产物校验和不匹配：期望 ${input.expectedSha256}，实际 ${sha256}`)
    }

    const dir = job.ticketId
      ? join(this.deps.workspaceRoot, job.ticketId, 'output', 'remote')
      : join(this.deps.stateDir, 'remote-artifacts', job.id)
    mkdirSync(dir, { recursive: true })
    const fullPath = join(dir, safeName)
    writeFileSync(fullPath, buf)

    const relRef = job.ticketId ? `output/remote/${safeName}` : fullPath
    const updated = this.deps.store.appendArtifact(jobId, { path: relRef, sha256, bytes: buf.length }, this.doNow())!
    return { path: relRef, sha256, bytes: buf.length, job: updated }
  }

  /**
   * 远程节点按 `callId` 去重上报模型/计算费用到主控账本：
   * 同一个 `callId` 无论重传多少次，账本只扣一次钱！
   */
  reportUsage(jobId: string, input: {
    callId: string
    provider: string
    model: string
    promptHit?: number
    promptMiss?: number
    completion?: number
    costUsd: number
    latencyMs?: number
  }): { deduplicated: boolean; costUsd: number } {
    const job = this.deps.store.getJob(jobId)
    if (!job) throw new Error(`找不到远程作业 ${jobId}`)
    const callId = input.callId.trim()
    if (!callId) throw new Error('上报远程用量必须提供稳定 callId 以防止重复结算')
    const costUsd = Math.max(0, Number(input.costUsd) || 0)
    const inserted = this.deps.store.recordUsageDedup(callId, jobId, costUsd, this.doNow())
    if (!inserted) return { deduplicated: true, costUsd }

    this.deps.ledger.record({
      at: this.doNow().toISOString(),
      ticketId: job.ticketId ?? `remote:${job.id}`,
      agent: `remote:${job.nodeId ?? 'node'}`,
      provider: input.provider,
      model: input.model,
      status: 200,
      promptHit: input.promptHit ?? 0,
      promptMiss: input.promptMiss ?? 0,
      completion: input.completion ?? 0,
      costUsd,
      latencyMs: input.latencyMs ?? 0,
    })
    return { deduplicated: false, costUsd }
  }

  completeJob(jobId: string, outcome: { ok: boolean; summary: string; error?: string }): RemoteJobRecord {
    const updated = this.deps.store.finishJob(
      jobId,
      { status: outcome.ok ? 'completed' : 'failed', summary: outcome.summary, ...(outcome.error ? { error: outcome.error } : {}) },
      this.doNow(),
    )
    if (!updated) throw new Error(`找不到远程作业 ${jobId}`)
    return updated
  }
}
