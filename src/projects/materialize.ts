/**
 * Putting a project into a ticket's workspace: the `AGENTS.md` contract file and the one-time tree copy.
 *
 * The copy goes to `<workspace>/project.partial` and is renamed to `project` only when it finished, so a daemon restart
 * in the middle of a 2 GB copy can never leave a half tree that looks complete. `fs.promises.cp` keeps `.git` (dotfiles
 * and directory entries are copied as-is) and preserves timestamps. The library's own `tree/` is never modified.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { cp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { agentsFileText } from './agents-md.ts'

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The copy step, injectable so a test can simulate a crash mid-way. */
export type CopyTree = (source: string, target: string) => Promise<void>

const copyTree: CopyTree = (source, target) => cp(source, target, {
  recursive: true,
  preserveTimestamps: true,
  force: true,
  errorOnExist: false,
})

export interface MaterializeOptions {
  /** Replaces `fs.promises.cp`; tests use it to throw in the middle of a copy. */
  copy?: CopyTree
}

/** Write `<workspace>/AGENTS.md` unless the workspace already has one (a person may have edited it). */
export function writeAgentsFile(workspace: string, withProject: boolean): void {
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const path = join(workspace, 'AGENTS.md')
  if (existsSync(path)) return
  writeFileSync(path, agentsFileText(withProject), { mode: 0o644 })
}

/**
 * Copy `tree/` to `<workspace>/project/`, preserving `.git` and timestamps.
 *
 * - `project/` already exists: it is a finished copy and nothing is touched.
 * - A leftover `project.partial` from an interrupted copy is removed and the copy starts over.
 * - On failure the partial directory is removed, so the next launch retries instead of trusting a half tree.
 */
export async function materializeProject(treeDir: string, workspace: string, options: MaterializeOptions = {}): Promise<void> {
  const target = join(workspace, 'project')
  if (existsSync(target)) return
  const partial = `${target}.partial`
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  rmSync(partial, { recursive: true, force: true })
  const copy = options.copy ?? copyTree
  try {
    await copy(treeDir, partial)
    await rename(partial, target)
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`准备项目文件失败：${describe(error).slice(0, 200)}`)
  }
}
