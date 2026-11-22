/**
 * On-disk layout of one book: `<root>/<bookId>/` holds the book record, the canon files, snapshots, chapters, chapter
 * summaries, per-chapter work scratch space, discarded chapters and rendered views.
 *
 * Canon is validated against the schemas on every read and write. Writes go through `atomicWrite` (temp file, then
 * rename). Symbolic links are refused, never followed.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Book, Canon, CanonFile, Setup } from './schemas.ts'
import { BookSchema, CANON_FILES, CANON_SCHEMAS } from './schemas.ts'

const BOOK_ID = /^b_[A-Za-z0-9]{1,32}$/
/** Scratch file names: ASCII only, no leading dot, so they can never climb out of their directory. */
const WORK_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
/** View names may use CJK letters, but never separators or a leading dot. */
const VIEW_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u
const CHAPTER_FILE = /^ch-(\d+)\.md$/
const SUMMARY_FILE = /^ch-(\d+)\.json$/
/** Canon files a book may legitimately lack on disk (no chapter written yet); they read as []. */
const OPTIONAL_CANON: ReadonlySet<CanonFile> = new Set<CanonFile>(['timeline', 'pacing'])

export function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

/** Write `data` to `path` through a temp file and a rename, creating parent directories first. */
export function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/** Read a regular file as UTF-8, or undefined when it does not exist. Symbolic links and non-files are refused. */
function readIfExists(path: string): string | undefined {
  const st = lstatOrUndefined(path)
  if (st === undefined) return undefined
  if (st.isSymbolicLink()) throw new Error(`拒绝跟随符号链接: ${path}`)
  if (!st.isFile()) throw new Error(`不是普通文件: ${path}`)
  return readFileSync(path, 'utf8')
}

function checkN(n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new Error(`章号不合法: ${n}`)
}

function checkName(name: string, pattern: RegExp, label: string): void {
  if (!pattern.test(name)) throw new Error(`${label}不合法: ${name}`)
}

/** Copy a directory tree; a symbolic link anywhere in the source aborts the copy. */
function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    const st = lstatSync(from)
    if (st.isSymbolicLink()) throw new Error(`拒绝跟随符号链接: ${from}`)
    if (st.isDirectory()) copyTree(from, to)
    else if (st.isFile()) copyFileSync(from, to)
  }
}

/** Split a chapter into its `# ` heading (title) and the rest (body). */
function splitHeading(text: string): { title: string; body: string } {
  const trimmed = text.replace(/^\s+/, '')
  const newline = trimmed.indexOf('\n')
  const first = (newline < 0 ? trimmed : trimmed.slice(0, newline)).trimEnd()
  const rest = newline < 0 ? '' : trimmed.slice(newline + 1)
  const heading = /^#\s+(.*)$/.exec(first)
  if (heading === null) return { title: '', body: trimmed.trim() }
  return { title: (heading[1] ?? '').trim(), body: rest.trim() }
}

function describeZod(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join('.') || '(根)'} ${issue.message}`).join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}

/** Parse every canon file with its schema. Throws naming the first file that fails; writes nothing. */
function parseCanon(canon: Canon): Record<CanonFile, unknown> {
  const out = {} as Record<CanonFile, unknown>
  for (const file of CANON_FILES) {
    const schema: z.ZodType = CANON_SCHEMAS[file]
    try {
      out[file] = schema.parse(canon[file])
    } catch (error) {
      throw new Error(`canon/${file}.json 不合法: ${describeZod(error)}`)
    }
  }
  return out
}

export class BookFiles {
  readonly dir: string

  constructor(root: string, bookId: string) {
    checkName(bookId, BOOK_ID, '书籍编号')
    this.dir = join(root, bookId)
  }

  /** Create a new book directory with the book record and the initial canon. Throws if the directory exists. */
  static create(root: string, book: Book, setup: Setup): BookFiles {
    const files = new BookFiles(root, book.id)
    if (existsSync(files.dir)) throw new Error(`书籍目录已存在: ${book.id}`)
    const parsedBook = BookSchema.parse(book)
    const parsedCanon = parseCanon({
      bible: setup.bible,
      power: setup.power,
      characters: setup.characters,
      items: setup.items,
      world: setup.world,
      foreshadow: setup.foreshadow,
      secrets: setup.secrets,
      timeline: [],
      plan: setup.plan,
      pacing: [],
    })
    files.writeBookParsed(parsedBook)
    files.writeParsedCanon(parsedCanon)
    return files
  }

  exists(): boolean {
    return existsSync(this.bookPath())
  }

  readBook(): Book {
    const text = readIfExists(this.bookPath())
    if (text === undefined) throw new Error(`书籍不存在: ${this.dir}`)
    return BookSchema.parse(JSON.parse(text))
  }

  writeBook(book: Book): void {
    this.writeBookParsed(BookSchema.parse(book))
  }

  private writeBookParsed(book: Book): void {
    atomicWrite(this.bookPath(), JSON.stringify(book, null, 2))
  }

  readCanon(): Canon {
    const values: Record<string, unknown> = {}
    for (const file of CANON_FILES) {
      const text = readIfExists(this.canonPath(file))
      if (text === undefined) {
        if (!OPTIONAL_CANON.has(file)) throw new Error(`canon/${file}.json 缺失`)
        values[file] = []
        continue
      }
      const schema: z.ZodType = CANON_SCHEMAS[file]
      values[file] = schema.parse(JSON.parse(text))
    }
    return values as unknown as Canon
  }

  /** Validate the whole canon first; only when every file passes is anything written. */
  writeCanon(canon: Canon): void {
    this.writeParsedCanon(parseCanon(canon))
  }

  private writeParsedCanon(parsed: Record<CanonFile, unknown>): void {
    for (const file of CANON_FILES) atomicWrite(this.canonPath(file), JSON.stringify(parsed[file], null, 2))
  }

  /** sha256 over the contents of every file in canon/, in file-name order. */
  canonSha(): string {
    const hash = createHash('sha256')
    for (const name of this.canonNames()) hash.update(readFileSync(join(this.canonDir(), name)))
    return hash.digest('hex')
  }

  /** Copy canon/ to snapshots/<pad4(n)>/, replacing an earlier snapshot of the same number. */
  snapshot(n: number): void {
    checkN(n)
    const target = this.snapshotDir(n)
    rmSync(target, { recursive: true, force: true })
    copyTree(this.canonDir(), target)
  }

  hasSnapshot(n: number): boolean {
    checkN(n)
    return existsSync(this.snapshotDir(n))
  }

  /** Replace canon/ with the snapshot of chapter n. Throws when there is no such snapshot. */
  restore(n: number): void {
    if (!this.hasSnapshot(n)) throw new Error(`快照不存在: 第${n}章`)
    rmSync(this.canonDir(), { recursive: true, force: true })
    copyTree(this.snapshotDir(n), this.canonDir())
  }

  /** Delete every snapshot directory whose number `keep` rejects. */
  pruneSnapshots(keep: (n: number) => boolean): void {
    const root = join(this.dir, 'snapshots')
    if (!existsSync(root)) return
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
      if (!keep(Number(entry.name))) rmSync(join(root, entry.name), { recursive: true, force: true })
    }
  }

  writeChapter(n: number, text: string): void {
    checkN(n)
    atomicWrite(this.chapterPath(n), text)
  }

  readChapter(n: number): string | undefined {
    checkN(n)
    return readIfExists(this.chapterPath(n))
  }

  chapterNumbers(): number[] {
    return this.numbersIn('chapters', CHAPTER_FILE)
  }

  writeSummary(n: number, value: unknown): void {
    checkN(n)
    if (value === undefined) throw new Error('摘要不能为 undefined')
    atomicWrite(this.summaryPath(n), JSON.stringify(value, null, 2))
  }

  readSummary<T = unknown>(n: number): T | undefined {
    checkN(n)
    const text = readIfExists(this.summaryPath(n))
    return text === undefined ? undefined : JSON.parse(text) as T
  }

  writeWork(n: number, name: string, data: string): void {
    checkN(n)
    checkName(name, WORK_NAME, '工作文件名')
    atomicWrite(join(this.workDir(n), name), data)
  }

  readWork(n: number, name: string): string | undefined {
    checkN(n)
    checkName(name, WORK_NAME, '工作文件名')
    return readIfExists(join(this.workDir(n), name))
  }

  clearWork(n: number): void {
    checkN(n)
    rmSync(this.workDir(n), { recursive: true, force: true })
  }

  /**
   * Move chapters and summaries numbered >= n into chapters/.discarded/<YYYYMMDDHHmmss>/ (UTC, from `at`).
   * Returns the number of chapters moved.
   */
  discardFrom(n: number, at: Date): number {
    checkN(n)
    const chapters = this.chapterNumbers().filter(x => x >= n)
    const summaries = this.numbersIn('summaries', SUMMARY_FILE).filter(x => x >= n)
    if (chapters.length === 0 && summaries.length === 0) return 0
    const stamp = at.toISOString().replace(/\D/g, '').slice(0, 14)
    const target = join(this.dir, 'chapters', '.discarded', stamp)
    mkdirSync(target, { recursive: true })
    for (const x of chapters) renameSync(this.chapterPath(x), join(target, `ch-${pad4(x)}.md`))
    for (const x of summaries) renameSync(this.summaryPath(x), join(target, `ch-${pad4(x)}.summary.json`))
    return chapters.length
  }

  writeView(name: string, markdown: string): void {
    checkName(name, VIEW_NAME, '视图名')
    atomicWrite(join(this.dir, 'views', `${name}.md`), markdown)
  }

  /** Concatenate chapters from..to (inclusive), each headed `第N章 标题`. */
  exportText(from: number, to: number): string {
    const parts: string[] = []
    for (const n of this.chapterNumbers()) {
      if (n < from || n > to) continue
      const text = this.readChapter(n)
      if (text === undefined) continue
      const { title, body } = splitHeading(text)
      parts.push(`${`第${n}章 ${title}`.trimEnd()}\n\n${body}`)
    }
    return parts.join('\n\n')
  }

  private bookPath(): string {
    return join(this.dir, 'book.json')
  }

  private canonDir(): string {
    return join(this.dir, 'canon')
  }

  private canonPath(file: CanonFile): string {
    return join(this.canonDir(), `${file}.json`)
  }

  private chapterPath(n: number): string {
    return join(this.dir, 'chapters', `ch-${pad4(n)}.md`)
  }

  private summaryPath(n: number): string {
    return join(this.dir, 'summaries', `ch-${pad4(n)}.json`)
  }

  private snapshotDir(n: number): string {
    return join(this.dir, 'snapshots', pad4(n))
  }

  private workDir(n: number): string {
    return join(this.dir, 'work', `ch-${pad4(n)}`)
  }

  private canonNames(): string[] {
    const dir = this.canonDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort()
  }

  private numbersIn(sub: string, pattern: RegExp): number[] {
    const dir = join(this.dir, sub)
    if (!existsSync(dir)) return []
    const out: number[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const match = pattern.exec(entry.name)
      if (match?.[1]) out.push(Number(match[1]))
    }
    return out.sort((a, b) => a - b)
  }
}
