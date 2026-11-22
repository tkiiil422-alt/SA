/**
 * SSH connections for workers (the console's 连接 → SSH).
 *
 * A connection is a name, an address, a user and the host's key as `ssh-keyscan` saw it when it was registered. The
 * private key lives in the vault as `SSH_KEY_<NAME>` and is never handed to a worker as an environment variable: at
 * launch the runtime writes it to a one-off file under the ticket's Pi config (`ssh/keys/`), the container's entry script
 * loads it into ssh-agent and deletes it before Pi starts (see `deploy/pi-container.sh`). Measured on the host: a key
 * passed in the environment stays readable in `/proc/1/environ` even after `unset`, so files are the only safe path.
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SshConnection {
  /** Alias the worker types: `ssh <name>`. */
  name: string
  host: string
  port: number
  user: string
  /** `known_hosts` lines from `ssh-keyscan` at registration; a changed host key is refused. */
  knownHosts: string
}

export const SSH_NAME = /^[a-z][a-z0-9-]{0,31}$/
export const HOST_RE = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9a-fA-F:]{2,39}\]?$/
export const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/

/** The vault name of a connection's private key. */
export const keySecretName = (name: string): string => `SSH_KEY_${name.toUpperCase().replace(/-/g, '_')}`

/** Whether a value looks like an OpenSSH or PEM private key. */
export function looksLikeKey(value: string): boolean {
  return /-----BEGIN (OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----[\s\S]+-----END (OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----/.test(value.trim())
}

/** The `~/.ssh/config` block for each connection. */
export function sshConfigText(connections: readonly SshConnection[]): string {
  return connections.map(c => [
    `Host ${c.name}`,
    `  HostName ${c.host}`,
    `  Port ${c.port}`,
    `  User ${c.user}`,
    '  StrictHostKeyChecking yes',
    '  UserKnownHostsFile ~/.ssh/known_hosts',
    '  IdentitiesOnly no',
    '  ServerAliveInterval 30',
  ].join('\n')).join('\n\n') + '\n'
}

/** `known_hosts` lines, rewritten so a non-default port matches `[host]:port`. */
export function knownHostsText(connections: readonly SshConnection[]): string {
  const lines: string[] = []
  for (const c of connections) {
    for (const raw of c.knownHosts.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const parts = line.split(/\s+/)
      if (parts.length < 3) continue
      const hostField = c.port === 22 ? c.host : `[${c.host}]:${c.port}`
      lines.push(`${hostField} ${parts.slice(1).join(' ')}`)
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/**
 * Writes `<piConfig>/ssh/{config,known_hosts,keys/<name>}` for the container's entry script, or removes the directory
 * when no connection has a usable key. Returns the names that got a key.
 */
export function writeSshFiles(piConfig: string, connections: readonly SshConnection[], key: (name: string) => string | undefined): string[] {
  const dir = join(piConfig, 'ssh')
  rmSync(dir, { recursive: true, force: true })
  const usable = connections.filter(c => {
    const value = key(c.name)
    return value !== undefined && looksLikeKey(value)
  })
  if (usable.length === 0) return []
  mkdirSync(join(dir, 'keys'), { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  for (const c of usable) {
    const value = key(c.name)!.trim().replace(/\r\n/g, '\n')
    writeFileSync(join(dir, 'keys', c.name), `${value}\n`, { mode: 0o600 })
  }
  writeFileSync(join(dir, 'config'), sshConfigText(usable), { mode: 0o600 })
  writeFileSync(join(dir, 'known_hosts'), knownHostsText(usable), { mode: 0o600 })
  return usable.map(c => c.name)
}

/** Reads the host's public keys with `ssh-keyscan`; resolves to the lines, or rejects with a readable reason. */
export function scanHostKeys(host: string, port: number, timeoutSec = 8): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!HOST_RE.test(host)) { reject(new Error('地址不合法')); return }
    let out = ''
    let err = ''
    const child = spawn('ssh-keyscan', ['-T', String(timeoutSec), '-p', String(port), '-t', 'ed25519,ecdsa,rsa', '--', host], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
    child.on('error', e => reject(new Error(`运行 ssh-keyscan 失败：${e.message}`)))
    child.on('close', () => {
      const lines = out.split('\n').filter(l => l.trim() && !l.startsWith('#'))
      if (lines.length === 0) reject(new Error(`读不到 ${host}:${port} 的主机指纹${err.trim() ? `：${err.trim().split('\n').at(-1)}` : '（连不上或不是 SSH 服务）'}`))
      else resolve(lines.join('\n'))
    })
  })
}
