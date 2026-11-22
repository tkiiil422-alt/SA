/**
 * 项目库原件的快照历史：用一个独立的 git 目录（`<projectDir>/history.git`）记录 `tree/` 的版本，
 * 既不碰项目自带的 `.git`，也不往 `tree/` 里写任何东西。
 *
 * 用途：任务以「直接修改原件」模式运行前后各拍一张快照，可以查看改了哪些文件，也能一键回滚。
 * 依赖、虚拟环境与缓存目录被排除，避免把几百 MB 的 node_modules 塞进历史。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 不进快照历史的路径（git 排除语法）。 */
export const HISTORY_EXCLUDES = [
  '.git/',
  'node_modules/',
  '.venv/',
  'venv/',
  '.mitmvenv/',
  '__pycache__/',
  '*.pyc',
  '.pytest_cache/',
  '.ruff_cache/',
  '.mypy_cache/',
  '.hypothesis/',
  '.cache/',
  '.vite/',
  '.turbo/',
  '.next/',
]

export interface Snapshot {
  sha: string
  at: string
  message: string
}

export interface DeleteSnapshotResult {
  deleted: string
  remaining: number
  freedBytes: number
  head?: string
}

export interface ChangeSummary {
  /** `git diff --shortstat` 的一行摘要，例如「3 files changed, 20 insertions(+), 4 deletions(-)」。 */
  stat: string
  /** 变化的文件（最多 `limit` 个），带状态前缀：M 修改、A 新增、D 删除、R 重命名。 */
  files: string[]
  total: number
}

const SHA = /^[0-9a-f]{7,40}$/
// 快照必须逐字节保存：关闭换行转换（Windows 上全局 core.autocrlf=true 会把恢复的文件改成 CRLF）。
const IDENTITY = [
  '-c', 'user.name=SuperAgent', '-c', 'user.email=superagent@localhost', '-c', 'core.quotepath=false',
  '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.filemode=true',
]

export class ProjectHistory {
  constructor(
    private readonly gitDir: string,
    private readonly workTree: string,
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  private run(args: string[], env?: Record<string, string>, stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', [...IDENTITY, `--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`, ...args], {
        cwd: this.workTree,
        timeout: this.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env ?? {}) },
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0]} 失败：${(stderr || error.message).trim().slice(0, 300)}`))
          return
        }
        resolve(stdout)
      })
      if (stdin !== undefined) child.stdin?.end(stdin, 'utf8')
    })
  }

  /** 首次使用时初始化独立的历史仓库并写入排除规则。 */
  async ensure(): Promise<void> {
    if (existsSync(join(this.gitDir, 'HEAD'))) return
    mkdirSync(this.gitDir, { recursive: true, mode: 0o700 })
    await this.run(['init', '-q'])
    await this.run(['config', 'core.bare', 'false'])
    await this.run(['config', 'gc.auto', '0'])
    mkdirSync(join(this.gitDir, 'info'), { recursive: true })
    writeFileSync(join(this.gitDir, 'info', 'exclude'), `${HISTORY_EXCLUDES.join('\n')}\n`)
  }

  /** 把当前 `tree/` 的状态记成一个快照，返回提交号；`ref` 用于给任务前后两张快照起名。 */
  async snapshot(message: string, ref?: string): Promise<string> {
    await this.ensure()
    await this.run(['add', '-A', '--', '.'])
    await this.run(['commit', '-q', '--allow-empty', '--no-verify', '-m', message])
    const sha = (await this.run(['rev-parse', 'HEAD'])).trim()
    if (ref) await this.run(['update-ref', ref, sha])
    return sha
  }

  async resolve(ref: string): Promise<string | undefined> {
    if (!existsSync(join(this.gitDir, 'HEAD'))) return undefined
    try {
      return (await this.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`])).trim() || undefined
    } catch {
      return undefined
    }
  }

  async list(limit = 50): Promise<Snapshot[]> {
    if (!existsSync(join(this.gitDir, 'HEAD'))) return []
    let out = ''
    try {
      out = await this.run(['log', `-n${Math.max(1, Math.min(500, limit))}`, '--format=%H%x1f%cI%x1f%s'])
    } catch {
      return []
    }
    return out.split('\n').filter(Boolean).map(line => {
      const [sha = '', at = '', message = ''] = line.split('\x1f')
      return { sha, at, message }
    })
  }

  async diff(from: string, to: string, limit = 40): Promise<ChangeSummary> {
    const stat = (await this.run(['diff', '--shortstat', from, to])).trim()
    const names = (await this.run(['diff', '--name-status', '-M', from, to])).split('\n').filter(Boolean)
    return {
      stat: stat || '没有文件变化',
      files: names.slice(0, limit).map(line => line.replace(/\t/g, ' ')),
      total: names.length,
    }
  }

  /**
   * 把 `tree/` 恢复到某个快照：先给当前状态补一张快照（可再撤回），再按目标版本覆盖被跟踪的文件，
   * 目标版本里没有的文件会被删除；被排除的依赖目录保持不动。
   */
  async restore(sha: string): Promise<{ before: string; restored: string }> {
    if (!SHA.test(sha)) throw new Error('快照编号不合法')
    const target = await this.resolve(sha)
    if (!target) throw new Error('找不到这个快照')
    const before = await this.snapshot(`恢复前自动快照（准备恢复到 ${target.slice(0, 8)}）`)
    await this.run(['read-tree', '-u', '--reset', target])
    const restored = await this.snapshot(`已恢复到快照 ${target.slice(0, 8)}`)
    return { before, restored }
  }

  /**
   * 永久删除某条历史快照并立即回收 git 对象空间；绝不修改 `tree/` 中的当前项目文件。
   * - 若删除的是唯一快照：移除整个 `history.git`（下次拍快照会自动重新初始化）；
   * - 若删除的是更早/中间快照：重写其后的提交链路以跳过目标节点并保留原树内容与时间/说明；
   * - 若删除的是最新快照：仅回退历史分支与索引，不动工作树文件。
   */
  async delete(sha: string): Promise<DeleteSnapshotResult> {
    if (!SHA.test(sha)) throw new Error('快照编号不合法')
    if (!existsSync(join(this.gitDir, 'HEAD'))) throw new Error('找不到这个快照')
    const target = await this.resolve(sha)
    if (!target) throw new Error('找不到这个快照')

    const commits = (await this.run(['rev-list', '--first-parent', '--reverse', 'HEAD']))
      .split(/\r?\n/)
      .filter(Boolean)
    const idx = commits.indexOf(target)
    if (idx === -1) throw new Error('找不到这个快照')

    const beforeBytes = dirBytes(this.gitDir)
    if (commits.length === 1) {
      rmSync(this.gitDir, { recursive: true, force: true })
      return { deleted: target, remaining: 0, freedBytes: beforeBytes }
    }

    const branchRef = (await this.run(['symbolic-ref', 'HEAD'])).trim()
    const oldHead = commits[commits.length - 1]!
    const remap = new Map<string, string>()
    for (let k = 0; k < idx; k += 1) remap.set(commits[k]!, commits[k]!)

    let parent: string | undefined = idx > 0 ? commits[idx - 1] : undefined
    for (let k = idx + 1; k < commits.length; k += 1) {
      const oldSha = commits[k]!
      const raw = await this.run(['show', '-s', '--format=%T%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', oldSha])
      const parts: string[] = []
      let cursor = 0
      for (let field = 0; field < 7; field += 1) {
        const sep = raw.indexOf('\0', cursor)
        if (sep === -1) throw new Error('读取快照元数据失败')
        parts.push(raw.slice(cursor, sep))
        cursor = sep + 1
      }
      const [tree, an, ae, ad, cn, ce, cd] = parts as [string, string, string, string, string, string, string]
      const message = raw.slice(cursor).replace(/\r?\n$/, '')
      const args = parent === undefined ? ['commit-tree', tree] : ['commit-tree', tree, '-p', parent]
      const nextSha = (await this.run(args, {
        GIT_AUTHOR_NAME: an,
        GIT_AUTHOR_EMAIL: ae,
        GIT_AUTHOR_DATE: ad,
        GIT_COMMITTER_NAME: cn,
        GIT_COMMITTER_EMAIL: ce,
        GIT_COMMITTER_DATE: cd,
      }, message)).trim()
      remap.set(oldSha, nextSha)
      parent = nextSha
    }

    const newHead = parent!
    await this.run(['update-ref', branchRef, newHead, oldHead])

    // 同步清理或更新任务前后快照引用，防止旧引用拽住已删除对象不放。
    const refOut = await this.run(['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/superagent'])
    for (const line of refOut.split(/\r?\n/).filter(Boolean)) {
      const [refName, refSha] = line.split('\t')
      if (!refName || !refSha) continue
      if (refSha === target) {
        await this.run(['update-ref', '-d', refName])
      } else {
        const mapped = remap.get(refSha)
        if (mapped !== undefined && mapped !== refSha) {
          await this.run(['update-ref', refName, mapped])
        }
      }
    }

    // 若删掉了最新快照，仅刷新索引匹配新 HEAD，不带 -u 绝不碰工作树。
    if (idx === commits.length - 1) {
      await this.run(['read-tree', 'HEAD'])
    }

    await this.run(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
    await this.run(['gc', '--quiet', '--prune=now'])

    const afterBytes = dirBytes(this.gitDir)
    return {
      deleted: target,
      remaining: commits.length - 1,
      freedBytes: Math.max(0, beforeBytes - afterBytes),
      head: newHead,
    }
  }
}

/** 统计目录体积（仅计算普通文件，不跟随符号链接），用于估算删除快照释放的空间。 */
function dirBytes(root: string): number {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try { total += statSync(full).size } catch { /* 已被回收 */ }
      }
    }
  }
  return total
}
