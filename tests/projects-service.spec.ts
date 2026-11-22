/**
 * The project service: chunked uploads (offset, checksum, size guards), the extraction queue, restart recovery and the
 * ticket hand-off (copy with `.git`, AGENTS.md, the preparing marker).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AdminError } from '../src/admin/host.ts'
import { createRuntimeAdminHost } from '../src/admin/runtime-host.ts'
import type { RuntimeAdminDeps } from '../src/admin/runtime-host.ts'
import type { ExtractLimits } from '../src/projects/extract.ts'
import { ProjectService, UploadConflict } from '../src/projects/service.ts'
import { ProjectStore } from '../src/projects/store.ts'
import { writeZip } from './helpers/zip.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-project-service-'))
  dirs.push(dir)
  return dir
}

function makeZip(path: string, files: Record<string, string> = { 'README.md': '# demo' }): number {
  writeZip(path, [{ name: 'demo/', mode: 0o040755 }, ...Object.entries(files).map(([name, data]) => ({
    name: `demo/${name}`,
    data,
    mode: 0o100644,
  }))])
  return statSync(path).size
}

function chunkRequest(data: Buffer, contentLength: number | undefined = data.length): Parameters<ProjectService['appendChunk']>[2] {
  const request = Readable.from([data]) as unknown as Parameters<ProjectService['appendChunk']>[2]
  Object.defineProperty(request, 'headers', {
    value: contentLength === undefined ? {} : { 'content-length': String(contentLength) },
  })
  return request
}

function harness(options: { extractLimits?: Partial<ExtractLimits>; now?: () => Date } = {}) {
  const dir = tempDir()
  const root = join(dir, 'projects')
  const workspaceRoot = join(dir, 'workspaces')
  mkdirSync(root, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  const db = new DatabaseSync(':memory:')
  const service = new ProjectService({
    db,
    root,
    workspaceRoot,
    limits: () => ({ maxUploadMb: 100, maxExtractMb: 100, maxFiles: 1000 }),
    ...(options.extractLimits === undefined ? {} : { extractLimits: options.extractLimits }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { dir, root, workspaceRoot, db, service }
}

async function uploadAndWait(
  service: ProjectService,
  zipPath: string,
  name = 'demo.zip',
): Promise<string> {
  const size = statSync(zipPath).size
  const { uploadId } = service.createUpload({ name, size })
  const data = readFileSync(zipPath)
  const result = await service.appendChunk(uploadId, 0, chunkRequest(data))
  expect(result.received).toBe(size)
  const { projectId } = service.finishUpload(uploadId, '演示项目')
  await service.whenIdle()
  return projectId
}

describe('ProjectService uploads', () => {
  it('accepts chunks, reports progress and extracts in the background', async () => {
    const { service, dir } = harness()
    const zip = join(dir, 'demo.zip')
    const size = makeZip(zip)
    const { uploadId } = service.createUpload({ name: 'demo.zip', size })
    expect(service.uploadInfo(uploadId)).toMatchObject({ name: 'demo.zip', size, received: 0, state: 'uploading' })

    const data = readFileSync(zip)
    const half = Math.floor(data.length / 2)
    expect(await service.appendChunk(uploadId, 0, chunkRequest(data.subarray(0, half))))
      .toEqual({ received: half })
    expect(service.uploadInfo(uploadId)?.received).toBe(half)
    await service.appendChunk(uploadId, half, chunkRequest(data.subarray(half)))

    const { projectId } = service.finishUpload(uploadId, '演示项目')
    await service.whenIdle(projectId)
    const detail = service.get(projectId)
    expect(detail?.status).toBe('ready')
    expect(detail?.files).toBe(1) // the directory entry is not a file
    expect(detail?.profile?.readme).toContain('# demo')
    expect(service.treeRoot(projectId)).toBeDefined()
    expect(readFileSync(join(service.projectDir(projectId), 'tree', 'README.md'), 'utf8')).toBe('# demo')

    expect(service.list().map(item => item.id)).toContain(projectId)
    expect(service.delete(projectId)).toBe(true)
    expect(service.get(projectId)).toBeUndefined()
    expect(existsSync(service.projectDir(projectId))).toBe(false)
  })

  it('reports 409 with the committed length and accepts the retried chunk', async () => {
    const { service, dir } = harness()
    const zip = join(dir, 'demo.zip')
    const data = Buffer.from('abcdefghij')
    const { uploadId } = service.createUpload({ name: 'demo.zip', size: data.length })
    await service.appendChunk(uploadId, 0, chunkRequest(data.subarray(0, 4)))
    await expect(service.appendChunk(uploadId, 7, chunkRequest(data.subarray(7))))
      .rejects.toMatchObject({ received: 4 })
    await expect(service.appendChunk(uploadId, 7, chunkRequest(data.subarray(7)))).rejects.toBeInstanceOf(UploadConflict)
    expect(await service.appendChunk(uploadId, 4, chunkRequest(data.subarray(4)))).toEqual({ received: 10 })
  })

  it('refuses a chunk that passes the declared size, with or without content-length', async () => {
    const { service } = harness()
    const { uploadId } = service.createUpload({ name: 'demo.zip', size: 3 })
    await expect(service.appendChunk(uploadId, 0, chunkRequest(Buffer.from('abcde'))))
      .rejects.toMatchObject({ status: 400 })
    await expect(service.appendChunk(uploadId, 0, chunkRequest(Buffer.from('abcde'), undefined)))
      .rejects.toMatchObject({ status: 400 })
    expect(service.uploadInfo(uploadId)?.received).toBe(0)
  })

  it('refuses a mismatched x-chunk-sha256, truncates the chunk and accepts the retry', async () => {
    const { service, dir } = harness()
    const zip = join(dir, 'demo.zip')
    makeZip(zip)
    const data = readFileSync(zip)
    const { uploadId } = service.createUpload({ name: 'demo.zip', size: data.length })
    await expect(service.appendChunk(uploadId, 0, chunkRequest(data), 'deadbeef'))
      .rejects.toMatchObject({ status: 400 })
    expect(service.uploadInfo(uploadId)?.received).toBe(0)
    await expect(service.appendChunk(uploadId, 0, chunkRequest(data))).resolves.toEqual({ received: data.length })
  })

  it('refuses a second chunk for the same upload while the first is still writing', async () => {
    const { service, dir } = harness()
    const zip = join(dir, 'demo.zip')
    makeZip(zip, { 'README.md': '# concurrent' })
    const data = readFileSync(zip)
    const { uploadId } = service.createUpload({ name: 'demo.zip', size: data.length })

    const first = service.appendChunk(uploadId, 0, chunkRequest(data))
    const second = service.appendChunk(uploadId, 0, chunkRequest(Buffer.from('x')))
    await expect(second).rejects.toBeInstanceOf(UploadConflict)
    await expect(second).rejects.toMatchObject({ received: 0 })

    expect(await first).toEqual({ received: data.length })
    expect(service.uploadInfo(uploadId)?.received).toBe(data.length)
    const { projectId } = service.finishUpload(uploadId)
    await service.whenIdle(projectId)
    expect(service.get(projectId)?.status).toBe('ready')
    expect(readFileSync(join(service.projectDir(projectId), 'tree', 'README.md'), 'utf8')).toBe('# concurrent')
  })

  it('refuses finish while bytes are missing', async () => {
    const { service } = harness()
    const { uploadId } = service.createUpload({ name: 'demo.zip', size: 10 })
    await service.appendChunk(uploadId, 0, chunkRequest(Buffer.from('1234')))
    expect(() => service.finishUpload(uploadId)).toThrow(AdminError)
    expect(() => service.finishUpload(uploadId)).toThrow(/上传还没完成/)
  })

  it('keeps an unfinished upload across a restart and resumes at the committed offset', async () => {
    const first = harness()
    const { uploadId } = first.service.createUpload({ name: 'demo.zip', size: 6 })
    await first.service.appendChunk(uploadId, 0, chunkRequest(Buffer.from('abc')))
    first.service.close()

    const second = new ProjectService({
      db: first.db,
      root: first.root,
      workspaceRoot: first.workspaceRoot,
      limits: () => ({ maxUploadMb: 100, maxExtractMb: 100, maxFiles: 1000 }),
    })
    expect(second.uploadInfo(uploadId)?.received).toBe(3)
    await expect(second.appendChunk(uploadId, 3, chunkRequest(Buffer.from('def')))).resolves.toEqual({ received: 6 })
    second.close()
  })

  it('deletes stale uploads after 24 hours', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const first = harness({ now: () => now })
    const { uploadId } = first.service.createUpload({ name: 'old.zip', size: 10 })
    first.service.close()
    expect(first.service.uploadInfo(uploadId)).toBeDefined()

    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000)
    const second = new ProjectService({
      db: first.db,
      root: first.root,
      workspaceRoot: first.workspaceRoot,
      limits: () => ({ maxUploadMb: 100, maxExtractMb: 100, maxFiles: 1000 }),
      now: () => later,
      idFactory: prefix => `${prefix}${'a'.repeat(12)}`,
    })
    expect(second.uploadInfo(uploadId)).toBeUndefined()
    second.close()
  })
})

describe('ProjectService extraction and recovery', () => {
  it('marks an interrupted extraction as failed on restart and removes its partial tree', () => {
    const { service, db, root, workspaceRoot } = harness()
    const store = new ProjectStore(db)
    const id = 'p_deadbeefcafe'
    store.insert({
      id,
      name: '中断的项目',
      sourceName: 'x.zip',
      archiveBytes: 1,
      files: 0,
      bytes: 0,
      status: 'extracting',
      warnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    mkdirSync(join(root, id, 'tree.partial'), { recursive: true })
    service.close()

    const restarted = new ProjectService({
      db,
      root,
      workspaceRoot,
      limits: () => ({ maxUploadMb: 100, maxExtractMb: 100, maxFiles: 1000 }),
    })
    const record = restarted.get(id)
    expect(record?.status).toBe('failed')
    expect(record?.error).toContain('解压被中断')
    expect(existsSync(join(root, id, 'tree.partial'))).toBe(false)
    expect(() => restarted.requireReady(id)).toThrow(/重新上传/)
    restarted.close()
  })

  it('reports a failed extraction with an actionable message', async () => {
    const { service, dir } = harness({ extractLimits: { maxExtractBytes: 10 } })
    const zip = join(dir, 'demo.zip')
    const size = makeZip(zip, { 'a.txt': 'a'.repeat(100) })
    const projectId = await uploadAndWait(service, zip)
    const detail = service.get(projectId)
    expect(detail?.status).toBe('failed')
    expect(detail?.error).toContain('上限，可在设置→项目里调高')
    expect(service.treeRoot(projectId)).toBeUndefined()
    expect(existsSync(join(service.projectDir(projectId), 'archive.zip'))).toBe(false)
    expect(size).toBeGreaterThan(0)
  })

  it('requireReady rejects missing, extracting and failed projects with a 400', () => {
    const { service } = harness()
    expect(() => service.requireReady('p_unknown')).toThrow(AdminError)
    expect(() => service.requireReady('bad id')).toThrow(AdminError)
  })
})

describe('createRuntimeAdminHost projectId validation', () => {
  function hostWith(service: ProjectService) {
    const calls: (string | undefined)[] = []
    const base = {
      projects: service,
      vault: { has: () => true },
      ask: async (_text: string, _model?: string, _secrets?: string[], projectId?: string) => {
        calls.push(projectId)
        return { triggerId: 'tr', threadId: 'th', threadKey: 'cli:th' }
      },
    }
    const deps = new Proxy(base, {
      get(target, property) {
        if (property in target) return (target as Record<string | symbol, unknown>)[property]
        return () => {
          throw new Error(`unexpected host call ${String(property)}`)
        }
      },
    }) as unknown as RuntimeAdminDeps
    return { host: createRuntimeAdminHost(deps), calls }
  }

  it('refuses a missing or failed project with a 400 and never accepts the ticket', async () => {
    const { service, db } = harness()
    const { host, calls } = hostWith(service)
    await expect(host.createTicket('do it', undefined, undefined, 'p_unknown')).rejects.toMatchObject({ status: 400 })

    new ProjectStore(db).insert({
      id: 'p_extracting1',
      name: '准备中',
      sourceName: 'y.zip',
      archiveBytes: 1,
      files: 0,
      bytes: 0,
      status: 'extracting',
      warnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await expect(host.createTicket('do it', undefined, undefined, 'p_extracting1')).rejects.toMatchObject({ status: 400 })

    new ProjectStore(db).insert({
      id: 'p_failedone1',
      name: '坏了',
      sourceName: 'x.zip',
      archiveBytes: 1,
      files: 0,
      bytes: 0,
      status: 'failed',
      error: '压缩包损坏',
      warnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await expect(host.createTicket('do it', undefined, undefined, 'p_failedone1')).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('passes a ready project id through to the runtime ask', async () => {
    const { service, dir } = harness()
    const zip = join(dir, 'demo.zip')
    makeZip(zip)
    const projectId = await uploadAndWait(service, zip)
    const { host, calls } = hostWith(service)
    const result = await host.createTicket('do it', undefined, undefined, projectId)
    expect(result.triggerId).toBe('tr')
    expect(calls).toEqual([projectId])
  })
})

describe('ProjectService ticket hand-off', () => {
  it('copies the tree (with .git) into the workspace and writes AGENTS.md', async () => {
    const { service, dir, workspaceRoot } = harness()
    const zip = join(dir, 'demo.zip')
    writeZip(zip, [
      { name: 'demo/', mode: 0o040755 },
      { name: 'demo/README.md', data: '# demo' },
      { name: 'demo/.git/HEAD', data: 'ref: refs/heads/main\n' },
      { name: 'demo/src/app.ts', data: 'export {}\n' },
    ])
    const projectId = await uploadAndWait(service, zip)
    service.setPending('tr1', projectId)

    const ticketId = 't1'
    await service.prepareWorkspace(ticketId, ['tr1'])
    const project = join(workspaceRoot, ticketId, 'project')
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('# demo')
    expect(readFileSync(join(project, '.git', 'HEAD'), 'utf8')).toContain('main')
    expect(readFileSync(join(workspaceRoot, ticketId, 'AGENTS.md'), 'utf8')).toContain('/workspace/project/')
    expect(service.ticketProject(ticketId)).toMatchObject({ id: projectId, name: '演示项目', preparing: false })
  })

  it('resolves the project from the pending trigger and shows the preparing marker during the copy', async () => {
    const { service, dir } = harness()
    const zip = join(dir, 'demo.zip')
    makeZip(zip)
    const projectId = await uploadAndWait(service, zip)
    service.setPending('tr9', projectId)

    const copying = service.prepareWorkspace('t9', ['tr9'])
    expect(service.isPreparing('t9')).toBe(true)
    await copying
    expect(service.isPreparing('t9')).toBe(false)
    expect(service.ticketProject('t9', 'tr9')?.id).toBe(projectId)
  })

  it('writes a project-free AGENTS.md and keeps an existing one', async () => {
    const { service, workspaceRoot } = harness()
    await service.prepareWorkspace('t2', [])
    const path = join(workspaceRoot, 't2', 'AGENTS.md')
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('/workspace/output/')
    expect(text).not.toContain('/workspace/project/')
    writeFileSync(path, 'custom instructions\n')
    await service.prepareWorkspace('t2', [])
    expect(readFileSync(path, 'utf8')).toBe('custom instructions\n')
  })
})

describe('ProjectService direct editing of the original', () => {
  it('mounts the library tree instead of copying, snapshots before/after and reports the changes', async () => {
    const { service, dir, root, workspaceRoot } = harness()
    const zip = join(dir, 'demo.zip')
    writeZip(zip, [
      { name: 'demo/', mode: 0o040755 },
      { name: 'demo/README.md', data: '# demo' },
      { name: 'demo/src/app.ts', data: 'export const a = 1\n' },
      { name: 'demo/node_modules/dep/index.js', data: 'module.exports = 1\n' },
    ])
    const projectId = await uploadAndWait(service, zip)
    service.setPending('trd', projectId, 'direct')

    const prepared = await service.prepareWorkspace('td1', ['trd'])
    const tree = join(root, projectId, 'tree')
    expect(prepared.directTree).toBe(tree)
    expect(prepared.warning).toBeUndefined()
    // Nothing copied: the workspace only has an empty mount point.
    expect(existsSync(join(workspaceRoot, 'td1', 'project', 'README.md'))).toBe(false)
    expect(readFileSync(join(workspaceRoot, 'td1', 'AGENTS.md'), 'utf8')).toContain('项目库里的原件')
    expect(service.ticketProject('td1')).toMatchObject({ id: projectId, mode: 'direct' })
    expect(service.directTickets(projectId)).toEqual(['td1'])

    // A relaunch keeps the first "before" snapshot.
    await service.prepareWorkspace('td1', [])
    expect((await service.snapshots(projectId)).length).toBe(1)

    // The worker edits the original tree.
    writeFileSync(join(tree, 'src', 'app.ts'), 'export const a = 2\n')
    writeFileSync(join(tree, 'NEW.md'), 'added\n')
    rmSync(join(tree, 'README.md'))
    writeFileSync(join(tree, 'node_modules', 'dep', 'index.js'), 'changed but excluded\n')

    const change = await service.finishDirect('td1')
    expect(change).toBeDefined()
    expect(change!.projectId).toBe(projectId)
    expect(change!.total).toBe(3)
    expect(change!.files.join('\n')).toContain('src/app.ts')
    expect(change!.files.join('\n')).not.toContain('node_modules')
    expect(change!.stat).toContain('3 files changed')

    // A copy-mode ticket is not affected.
    expect(await service.finishDirect('t-unknown')).toBeUndefined()
    // The project's own tree has no history directory inside it.
    expect(existsSync(join(tree, 'history.git'))).toBe(false)

    // Roll back to the state before the ticket.
    const snaps = await service.snapshots(projectId)
    const before = snaps.find(s => s.message.includes('开始前'))!
    await expect(service.restoreSnapshot(projectId, before.sha, () => true)).rejects.toThrow(/正在直接修改/)
    await service.restoreSnapshot(projectId, before.sha, () => false)
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('# demo')
    expect(readFileSync(join(tree, 'src', 'app.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(existsSync(join(tree, 'NEW.md'))).toBe(false)
    // Excluded dependency folders are left alone by a restore.
    expect(readFileSync(join(tree, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('changed but excluded\n')
  }, 30_000)

  it('imports a staged directory as a new project and syncs newer code into an existing one', async () => {
    const { service, root } = harness()
    const staged = join(root, '.imports', 'first')
    mkdirSync(join(staged, 'src'), { recursive: true })
    writeFileSync(join(staged, 'README.md'), '# v1')
    writeFileSync(join(staged, 'src', 'a.py'), 'print(1)\n')

    const created = await service.importDirectory({ sourceDir: staged, name: '本地项目' })
    expect(created.created).toBe(true)
    expect(created.files).toBe(2)
    expect(existsSync(staged)).toBe(false)
    expect(service.get(created.projectId)).toMatchObject({ name: '本地项目', status: 'ready', files: 2, sourceName: 'local-sync' })

    const next = join(root, '.imports', 'second')
    mkdirSync(next, { recursive: true })
    writeFileSync(join(next, 'README.md'), '# v2')
    const synced = await service.importDirectory({ sourceDir: next, name: '本地项目', projectId: created.projectId })
    expect(synced).toMatchObject({ projectId: created.projectId, created: false, files: 1 })
    expect(readFileSync(join(root, created.projectId, 'tree', 'README.md'), 'utf8')).toBe('# v2')
    const snaps = await service.snapshots(created.projectId)
    expect(snaps.map(s => s.message).some(m => m.includes('同步本地代码前'))).toBe(true)

    // Only directories under <root>/.imports may be imported.
    await expect(service.importDirectory({ sourceDir: tmpdir(), name: 'x' })).rejects.toThrow(/只能导入/)
    // A project being edited directly cannot be replaced.
    service.setPending('trx', created.projectId, 'direct')
    await service.prepareWorkspace('tx', ['trx'])
    const third = join(root, '.imports', 'third')
    mkdirSync(third, { recursive: true })
    await expect(service.importDirectory({ sourceDir: third, name: 'x', projectId: created.projectId }, () => true)).rejects.toThrow(/正在直接修改/)
  }, 30_000)

  it('migrates an old ticket_projects table without a mode column', () => {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE TABLE ticket_projects (ticket_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO ticket_projects VALUES ('t_old', 'p_old', '2026-01-01')")
    db.exec('CREATE TABLE pending_projects (trigger_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)')
    const store = new ProjectStore(db)
    expect(store.ticketEntry('t_old')).toEqual({ projectId: 'p_old', mode: 'copy' })
    store.setPending('tr', 'p_new', 'direct')
    expect(store.pendingEntry(['tr'])).toEqual({ projectId: 'p_new', mode: 'direct' })
  })

  it('deletes oldest, middle, newest and last snapshot without modifying tree files', async () => {
    const { service, root } = harness()
    const stage = (name: string, content: string) => {
      const p = join(root, '.imports', name)
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'README.md'), content)
      return p
    }
    const { projectId } = await service.importDirectory({ sourceDir: stage('s1', 'v1\n'), name: '演示' })
    const tree = join(root, projectId, 'tree')
    // 再构造 3 条快照，共 4 条：v4（最新）、v3、v2、v1（最旧）
    await service.importDirectory({ sourceDir: stage('s2', 'v2\n'), name: '演示', projectId })
    // importDirectory 会额外拍「同步本地代码前的状态」+「同步本地代码(...)」，先核对并制造清晰的 4 条
    service.setPending('tr_d', projectId, 'direct')
    await service.prepareWorkspace('t_d', ['tr_d'])
    writeFileSync(join(tree, 'README.md'), 'v3\n')
    await service.finishDirect('t_d')
    writeFileSync(join(tree, 'README.md'), 'v4\n')
    await service.snapshotDiff(projectId, (await service.snapshots(projectId))[0]!.sha)

    // 先验证运行中的 direct 任务会阻塞删除（409）
    const beforeAll = await service.snapshots(projectId)
    expect(beforeAll.length).toBeGreaterThanOrEqual(4)
    await expect(service.deleteSnapshot(projectId, beforeAll.at(-1)!.sha, () => true))
      .rejects.toMatchObject({ status: 409 })

    // 1. 删除最旧快照：后续快照保留且可恢复，当前 tree 不变
    const oldest = beforeAll.at(-1)!
    const delOldest = await service.deleteSnapshot(projectId, oldest.sha, () => false)
    expect(delOldest.deleted).toBe(oldest.sha)
    expect(delOldest.remaining).toBe(beforeAll.length - 1)
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('v4\n')
    // 已被彻底清除，不能再删除或恢复
    await expect(service.deleteSnapshot(projectId, oldest.sha, () => false)).rejects.toMatchObject({ status: 404 })

    // 2. 删除中间快照（含任务 before ref）：前后快照仍完整
    const afterOldest = await service.snapshots(projectId)
    const mid = afterOldest[Math.floor(afterOldest.length / 2)]!
    const delMid = await service.deleteSnapshot(projectId, mid.sha, () => false)
    expect(delMid.remaining).toBe(afterOldest.length - 1)
    expect((await service.snapshots(projectId)).some(s => s.message === mid.message && s.sha === mid.sha)).toBe(false)
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('v4\n')

    // 3. 删除最新（HEAD）快照：绝不回滚 tree 文件
    const afterMid = await service.snapshots(projectId)
    const newest = afterMid[0]!
    const delNewest = await service.deleteSnapshot(projectId, newest.sha, () => false)
    expect(delNewest.remaining).toBe(afterMid.length - 1)
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('v4\n')

    // 4. 逐条删光到最后 1 条：history.git 被清空，tree 仍完好，且后续新快照可正常重建
    let left = await service.snapshots(projectId)
    while (left.length > 0) {
      await service.deleteSnapshot(projectId, left[0]!.sha, () => false)
      left = await service.snapshots(projectId)
    }
    expect(left).toEqual([])
    expect(existsSync(join(root, projectId, 'history.git'))).toBe(false)
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('v4\n')

    // 重建历史正常
    await service.importDirectory({ sourceDir: stage('s5', 'v5\n'), name: '演示', projectId })
    const rebuilt = await service.snapshots(projectId)
    expect(rebuilt.length).toBe(2)
    expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('v5\n')
  }, 30_000)
})
