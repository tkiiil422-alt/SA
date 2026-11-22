/**
 * Safe extraction of an untrusted `.zip` archive into a project tree.
 *
 * Nothing in the archive is ever executed here. Every entry name is validated, symbolic links and special files are
 * skipped, the number of files and the bytes actually written are counted, and a zip bomb is refused. Extraction goes to
 * `<target>.partial` and is renamed into place only when the whole archive was read, so a failure never leaves a
 * half-ready `tree/`.
 *
 * Every threshold is an injectable limit with a production default; tests lower them instead of creating gigabytes.
 */
import { chmodSync, createWriteStream, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { open, type Entry, type ZipFile } from 'yauzl'

/** Codes callers and tests can rely on. */
export type ExtractErrorCode =
  | 'bad_zip'
  | 'too_many_files'
  | 'too_large'
  | 'bomb'
  | 'traversal'
  | 'write_failures'
  | 'unavailable'

/** A refusal that ends the whole extraction with a Chinese, actionable message. */
export class ExtractError extends Error {
  readonly code: ExtractErrorCode

  constructor(code: ExtractErrorCode, message: string) {
    super(message)
    this.name = 'ExtractError'
    this.code = code
  }
}

/** Injectable thresholds. Defaults follow the project-library contract (11-改进计划.md §3.4). */
export interface ExtractLimits {
  /** Refuse an archive with more entries than this. */
  maxFiles: number
  /** Refuse to write more than this many bytes in total. */
  maxExtractBytes: number
  /** Skip a single file whose actual bytes exceed this. */
  maxFileBytes: number
  /** Abort when written bytes / archive bytes exceeds this and the minimum below is crossed. */
  bombRatio: number
  /** The expansion ratio only counts as a bomb once this many bytes were written. */
  bombMinBytes: number
  /** Abort when more entries than this try to escape with `..`. */
  traversalAbortCount: number
  maxPathBytes: number
  maxSegmentBytes: number
  maxWarnings: number
  /** Failed file writes tolerated before the whole extraction fails. */
  maxWriteFailures: number
  /** Files per event-loop yield. */
  yieldEvery: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxFiles: 300_000,
  maxExtractBytes: 12 * 1024 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  bombRatio: 200,
  bombMinBytes: 1024 * 1024 * 1024,
  traversalAbortCount: 20,
  maxPathBytes: 1024,
  maxSegmentBytes: 255,
  maxWarnings: 50,
  maxWriteFailures: 200,
  yieldEvery: 200,
}

export interface ExtractOptions {
  /** Absolute path of the `.zip` file. */
  archivePath: string
  /** Final directory; extraction happens in `<target>.partial`, which is renamed here on success. */
  targetDir: string
  limits?: Partial<ExtractLimits>
  /** Called after each entry with the number processed and the number of entries in the archive. */
  onProgress?: (done: number, total: number) => void
}

export interface ExtractResult {
  files: number
  bytes: number
  /** Total entries the central directory declared. */
  entries: number
  /** Up to `maxWarnings` human-readable Chinese warnings. */
  warnings: string[]
  /** All warnings, including those past the stored cap. */
  warningCount: number
  /** The shared top-level directory that was removed, when there was one. */
  outerDir?: string
}

/** CP437's upper half, the last-resort decoding for a name that is neither valid UTF-8 nor valid GBK. */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function decodeCp437(buffer: Buffer): string {
  let text = ''
  for (const byte of buffer) text += byte < 0x80 ? String.fromCharCode(byte) : (CP437[byte - 0x80] ?? '�')
  return text
}

/** A fatal UTF-8 decoder is safe to reuse: `decode` without `stream` resets after every call. */
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true })
/** GBK may be missing in a small-icu build; the probe runs once, then GBK is simply skipped. */
const GBK_FATAL = (() => {
  try {
    return new TextDecoder('gbk', { fatal: true })
  } catch {
    return undefined
  }
})()

type NameEncoding = 'utf8' | 'gbk' | 'cp437'

/**
 * Decode an entry name. A UTF-8 flag wins outright. Without the flag: strict UTF-8 first, then strict GBK (the common
 * encoding of Windows-made Chinese zips), and CP437 as the documented last resort with a warning.
 */
function decodeName(raw: Buffer, utf8Flag: boolean): { name: string; encoding: NameEncoding } {
  if (utf8Flag) return { name: raw.toString('utf8'), encoding: 'utf8' }
  try {
    return { name: UTF8_FATAL.decode(raw), encoding: 'utf8' }
  } catch {
    // Not UTF-8; try GBK before falling back.
  }
  if (GBK_FATAL !== undefined) {
    try {
      return { name: GBK_FATAL.decode(raw), encoding: 'gbk' }
    } catch {
      // Not GBK either.
    }
  }
  return { name: decodeCp437(raw), encoding: 'cp437' }
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

interface PlannedEntry {
  index: number
  /** Normalized relative path with `/` separators. */
  path: string
  dir: boolean
  /** Empty when the entry should be extracted; otherwise the reason it is skipped. */
  skip: string
  /** Unix mode from the archive, zero when absent. */
  mode: number
  /** How the raw name bytes were decoded; only CP437 and GBK carry warnings. */
  encoding: NameEncoding
}

interface ScanResult {
  entries: PlannedEntry[]
  total: number
  traversal: number
  /** Names decoded as GBK; one aggregate warning instead of one per file. */
  gbk: number
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveOpen, rejectOpen) => {
    // `decodeStrings: false` keeps yauzl from rejecting suspicious names itself: this module decides skip vs abort.
    open(path, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (error, zip) => {
      if (error) rejectOpen(error)
      else resolveOpen(zip)
    })
  })
}

function readAllEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolveRead, rejectRead) => {
    const entries: Entry[] = []
    zip.on('entry', (entry: Entry) => {
      entries.push(entry)
      zip.readEntry()
    })
    zip.on('end', () => resolveRead(entries))
    zip.on('error', rejectRead)
    zip.readEntry()
  })
}

/** Normalize and validate one entry name. Returns the planned entry and whether it counts as a traversal attempt. */
function planEntry(entry: Entry, index: number, limits: ExtractLimits): { planned: PlannedEntry; traversal: boolean } {
  const decoded = decodeName(entry.fileNameRaw, (entry.generalPurposeBitFlag & 0x800) !== 0)

  const name = decoded.name.replace(/\\/g, '/')
  const mode = entry.externalFileAttributes >>> 16
  const declaredDir = name.endsWith('/') || (mode & S_IFMT) === S_IFDIR
  // Keep the decoded name on a skipped entry so the warning says what was rejected; it is never used as a disk path.
  const fail = (skip: string): { planned: PlannedEntry; traversal: boolean } => ({
    planned: {
      index,
      path: skip === '路径里有 NUL 字符' ? '' : name,
      dir: declaredDir,
      skip,
      mode,
      encoding: decoded.encoding,
    },
    traversal: false,
  })

  if (decoded.name.includes('\0')) return fail('路径里有 NUL 字符')
  if (name.startsWith('/')) return fail('绝对路径')
  if (/^[A-Za-z]:/.test(name)) return fail('带盘符的路径')
  const segments = name.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.includes('..')) {
    return {
      planned: { index, path: name, dir: declaredDir, skip: '越界路径（..）', mode, encoding: decoded.encoding },
      traversal: true,
    }
  }
  if (segments.length === 0) return fail('空路径')
  const path = segments.join('/')
  if (Buffer.byteLength(path) > limits.maxPathBytes) return fail('路径太长')
  if (segments.some(segment => Buffer.byteLength(segment) > limits.maxSegmentBytes)) return fail('路径段太长')

  const fileType = mode & S_IFMT
  if (fileType === S_IFLNK) return fail('符号链接')
  if (fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR) return fail('设备或特殊文件')

  return { planned: { index, path, dir: declaredDir, skip: '', mode, encoding: decoded.encoding }, traversal: false }
}

/** File mode to apply: 0o644, or 0o755 when the archive marked it executable; setuid/setgid/sticky are cleared. */
function fileModeFrom(mode: number): number {
  if ((mode & 0o111) !== 0) return 0o755
  return 0o644
}

class Abort extends Error {
  readonly reason: ExtractErrorCode | 'file_too_large'

  constructor(reason: ExtractErrorCode | 'file_too_large') {
    super(reason)
    this.reason = reason
  }
}

function countingStream(stats: { streamed: number }, perFile: { bytes: number }, limit: {
  maxExtractBytes: number
  maxFileBytes: number
  bombRatio: number
  bombMinBytes: number
  archiveBytes: number
}): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      perFile.bytes += chunk.length
      stats.streamed += chunk.length
      if (perFile.bytes > limit.maxFileBytes) return callback(new Abort('file_too_large'))
      if (stats.streamed > limit.maxExtractBytes) return callback(new Abort('too_large'))
      if (stats.streamed > limit.bombMinBytes && limit.archiveBytes > 0
        && stats.streamed / limit.archiveBytes > limit.bombRatio) {
        return callback(new Abort('bomb'))
      }
      callback(null, chunk)
    },
  })
}

function streamEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, rejectStream) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) rejectStream(error)
      else resolveStream(stream)
    })
  })
}

/** Human-readable size for the quota message: GB for the production limit, MB for a lowered test limit. */
function limitText(bytes: number): string {
  const gib = 1024 * 1024 * 1024
  if (bytes >= gib) return `${Math.round(bytes / gib)} GB`
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Remove a file or directory without letting a cleanup failure hide the real error. */
function quietRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // A leftover tree.partial is harmless; the caller reports the extraction error.
  }
}

/**
 * Extract `archivePath` into `targetDir`, guarding against path traversal, links, quota overruns and zip bombs.
 * On any fatal error `<targetDir>.partial` and any previous `targetDir` are removed and an {@link ExtractError} is thrown.
 */
export async function extractArchive(options: ExtractOptions): Promise<ExtractResult> {
  const limits: ExtractLimits = { ...DEFAULT_EXTRACT_LIMITS, ...options.limits }
  const target = options.targetDir
  const partial = `${target}.partial`
  quietRemove(partial)
  // A failed attempt must not leave a stale tree that looks ready.
  quietRemove(target)
  mkdirSync(partial, { recursive: true, mode: 0o755 })

  let archiveBytes = 0
  try {
    archiveBytes = statSync(options.archivePath).size
  } catch {
    quietRemove(partial)
    throw new ExtractError('bad_zip', '找不到上传的压缩包，请重新上传。')
  }

  const warnings: string[] = []
  let warningCount = 0
  const warn = (text: string): void => {
    warningCount += 1
    if (warnings.length < limits.maxWarnings) warnings.push(text)
  }

  try {
    let planned: PlannedEntry[]
    let total = 0
    // Pass one reads only the central directory: it validates names and gives the progress total before any write.
    try {
      const scanZip = await openZip(options.archivePath)
      let scan: Entry[]
      try {
        scan = await readAllEntries(scanZip)
      } finally {
        scanZip.close()
      }
      total = scan.length
      if (total > limits.maxFiles) {
        throw new ExtractError('too_many_files', `压缩包里的文件有 ${total} 个，超过 ${limits.maxFiles} 个上限，可在设置→项目里调高。`)
      }
      const scanResult = scan.reduce<ScanResult>((acc, entry, index) => {
        const { planned: item, traversal } = planEntry(entry, index, limits)
        if (traversal) acc.traversal += 1
        if (item.encoding === 'cp437') {
          warn(`文件名编码可能不对：${(item.path === '' ? '(无法显示的路径)' : item.path).slice(0, 120)}`)
        } else if (item.encoding === 'gbk') {
          acc.gbk += 1
        }
        if (item.skip !== '') {
          warn(`跳过${item.skip}：${item.path === '' ? '(无法显示的路径)' : item.path.slice(0, 160)}`)
        }
        acc.entries.push(item)
        return acc
      }, { entries: [], total, traversal: 0, gbk: 0 })
      if (scanResult.traversal > limits.traversalAbortCount) {
        throw new ExtractError('traversal', '压缩包里有大量越界路径，疑似恶意文件，已中止解压。')
      }
      if (scanResult.gbk > 0) warn(`${scanResult.gbk} 个文件名按 GBK 解码`)
      planned = scanResult.entries
    } catch (error) {
      if (error instanceof ExtractError) throw error
      throw new ExtractError('bad_zip', '压缩包损坏或不是有效的 zip 文件。')
    }

    const zip = await openZip(options.archivePath)
    const stats = { streamed: 0 }
    let files = 0
    let bytes = 0
    let writeFailures = 0
    let done = 0

    const advance = async (): Promise<void> => {
      done += 1
      options.onProgress?.(done, total)
      if (done % limits.yieldEvery === 0) await new Promise<void>(resolveYield => setImmediate(resolveYield))
    }

    try {
      for (let index = 0; index < planned.length; index += 1) {
        const item = planned[index]!
        const entry = await new Promise<Entry>((resolveEntry, rejectEntry) => {
          const onEntry = (next: Entry): void => {
            if (next === undefined) return
            cleanup()
            resolveEntry(next)
          }
          const onEnd = (): void => {
            cleanup()
            rejectEntry(new ExtractError('bad_zip', '压缩包内容不完整。'))
          }
          const onError = (error: Error): void => {
            cleanup()
            rejectEntry(error)
          }
          const cleanup = (): void => {
            zip.off('entry', onEntry)
            zip.off('end', onEnd)
            zip.off('error', onError)
          }
          zip.once('entry', onEntry)
          zip.once('end', onEnd)
          zip.once('error', onError)
          zip.readEntry()
        })

        if (item.skip !== '' || item.dir) {
          if (item.skip === '' && item.path !== '') {
            const directory = join(partial, item.path)
            try {
              mkdirSync(directory, { recursive: true, mode: 0o755 })
              chmodSync(directory, 0o755)
            } catch {
              // An illegal name on this platform is a warning; Windows ignores POSIX modes anyway.
              warn(`无法创建目录：${item.path.slice(0, 160)}`)
            }
          }
          await advance()
          continue
        }

        const destination = join(partial, item.path)
        const perFile = { bytes: 0 }
        try {
          mkdirSync(dirname(destination), { recursive: true, mode: 0o755 })
          const stream = await streamEntry(zip, entry)
          await pipeline(stream, countingStream(stats, perFile, {
            maxExtractBytes: limits.maxExtractBytes,
            maxFileBytes: limits.maxFileBytes,
            bombRatio: limits.bombRatio,
            bombMinBytes: limits.bombMinBytes,
            archiveBytes,
          }), createWriteStream(destination, { mode: 0o644 }))
          chmodSync(destination, fileModeFrom(item.mode))
          files += 1
          bytes += perFile.bytes
        } catch (error) {
          if (error instanceof Abort && error.reason !== 'file_too_large') {
            throw new ExtractError(
              error.reason === 'bomb' ? 'bomb' : 'too_large',
              error.reason === 'bomb'
                ? '压缩包疑似压缩炸弹，已中止解压。'
                : `解压后超过 ${limitText(limits.maxExtractBytes)} 上限，可在设置→项目里调高。`,
            )
          }
          // One unwritable file (an illegal Windows name, a full disk) is a warning; many of them fail the extraction.
          try {
            unlinkSync(destination)
          } catch {
            // The file may never have been created.
          }
          if (error instanceof Abort && error.reason === 'file_too_large') {
            warn(`跳过了过大的文件：${item.path.slice(0, 160)}`)
          } else {
            writeFailures += 1
            warn(`写入失败：${item.path.slice(0, 160)}`)
            if (writeFailures > limits.maxWriteFailures) {
              throw new ExtractError('write_failures', `有超过 ${limits.maxWriteFailures} 个文件无法写入，解压失败，请检查磁盘空间与文件名。`)
            }
          }
        }
        if (stats.streamed > limits.maxExtractBytes) {
          throw new ExtractError('too_large', `解压后超过 ${limitText(limits.maxExtractBytes)} 上限，可在设置→项目里调高。`)
        }
        if (stats.streamed > limits.bombMinBytes && archiveBytes > 0 && stats.streamed / archiveBytes > limits.bombRatio) {
          throw new ExtractError('bomb', '压缩包疑似压缩炸弹，已中止解压。')
        }
        await advance()
      }
    } finally {
      zip.close()
    }

    if (bytes > limits.maxExtractBytes) {
      throw new ExtractError('too_large', `解压后超过 ${limitText(limits.maxExtractBytes)} 上限，可在设置→项目里调高。`)
    }

    const outerDir = unwrapSingleTopLevel(partial, target)
    return { files, bytes, entries: total, warnings, warningCount, ...(outerDir === undefined ? {} : { outerDir }) }
  } catch (error) {
    quietRemove(partial)
    try {
      if (lstatSync(target).isDirectory()) quietRemove(target)
    } catch (missing) {
      if (!isMissing(missing)) quietRemove(target)
    }
    if (error instanceof ExtractError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ExtractError('bad_zip', `解压失败：${message.slice(0, 200)}`)
  }
}

/**
 * Move `partial` to `target`. When every entry lives under one shared top-level directory, that directory's contents
 * become the project root instead (the archive's `ai-ak47-main/` wrapper is not part of the project).
 */
function unwrapSingleTopLevel(partial: string, target: string): string | undefined {
  let entries: string[] = []
  try {
    entries = readdirSync(partial)
  } catch {
    entries = []
  }
  if (entries.length === 1) {
    const only = entries[0]!
    const candidate = join(partial, only)
    try {
      const info = lstatSync(candidate)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        const staging = `${target}.unwrap`
        rmSync(staging, { recursive: true, force: true })
        renameSync(candidate, staging)
        rmSync(partial, { recursive: true, force: true })
        renameSync(staging, target)
        return only
      }
    } catch {
      // Fall through to the plain rename; the tree is still valid without unwrapping.
    }
  }
  renameSync(partial, target)
  return undefined
}
