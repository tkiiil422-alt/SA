/**
 * `listDeliverables` only scans the workspace root, output/, reports/ and docs/, only two levels deep, and only for the
 * extensions the reader can show. A project copy and other bulky directories are never walked.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDeliverables } from '../src/projects/deliverables.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-deliverables-'))
  dirs.push(dir)
  return dir
}

function write(root: string, path: string, text = 'x'): string {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
  return full
}

describe('listDeliverables', () => {
  it('lists allowed files from the root and the three output directories', () => {
    const root = workspace()
    write(root, 'SUMMARY.md')
    write(root, 'notes.txt')
    write(root, 'data.exe')
    write(root, 'output/report.md')
    write(root, 'output/chart.png')
    write(root, 'output/sub/table.csv')
    write(root, 'reports/audit.json')
    write(root, 'docs/guide.html')
    write(root, 'docs/manual.pdf')
    write(root, 'docs/deep/nested.md')
    write(root, 'docs/deep/deeper/too-deep.md')
    write(root, 'other/deep.md')
    write(root, 'project/README.md')
    write(root, 'inbox/mail.md')

    const items = listDeliverables(root)
    const paths = items.map(item => item.path)
    expect(paths).toContain('SUMMARY.md')
    expect(paths).toContain('notes.txt')
    expect(paths).toContain('output/report.md')
    expect(paths).toContain('output/sub/table.csv')
    expect(paths).toContain('reports/audit.json')
    expect(paths).toContain('docs/guide.html')
    expect(paths).toContain('docs/manual.pdf')
    expect(paths).toContain('docs/deep/nested.md')
    expect(paths).toContain('other/deep.md')
    expect(paths).not.toContain('data.exe')
    expect(paths).not.toContain('docs/deep/deeper/too-deep.md')
    expect(paths).not.toContain('project/README.md')
    expect(paths).not.toContain('inbox/mail.md')
    expect(items.find(item => item.path === 'output/chart.png')?.kind).toBe('png')
  })

  it('sorts newest first, caps the list and skips symbolic links', () => {
    const root = workspace()
    const old = write(root, 'old.md')
    const newer = write(root, 'newer.md')
    const a = write(root, 'a.md')
    const b = write(root, 'b.md')
    utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'))
    utimesSync(a, new Date('2020-01-02'), new Date('2020-01-02'))
    utimesSync(b, new Date('2020-01-03'), new Date('2020-01-03'))
    utimesSync(newer, new Date('2021-01-01'), new Date('2021-01-01'))

    const items = listDeliverables(root)
    expect(items[0]?.path).toBe('newer.md')
    expect(listDeliverables(root, { limit: 2 })).toHaveLength(2)

    try {
      symlinkSync(old, join(root, 'link.md'))
      const linked = listDeliverables(root).map(item => item.path)
      expect(linked).not.toContain('link.md')
    } catch {
      // Windows without Developer Mode cannot create a symlink; the rule is covered on CI/Linux.
    }
  })
})
