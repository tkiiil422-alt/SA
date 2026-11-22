/**
 * Safe extraction of untrusted archives: name rules, links, quotas, zip bombs and the outer-directory unwrap.
 *
 * Every archive is built in the test with `tests/helpers/zip.ts`; the extractor's thresholds are lowered so a bomb or a
 * quota test does not need gigabytes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_EXTRACT_LIMITS, extractArchive, ExtractError } from '../src/projects/extract.ts'
import { writeZip, type ZipEntryInput } from './helpers/zip.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-extract-'))
  dirs.push(dir)
  return dir
}

function archive(entries: ZipEntryInput[]): { dir: string; zip: string; target: string } {
  const dir = tempDir()
  const zip = join(dir, 'sample.zip')
  writeZip(zip, entries)
  return { dir, zip, target: join(dir, 'tree') }
}

const run = (entries: ZipEntryInput[], limits: Record<string, number> = {}) => {
  const { zip, target } = archive(entries)
  return extractArchive({ archivePath: zip, targetDir: target, limits })
}

describe('extractArchive', () => {
  it('extracts a normal tree, strips the shared top directory and keeps the executable bit', async () => {
    const { dir, zip, target } = archive([
      { name: 'proj/', mode: 0o040755 },
      { name: 'proj/README.md', data: '# Hello', mode: 0o100644 },
      { name: 'proj/bin/run.sh', data: '#!/bin/sh\n', mode: 0o100755 },
      { name: 'proj/.git/HEAD', data: 'ref: refs/heads/main\n', mode: 0o100644 },
    ])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(result.files).toBe(3)
    expect(result.bytes).toBe(Buffer.byteLength('# Hello') + Buffer.byteLength('#!/bin/sh\n') + Buffer.byteLength('ref: refs/heads/main\n'))
    expect(result.outerDir).toBe('proj')
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Hello')
    expect(readFileSync(join(target, '.git', 'HEAD'), 'utf8')).toContain('main')
    expect(existsSync(join(dir, 'proj'))).toBe(false)
    if (process.platform !== 'win32') {
      expect(statSync(join(target, 'bin', 'run.sh')).mode & 0o777).toBe(0o755)
      expect(statSync(join(target, 'README.md')).mode & 0o777).toBe(0o644)
    }
  })

  it('does not strip when the root has more than one entry', async () => {
    const { zip, target } = archive([
      { name: 'a.txt', data: 'a' },
      { name: 'b/c.txt', data: 'c' },
    ])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(result.outerDir).toBeUndefined()
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(target, 'b', 'c.txt'), 'utf8')).toBe('c')
  })

  it('skips ../, absolute and drive-letter names without writing outside the target', async () => {
    const { dir, zip, target } = archive([
      { name: '../evil.txt', data: 'evil' },
      { name: '/etc/passwd', data: 'root' },
      { name: 'C:\\Windows\\x.txt', data: 'x' },
      { name: 'ok.txt', data: 'fine' },
    ])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(result.files).toBe(1)
    expect(readFileSync(join(target, 'ok.txt'), 'utf8')).toBe('fine')
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false)
    expect(existsSync(join(target, '..', 'evil.txt'))).toBe(false)
    const text = result.warnings.join('\n')
    expect(text).toContain('越界路径')
    expect(text).toContain('绝对路径')
    expect(text).toContain('带盘符的路径')
  })

  it('aborts when more than the configured number of entries try to escape', async () => {
    const entries: ZipEntryInput[] = Array.from({ length: 21 }, (_, index) => ({ name: `../x${index}`, data: 'x' }))
    const { zip, target } = archive(entries)
    await expect(extractArchive({ archivePath: zip, targetDir: target })).rejects.toMatchObject({ code: 'traversal' })
    expect(existsSync(target)).toBe(false)
  })

  it('skips symbolic links and special files with a warning', async () => {
    const result = await run([
      { name: 'link', data: 'target', mode: 0o120777 },
      { name: 'dev', data: '', mode: 0o020644 },
      { name: 'pipe', data: '', mode: 0o010644 },
      { name: 'ok.txt', data: 'fine' },
    ])
    expect(result.files).toBe(1)
    expect(result.warnings.some(text => text.includes('符号链接'))).toBe(true)
    expect(result.warnings.filter(text => text.includes('设备或特殊文件'))).toHaveLength(2)
  })

  it('stops a deflate bomb using the injectable ratio and minimum', async () => {
    const bomb = Buffer.alloc(2 * 1024 * 1024, 0)
    const { zip, target } = archive([{ name: 'zeros.bin', data: bomb, method: 8 }])
    await expect(extractArchive({
      archivePath: zip,
      targetDir: target,
      limits: { bombRatio: 5, bombMinBytes: 1_000, maxExtractBytes: 100 * 1024 * 1024 },
    })).rejects.toMatchObject({ code: 'bomb' })
    expect(existsSync(target)).toBe(false)
  })

  it('refuses too many entries and too many bytes', async () => {
    const many = archive([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    await expect(extractArchive({ archivePath: many.zip, targetDir: many.target, limits: { maxFiles: 2 } }))
      .rejects.toMatchObject({ code: 'too_many_files' })

    const big = archive([{ name: 'a.txt', data: Buffer.alloc(100, 1) }, { name: 'b.txt', data: Buffer.alloc(100, 2) }])
    await expect(extractArchive({ archivePath: big.zip, targetDir: big.target, limits: { maxExtractBytes: 150 } }))
      .rejects.toMatchObject({ code: 'too_large' })
  })

  it('skips one oversized file but keeps extracting the rest', async () => {
    const result = await run(
      [
        { name: 'big.bin', data: Buffer.alloc(100, 0) },
        { name: 'small.txt', data: 'small' },
      ],
      { maxFileBytes: 10 },
    )
    expect(result.files).toBe(1)
    expect(result.warnings.some(text => text.includes('过大的文件'))).toBe(true)
  })

  it('decodes CP437 names and warns about the encoding', async () => {
    // 0x82 is 'é' in CP437; it is invalid UTF-8 and cannot start a GBK pair with '.' as its trail.
    const rawName = Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74])
    const { zip, target } = archive([{ name: rawName, data: 'x', utf8: false }])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(result.warnings.some(text => text.includes('文件名编码可能不对'))).toBe(true)
    expect(readdirSync(target)).toContain('é.txt')
  })

  it('decodes GBK names without the UTF-8 flag and reports one aggregate warning', async () => {
    // GBK: 三马 = C8 FD C2 ED; the extension is ASCII.
    const gbkName = Buffer.from([0xC8, 0xFD, 0xC2, 0xED, 0x2e, 0x70, 0x79])
    const utf8Name = Buffer.from('中文.txt', 'utf8')
    const { zip, target } = archive([
      { name: gbkName, data: 'gbk', utf8: false },
      { name: utf8Name, data: 'utf8', utf8: false },
    ])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(readdirSync(target).sort()).toEqual(['中文.txt', '三马.py'].sort())
    expect(readFileSync(join(target, '三马.py'), 'utf8')).toBe('gbk')
    expect(result.warnings).toEqual(['1 个文件名按 GBK 解码'])
  })

  it('still rejects a GBK-decoded name that tries to escape', async () => {
    // GBK 三 followed by an ASCII `/../` segment: decoding must not bypass the traversal check.
    const rawName = Buffer.concat([Buffer.from([0xC8, 0xFD]), Buffer.from('/../x.txt')])
    const { zip, target } = archive([{ name: rawName, data: 'x', utf8: false }])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(result.files).toBe(0)
    expect(result.warnings.join('\n')).toContain('越界路径')
    expect(result.warnings.join('\n')).toContain('三/../x.txt')
    expect(readdirSync(target)).toEqual([])
  })

  it('keeps rejecting a drive-letter name without the UTF-8 flag', async () => {
    const { zip, target } = archive([{ name: 'C:/x.txt', data: 'x', utf8: false }])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(result.files).toBe(0)
    expect(result.warnings.join('\n')).toContain('带盘符的路径')
    expect(readdirSync(target)).toEqual([])
  })

  it('rejects a drive path even when the rest of the name needed GBK decoding', async () => {
    // `C:/` forces the GBK branch through the trailing C8 FD (三); validation still sees the drive prefix.
    const rawName = Buffer.concat([Buffer.from('C:/'), Buffer.from([0xC8, 0xFD]), Buffer.from('.txt')])
    const { zip, target } = archive([{ name: rawName, data: 'x', utf8: false }])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(result.files).toBe(0)
    expect(result.warnings.join('\n')).toContain('带盘符的路径')
    expect(result.warnings.join('\n')).toContain('C:/三.txt')
    expect(readdirSync(target)).toEqual([])
  })

  it('keeps the CP437 warning when a name is neither UTF-8 nor GBK', async () => {
    // A lone GBK lead byte is an incomplete sequence; CP437 renders it as 'ü'.
    const rawName = Buffer.from([0x81, 0x2e, 0x74, 0x78, 0x74])
    const { zip, target } = archive([{ name: rawName, data: 'x', utf8: false }])
    const result = await extractArchive({ archivePath: zip, targetDir: target })
    expect(result.warnings.some(text => text.includes('文件名编码可能不对'))).toBe(true)
    expect(readdirSync(target)).toContain('ü.txt')
  })

  it('refuses a non-zip file and leaves no partial tree', async () => {
    const dir = tempDir()
    const zip = join(dir, 'bad.zip')
    writeFileSync(zip, 'not a zip')
    const target = join(dir, 'tree')
    await expect(extractArchive({ archivePath: zip, targetDir: target })).rejects.toBeInstanceOf(ExtractError)
    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}.partial`)).toBe(false)
  })

  it('has production defaults matching the contract', () => {
    expect(DEFAULT_EXTRACT_LIMITS.maxFiles).toBe(300_000)
    expect(DEFAULT_EXTRACT_LIMITS.maxExtractBytes).toBe(12 * 1024 * 1024 * 1024)
    expect(DEFAULT_EXTRACT_LIMITS.bombRatio).toBe(200)
    expect(DEFAULT_EXTRACT_LIMITS.bombMinBytes).toBe(1024 * 1024 * 1024)
    expect(DEFAULT_EXTRACT_LIMITS.traversalAbortCount).toBe(20)
  })

  it('cleans a previous tree when extraction fails', async () => {
    const dir = tempDir()
    const zip = join(dir, 'sample.zip')
    writeZip(zip, [{ name: 'ok.txt', data: 'x' }])
    const target = join(dir, 'tree')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'stale.txt'), 'old')
    await extractArchive({ archivePath: zip, targetDir: target })
    expect(existsSync(join(target, 'stale.txt'))).toBe(false)
    expect(readFileSync(join(target, 'ok.txt'), 'utf8')).toBe('x')
  })
})
