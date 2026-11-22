/**
 * Git Worktree 并发隔离、工单级 Diff 审查（含未追踪新文件完整 Diff）与安全回合并模块（SuperAgent 2.1 研发工厂）。
 *
 * 解决痛点：
 * - `copy` 模式复制 2GB 仓库慢、改完难合并；
 * - `direct` 模式同一仓库无法多工单并行；
 * - `worktree` 模式对 Git 仓库秒级拉出独立分支 `sa/<ticketId>`，多工单并发修改互不踩踏，
 *   支持未追踪新文件完整行级审查、审查签核指纹校验，满意后一键合并回主分支或推送创建 PR（冲突自动 abort 不破坏主分支）。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectHistory } from './history.ts'
import type { ProjectWorkspaceMode, TicketDiffFile, TicketDiffResponse } from '../shared/api-types.ts'

const MAX_DIFF_CHARS = 160_000
const MAX_UNTRACKED_FILE_BYTES = 128 * 1024
const GIT_TIMEOUT_MS = 60_000

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function runGit(args: readonly string[], cwd: string): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(
      'git',
      [...args],
      { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
          return
        }
        const errCode = typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : 1
        resolve({ code: errCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message) })
      },
    )
  })
}

/** 构造安全的工单专属分支名 `sa/<ticketId>`。 */
export function worktreeBranchName(ticketId: string): string {
  const safe = ticketId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60)
  return `sa/${safe}`
}

/** 判断目标目录是否具备有效的 Git 仓库与至少一个提交。 */
export async function isUsableGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false
  const rev = await runGit(['rev-parse', '--verify', 'HEAD'], dir)
  return rev.code === 0
}

/**
 * 为工单创建独立 Git Worktree：
 * - 若目标 `<workspace>/project` 已存在，直接复用（支持重启/恢复）；
 * - 若 `treeDir` 是可用 Git 仓，执行 `git worktree add -b sa/<ticketId>`；
 * - 若 `treeDir` 不是 Git 仓，返回 `{ usedWorktree: false }` 由调用方自动降级为副本并初始化基线。
 */
export async function prepareWorktree(
  treeDir: string,
  workspace: string,
  ticketId: string,
): Promise<{ usedWorktree: boolean; branch?: string; warning?: string }> {
  const target = join(workspace, 'project')
  const branch = worktreeBranchName(ticketId)
  if (existsSync(target)) {
    return { usedWorktree: await isUsableGitRepo(target), branch }
  }
  if (!(await isUsableGitRepo(treeDir))) {
    return { usedWorktree: false, warning: '项目原件不含有效 Git 历史，已自动降级为隔离副本模式。' }
  }

  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  await runGit(['worktree', 'prune'], treeDir)

  const branchExists = (await runGit(['show-ref', '--verify', `refs/heads/${branch}`], treeDir)).code === 0
  const addArgs = branchExists
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '-b', branch, target, 'HEAD']
  const res = await runGit(addArgs, treeDir)
  if (res.code !== 0) {
    rmSync(target, { recursive: true, force: true })
    return {
      usedWorktree: false,
      warning: `创建 Git Worktree 失败（${res.stderr.trim().slice(0, 140)}），已自动降级为副本模式。`,
    }
  }
  return { usedWorktree: true, branch }
}

/** 删除工单时顺手清理残留的 Git Worktree 注册（不删除主仓代码）。 */
export async function removeWorktree(treeDir: string, workspace: string): Promise<void> {
  const target = join(workspace, 'project')
  if (!(await isUsableGitRepo(treeDir))) return
  await runGit(['worktree', 'remove', '--force', target], treeDir)
  await runGit(['worktree', 'prune'], treeDir)
}

/** 为未追踪的新文件合成标准 Unified Diff，确保新增文件也能完整行级审查。 */
function synthesizeUntrackedDiff(repoDir: string, relPath: string): { diff: string; additions: number } {
  const absPath = join(repoDir, relPath)
  try {
    const st = statSync(absPath)
    if (!st.isFile()) return { diff: '', additions: 0 }
    if (st.size > MAX_UNTRACKED_FILE_BYTES) {
      return {
        diff: [
          `diff --git a/${relPath} b/${relPath}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${relPath}`,
          `@@ -0,0 +1,1 @@`,
          `+(新增文件过大：${st.size} 字节，已省略正文预览)`,
        ].join('\n'),
        additions: 1,
      }
    }
    const buf = readFileSync(absPath)
    // 含 NUL 字节按二进制文件处理
    if (buf.includes(0)) {
      return {
        diff: [
          `diff --git a/${relPath} b/${relPath}`,
          'new file mode 100644',
          `Binary files /dev/null and b/${relPath} differ`,
        ].join('\n'),
        additions: 0,
      }
    }
    const text = buf.toString('utf8')
    const rawLines = text.length === 0 ? [] : text.replace(/\r\n/g, '\n').split('\n')
    // 末尾换行不计作多余空行
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()
    const count = rawLines.length
    const header = [
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${Math.max(1, count)} @@`,
    ]
    const body = count === 0 ? ['+'] : rawLines.map(l => `+${l}`)
    return { diff: [...header, ...body].join('\n'), additions: count }
  } catch {
    return { diff: '', additions: 0 }
  }
}

/** 解析 `git diff --numstat` + `git status --porcelain -uall` 得到完整文件变更清单（含未追踪新文件）。 */
function parseDiffFiles(
  repoDir: string,
  statusOut: string,
  numstatOut: string,
): { files: TicketDiffFile[]; untrackedDiffs: string[] } {
  const stats = new Map<string, { add: number; del: number }>()
  for (const line of numstatOut.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const add = parts[0] === '-' ? 0 : Number(parts[0]) || 0
    const del = parts[1] === '-' ? 0 : Number(parts[1]) || 0
    const path = parts.slice(2).join('\t').trim()
    if (path) stats.set(path, { add, del })
  }

  const seen = new Set<string>()
  const files: TicketDiffFile[] = []
  const untrackedDiffs: string[] = []
  for (const raw of statusOut.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const code = raw.slice(0, 2).trim() || 'M'
    let path = raw.slice(3).trim()
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    if (!path || seen.has(path)) continue
    seen.add(path)
    if (code === '??') {
      const synth = synthesizeUntrackedDiff(repoDir, path)
      if (synth.diff) untrackedDiffs.push(synth.diff)
      files.push({ path, status: 'A', additions: synth.additions, deletions: 0 })
    } else {
      const st = stats.get(path)
      files.push({ path, status: code, additions: st?.add ?? 0, deletions: st?.del ?? 0 })
    }
  }
  for (const [path, st] of stats.entries()) {
    if (seen.has(path)) continue
    seen.add(path)
    files.push({ path, status: 'M', additions: st.add, deletions: st.del })
  }
  return { files, untrackedDiffs }
}

/**
 * 读取工单工作区的实时代码改动（支持 `worktree`、`copy` 及 `direct` 模式）。
 * 同时包含：已提交改动、已修改未提交改动、以及未追踪的新增文件完整 Diff，并输出 `headSha` 与 `treeFingerprint`。
 */
export async function inspectTicketDiff(opts: {
  workspace: string
  projectDir?: string
  mode?: ProjectWorkspaceMode
  projectId?: string
  projectName?: string
  ticketId: string
}): Promise<TicketDiffResponse> {
  const repoDir = opts.mode === 'direct' && opts.projectDir ? opts.projectDir : join(opts.workspace, 'project')
  if (!existsSync(repoDir)) {
    return { available: false, reason: '该任务没有绑定项目代码目录。', files: [], diff: '', truncated: false }
  }
  if (!(await isUsableGitRepo(repoDir))) {
    return { available: false, reason: '项目目录不是 Git 仓库，无法生成结构化代码 Diff。', files: [], diff: '', truncated: false }
  }

  const [branchRes, headRes] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir),
    runGit(['rev-parse', 'HEAD'], repoDir),
  ])
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : undefined
  const headSha = headRes.code === 0 ? headRes.stdout.trim() : undefined

  let baseRef = 'HEAD'
  if (opts.mode === 'worktree' && opts.projectDir && (await isUsableGitRepo(opts.projectDir))) {
    const mainHead = await runGit(['rev-parse', 'HEAD'], opts.projectDir)
    if (mainHead.code === 0 && mainHead.stdout.trim()) {
      const mb = await runGit(['merge-base', mainHead.stdout.trim(), 'HEAD'], repoDir)
      baseRef = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : mainHead.stdout.trim()
    }
  }

  const [statusRes, numstatRes, diffRes] = await Promise.all([
    runGit(['status', '--porcelain', '-uall'], repoDir),
    runGit(['diff', '--numstat', baseRef], repoDir),
    runGit(['diff', '--no-color', baseRef], repoDir),
  ])

  const { files, untrackedDiffs } = parseDiffFiles(repoDir, statusRes.stdout, numstatRes.stdout)
  const combinedDiff = [diffRes.stdout.trimEnd(), ...untrackedDiffs].filter(Boolean).join('\n')
  const treeFingerprint = createHash('sha256')
    .update(`${headSha ?? ''}\n${statusRes.stdout}\n${combinedDiff}`)
    .digest('hex')
    .slice(0, 16)

  const truncated = combinedDiff.length > MAX_DIFF_CHARS
  const diff = truncated ? `${combinedDiff.slice(0, MAX_DIFF_CHARS)}\n\n...（Diff 超过 ${MAX_DIFF_CHARS} 字符已截断）` : combinedDiff

  return {
    available: true,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(branch ? { branch } : {}),
    baseRef: baseRef.slice(0, 12),
    ...(headSha ? { headSha } : {}),
    treeFingerprint,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.projectName ? { projectName: opts.projectName } : {}),
    canMerge: opts.mode === 'worktree' && files.length > 0,
    files,
    diff,
    truncated,
  }
}

/** 确保工单 worktree 工作区改动已提交到专属分支 `sa/<ticketId>`，返回最新 HEAD SHA。 */
export async function commitWorktreeChanges(opts: {
  workspace: string
  ticketId: string
  message?: string
}): Promise<{ ok: true; branch: string; headSha: string; committed: boolean } | { ok: false; message: string }> {
  const workDir = join(opts.workspace, 'project')
  if (!existsSync(workDir)) return { ok: false, message: '找不到工单的工作区目录。' }
  if (!(await isUsableGitRepo(workDir))) {
    return { ok: false, message: '工单工作区不是有效的 Git 仓库。' }
  }
  const branch = worktreeBranchName(opts.ticketId)
  const dirty = await runGit(['status', '--porcelain'], workDir)
  let committed = false
  if (dirty.stdout.trim()) {
    await runGit(['add', '-A'], workDir)
    const msg = opts.message?.trim() || `feat(ticket): apply changes from ${opts.ticketId}`
    const commit = await runGit(
      ['-c', 'user.name=SuperAgent', '-c', 'user.email=superagent@local', 'commit', '-m', msg],
      workDir,
    )
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      return { ok: false, message: `提交工单分支改动失败：${commit.stderr.trim().slice(0, 200)}` }
    }
    committed = true
  }
  const head = await runGit(['rev-parse', 'HEAD'], workDir)
  return { ok: true, branch, headSha: head.stdout.trim(), committed }
}

/**
 * 将工单 worktree 分支推送到远端 Git 仓库（用于创建 GitHub PR）：
 * - 若传入 `token` 且远端是 HTTPS 地址，通过临时 `http.extraheader` 注入 Basic 认证，绝不写入 `.git/config`；
 * - 错误信息自动脱敏，绝不泄露明文 token。
 */
export async function pushWorktreeBranch(opts: {
  workspace: string
  ticketId: string
  remote?: string
  token?: string
}): Promise<{ ok: true; branch: string; remote: string } | { ok: false; message: string }> {
  const workDir = join(opts.workspace, 'project')
  if (!existsSync(workDir)) return { ok: false, message: '找不到工单的工作区目录。' }
  if (!(await isUsableGitRepo(workDir))) return { ok: false, message: '工单工作区不是有效的 Git 仓库。' }

  const remote = (opts.remote ?? 'origin').trim() || 'origin'
  const branch = worktreeBranchName(opts.ticketId)
  const remoteUrlRes = await runGit(['remote', 'get-url', remote], workDir)
  if (remoteUrlRes.code !== 0 || !remoteUrlRes.stdout.trim()) {
    return { ok: false, message: `项目未配置 Git 远程仓库 ${remote}，无法推送分支 ${branch}。` }
  }
  const remoteUrl = remoteUrlRes.stdout.trim()
  const args: string[] = []
  if (opts.token && /^https?:\/\//i.test(remoteUrl)) {
    const basic = Buffer.from(`x-access-token:${opts.token}`, 'utf8').toString('base64')
    args.push('-c', `http.extraheader=AUTHORIZATION: basic ${basic}`)
  }
  args.push('push', '-u', remote, `HEAD:refs/heads/${branch}`)

  const res = await runGit(args, workDir)
  if (res.code !== 0) {
    let err = (res.stderr || res.stdout || '未知推送错误').trim()
    if (opts.token) err = err.split(opts.token).join('***')
    return { ok: false, message: `推送分支 ${branch} 至 ${remote} 失败：${err.slice(0, 240)}` }
  }
  return { ok: true, branch, remote }
}

/**
 * 将 `worktree` 分支改动安全合并回项目库主树：
 * 1. 先给项目库主树拍一份回滚快照（若提供了 `history`）；
 * 2. 若工单工作树存在未提交改动，自动提交到工单分支 `sa/<ticketId>`；
 * 3. 在项目主树执行 `git merge --no-ff`，如发生冲突立即 `git merge --abort` 并返回冲突清单，确保主分支完好无损。
 */
export async function mergeWorktreeBranch(opts: {
  treeDir: string
  workspace: string
  ticketId: string
  history?: ProjectHistory
}): Promise<{ ok: true; branch: string; mergedCommit: string; snapshot?: string } | { ok: false; message: string; conflicts?: string[] }> {
  const workDir = join(opts.workspace, 'project')
  if (!existsSync(workDir)) return { ok: false, message: '找不到工单的工作区目录。' }
  if (!(await isUsableGitRepo(opts.treeDir)) || !(await isUsableGitRepo(workDir))) {
    return { ok: false, message: '项目原件或工单工作区不是有效的 Git Worktree，无法执行分支合并。' }
  }

  const committed = await commitWorktreeChanges({ workspace: opts.workspace, ticketId: opts.ticketId })
  if (!committed.ok) return committed
  const branch = committed.branch

  let snapshot: string | undefined
  if (opts.history) {
    try { snapshot = await opts.history.snapshot(`合并工单 ${opts.ticketId} 分支前的状态`) } catch { /* best effort */ }
  }

  const mainDirty = await runGit(['status', '--porcelain'], opts.treeDir)
  if (mainDirty.stdout.trim()) {
    return { ok: false, message: '项目原件当前有未提交的本地修改，请先清理或快照后再合并工单分支。' }
  }

  const merge = await runGit(
    ['-c', 'user.name=SuperAgent', '-c', 'user.email=superagent@local', 'merge', '--no-ff', branch, '-m', `merge: accept ticket ${opts.ticketId} (${branch})`],
    opts.treeDir,
  )
  if (merge.code !== 0) {
    const conflictsRes = await runGit(['diff', '--name-only', '--diff-filter=U'], opts.treeDir)
    const conflicts = conflictsRes.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    await runGit(['merge', '--abort'], opts.treeDir)
    return {
      ok: false,
      message: conflicts.length > 0
        ? `合并产生冲突（已自动中止保持原件干净）：${conflicts.slice(0, 8).join('、')}`
        : `合并失败（已中止）：${(merge.stderr || merge.stdout).trim().slice(0, 240)}`,
      ...(conflicts.length > 0 ? { conflicts } : {}),
    }
  }

  const head = await runGit(['rev-parse', 'HEAD'], opts.treeDir)
  if (opts.history) {
    try { await opts.history.snapshot(`合并工单 ${opts.ticketId} 分支后的状态`) } catch { /* best effort */ }
  }
  return { ok: true, branch, mergedCommit: head.stdout.trim(), ...(snapshot ? { snapshot } : {}) }
}
