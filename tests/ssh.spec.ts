/** SSH connections: the files the container's entry script reads, and SSH keys never reaching the environment. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { keySecretName, knownHostsText, looksLikeKey, sshConfigText, writeSshFiles, type SshConnection } from '../src/ssh/connections.ts'
import { secretLaunchEnv } from '../src/admin/vault.ts'

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'
const conn = (over: Partial<SshConnection> = {}): SshConnection => ({
  name: 'box', host: '192.168.31.66', port: 22, user: 'ghost', knownHosts: '192.168.31.66 ssh-ed25519 AAAAC3Nz', ...over,
})

describe('ssh connections', () => {
  it('names the vault secret after the connection and recognises private keys', () => {
    expect(keySecretName('my-box')).toBe('SSH_KEY_MY_BOX')
    expect(looksLikeKey(KEY)).toBe(true)
    expect(looksLikeKey('-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----')).toBe(true)
    expect(looksLikeKey('ssh-ed25519 AAAA public')).toBe(false)
  })

  it('writes an alias with strict host checking, and known_hosts with a non-default port', () => {
    expect(sshConfigText([conn()])).toContain('Host box\n  HostName 192.168.31.66\n  Port 22\n  User ghost\n  StrictHostKeyChecking yes')
    expect(knownHostsText([conn({ port: 2222 })])).toBe('[192.168.31.66]:2222 ssh-ed25519 AAAAC3Nz\n')
    expect(knownHostsText([conn({ knownHosts: '# comment\n\nbad' })])).toBe('')
  })

  it('writes keys only for connections with a usable key, private to the user, and clears old files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-ssh-'))
    try {
      const loaded = writeSshFiles(dir, [conn(), conn({ name: 'nokey' }), conn({ name: 'badkey' })],
        name => name === 'box' ? KEY : name === 'badkey' ? 'not a key' : undefined)
      expect(loaded).toEqual(['box'])
      expect(readFileSync(join(dir, 'ssh', 'keys', 'box'), 'utf8')).toBe(`${KEY}\n`)
      expect(existsSync(join(dir, 'ssh', 'keys', 'nokey'))).toBe(false)
      expect(readFileSync(join(dir, 'ssh', 'config'), 'utf8')).not.toContain('nokey')
      if (process.platform !== 'win32') expect(statSync(join(dir, 'ssh', 'keys', 'box')).mode & 0o077).toBe(0)
      // No usable key at all: the directory is gone, so the container starts Pi directly.
      expect(writeSshFiles(dir, [conn()], () => undefined)).toEqual([])
      expect(existsSync(join(dir, 'ssh'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never puts an SSH key into the launch environment, even when granted', () => {
    const env = secretLaunchEnv(['SSH_KEY_BOX', 'API_TOKEN'], name => name === 'API_TOKEN' ? 'value-123' : KEY)
    expect(env).toEqual({ API_TOKEN: 'value-123', SA_SECRET_NAMES: 'API_TOKEN' })
  })
})
