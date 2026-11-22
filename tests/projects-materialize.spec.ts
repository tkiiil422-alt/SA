/**
 * The project copy into a ticket workspace: `.git` survives, an interrupted copy never leaves a `project/` that looks
 * finished, a stale `project.partial` is discarded, and an existing `project/` is left alone.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeProject } from '../src/projects/materialize.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-materialize-'))
  dirs.push(dir)
  return dir
}

function tree(): string {
  const root = tempDir()
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# demo')
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'export {}\n')
  return root
}

describe('materializeProject', () => {
  it('copies the tree (with .git) through project.partial and leaves no partial behind', async () => {
    const source = tree()
    const workspace = tempDir()
    await materializeProject(source, workspace)
    const project = join(workspace, 'project')
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('# demo')
    expect(readFileSync(join(project, '.git', 'HEAD'), 'utf8')).toContain('main')
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('export {}\n')
    expect(existsSync(join(workspace, 'project.partial'))).toBe(false)
  })

  it('removes a half copy when the copy fails, so no project/ appears', async () => {
    const source = tree()
    const workspace = tempDir()
    await expect(materializeProject(source, workspace, {
      copy: async (_source, target) => {
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'half.txt'), 'half')
        throw new Error('disk full')
      },
    })).rejects.toMatchObject({ message: expect.stringContaining('准备项目文件失败') })
    expect(existsSync(join(workspace, 'project'))).toBe(false)
    expect(existsSync(join(workspace, 'project.partial'))).toBe(false)
  })

  it('discards a stale project.partial and copies again', async () => {
    const source = tree()
    const workspace = tempDir()
    mkdirSync(join(workspace, 'project.partial'), { recursive: true })
    writeFileSync(join(workspace, 'project.partial', 'stale.txt'), 'stale')

    await materializeProject(source, workspace)
    expect(readdirSync(join(workspace, 'project')).sort()).toEqual(['.git', 'README.md', 'src'])
    expect(existsSync(join(workspace, 'project', 'stale.txt'))).toBe(false)
    expect(existsSync(join(workspace, 'project.partial'))).toBe(false)
  })

  it('does not touch an existing project/ (a finished copy wins)', async () => {
    const source = tree()
    const workspace = tempDir()
    mkdirSync(join(workspace, 'project'), { recursive: true })
    writeFileSync(join(workspace, 'project', 'keep.txt'), 'keep')

    await materializeProject(source, workspace)
    expect(readFileSync(join(workspace, 'project', 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(workspace, 'project', 'README.md'))).toBe(false)
  })
})
