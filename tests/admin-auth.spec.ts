import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdminAuth, checkCliToken, clientIp, createCliToken } from '../src/admin/auth.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

interface Clock {
  now: number
}

function clockAt(now = 1_000_000): Clock {
  return { now }
}

function authFor(dir: string, env: NodeJS.ProcessEnv, clock: Clock): AdminAuth {
  return new AdminAuth({ stateDir: dir, env, now: () => clock.now })
}

const adminJson = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, 'admin.json'), 'utf8')) as Record<string, unknown>

const PASSWORD = 'correct-horse-battery'

describe('AdminAuth init', () => {
  it('uses SA_ADMIN_PASSWORD and persists only a hash', () => {
    const dir = tempDir()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clockAt())
    expect(auth.init()).toEqual({ generated: false })
    expect(auth.usingGeneratedPassword).toBe(false)

    const record = adminJson(dir)
    expect(record.generated).toBe(false)
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(record.hash).toMatch(/^[0-9a-f]{128}$/)
    expect(record.params).toEqual({ N: 16384, r: 8, p: 1 })
    expect(typeof record.updatedAt).toBe('string')
    expect(JSON.stringify(record)).not.toContain(PASSWORD)
  })

  it('generates a 20 character password without easily confused characters, returning it once', () => {
    const dir = tempDir()
    const auth = authFor(dir, {}, clockAt())
    const result = auth.init()
    expect(result.generated).toBe(true)
    const plaintext = result.plaintext
    expect(plaintext).toBeDefined()
    expect(plaintext).toHaveLength(20)
    expect(plaintext).toMatch(/^[A-Za-z0-9]+$/)
    expect(plaintext).not.toMatch(/[0O1lI]/)
    expect(auth.usingGeneratedPassword).toBe(true)
    expect(adminJson(dir).generated).toBe(true)
    expect(JSON.stringify(adminJson(dir))).not.toContain(plaintext as string)
    expect(auth.login('10.0.0.1', plaintext as string).ok).toBe(true)
    // A second init on the same instance does not mint another password.
    expect(auth.init()).toEqual({ generated: false })
  })

  it('reuses admin.json across restarts and keeps the generated flag', () => {
    const dir = tempDir()
    const clock = clockAt()
    const first = authFor(dir, {}, clock)
    const plaintext = first.init().plaintext as string

    const second = authFor(dir, {}, clock)
    expect(second.init()).toEqual({ generated: false })
    expect(second.usingGeneratedPassword).toBe(true)
    expect(second.login('10.0.0.2', plaintext).ok).toBe(true)
  })

  it('reuses an env-seeded admin.json across restarts', () => {
    const dir = tempDir()
    const clock = clockAt()
    authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock).init()
    const second = authFor(dir, { SA_ADMIN_PASSWORD: 'a-different-password' }, clock)
    expect(second.init()).toEqual({ generated: false })
    expect(second.usingGeneratedPassword).toBe(false)
    expect(second.login('10.0.0.3', PASSWORD).ok).toBe(true)
    expect(second.login('10.0.0.3', 'a-different-password')).toEqual({ ok: false, reason: 'bad_password' })
  })

  it('gives the stored hash priority over the environment', () => {
    const dir = tempDir()
    const clock = clockAt()
    authFor(dir, { SA_ADMIN_PASSWORD: 'stored-password' }, clock).init()
    const second = authFor(dir, { SA_ADMIN_PASSWORD: 'env-password' }, clock)
    second.init()
    expect(second.login('10.0.0.4', 'stored-password').ok).toBe(true)
    expect(second.login('10.0.0.4', 'env-password')).toEqual({ ok: false, reason: 'bad_password' })
  })

  it('creates the state directory and writes admin.json with mode 0600', () => {
    const dir = join(tempDir(), 'nested', 'state')
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clockAt())
    auth.init()
    const file = join(dir, 'admin.json')
    expect(existsSync(file)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })
})

describe('AdminAuth login', () => {
  it('accepts the right password and rejects the wrong or empty one', () => {
    const dir = tempDir()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clockAt())
    auth.init()
    expect(auth.login('10.1.0.1', 'wrong')).toEqual({ ok: false, reason: 'bad_password' })
    expect(auth.login('10.1.0.2', '')).toEqual({ ok: false, reason: 'bad_password' })
    const accepted = auth.login('10.1.0.3', PASSWORD)
    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('locks an IP after five failures within the window and unlocks after 15 minutes', () => {
    const dir = tempDir()
    const clock = clockAt()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock)
    auth.init()
    const ip = '10.2.0.1'
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(auth.login(ip, 'wrong')).toEqual({ ok: false, reason: 'bad_password' })
    }
    expect(auth.login(ip, 'wrong')).toEqual({ ok: false, reason: 'locked', retryAfterSec: 900 })

    // Correct passwords are refused while the lock is active.
    expect(auth.login(ip, PASSWORD)).toEqual({ ok: false, reason: 'locked', retryAfterSec: 900 })
    clock.now += 15 * 60 * 1000 - 1
    expect(auth.login(ip, PASSWORD)).toEqual({ ok: false, reason: 'locked', retryAfterSec: 1 })
    clock.now += 1
    expect(auth.login(ip, PASSWORD).ok).toBe(true)
  })

  it('does not lock when the failures are spread beyond the 15 minute window', () => {
    const dir = tempDir()
    const clock = clockAt()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock)
    auth.init()
    const ip = '10.2.0.2'
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(auth.login(ip, 'wrong')).toEqual({ ok: false, reason: 'bad_password' })
    }
    clock.now += 16 * 60 * 1000
    expect(auth.login(ip, 'wrong')).toEqual({ ok: false, reason: 'bad_password' })
  })

  it('throttles globally after 30 attempts in a minute', () => {
    const dir = tempDir()
    const clock = clockAt()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock)
    auth.init()
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const result = auth.login(`10.3.0.${attempt}`, 'wrong')
      expect(result).toEqual({ ok: false, reason: 'bad_password' })
    }
    const throttled = auth.login('10.3.1.1', PASSWORD)
    expect(throttled.ok).toBe(false)
    if (!throttled.ok) {
      expect(throttled.reason).toBe('throttled')
      expect(throttled.retryAfterSec).toBe(60)
    }
    clock.now += 60 * 1000
    expect(auth.login('10.3.1.1', PASSWORD).ok).toBe(true)
  })

  it('clears an IP failure count after a successful login', () => {
    const dir = tempDir()
    const clock = clockAt()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock)
    auth.init()
    const ip = '10.4.0.1'
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      auth.login(ip, 'wrong')
    }
    expect(auth.login(ip, PASSWORD).ok).toBe(true)
    // The next four failures start from zero, so the fifth overall does not lock.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(auth.login(ip, 'wrong')).toEqual({ ok: false, reason: 'bad_password' })
    }
  })
})

describe('AdminAuth sessions', () => {
  it('slides the 12 hour expiry forward on every verification', () => {
    const dir = tempDir()
    const clock = clockAt()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock)
    auth.init()
    const result = auth.login('10.5.0.1', PASSWORD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { token } = result

    expect(auth.verify(token)).toBe(true)
    clock.now += 11 * 60 * 60 * 1000
    expect(auth.verify(token)).toBe(true)
    clock.now += 12 * 60 * 60 * 1000
    expect(auth.verify(token)).toBe(false)
    expect(auth.verify(token)).toBe(false)
  })

  it('expires a session that is never touched within 12 hours', () => {
    const dir = tempDir()
    const clock = clockAt()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock)
    auth.init()
    const result = auth.login('10.5.0.2', PASSWORD)
    if (!result.ok) throw new Error('login should have succeeded')
    clock.now += 12 * 60 * 60 * 1000 + 1
    expect(auth.verify(result.token)).toBe(false)
  })

  it('logs out and ignores undefined tokens', () => {
    const dir = tempDir()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clockAt())
    auth.init()
    const result = auth.login('10.5.0.3', PASSWORD)
    if (!result.ok) throw new Error('login should have succeeded')
    expect(auth.verify(result.token)).toBe(true)
    auth.logout(result.token)
    expect(auth.verify(result.token)).toBe(false)
    expect(() => auth.logout(undefined)).not.toThrow()
    expect(auth.verify(undefined)).toBe(false)
  })
})

describe('AdminAuth changePassword', () => {
  it('checks the old password and the minimum length', () => {
    const dir = tempDir()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clockAt())
    auth.init()
    expect(auth.changePassword('wrong', 'a-new-long-password')).toEqual({ ok: false, reason: 'bad_password' })
    expect(auth.changePassword(PASSWORD, '123456789')).toEqual({ ok: false, reason: 'too_short' })
    expect(auth.login('10.6.0.1', PASSWORD).ok).toBe(true)
  })

  it('changes the password, clears every session, and marks the password as no longer generated', () => {
    const dir = tempDir()
    const clock = clockAt()
    const auth = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock)
    auth.init()
    const before = auth.login('10.6.0.2', PASSWORD)
    if (!before.ok) throw new Error('login should have succeeded')

    const newPassword = 'a-brand-new-password'
    expect(auth.changePassword(PASSWORD, newPassword)).toEqual({ ok: true })
    expect(auth.verify(before.token)).toBe(false)
    expect(auth.usingGeneratedPassword).toBe(false)
    expect(adminJson(dir).generated).toBe(false)
    expect(auth.login('10.6.0.2', PASSWORD)).toEqual({ ok: false, reason: 'bad_password' })
    expect(auth.login('10.6.0.3', newPassword).ok).toBe(true)

    const restarted = authFor(dir, { SA_ADMIN_PASSWORD: PASSWORD }, clock)
    restarted.init()
    expect(restarted.login('10.6.0.4', newPassword).ok).toBe(true)
    expect(restarted.login('10.6.0.4', PASSWORD)).toEqual({ ok: false, reason: 'bad_password' })
  })

  it('drops the generated-password marker after a change', () => {
    const dir = tempDir()
    const auth = authFor(dir, {}, clockAt())
    const plaintext = auth.init().plaintext as string
    expect(auth.usingGeneratedPassword).toBe(true)
    expect(auth.changePassword(plaintext, 'the-new-password')).toEqual({ ok: true })
    expect(auth.usingGeneratedPassword).toBe(false)
    expect(adminJson(dir).generated).toBe(false)
  })
})

describe('clientIp', () => {
  it('uses the peer address when it is not a loopback address, ignoring X-Forwarded-For', () => {
    expect(clientIp('203.0.113.5', '1.1.1.1, 2.2.2.2')).toBe('203.0.113.5')
    expect(clientIp('203.0.113.5', undefined)).toBe('203.0.113.5')
  })

  it('trusts the last X-Forwarded-For segment for loopback peers', () => {
    expect(clientIp('127.0.0.1', '1.1.1.1, 2.2.2.2')).toBe('2.2.2.2')
    expect(clientIp('::1', '198.51.100.7')).toBe('198.51.100.7')
    expect(clientIp('::ffff:127.0.0.1', [' 10.0.0.1 , 10.0.0.9 '])).toBe('10.0.0.9')
  })

  it('falls back to the peer address when no usable forwarded header exists', () => {
    expect(clientIp('127.0.0.1', undefined)).toBe('127.0.0.1')
    expect(clientIp('127.0.0.1', '')).toBe('127.0.0.1')
    expect(clientIp(undefined, '1.1.1.1')).toBe('')
  })
})

describe('CLI token', () => {
  it('writes a 32 byte base64url token with mode 0600 and validates it', () => {
    const dir = tempDir()
    const token = createCliToken(dir)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(readFileSync(join(dir, 'cli-token'), 'utf8')).toBe(token)
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'cli-token')).mode & 0o777).toBe(0o600)
    }
    expect(checkCliToken(token, `Bearer ${token}`)).toBe(true)
    expect(checkCliToken(token, `bearer ${token}`)).toBe(true)
    expect(checkCliToken(token, 'Bearer wrong')).toBe(false)
    expect(checkCliToken(token, token)).toBe(false)
    expect(checkCliToken(token, undefined)).toBe(false)
    expect(checkCliToken('', `Bearer ${token}`)).toBe(false)
  })

  it('generates a different token on each call', () => {
    const dir = tempDir()
    expect(createCliToken(dir)).not.toBe(createCliToken(dir))
  })
})
