/**
 * The documents a worker produced in its workspace, for the ticket page's "产出文档" section.
 *
 * Only the workspace root and three conventional output directories are scanned, at most two levels deep, for the
 * extensions the reader can show. Symbolic links are never followed.
 */
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Extensions the console's reader can display. */
const DOCUMENT_EXTENSIONS = new Set(['md', 'txt', 'csv', 'json', 'html', 'pdf'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])
/** Directories under the workspace root that hold human-facing output. */
const OUTPUT_DIRS = ['output', 'reports', 'docs']
/** Never walk into these: a project copy can hold tens of thousands of files and must not slow the page down. */
const SKIP_DIRS = new Set(['project', 'inbox', 'node_modules', '.git', '.pnpm-store', 'dist', 'build', 'target', 'vendor'])

export interface Deliverable {
  /** Path relative to the workspace root, with `/` separators. */
  path: string
  size: number
  mtime: string
  /** Extension without the dot, such as `md` or `png`. */
  kind: string
}

export interface DeliverableOptions {
  limit?: number
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  return name.slice(index + 1).toLowerCase()
}

function isAllowed(ext: string): boolean {
  return DOCUMENT_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)
}

interface Found {
  absolute: string
  path: string
  ext: string
  size: number
  mtimeMs: number
}

/** Walk one root for at most `depth` levels, collecting files with allowed extensions. */
function scan(root: string, base: string, depth: number, found: Found[], seen: Set<string>): void {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const absolute = join(root, entry.name)
    let info
    try {
      info = lstatSync(absolute)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    const relative = base === '' ? entry.name : `${base}/${entry.name}`
    if (info.isDirectory()) {
      if (depth > 1 && SKIP_DIRS.has(entry.name.toLowerCase())) continue
      if (depth > 1) scan(absolute, relative, depth - 1, found, seen)
      continue
    }
    if (!info.isFile()) continue
    const ext = extensionOf(entry.name)
    if (!isAllowed(ext)) continue
    if (seen.has(relative)) continue
    seen.add(relative)
    found.push({ absolute, path: relative, ext, size: info.size, mtimeMs: info.mtimeMs })
  }
}

/**
 * List the deliverables under `<workspace>`: the root itself plus `output/`, `reports/` and `docs/`, each two levels
 * deep, newest first, at most `limit` (default 50).
 */
export function listDeliverables(workspace: string, options: DeliverableOptions = {}): Deliverable[] {
  const limit = Math.max(1, options.limit ?? 50)
  const found: Found[] = []
  const seen = new Set<string>()
  // The root scan skips the output directories (they are scanned separately) and bulky project data.
  scanShallowRoot(workspace, found, seen)
  for (const directory of OUTPUT_DIRS) {
    scan(join(workspace, directory), directory, 2, found, seen)
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
  return found.slice(0, limit).map(item => ({
    path: item.path,
    size: item.size,
    mtime: new Date(item.mtimeMs).toISOString(),
    kind: item.ext,
  }))
}

/** Root-level files and files one directory below, excluding the directories scanned on their own. */
function scanShallowRoot(workspace: string, found: Found[], seen: Set<string>): void {
  let entries
  try {
    entries = readdirSync(workspace, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const absolute = join(workspace, entry.name)
    let info
    try {
      info = lstatSync(absolute)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    const lowered = entry.name.toLowerCase()
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(lowered) || OUTPUT_DIRS.includes(lowered)) continue
      scan(absolute, entry.name, 1, found, seen)
      continue
    }
    if (!info.isFile()) continue
    const ext = extensionOf(entry.name)
    if (!isAllowed(ext)) continue
    seen.add(entry.name)
    found.push({ absolute, path: entry.name, ext, size: info.size, mtimeMs: info.mtimeMs })
  }
}
