/**
 * The project profile reads counts, languages, README, manifests and git metadata from an extracted tree. Nothing is
 * executed and no git command runs; the `.git` files are read as text.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildProfile, PROFILE_MAX_BYTES } from '../src/projects/profile.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-profile-'))
  dirs.push(dir)
  return dir
}

function write(root: string, path: string, text: string): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

describe('buildProfile', () => {
  it('counts files and bytes, finds languages, README and manifests', () => {
    const root = tree()
    write(root, 'README.md', '# Project\nThis is a sample.')
    write(root, 'src/a.ts', 'export const a = 1\n')
    write(root, 'src/b.ts', 'export const b = 2\n')
    write(root, 'web/app.js', 'console.log(1)\n')
    write(root, 'package.json', JSON.stringify({ name: 'demo', scripts: { build: 'tsc', test: 'vitest' } }))
    write(root, 'pyproject.toml', '[project]\nname = "demo"\n' + 'x = 1\n'.repeat(40))

    const profile = buildProfile(root)
    expect(profile.files).toBe(6)
    expect(profile.bytes).toBeGreaterThan(0)
    expect(profile.languages[0]).toEqual({ ext: 'ts', files: 2 })
    expect(profile.readme).toContain('# Project')
    expect(profile.topLevel).toContain('src/')
    expect(profile.topLevel).toContain('src/a.ts')
    expect(profile.manifests.find(item => item.file === 'package.json')?.summary).toContain('name: demo')
    expect(profile.manifests.find(item => item.file === 'package.json')?.summary).toContain('build')
    const pyproject = profile.manifests.find(item => item.file === 'pyproject.toml')?.summary ?? ''
    expect(pyproject.split('\n').length).toBeLessThanOrEqual(20)
    expect(profile.git).toBeUndefined()
  })

  it('finds a README and a manifest one level down (a monorepo layout)', () => {
    const root = tree()
    write(root, 'frontend/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }))
    write(root, 'backend/pyproject.toml', '[project]\nname = "api"\n')
    write(root, 'frontend/README.md', '# Web')
    const profile = buildProfile(root)
    expect(profile.readme).toContain('# Web')
    expect(profile.manifests.map(item => item.file)).toEqual(['backend/pyproject.toml', 'frontend/package.json'])
  })

  it('keeps only the top eight languages, the first README and 3000 characters', () => {
    const root = tree()
    for (let index = 0; index < 10; index += 1) {
      write(root, `f${index}.ext${index}`, 'x')
    }
    write(root, 'README.md', 'a'.repeat(10_000))
    write(root, 'readme-other.md', 'other')
    const profile = buildProfile(root)
    expect(profile.languages).toHaveLength(8)
    expect(profile.readme).toHaveLength(3000)
    expect(profile.readme.startsWith('a'.repeat(100))).toBe(true)
  })

  it('reads the git branch and recent commits from HEAD and logs/HEAD text', () => {
    const root = tree()
    write(root, '.git/HEAD', 'ref: refs/heads/main\n')
    write(root, '.git/logs/HEAD', [
      `0000000 1111111abc Author <a@example.test> 1700000000 +0000\tfirst commit`,
      `1111111 2222222def Author <a@example.test> 1700000100 +0000\tsecond commit`,
      `2222222 3333333abc Author <a@example.test> 1700000200 +0000\tthird commit`,
      '',
    ].join('\n'))
    const profile = buildProfile(root)
    expect(profile.git?.branch).toBe('main')
    expect(profile.git?.recent.map(item => item.hash7)).toEqual(['1111111', '2222222', '3333333'])
    expect(profile.git?.recent.at(-1)?.message).toBe('third commit')
  })

  it('omits git when .git is a file (a worktree) and never follows it', () => {
    const root = tree()
    write(root, '.git', 'gitdir: ../elsewhere/.git/worktrees/x')
    expect(buildProfile(root).git).toBeUndefined()
  })

  it('caps the whole profile at 24 KB', () => {
    const root = tree()
    for (let index = 0; index < 300; index += 1) write(root, `dir${index}/file.txt`, 'x')
    write(root, 'README.md', 'a'.repeat(50_000))
    const profile = buildProfile(root)
    expect(Buffer.byteLength(`${JSON.stringify(profile)}\n`)).toBeLessThanOrEqual(PROFILE_MAX_BYTES)
  })
})
