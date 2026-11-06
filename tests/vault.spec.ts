/**
 * The secret vault: encrypted at rest, write-only in public views, with per-ticket grants and AI requests.
 */
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Vault,
  VaultError,
  redactValues,
  secretLaunchEnv,
  secretNameProblem,
} from '../src/admin/vault.ts'
import type { VaultEvent } from '../src/admin/vault.ts'
import { Effects } from '../src/effects/effects.ts'
import { Outbox } from '../src/outbox/outbox.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-vault-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function vaultAt(dir: string, events: VaultEvent[] = []): Vault {
  return new Vault(join(dir, 'vault.json'), {
    env: {},
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    onEvent: event => { events.push(event) },
  })
}

describe('vault', () => {
  it('encrypts values at rest and returns metadata only from list()', () => {
    const dir = tempDir()
    const vault = vaultAt(dir)

    vault.create('API_TOKEN', 'super-secret-value', 'for the API', 'operator')

    expect(vault.reveal('API_TOKEN')).toBe('super-secret-value')
    expect(vault.list()).toEqual([{
      name: 'API_TOKEN',
      description: 'for the API',
      origin: 'operator',
      createdAt: '2026-01-02T03:04:05.000Z',
      grantedTickets: 0,
    }])

    const raw = readFileSync(join(dir, 'vault.json'), 'utf8')
    expect(raw).not.toContain('super-secret-value')
    expect(raw).toContain('API_TOKEN')
    expect(statSync(join(dir, 'vault.key')).size).toBe(32)
  })

  it('fails cleanly with a different master key', () => {
    const dir = tempDir()
    vaultAt(dir).create('API_TOKEN', 'super-secret-value', '', 'operator')

    const wrong = randomBytes(32).toString('base64')
    const reopened = new Vault(join(dir, 'vault.json'), { env: { SA_VAULT_KEY: wrong } })

    let message = ''
    try {
      reopened.reveal('API_TOKEN')
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError)
      message = (error as Error).message
    }
    expect(message).toContain('无法解密')
    expect(message).not.toContain('super-secret-value')
  })

  it('uses SA_VAULT_KEY instead of the key file when it is set', () => {
    const dir = tempDir()
    const key = randomBytes(32).toString('base64')
    const first = new Vault(join(dir, 'vault.json'), { env: { SA_VAULT_KEY: key } })
    first.create('API_TOKEN', 'value-123', '', 'operator')
    expect(existsSync(join(dir, 'vault.key'))).toBe(false)

    const second = new Vault(join(dir, 'vault.json'), { env: { SA_VAULT_KEY: key } })
    expect(second.reveal('API_TOKEN')).toBe('value-123')
  })

  it('validates names, including reserved environment variables', () => {
    const vault = vaultAt(tempDir())
    for (const name of ['api_token', '1TOKEN', 'A-B', '', 'A'.repeat(65)]) {
      expect(() => vault.create(name, 'value', '', 'operator'), name).toThrow(VaultError)
    }
    for (const name of ['PATH', 'HOME', 'PI_CODING_AGENT_DIR', 'SA_TICKET_TOKEN', 'NODE_OPTIONS']) {
      expect(secretNameProblem(name), name).toContain('保留')
      expect(() => vault.create(name, 'value', '', 'operator'), name).toThrow(VaultError)
    }
    expect(secretNameProblem('API_TOKEN')).toBeUndefined()
  })

  it('rejects a value outside 1..8192 characters', () => {
    const vault = vaultAt(tempDir())
    expect(() => vault.create('EMPTY', '', '', 'operator')).toThrow(VaultError)
    expect(() => vault.create('HUGE', 'x'.repeat(8193), '', 'operator')).toThrow(VaultError)
  })

  it('lets an AI store add a name but never overwrite an existing one', () => {
    const dir = tempDir()
    const events: VaultEvent[] = []
    const vault = vaultAt(dir, events)

    vault.create('API_TOKEN', 'operator-value', '', 'operator')
    expect(() => vault.create('API_TOKEN', 'ai-value', '', 'ai')).toThrow(VaultError)
    expect(vault.reveal('API_TOKEN')).toBe('operator-value')

    vault.create('AI_TOKEN', 'ai-value', '', 'ai')
    expect(vault.list().find(item => item.name === 'AI_TOKEN')?.origin).toBe('ai')
    expect(events.map(event => event.kind)).toEqual(['secret.stored', 'secret.stored'])
    expect(JSON.stringify(events)).not.toContain('operator-value')
    expect(JSON.stringify(events)).not.toContain('ai-value')
  })

  it('rotates a value and keeps the old one out of the file', () => {
    const dir = tempDir()
    const events: VaultEvent[] = []
    const vault = vaultAt(dir, events)
    vault.create('API_TOKEN', 'old-value', '', 'operator')
    vault.update('API_TOKEN', { value: 'new-value', description: 'rotated' })

    expect(vault.reveal('API_TOKEN')).toBe('new-value')
    expect(vault.list()[0]).toMatchObject({ description: 'rotated', rotatedAt: '2026-01-02T03:04:05.000Z' })
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).not.toContain('new-value')
    expect(events.map(event => event.kind)).toContain('secret.rotated')
  })

  it('turns an AI request into a grant for the requesting ticket', () => {
    const events: VaultEvent[] = []
    const vault = vaultAt(tempDir(), events)
    vault.create('DEPLOY_KEY', 'value-123', '', 'operator')

    const request = vault.addRequest({ ticketId: 't1', name: 'DEPLOY_KEY', why: 'deploy the fix' })
    expect(vault.requests()[0]).toMatchObject({ id: request.id, ticketId: 't1', status: 'pending' })
    expect(events.map(event => event.kind)).toContain('secret.requested')

    vault.decide(request.id, 'grant')
    expect(vault.requests()[0]?.status).toBe('granted')
    expect(vault.grants('t1')).toEqual(['DEPLOY_KEY'])
    expect(vault.list()[0]?.grantedTickets).toBe(1)
  })

  it('denies a request without granting it', () => {
    const events: VaultEvent[] = []
    const vault = vaultAt(tempDir(), events)
    vault.create('DEPLOY_KEY', 'value-123', '', 'operator')
    const request = vault.addRequest({ ticketId: 't1', name: 'DEPLOY_KEY', why: 'deploy' })

    vault.decide(request.id, 'deny')

    expect(vault.requests()[0]?.status).toBe('denied')
    expect(vault.grants('t1')).toEqual([])
    expect(events.map(event => event.kind)).toContain('secret.denied')
    expect(() => vault.decide(request.id, 'grant')).toThrow(VaultError)
  })

  it('revokes every grant when a secret is deleted', () => {
    const vault = vaultAt(tempDir())
    vault.create('API_TOKEN', 'value-123', '', 'operator')
    vault.grant('t1', 'API_TOKEN')
    vault.grant('t2', 'API_TOKEN')

    vault.remove('API_TOKEN')

    expect(vault.has('API_TOKEN')).toBe(false)
    expect(vault.grants('t1')).toEqual([])
    expect(vault.grants('t2')).toEqual([])
    expect(vault.list()).toEqual([])
  })

  it('refuses to grant a name that does not exist', () => {
    const vault = vaultAt(tempDir())
    expect(() => vault.grant('t1', 'MISSING')).toThrow(VaultError)
    expect(() => vault.setGrants('t1', ['MISSING'])).toThrow(VaultError)
  })

  it('marks a secret used with the ticket id', () => {
    const events: VaultEvent[] = []
    const vault = vaultAt(tempDir(), events)
    vault.create('API_TOKEN', 'value-123', '', 'operator')
    vault.markUsed('API_TOKEN', '2026-02-03T00:00:00.000Z', 't1')

    expect(vault.list()[0]?.lastUsedAt).toBe('2026-02-03T00:00:00.000Z')
    expect(events.at(-1)).toMatchObject({ kind: 'secret.used', data: { name: 'API_TOKEN', ticketId: 't1' } })
  })

  it('redacts stored values of at least six characters', () => {
    const vault = vaultAt(tempDir())
    vault.create('API_TOKEN', 'super-secret-value', '', 'operator')
    vault.create('SHORT', 'abcde', '', 'operator')

    expect(vault.redactSecrets('token=super-secret-value short=abcde')).toBe('token=*** short=abcde')
    expect(redactValues('a super-secret-value and super-secret-value', ['super-secret-value'])).toBe('a *** and ***')
  })

  it('builds the launch environment from granted names only', () => {
    expect(secretLaunchEnv(['API_TOKEN', 'PATH', 'bad-name', 'MISSING'], name => name === 'API_TOKEN' ? 'value-123' : undefined))
      .toEqual({ API_TOKEN: 'value-123', SA_SECRET_NAMES: 'API_TOKEN' })
    expect(secretLaunchEnv([], () => undefined)).toEqual({})
  })

  it('puts granted secrets and SA_SECRET_NAMES in a ticket launch env', () => {
    const vault = vaultAt(tempDir())
    vault.create('API_TOKEN', 'value-123', '', 'operator')
    vault.create('OTHER', 'value-456', '', 'operator')
    vault.grant('t1', 'API_TOKEN')

    expect(vault.launchEnv('t1')).toEqual({ env: { API_TOKEN: 'value-123', SA_SECRET_NAMES: 'API_TOKEN' }, names: ['API_TOKEN'] })
  })
})

describe('outbound redaction', () => {
  it('stores a redacted message text in the outbox', () => {
    const db = new DatabaseSync(':memory:')
    const effects = new Effects(db)
    const outbox = new Outbox({ db, effects, redact: text => redactValues(text, ['super-secret-value']) })

    outbox.send({
      id: 'm1',
      channel: { source: 'cli', thread: 'th', address: {} },
      text: 'the token is super-secret-value',
      kind: 'notice',
      ticketId: 't1',
    })

    expect(outbox.messagesForTicket('t1')[0]?.text).toBe('the token is ***')
    db.close()
  })
})
