/**
 * The project library: chunked resumable uploads, the extraction queue, project rows, and the ticket hand-off.
 *
 * Uploads stream straight to `<root>/.uploads/<id>.part`; the JSON beside it records how many bytes were committed, so a
 * client can resume after a crash or a dropped connection. Extraction runs one project at a time in the background, and
 * `finish` returns before it starts. Nothing from an archive is executed.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, truncateSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AdminError } from '../admin/host.ts'
import { extractArchive, ExtractError, type ExtractLimits, type ExtractResult } from './extract.ts'
import { materializeProject, writeAgentsFile } from './materialize.ts'
import { buildProfile, type ProjectProfile } from './profile.ts'
import { ProjectStore, type ProjectRecord, type ProjectStatus } from './store.ts'

/** The chunk size the console and the CLI use. */
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
const MIB = 1024 * 1024
const HOUR_MS = 60 * 60 * 1000
const STALE_UPLOAD_MS = 24 * HOUR_MS
const UPLOAD_ID = /^u_[A-Za-z0-9]{1,32}$/
const PROJECT_ID = /^p_[A-Za-z0-9]{1,32}$/
const PROFILE_FILE = 'profile.json'

export interface ProjectLimits {
  maxUploadMb: number
  maxExtractMb: number
  maxFiles: number
}

export interface UploadInfo {
  uploadId: string
  name: string
  size: number
  received: number
  state: 'uploading' | 'uploaded'
}

interface UploadMeta {
  uploadId: string
  name: string
  size: number
  received: number
  createdAt: string
}

export interface UploadCreateInput {
  name: string
  size: number
}

export interface ProjectListItem {
  id: string
  name: string
  status: ProjectStatus
  files: number
  bytes: number
  createdAt: string
  error?: string
}

export interface ProjectDetail extends ProjectListItem {
  sourceName: string
  archiveBytes: number
  updatedAt: string
  warnings: string[]
  progress: { done: number; total: number }
  profile?: ProjectProfile
}

export interface TicketProjectView {
  id: string
  name: string
  /** True while the 2 GB tree is still being copied into the ticket's workspace. */
  preparing: boolean
}

/** A chunk whose `offset` did not match the committed length; the client resumes from `received`. */
export class UploadConflict extends Error {
  readonly received: number

  constructor(received: number) {
    super('offset_mismatch')
    this.name = 'UploadConflict'
    this.received = received
  }
}

export interface ProjectServiceOptions {
  /** The SQLite connection shared with the rest of the runtime. */
  db: import('node:sqlite').DatabaseSync
  /** `SA_PROJECTS_ROOT`; deliberately outside `state/` so daily backups stay small. */
  root: string
  /** Ticket workspace root, used only when a ticket is launched with a project. */
  workspaceRoot: string
  limits: () => ProjectLimits
  /** Test hook: lower the extraction thresholds without building gigabytes. */
  extractLimits?: Partial<ExtractLimits>
  now?: () => Date
  /** Test hook: stable ids. */
  idFactory?: (prefix: 'u_' | 'p_') => string
}

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error)

function randomId(prefix: 'u_' | 'p_'): string {
  return `${prefix}${randomBytes(6).toString('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Uploads, extraction, project rows and the ticket hand-off. */
export class ProjectService {
  readonly root: string
  private readonly workspaceRoot: string
  private readonly uploadsDir: string
  private readonly store: ProjectStore
  private readonly limits: () => ProjectLimits
  private readonly extractLimits: Partial<ExtractLimits>
  private readonly now: () => Date
  private readonly idFactory: (prefix: 'u_' | 'p_') => string

  private readonly queue: string[] = []
  private running = false
  private readonly progress = new Map<string, { done: number; total: number }>()
  private readonly idleWaiters: (() => void)[] = []
  private readonly preparing = new Set<string>()
  private readonly copies = new Map<string, Promise<void>>()
  /** Upload ids with a chunk being written right now; a second concurrent PUT is refused with 409. */
  private readonly writing = new Set<string>()
  private readonly timers: NodeJS.Timeout[] = []

  constructor(options: ProjectServiceOptions) {
    this.root = options.root
    this.workspaceRoot = options.workspaceRoot
    this.uploadsDir = join(this.root, '.uploads')
    this.limits = options.limits
    this.extractLimits = options.extractLimits ?? {}
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomId
    mkdirSync(this.uploadsDir, { recursive: true, mode: 0o700 })
    this.store = new ProjectStore(options.db)
    this.recover()
    this.cleanupStaleUploads()
    // The 24-hour rule is enforced while running too; unref so it never keeps the daemon alive.
    const timer = setInterval(() => this.cleanupStaleUploads(), HOUR_MS)
    timer.unref()
    this.timers.push(timer)
  }

  /** Stop the cleanup timer; extraction already queued still finishes. */
  close(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer)
  }

  // --- Restart recovery -------------------------------------------------------------------------------------------

  private metaPath(uploadId: string): string {
    return join(this.uploadsDir, `${uploadId}.json`)
  }

  private partPath(uploadId: string): string {
    return join(this.uploadsDir, `${uploadId}.part`)
  }

  private readMeta(uploadId: string): UploadMeta | undefined {
    if (!UPLOAD_ID.test(uploadId)) return undefined
    let text: string
    try {
      text = readFileSync(this.metaPath(uploadId), 'utf8')
    } catch {
      return undefined
    }
    try {
      const value = JSON.parse(text) as unknown
      if (!isRecord(value)) return undefined
      if (typeof value.uploadId !== 'string' || typeof value.name !== 'string') return undefined
      if (typeof value.size !== 'number' || typeof value.received !== 'number' || typeof value.createdAt !== 'string') return undefined
      return {
        uploadId: value.uploadId,
        name: value.name,
        size: value.size,
        received: value.received,
        createdAt: value.createdAt,
      }
    } catch {
      return undefined
    }
  }

  private writeMeta(meta: UploadMeta): void {
    const path = this.metaPath(meta.uploadId)
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(meta)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  }

  /**
   * After a crash the `.part` may be longer than the committed length (a chunk was written but its metadata was not
   * updated). The metadata is the source of truth, so the extra tail is cut off; a shorter file is adopted as-is.
   */
  private recover(): void {
    for (const record of this.store.list()) {
      if (record.status !== 'extracting') continue
      this.removeProjectData(record.id)
      this.store.update(record.id, {
        status: 'failed',
        error: '解压被中断，请重新上传。',
        updatedAt: this.now().toISOString(),
      })
    }
    let names: string[]
    try {
      names = readdirSync(this.uploadsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const uploadId = name.slice(0, -'.json'.length)
      const meta = this.readMeta(uploadId)
      if (meta === undefined) {
        try {
          rmSync(join(this.uploadsDir, name), { force: true })
        } catch {
          // A leftover metadata file is harmless.
        }
        continue
      }
      let size = 0
      try {
        size = statSync(this.partPath(uploadId)).size
      } catch {
        rmSync(this.metaPath(uploadId), { force: true })
        continue
      }
      if (size > meta.received) {
        try {
          truncateSync(this.partPath(uploadId), meta.received)
        } catch {
          // If the truncate fails the next append still starts at the committed offset.
        }
      } else if (size < meta.received) {
        this.writeMeta({ ...meta, received: size })
      }
    }
  }

  /** Remove unfinished uploads older than 24 hours (and parts with no metadata). */
  cleanupStaleUploads(): void {
    const cutoff = this.now().getTime() - STALE_UPLOAD_MS
    let names: string[]
    try {
      names = readdirSync(this.uploadsDir)
    } catch {
      return
    }
    const known = new Set<string>()
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const uploadId = name.slice(0, -'.json'.length)
      known.add(uploadId)
      const meta = this.readMeta(uploadId)
      if (meta === undefined) continue
      if (Date.parse(meta.createdAt) < cutoff) {
        this.removeUploadFiles(uploadId)
      }
    }
    for (const name of names) {
      if (!name.endsWith('.part')) continue
      const uploadId = name.slice(0, -'.part'.length)
      if (known.has(uploadId)) continue
      try {
        if (statSync(join(this.uploadsDir, name)).mtimeMs < cutoff) rmSync(join(this.uploadsDir, name), { force: true })
      } catch {
        // Another request may have removed it.
      }
    }
  }

  private removeUploadFiles(uploadId: string): void {
    for (const path of [this.partPath(uploadId), this.metaPath(uploadId)]) {
      try {
        rmSync(path, { force: true })
      } catch {
        // Best effort.
      }
    }
  }

  // --- Uploads ----------------------------------------------------------------------------------------------------

  /**
   * Create a staging upload. `size` is checked against `projects.maxUploadMb` (413) and three times the free disk space
   * is required (507). Nothing touches the project tree until `finish`.
   */
  createUpload(input: UploadCreateInput): { uploadId: string; chunkSize: number } {
    const limits = this.limits()
    if (input.size <= 0) throw new AdminError('invalid', '压缩包大小必须大于 0。', 400)
    const maxBytes = limits.maxUploadMb * MIB
    if (input.size > maxBytes) {
      throw new AdminError('too_large', `压缩包超过 ${limits.maxUploadMb} MB 上传上限，可在设置→项目里调高。`, 413)
    }
    const free = this.freeBytes(this.root)
    if (free !== undefined && free < input.size * 3) {
      throw new AdminError('no_space', `磁盘可用空间不足：上传需要约 ${Math.ceil(input.size * 3 / MIB)} MB（含解压余量），当前只剩 ${Math.floor(free / MIB)} MB。`, 507)
    }
    let uploadId = this.idFactory('u_')
    for (let attempt = 0; attempt < 5 && (existsSync(this.metaPath(uploadId)) || existsSync(this.partPath(uploadId))); attempt += 1) {
      uploadId = this.idFactory('u_')
    }
    if (existsSync(this.metaPath(uploadId)) || existsSync(this.partPath(uploadId))) {
      throw new AdminError('internal', '无法分配上传编号，请重试。', 500)
    }
    writeFileSync(this.partPath(uploadId), Buffer.alloc(0), { mode: 0o600 })
    const meta: UploadMeta = {
      uploadId,
      name: input.name.trim().slice(0, 255),
      size: input.size,
      received: 0,
      createdAt: this.now().toISOString(),
    }
    this.writeMeta(meta)
    return { uploadId, chunkSize: UPLOAD_CHUNK_SIZE }
  }

  private freeBytes(path: string): number | undefined {
    try {
      const stats = statfsSync(path)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      // statfs is unavailable on some Windows builds; the disk check is a guard, not a correctness requirement.
      return undefined
    }
  }

  uploadInfo(uploadId: string): UploadInfo | undefined {
    const meta = this.readMeta(uploadId)
    if (meta === undefined) return undefined
    return {
      uploadId,
      name: meta.name,
      size: meta.size,
      received: meta.received,
      state: meta.received >= meta.size ? 'uploaded' : 'uploading',
    }
  }

  /**
   * Append one raw chunk at `offset` (which must equal the committed length). The request stream is written as it
   * arrives; a chunk that would pass the declared size, the 8 MiB chunk limit, or the optional SHA-256 is rolled back by
   * truncating the staging file to the previous committed length, so a retry starts from the same offset.
   */
  async appendChunk(uploadId: string, offset: number, req: IncomingMessage, expectedSha?: string): Promise<{ received: number }> {
    const meta = this.readMeta(uploadId)
    if (meta === undefined) {
      req.resume()
      throw new AdminError('not_found', '找不到这个上传任务，请重新开始。', 404)
    }
    if (offset !== meta.received) {
      req.resume()
      throw new UploadConflict(meta.received)
    }
    if (meta.received >= meta.size) {
      req.resume()
      throw new AdminError('upload_finished', '这个压缩包已经上传完成。', 400)
    }
    // Two tabs (or a retry racing the original request) must never write the same .part at once. The second one is told
    // the committed length and can resume from there once the first finishes.
    if (this.writing.has(uploadId)) {
      req.resume()
      throw new UploadConflict(meta.received)
    }
    this.writing.add(uploadId)
    try {
      return await this.appendLocked(uploadId, meta, req, expectedSha)
    } finally {
      this.writing.delete(uploadId)
    }
  }

  /** The body of {@link appendChunk}; the caller holds the per-upload write lock. */
  private async appendLocked(
    uploadId: string,
    meta: UploadMeta,
    req: IncomingMessage,
    expectedSha?: string,
  ): Promise<{ received: number }> {
    const start = meta.received
    const contentLength = Number(req.headers['content-length'])
    if (Number.isFinite(contentLength) && contentLength > UPLOAD_CHUNK_SIZE) {
      req.resume()
      throw new AdminError('chunk_too_large', '每次最多上传 8 MiB，请把压缩包分块上传。', 413)
    }
    if (Number.isFinite(contentLength) && start + contentLength > meta.size) {
      req.resume()
      throw new AdminError('too_large', '这一块超过了压缩包的声明大小，请重新开始上传。', 400)
    }

    const hash = createHash('sha256')
    const state = { written: 0 }
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        state.written += chunk.length
        if (state.written > UPLOAD_CHUNK_SIZE) return callback(new Error('chunk_too_large'))
        if (start + state.written > meta.size) return callback(new Error('past_declared_size'))
        hash.update(chunk)
        callback(null, chunk)
      },
    })

    try {
      await pipeline(req, limiter, createWriteStream(this.partPath(uploadId), { flags: 'r+', start }))
    } catch (error) {
      this.truncateQuiet(uploadId, start)
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'chunk_too_large') {
        throw new AdminError('chunk_too_large', '每次最多上传 8 MiB，请把压缩包分块上传。', 413)
      }
      if (reason === 'past_declared_size') {
        throw new AdminError('too_large', '这一块超过了压缩包的声明大小，请重新开始上传。', 400)
      }
      throw new AdminError('upload_interrupted', '上传中途断开或出错了，请从已记录的进度继续。', 400)
    }

    // A request that did not deliver the promised bytes is treated as an interruption, never as a valid chunk.
    if (Number.isFinite(contentLength) && contentLength !== state.written) {
      this.truncateQuiet(uploadId, start)
      throw new AdminError('upload_interrupted', '这一块的字节数和声明的不一致，请重试。', 400)
    }
    if (expectedSha !== undefined && expectedSha.trim() !== '') {
      const actual = hash.digest('hex')
      if (expectedSha.trim().toLowerCase() !== actual) {
        this.truncateQuiet(uploadId, start)
        throw new AdminError('chunk_checksum', '这一块的校验值不对，请重新传这一块。', 400)
      }
    }

    // The write is committed only now: from here on the client's next offset is `start + written`.
    this.writeMeta({ ...meta, received: start + state.written })
    return { received: start + state.written }
  }

  private truncateQuiet(uploadId: string, length: number): void {
    try {
      truncateSync(this.partPath(uploadId), length)
    } catch {
      // The file may be gone (a concurrent delete); the metadata still records the committed length.
    }
  }

  /**
   * Validate the upload, move the archive into place and queue extraction. Returns immediately; the GET endpoint
   * reports `extracting` and progress until the tree is ready or the extraction fails.
   */
  finishUpload(uploadId: string, projectName?: string): { projectId: string } {
    const meta = this.readMeta(uploadId)
    if (meta === undefined) throw new AdminError('not_found', '找不到这个上传任务，请重新开始。', 404)
    if (meta.received !== meta.size) {
      throw new AdminError('incomplete', `上传还没完成（已收到 ${meta.received} / 共 ${meta.size} 字节）。`, 400)
    }

    let projectId = this.idFactory('p_')
    for (let attempt = 0; attempt < 5 && (existsSync(join(this.root, projectId)) || this.store.get(projectId) !== undefined); attempt += 1) {
      projectId = this.idFactory('p_')
    }
    if (existsSync(join(this.root, projectId)) || this.store.get(projectId) !== undefined) {
      throw new AdminError('internal', '无法分配项目编号，请重试。', 500)
    }
    const projectDir = join(this.root, projectId)
    mkdirSync(projectDir, { recursive: true, mode: 0o755 })
    const archive = join(projectDir, 'archive.zip')
    renameSync(this.partPath(uploadId), archive)
    rmSync(this.metaPath(uploadId), { force: true })

    const fallback = meta.name.replace(/\.zip$/i, '').trim()
    const name = (projectName?.trim() || fallback || '未命名项目').slice(0, 120)
    const now = this.now().toISOString()
    this.store.insert({
      id: projectId,
      name,
      sourceName: meta.name,
      archiveBytes: meta.size,
      files: 0,
      bytes: 0,
      status: 'extracting',
      warnings: [],
      createdAt: now,
      updatedAt: now,
    })
    this.progress.set(projectId, { done: 0, total: 0 })
    this.queue.push(projectId)
    void this.drain()
    return { projectId }
  }

  /** Remove an unfinished upload. A finished project is removed with {@link delete}. */
  cancelUpload(uploadId: string): boolean {
    if (this.readMeta(uploadId) === undefined) return false
    this.removeUploadFiles(uploadId)
    return true
  }

  // --- Extraction queue ------------------------------------------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const projectId = this.queue.shift()!
        await this.extractOne(projectId)
      }
    } finally {
      this.running = false
      for (const resolveIdle of this.idleWaiters.splice(0)) resolveIdle()
    }
  }

  /** Resolves when the queue is empty; used by tests and the smoke script. */
  whenIdle(projectId?: string): Promise<void> {
    if (!this.running && (projectId === undefined || !this.queue.includes(projectId))) return Promise.resolve()
    return new Promise(resolveIdle => this.idleWaiters.push(resolveIdle))
  }

  private async extractOne(projectId: string): Promise<void> {
    const record = this.store.get(projectId)
    if (record === undefined || record.status !== 'extracting') return
    const projectDir = join(this.root, projectId)
    const archive = join(projectDir, 'archive.zip')
    const tree = join(projectDir, 'tree')
    const limits = this.limits()
    // Settings own the production quota; an explicit test limit may override it so tests never build gigabytes.
    const extractLimits: Partial<ExtractLimits> = {
      maxFiles: limits.maxFiles,
      maxExtractBytes: limits.maxExtractMb * MIB,
      ...this.extractLimits,
    }

    let result: ExtractResult
    try {
      result = await extractArchive({
        archivePath: archive,
        targetDir: tree,
        limits: extractLimits,
        onProgress: (done, total) => this.progress.set(projectId, { done, total }),
      })
    } catch (error) {
      const message = error instanceof ExtractError
        ? error.message
        : `解压失败：${describeError(error).slice(0, 200)}`
      this.store.update(projectId, {
        status: 'failed',
        error: message,
        updatedAt: this.now().toISOString(),
      })
      this.progress.set(projectId, { done: 0, total: 0 })
      rmSync(archive, { force: true })
      rmSync(tree, { recursive: true, force: true })
      return
    }

    // The profile is best effort: a readable tree must still become a ready project if the profile cannot be written.
    try {
      const profile = buildProfile(tree)
      writeFileSync(join(projectDir, PROFILE_FILE), `${JSON.stringify(profile)}\n`)
    } catch {
      // No profile: the detail view simply omits it.
    }
    this.store.update(projectId, {
      status: 'ready',
      files: result.files,
      bytes: result.bytes,
      warnings: result.warnings,
      error: null,
      updatedAt: this.now().toISOString(),
    })
    this.progress.set(projectId, { done: result.files, total: result.files })
    // The archive is only an input; keeping a second 800 MB copy is not useful.
    rmSync(archive, { force: true })
  }

  // --- Projects ---------------------------------------------------------------------------------------------------

  list(): ProjectListItem[] {
    return this.store.list().map(record => ({
      id: record.id,
      name: record.name,
      status: record.status,
      files: record.files,
      bytes: record.bytes,
      createdAt: record.createdAt,
      ...(record.error === undefined ? {} : { error: record.error }),
    }))
  }

  get(id: string): ProjectDetail | undefined {
    if (!PROJECT_ID.test(id)) return undefined
    const record = this.store.get(id)
    if (record === undefined) return undefined
    const progress = this.progress.get(id) ?? { done: record.files, total: record.files }
    let profile: ProjectProfile | undefined
    try {
      const text = readFileSync(join(this.root, id, PROFILE_FILE), 'utf8')
      const parsed = JSON.parse(text) as unknown
      if (isRecord(parsed)) profile = parsed as unknown as ProjectProfile
    } catch {
      profile = undefined
    }
    return {
      id: record.id,
      name: record.name,
      status: record.status,
      files: record.files,
      bytes: record.bytes,
      createdAt: record.createdAt,
      sourceName: record.sourceName,
      archiveBytes: record.archiveBytes,
      updatedAt: record.updatedAt,
      warnings: record.warnings,
      progress,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(profile === undefined ? {} : { profile }),
    }
  }

  /** The `tree/` root for file browsing and downloads; only a ready project has one. */
  treeRoot(id: string): string | undefined {
    if (!PROJECT_ID.test(id)) return undefined
    const record = this.store.get(id)
    if (record === undefined || record.status !== 'ready') return undefined
    const tree = join(this.root, id, 'tree')
    return existsSync(tree) ? tree : undefined
  }

  /** Delete the directory, the row, and any trigger/ticket references. Tickets keep their own copies. */
  delete(id: string): boolean {
    if (!PROJECT_ID.test(id)) return false
    const record = this.store.get(id)
    if (record === undefined) return false
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
    this.progress.delete(id)
    this.removeProjectData(id)
    this.store.delete(id)
    return true
  }

  private removeProjectData(id: string): void {
    const directory = join(this.root, id)
    // Only names this service generated reach here; still require the id shape before a recursive remove.
    if (!PROJECT_ID.test(id)) return
    rmSync(directory, { recursive: true, force: true })
  }

  /** Throw a 400 with the reason when a project cannot be attached to a new ticket. */
  requireReady(id: string): ProjectRecord {
    if (!PROJECT_ID.test(id)) throw new AdminError('invalid', '项目编号不合法。', 400)
    const record = this.store.get(id)
    if (record === undefined) throw new AdminError('invalid', '找不到这个项目，请刷新项目列表。', 400)
    if (record.status === 'extracting' || record.status === 'uploading') {
      throw new AdminError('invalid', '项目还在准备中，请等解压完成后再开任务。', 400)
    }
    if (record.status === 'failed') {
      throw new AdminError('invalid', `项目没有准备好：${record.error ?? '解压失败'}，请重新上传。`, 400)
    }
    return record
  }

  // --- Ticket hand-off --------------------------------------------------------------------------------------------

  /** Remember the project a trigger asked for; read by the launcher before the ticket exists. */
  setPending(triggerId: string, projectId: string): void {
    this.store.setPending(triggerId, projectId)
  }

  bindTicket(ticketId: string, projectId: string): void {
    this.store.bindTicket(ticketId, projectId, this.now().toISOString())
  }

  /** Drop a pending association when the request was not accepted and no ticket will ever be launched for it. */
  clearPendingTrigger(triggerId: string): void {
    this.store.clearPending([triggerId])
  }

  /** The project badge for a ticket, including whether its files are being copied right now. */
  ticketProject(ticketId: string, triggerId?: string): TicketProjectView | undefined {
    const projectId = this.store.projectForTicket(ticketId)
      ?? (triggerId === undefined ? undefined : this.store.pendingFor([triggerId]))
    if (projectId === undefined) return undefined
    const record = this.store.get(projectId)
    if (record === undefined) return undefined
    return { id: record.id, name: record.name, preparing: this.preparing.has(ticketId) }
  }

  /**
   * Prepare `<workspace>/AGENTS.md` and, when the ticket has a project, copy `tree/` to `<workspace>/project/`.
   * Called from the launcher before the container starts. `.git` is copied as part of the tree. Concurrent calls for the
   * same ticket share one copy.
   */
  async prepareWorkspace(ticketId: string, triggerIds: readonly string[]): Promise<void> {
    const workspace = join(this.workspaceRoot, ticketId)
    const projectId = this.store.projectForTicket(ticketId) ?? this.store.pendingFor(triggerIds)
    const record = projectId === undefined ? undefined : this.store.get(projectId)
    const tree = record?.status === 'ready' && projectId !== undefined ? this.treeRoot(projectId) : undefined

    writeAgentsFile(workspace, tree !== undefined)
    if (record !== undefined) this.store.bindTicket(ticketId, record.id, this.now().toISOString())
    if (triggerIds.length > 0) this.store.clearPending(triggerIds)
    if (tree === undefined) return

    // The same ticket can be launched again after an idle retirement; the project copy happens only once.
    const existing = this.copies.get(ticketId)
    if (existing !== undefined) {
      await existing
      return
    }
    const copy = (async (): Promise<void> => {
      this.preparing.add(ticketId)
      try {
        await materializeProject(tree, workspace)
      } finally {
        this.preparing.delete(ticketId)
        this.copies.delete(ticketId)
      }
    })()
    this.copies.set(ticketId, copy)
    await copy
  }

  /** Whether a ticket's project files are being copied; the ticket view shows the "正在准备项目文件" hint. */
  isPreparing(ticketId: string): boolean {
    return this.preparing.has(ticketId)
  }

  /**
   * Move a finished tree into the workspace for tests and tooling that do not go through the launcher. Production code
   * calls {@link prepareWorkspace}.
   */
  async materializeForTicket(ticketId: string, projectId: string): Promise<string> {
    this.bindTicket(ticketId, projectId)
    await this.prepareWorkspace(ticketId, [])
    return join(this.workspaceRoot, ticketId, 'project')
  }

  /** Exposed for the smoke script: where extracted trees live. */
  projectDir(id: string): string {
    return join(this.root, id)
  }
}
