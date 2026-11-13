/**
 * State backups: the archive holds a consistent SQLite snapshot and the small configuration files, never the CLI token,
 * and old archives are pruned to `keep`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackup, listBackups } from '../src/admin/backup.ts'
import { SqliteRepositories } from '../src/store/sqlite.ts'
import type { Ticket } from '../src/core/model.ts'

const at = '2026-09-23T00:00:00.000Z'
const actor = { source: 'chat', id: 'alice' }

function ticket(id: string): Ticket {
  return {
    id, title: 'Fix', decisionId: 'decision-1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor, scope: 'small' },
    channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: at, updatedAt: at, origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
  }
}

const dirs: string[] = []
const repos: SqliteRepositories[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) if (repo.db.isOpen) repo.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-backup-test-'))
  dirs.push(dir)
  return dir
}

/** `tar` is present in Git Bash and on Debian; on a machine without it these tests are skipped. */
const hasTar = (() => {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

function stateWithDatabase(stateDir: string): SqliteRepositories {
  writeFileSync(join(stateDir, 'options.json'), '{"provider":"default"}\n')
  writeFileSync(join(stateDir, 'settings.json'), '{}\n')
  writeFileSync(join(stateDir, 'admin.json'), '{"hash":"x"}\n')
  writeFileSync(join(stateDir, 'vault.json'), '{"key":"value"}\n')
  writeFileSync(join(stateDir, 'vault.key'), Buffer.alloc(32, 1))
  writeFileSync(join(stateDir, 'cli-token'), 'do-not-copy-me\n')
  const repo = new SqliteRepositories(join(stateDir, 'state.sqlite'))
  repos.push(repo)
  repo.tickets.save(ticket('t1'))
  return repo
}

describe('state backups', () => {
  it.skipIf(!hasTar)('creates a tgz with the database snapshot and config files, but not the cli token', async () => {
    const stateDir = tempDir()
    const backupDir = join(stateDir, 'backups')
    const repo = stateWithDatabase(stateDir)

    const item = await createBackup({
      stateDir, backupDir, db: repo.db, now: () => new Date(2026, 0, 2, 3, 4, 5),
    })

    expect(item.name).toBe('state-20260102-030405.tgz')
    expect(item.bytes).toBeGreaterThan(0)
    expect(existsSync(join(backupDir, item.name))).toBe(true)
    if (process.platform !== 'win32') expect(statSync(join(backupDir, item.name)).mode & 0o777).toBe(0o600)

    const local = process.platform === 'win32' ? ['--force-local'] : []
    const names = execFileSync('tar', [...local, '-tzf', join(backupDir, item.name)], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(name => name.replace(/^\.\//, ''))
    expect(names).toContain('state.sqlite')
    expect(names).toContain('options.json')
    expect(names).toContain('settings.json')
    expect(names).toContain('admin.json')
    expect(names).toContain('vault.json')
    expect(names).toContain('vault.key')
    expect(names).not.toContain('cli-token')
    if (process.platform !== 'win32') {
      // The vault and its key must stay private inside the archive, or the backup leaks what it protects.
      const listing = execFileSync('tar', [...local, '-tvzf', join(backupDir, item.name)], { encoding: 'utf8' })
        .split(/\r?\n/)
      for (const name of ['vault.json', 'vault.key']) {
        const line = listing.find(entry => entry.endsWith(` ${name}`) || entry.endsWith(`./${name}`))
        expect(line, `${name} is in the archive`).toMatch(/^-rw-------/)
      }
    }
  })

  it.skipIf(!hasTar)('keeps only the newest archives', async () => {
    const stateDir = tempDir()
    const backupDir = join(stateDir, 'backups')
    const repo = stateWithDatabase(stateDir)

    for (const hour of [3, 4, 5]) {
      await createBackup({
        stateDir, backupDir, db: repo.db, keep: 2, now: () => new Date(2026, 0, 2, hour, 0, 0),
      })
    }

    expect(listBackups(backupDir).map(item => item.name)).toEqual([
      'state-20260102-050000.tgz',
      'state-20260102-040000.tgz',
    ])
  })

  it('returns an empty list for a missing directory', () => {
    expect(listBackups(join(tempDir(), 'nothing-here'))).toEqual([])
  })

  it.skipIf(!hasTar)('archives each book\'s canon, chapters and summaries but not its snapshots or work files', async () => {
    const stateDir = tempDir()
    const backupDir = join(stateDir, 'backups')
    const repo = stateWithDatabase(stateDir)
    const book = join(stateDir, 'novels', 'b_test1')
    for (const dir of ['canon', 'chapters', 'summaries', 'snapshots/0001', 'work/ch-0002']) mkdirSync(join(book, dir), { recursive: true })
    writeFileSync(join(book, 'book.json'), '{}\n')
    writeFileSync(join(book, 'canon', 'bible.json'), '{}\n')
    writeFileSync(join(book, 'chapters', 'ch-0001.md'), '# 一\n\n正文\n')
    writeFileSync(join(book, 'summaries', 'ch-0001.json'), '{}\n')
    writeFileSync(join(book, 'snapshots', '0001', 'bible.json'), '{}\n')
    writeFileSync(join(book, 'work', 'ch-0002', 'draft-0.md'), 'draft\n')
    mkdirSync(join(stateDir, 'novels', 'not-a-book'), { recursive: true })
    writeFileSync(join(stateDir, 'novels', 'not-a-book', 'x.txt'), 'x\n')

    const item = await createBackup({ stateDir, backupDir, db: repo.db, novelsDir: join(stateDir, 'novels'), now: () => new Date(2026, 0, 3, 1, 0, 0) })
    const local = process.platform === 'win32' ? ['--force-local'] : []
    const names = execFileSync('tar', [...local, '-tzf', join(backupDir, item.name)], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).map(name => name.replace(/^\.\//, ''))
    expect(names).toContain('novels/b_test1/book.json')
    expect(names).toContain('novels/b_test1/canon/bible.json')
    expect(names).toContain('novels/b_test1/chapters/ch-0001.md')
    expect(names).toContain('novels/b_test1/summaries/ch-0001.json')
    expect(names.some(name => name.includes('snapshots'))).toBe(false)
    expect(names.some(name => name.includes('/work/'))).toBe(false)
    expect(names.some(name => name.includes('not-a-book'))).toBe(false)
  })
})
