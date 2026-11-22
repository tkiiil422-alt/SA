/**
 * Project profile: a small, read-only description of an extracted project for the console and the council.
 *
 * Nothing in the project is executed and git is never run: this module only reads directory entries and a few text
 * files. The result is capped at 24 KB so it can be sent inline.
 */
import { closeSync, lstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** How much of the first README and a manifest is kept. */
const README_CHARS = 3000
/** The whole `profile.json` must stay at or below this. */
export const PROFILE_MAX_BYTES = 24 * 1024
const TOP_LEVEL_MAX = 120
const LANGUAGE_MAX = 8

export interface ProfileManifest {
  file: string
  summary: string
}

export interface ProfileGitCommit {
  hash7: string
  message: string
}

export interface ProjectProfile {
  files: number
  bytes: number
  /** The first two levels of the tree, directories suffixed with `/`, at most 120 lines. */
  topLevel: string[]
  languages: { ext: string; files: number }[]
  /** The beginning of the first root README*.md, or an empty string. */
  readme: string
  manifests: ProfileManifest[]
  git?: { branch: string; recent: ProfileGitCommit[] }
}

export interface BuildProfileOptions {
  /** Injected for tests; the profile is also capped by this. */
  maxBytes?: number
}

function readTextPrefix(file: string, bytes: number): string {
  const length = Math.max(0, Math.min(bytes, 256 * 1024))
  const buffer = Buffer.allocUnsafe(length)
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const read = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The read already finished; a close failure changes nothing.
      }
    }
  }
}

function readTextTail(file: string, bytes: number): string {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return ''
  }
  const length = Math.min(bytes, size)
  const buffer = Buffer.allocUnsafe(length)
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const read = readSync(fd, buffer, 0, length, size - length)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Nothing to do.
      }
    }
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  return name.slice(index + 1).toLowerCase()
}

/** Walk the tree once, counting files and bytes and collecting the first two levels for the display. */
function walk(treeDir: string): { files: number; bytes: number; languages: Map<string, number>; topLevel: string[] } {
  let files = 0
  let bytes = 0
  const languages = new Map<string, number>()
  const topLevel: string[] = []
  let rootEntries: string[]
  try {
    rootEntries = readdirSync(treeDir).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  } catch {
    return { files, bytes, languages, topLevel }
  }

  const stack: { path: string; depth: number }[] = []
  for (const name of rootEntries) {
    const full = join(treeDir, name)
    let info
    try {
      info = lstatSync(full)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    const isDir = info.isDirectory()
    if (topLevel.length < TOP_LEVEL_MAX) topLevel.push(isDir ? `${name}/` : name)
    if (isDir) {
      stack.push({ path: full, depth: 1 })
    } else if (info.isFile()) {
      files += 1
      bytes += info.size
      const ext = extensionOf(name)
      if (ext !== '') languages.set(ext, (languages.get(ext) ?? 0) + 1)
    }
  }

  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current.path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (current.depth < 2 && topLevel.length < TOP_LEVEL_MAX) {
          const relative = full.slice(treeDir.length + 1).replace(/\\/g, '/')
          topLevel.push(`${relative}/`)
        }
        stack.push({ path: full, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (current.depth < 2 && topLevel.length < TOP_LEVEL_MAX) {
        topLevel.push(full.slice(treeDir.length + 1).replace(/\\/g, '/'))
      }
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      files += 1
      bytes += info.size
      const ext = extensionOf(entry.name)
      if (ext !== '') languages.set(ext, (languages.get(ext) ?? 0) + 1)
    }
  }
  return { files, bytes, languages, topLevel }
}

/** Child directories that may hold a README or a manifest (a monorepo keeps them one level down). */
function shallowDirectories(treeDir: string, rootEntries: string[]): string[] {
  const directories: string[] = ['']
  for (const name of rootEntries.slice(0, 200)) {
    try {
      const info = lstatSync(join(treeDir, name))
      if (info.isDirectory() && !info.isSymbolicLink()) directories.push(name)
    } catch {
      // A vanished entry contributes nothing.
    }
  }
  // The root stays first; the rest are stable so the profile does not change between identical runs.
  return [directories[0]!, ...directories.slice(1).sort((a, b) => a.localeCompare(b))]
}

function readmeName(entries: string[]): string | undefined {
  return entries
    .filter(name => /^readme.*\.md$/i.test(name))
    .sort((a, b) => {
      if (a.toLowerCase() === 'readme.md') return -1
      if (b.toLowerCase() === 'readme.md') return 1
      return a.localeCompare(b)
    })[0]
}

/** The first README*.md at the root or one level down, at most 3000 characters. */
function readmeOf(treeDir: string, directories: string[]): string {
  for (const directory of directories) {
    let entries: string[]
    try {
      entries = readdirSync(join(treeDir, directory))
    } catch {
      continue
    }
    const name = readmeName(entries)
    if (name !== undefined) {
      return readTextPrefix(join(treeDir, directory, name), README_CHARS * 4).slice(0, README_CHARS)
    }
  }
  return ''
}

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml']

/** `package.json` keeps its name and script names; the other manifests keep their first 20 lines. */
function manifestSummary(treeDir: string, file: string): ProfileManifest {
  const text = readTextPrefix(join(treeDir, file), 64 * 1024)
  if (file.endsWith('package.json')) {
    try {
      const value = JSON.parse(text) as { name?: unknown; scripts?: unknown }
      const name = typeof value.name === 'string' ? value.name : '(未命名)'
      const scripts = typeof value.scripts === 'object' && value.scripts !== null && !Array.isArray(value.scripts)
        ? Object.keys(value.scripts as Record<string, unknown>)
        : []
      const scriptText = scripts.length > 0 ? scripts.slice(0, 30).join(', ') : '无'
      return { file, summary: `name: ${name}；scripts: ${scriptText}` }
    } catch {
      return { file, summary: '无法解析 package.json' }
    }
  }
  const lines = text.split(/\r?\n/).slice(0, 20).join('\n').trim()
  return { file, summary: lines.slice(0, 1200) }
}

function gitInfo(treeDir: string): ProjectProfile['git'] {
  const gitDir = join(treeDir, '.git')
  let info
  try {
    info = lstatSync(gitDir)
  } catch {
    return undefined
  }
  // A worktree's `.git` is a file pointing elsewhere; reading outside the tree is not our business, so omit.
  if (!info.isDirectory()) return undefined

  let branch = ''
  const head = readTextPrefix(join(gitDir, 'HEAD'), 512).trim()
  if (head.startsWith('ref:')) branch = head.slice(4).trim().replace(/^refs\/heads\//, '')
  else if (head !== '') branch = head.slice(0, 12)

  const recent: ProfileGitCommit[] = []
  const log = readTextTail(join(gitDir, 'logs', 'HEAD'), 16 * 1024)
  for (const line of log.split(/\r?\n/).filter(value => value.trim() !== '').slice(-5)) {
    const tab = line.indexOf('\t')
    const message = tab >= 0 ? line.slice(tab + 1).trim() : ''
    const fields = (tab >= 0 ? line.slice(0, tab) : line).trim().split(/\s+/)
    const hash = fields[1] ?? ''
    recent.push({ hash7: hash.slice(0, 7), message: message.slice(0, 200) })
  }
  return { branch, recent }
}

function limitProfile(profile: ProjectProfile, maxBytes: number): ProjectProfile {
  const tooBig = (value: ProjectProfile): boolean => Buffer.byteLength(`${JSON.stringify(value)}\n`) > maxBytes
  if (!tooBig(profile)) return profile
  const trimmed: ProjectProfile = {
    ...profile,
    topLevel: profile.topLevel.slice(0, 40),
    readme: profile.readme.slice(0, 1500),
    manifests: profile.manifests.map(item => ({ file: item.file, summary: item.summary.slice(0, 500) })),
    ...(profile.git === undefined ? {} : { git: { ...profile.git, recent: profile.git.recent.slice(-3) } }),
  }
  if (!tooBig(trimmed)) return trimmed
  const minimal: ProjectProfile = {
    ...trimmed,
    topLevel: trimmed.topLevel.slice(0, 10),
    readme: trimmed.readme.slice(0, 400),
    manifests: trimmed.manifests.map(item => ({ file: item.file, summary: item.summary.slice(0, 200) })),
    ...(trimmed.git === undefined ? {} : { git: { ...trimmed.git, recent: [] } }),
  }
  return minimal
}

/**
 * Build the profile from an extracted `tree/` directory. Read-only: project files are opened as text and never run,
 * and no git command is executed.
 */
export function buildProfile(treeDir: string, options: BuildProfileOptions = {}): ProjectProfile {
  const { files, bytes, languages, topLevel } = walk(treeDir)
  let rootEntries: string[] = []
  try {
    rootEntries = readdirSync(treeDir)
  } catch {
    rootEntries = []
  }
  const directories = shallowDirectories(treeDir, rootEntries)
  const manifests: ProfileManifest[] = []
  for (const directory of directories) {
    if (manifests.length >= 5) break
    let entries: string[]
    try {
      entries = readdirSync(join(treeDir, directory))
    } catch {
      continue
    }
    for (const name of MANIFESTS) {
      if (manifests.length >= 5) break
      // Root manifests first, then one level down (monorepos keep them in `frontend/`, `backend/` and the like).
      if (!entries.includes(name)) continue
      manifests.push(manifestSummary(treeDir, directory === '' ? name : `${directory}/${name}`))
    }
  }
  const git = gitInfo(treeDir)
  const profile: ProjectProfile = {
    files,
    bytes,
    topLevel,
    languages: [...languages.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LANGUAGE_MAX)
      .map(([ext, count]) => ({ ext, files: count })),
    readme: readmeOf(treeDir, directories),
    manifests,
    ...(git === undefined ? {} : { git }),
  }
  return limitProfile(profile, options.maxBytes ?? PROFILE_MAX_BYTES)
}
