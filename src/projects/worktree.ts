/**
 * Git Worktree 并发隔离、工单级 Diff 审查与安全回合并模块（SuperAgent 2.1 研发工厂）。
 *
 * 解决痛点：
 * - `copy` 模式复制 2GB 仓库慢、改完难合并；
 * - `direct` 模式同一仓库无法多工单并行；
 * - `worktree` 模式对 Git 仓库秒级拉出独立分支 `sa/<ticketId>`，多工单并发修改互不踩踏，
 *   审查满意后一键合并回项目主分支（合并前自动打快照，冲突时自动 abort 不破坏原仓）。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectHistory } from './history.ts'
import type { ProjectWorkspaceMode, TicketDiffFile, TicketDiffResponse } from '../shared/api-types.ts'

const MAX_DIFF_CHARS = 120_000
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
  // 清理可能残留的失效 worktree 注册项
  await runGit(['worktree', 'prune'], treeDir)

  // 若同名分支已存在（例如同票重建），直接检出该分支；否则从当前 HEAD 新建分支
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

/** 解析 `git diff --numstat` + `git status --porcelain` 得到清晰的文件变更清单。 */
function parseDiffFiles(statusOut: string, numstatOut: string): TicketDiffFile[] {
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
  for (const raw of statusOut.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const code = raw.slice(0, 2).trim() || 'M'
    const path = raw.slice(3).trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    const st = stats.get(path)
    files.push({ path, status: code, additions: st?.add ?? 0, deletions: st?.del ?? 0 })
  }
  for (const [path, st] of stats.entries()) {
    if (seen.has(path)) continue
    seen.add(path)
    files.push({ path, status: 'M', additions: st.add, deletions: st.del })
  }
  return files
}

/**
 * 读取工单工作区的实时代码改动（支持 `worktree`、`copy` 及 `direct` 模式）。
 * 若工单在 worktree 分支里已经产生了提交，同时对比基线与当前工作树，完整呈现全部改动。
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

  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : undefined

  // 尝试找到主分支基线（worktree 模式下以主仓当前 HEAD 或 merge-base 为基线，捕获已 commit + 未 commit 的全部改动）
  let baseRef = 'HEAD'
  if (opts.mode === 'worktree' && opts.projectDir && (await isUsableGitRepo(opts.projectDir))) {
    const mainHead = await runGit(['rev-parse', 'HEAD'], opts.projectDir)
    if (mainHead.code === 0 && mainHead.stdout.trim()) {
      const mb = await runGit(['merge-base', mainHead.stdout.trim(), 'HEAD'], repoDir)
      baseRef = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : mainHead.stdout.trim()
    }
  }

  const [statusRes, numstatRes, diffRes] = await Promise.all([
    runGit(['status', '--porcelain'], repoDir),
    runGit(['diff', '--numstat', baseRef], repoDir),
    runGit(['diff', '--no-color', baseRef], repoDir),
  ])

  const files = parseDiffFiles(statusRes.stdout, numstatRes.stdout)
  const rawDiff = diffRes.stdout
  const truncated = rawDiff.length > MAX_DIFF_CHARS
  const diff = truncated ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n\n...（Diff 超过 ${MAX_DIFF_CHARS} 字符已截断）` : rawDiff

  return {
    available: true,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(branch ? { branch } : {}),
    baseRef: baseRef.slice(0, 12),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.projectName ? { projectName: opts.projectName } : {}),
    canMerge: opts.mode === 'worktree' && files.length > 0,
    files,
    diff,
    truncated,
  }
}

/**
 * 将 `worktree` 分支改动安全合并回项目库主树：
 * 1. 先给项目库主树拍一份回滚快照（若提供了 `history`）；
 * 2. 若工单工作树存在未提交改动，自动提交到工单分支 `sa/<ticketId>`；
 * 3. 在项目主树执行 `git merge --no-ff`，如发生冲突立即 `git merge --abort` 并返回冲突清单。
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

  const branch = worktreeBranchName(opts.ticketId)
  // 1. 先检查工单工作树是否有未提交改动，有则自动暂存并提交到工单分支
  const dirty = await runGit(['status', '--porcelain'], workDir)
  if (dirty.stdout.trim()) {
    await runGit(['add', '-A'], workDir)
    const commit = await runGit(
      ['-c', 'user.name=SuperAgent', '-c', 'user.email=superagent@local', 'commit', '-m', `feat(ticket): apply changes from ${opts.ticketId}`],
      workDir,
    )
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      return { ok: false, message: `提交工单分支改动失败：${commit.stderr.trim().slice(0, 200)}` }
    }
  }

  // 2. 合并前给项目原件拍一份可回滚快照
  let snapshot: string | undefined
  if (opts.history) {
    try { snapshot = await opts.history.snapshot(`合并工单 ${opts.ticketId} 分支前的状态`) } catch { /* best effort */ }
  }

  // 3. 检查主树是否干净，避免合并误伤未提交文件
  const mainDirty = await runGit(['status', '--porcelain'], opts.treeDir)
  if (mainDirty.stdout.trim()) {
    return { ok: false, message: '项目原件当前有未提交的本地修改，请先清理或快照后再合并工单分支。' }
  }

  // 4. 执行合并
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
