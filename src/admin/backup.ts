/**
 * State backups: one consistent SQLite snapshot plus the small configuration files, packed into a `.tgz`.
 *
 * `VACUUM INTO` reads the database through the same connection the daemon uses, so the snapshot is consistent while the
 * daemon keeps running; no shutdown is needed. The archive never contains `cli-token` or the per-ticket `pi-config`
 * directories. Archives live in one directory, are mode 0600, and only the newest `keep` are retained.
 */
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/** One archive as the console lists it. */
export interface BackupItem {
  name: string
  /** Creation time of the archive, ISO 8601. */
  at: string
  bytes: number
}

export interface CreateBackupOptions {
  stateDir: string
  backupDir: string
  db: DatabaseSync
  /** Time source; injectable for tests. */
  now?: () => Date
  /** How many archives to keep after the new one is written. Default 7. */
  keep?: number
}

/** Archive names produced by {@link createBackup}; anything else in the directory is ignored. */
const NAME = /^state-\d{8}-\d{6}\.tgz$/
const DEFAULT_KEEP = 7
/** Only small JSON (and `vault.*`) files belong in a backup; the SQLite snapshot is the bulk. */
const MAX_COPIED_FILE = 1024 * 1024
const ALWAYS = ['options.json', 'settings.json', 'admin.json'] as const

const pad = (value: number): string => String(value).padStart(2, '0')

/** Local-time `YYYYMMDD-HHMMSS`, matching the archive name contract. */
function stamp(value: Date): string {
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}`
    + `-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`
}

/** Escape a path for a single-quoted SQLite string literal. */
const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1_000_000 }, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** Archives in `dir`, newest first. A missing directory is an empty list. */
export function listBackups(dir: string): BackupItem[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const items: BackupItem[] = []
  for (const name of names) {
    if (!NAME.test(name)) continue
    try {
      const info = statSync(join(dir, name))
      if (!info.isFile()) continue
      items.push({ name, at: info.mtime.toISOString(), bytes: info.size })
    } catch {
      // A file that vanished between readdir and stat is not a backup to report.
    }
  }
  return items.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0)
}

/**
 * Write one archive and prune old ones. The SQLite snapshot is made with `VACUUM INTO`; the configuration files are
 * copied only when they exist. Throws when `tar` fails or the snapshot cannot be written.
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupItem> {
  const now = options.now?.() ?? new Date()
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_KEEP))
  mkdirSync(options.backupDir, { recursive: true, mode: 0o700 })
  try { chmodSync(options.backupDir, 0o700) } catch { /* Windows and exotic filesystems */ }

  const staging = mkdtempSync(join(tmpdir(), 'sa-backup-'))
  try {
    try { chmodSync(staging, 0o700) } catch { /* best effort */ }

    options.db.exec(`VACUUM INTO ${sqlString(join(staging, 'state.sqlite'))}`)

    const names = new Set<string>(ALWAYS)
    let entries: string[] = []
    try { entries = readdirSync(options.stateDir) } catch { /* no state files yet */ }
    for (const name of entries) {
      if (name.endsWith('.json') || name.startsWith('vault.')) names.add(name)
    }
    // Never archive the CLI token (it is a live credential) or the per-ticket Pi configuration (large and rebuildable).
    names.delete('cli-token')
    for (const name of names) {
      const source = join(options.stateDir, name)
      try {
        const info = statSync(source)
        if (!info.isFile() || info.size > MAX_COPIED_FILE) continue
        const target = join(staging, name)
        copyFileSync(source, target)
        // The vault key and vault must stay private inside the archive as well; copyFile does not promise the mode.
        try { chmodSync(target, 0o600) } catch { /* Windows and exotic filesystems */ }
      } catch {
        // The file is optional.
      }
    }

    const name = `state-${stamp(now)}.tgz`
    const target = join(options.backupDir, name)
    // GNU tar reads `C:\...` as a remote host; on Windows it must be told the path is local. Debian paths need no flag.
    const forceLocal = process.platform === 'win32' ? ['--force-local'] : []
    await run('tar', [...forceLocal, '-czf', target, '-C', staging, '.'])
    try { chmodSync(target, 0o600) } catch { /* best effort */ }

    for (const old of listBackups(options.backupDir).slice(keep)) {
      try { rmSync(join(options.backupDir, old.name), { force: true }) } catch { /* keep the new backup */ }
    }

    return { name, at: now.toISOString(), bytes: statSync(target).size }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
