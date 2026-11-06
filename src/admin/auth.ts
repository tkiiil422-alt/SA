/**
 * Admin console authentication.
 *
 * One administrator password, stored only as a scrypt hash in `state/admin.json` (mode 0600). Sessions live in
 * memory (a restart logs everyone out) and slide forward on every successful verification. Login attempts are
 * rate limited per source IP and globally. Passwords never appear in logs or errors.
 */
import { randomInt, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AuthOptions {
  stateDir: string
  env?: NodeJS.ProcessEnv
  /** Current time in milliseconds; injectable for tests. */
  now?: () => number
}

interface ScryptParams {
  N: number
  r: number
  p: number
}

interface AdminRecord {
  salt: string
  hash: string
  params: ScryptParams
  generated: boolean
  updatedAt: string
}

interface FailureRecord {
  failures: number[]
  lockedUntil?: number
}

const SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 }
const KEY_LENGTH = 64
const SALT_BYTES = 16
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const SESSION_BYTES = 32
const LOCK_WINDOW_MS = 15 * 60 * 1000
const LOCK_DURATION_MS = 15 * 60 * 1000
const LOCK_AFTER_FAILURES = 5
const THROTTLE_WINDOW_MS = 60 * 1000
const THROTTLE_MAX_ATTEMPTS = 30
const MAX_TRACKED_IPS = 1000
const PASSWORD_LENGTH = 20
const MIN_NEW_PASSWORD_LENGTH = 10
const GENERATED_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'bad_password' | 'locked' | 'throttled'; retryAfterSec?: number }

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: 'bad_password' | 'too_short' }

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a)
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temporary file may not exist; report the original error instead.
    }
    throw error
  }
}

function generatePassword(): string {
  let password = ''
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    password += GENERATED_ALPHABET.charAt(randomInt(GENERATED_ALPHABET.length))
  }
  return password
}

/** Hash a password with scrypt. Accepts a hex salt so stored records stay JSON-friendly. */
function hashPassword(password: string, saltHex: string): Buffer {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH, SCRYPT_PARAMS)
}

function newSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex')
}

function retryAfterSeconds(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 1000))
}

export class AdminAuth {
  private readonly stateDir: string
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly adminFile: string
  private record: AdminRecord | undefined
  private generated = false
  private readonly sessions = new Map<string, number>()
  private readonly failures = new Map<string, FailureRecord>()
  private readonly attempts: number[] = []

  constructor(options: AuthOptions) {
    this.stateDir = options.stateDir
    this.env = options.env ?? process.env
    this.now = options.now ?? Date.now
    this.adminFile = join(options.stateDir, 'admin.json')
  }

  /** Load the stored hash or create one from `SA_ADMIN_PASSWORD` / a random password. */
  init(): { generated: boolean; plaintext?: string } {
    if (this.record) return { generated: false }

    let text: string | undefined
    try {
      text = readFileSync(this.adminFile, 'utf8')
    } catch (error) {
      if (!isEnoent(error)) {
        throw new Error(`无法读取管理员口令文件 ${this.adminFile}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (text !== undefined) {
      this.record = this.parseRecord(text)
      this.generated = this.record.generated
      return { generated: false }
    }

    mkdirSync(this.stateDir, { recursive: true })
    const fromEnv = this.env.SA_ADMIN_PASSWORD
    if (fromEnv !== undefined && fromEnv.length > 0) {
      this.persistPassword(fromEnv, false)
      return { generated: false }
    }

    const plaintext = generatePassword()
    this.persistPassword(plaintext, true)
    return { generated: true, plaintext }
  }

  get usingGeneratedPassword(): boolean {
    return this.generated
  }

  login(ip: string, password: string): LoginResult {
    const now = this.now()
    this.pruneSessions(now)

    const failure = this.failures.get(ip)
    if (failure?.lockedUntil !== undefined) {
      if (failure.lockedUntil > now) {
        return { ok: false, reason: 'locked', retryAfterSec: retryAfterSeconds(failure.lockedUntil, now) }
      }
      failure.lockedUntil = undefined
      failure.failures = []
    }

    this.pruneAttempts(now)
    if (this.attempts.length >= THROTTLE_MAX_ATTEMPTS) {
      const oldest = this.attempts[0]
      const until = oldest === undefined ? now + THROTTLE_WINDOW_MS : oldest + THROTTLE_WINDOW_MS
      return { ok: false, reason: 'throttled', retryAfterSec: retryAfterSeconds(until, now) }
    }
    this.attempts.push(now)

    if (!this.verifyPassword(password)) {
      const record = failure ?? { failures: [] }
      record.failures = record.failures.filter(at => now - at < LOCK_WINDOW_MS)
      record.failures.push(now)
      if (record.failures.length >= LOCK_AFTER_FAILURES) {
        record.lockedUntil = now + LOCK_DURATION_MS
      }
      this.trackFailure(ip, record)
      if (record.lockedUntil !== undefined) {
        return { ok: false, reason: 'locked', retryAfterSec: retryAfterSeconds(record.lockedUntil, now) }
      }
      return { ok: false, reason: 'bad_password' }
    }

    this.failures.delete(ip)
    const token = randomBytes(SESSION_BYTES).toString('base64url')
    this.sessions.set(token, now + SESSION_TTL_MS)
    return { ok: true, token }
  }

  /** Validate a session token and slide its expiry forward by another 12 hours. */
  verify(token: string | undefined): boolean {
    if (!token) return false
    const now = this.now()
    this.pruneSessions(now)
    const expiresAt = this.sessions.get(token)
    if (expiresAt === undefined || expiresAt <= now) {
      if (expiresAt !== undefined) this.sessions.delete(token)
      return false
    }
    this.sessions.set(token, now + SESSION_TTL_MS)
    return true
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token)
  }

  changePassword(oldPassword: string, newPassword: string): ChangePasswordResult {
    if (!this.verifyPassword(oldPassword)) return { ok: false, reason: 'bad_password' }
    if (newPassword.length < MIN_NEW_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' }
    this.persistPassword(newPassword, false)
    this.sessions.clear()
    this.failures.clear()
    return { ok: true }
  }

  private parseRecord(text: string): AdminRecord {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new Error(`无法解析管理员口令文件 ${this.adminFile}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const record = value as Partial<AdminRecord> | null
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.salt !== 'string' ||
      typeof record.hash !== 'string' ||
      record.salt.length === 0 ||
      record.hash.length === 0
    ) {
      throw new Error(`管理员口令文件 ${this.adminFile} 内容无效`)
    }
    return {
      salt: record.salt,
      hash: record.hash,
      params: record.params ?? SCRYPT_PARAMS,
      generated: record.generated === true,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    }
  }

  private persistPassword(password: string, generated: boolean): void {
    const salt = newSalt()
    const hash = hashPassword(password, salt).toString('hex')
    const record: AdminRecord = {
      salt,
      hash,
      params: SCRYPT_PARAMS,
      generated,
      updatedAt: new Date(this.now()).toISOString(),
    }
    writeFileAtomic(this.adminFile, `${JSON.stringify(record, null, 2)}\n`)
    this.record = record
    this.generated = generated
  }

  private verifyPassword(password: string): boolean {
    if (!this.record) {
      // Still pay the hashing cost so a missing record cannot be distinguished by timing.
      hashPassword(password, newSalt())
      return false
    }
    const actual = hashPassword(password, this.record.salt)
    const expected = Buffer.from(this.record.hash, 'hex')
    return constantTimeEqual(actual, expected)
  }

  private trackFailure(ip: string, record: FailureRecord): void {
    if (!this.failures.has(ip) && this.failures.size >= MAX_TRACKED_IPS) {
      const oldest = this.failures.keys().next().value
      if (oldest !== undefined) this.failures.delete(oldest)
    }
    this.failures.set(ip, record)
  }

  private pruneSessions(now: number): void {
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token)
    }
  }

  private pruneAttempts(now: number): void {
    while (this.attempts.length > 0) {
      const oldest = this.attempts[0]
      if (oldest === undefined || now - oldest < THROTTLE_WINDOW_MS) break
      this.attempts.shift()
    }
  }
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Resolve the client IP. `X-Forwarded-For` is only trusted when the connection itself came from a loopback
 * address (the Apache reverse proxy on the same host); otherwise the peer address is authoritative.
 */
export function clientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
  const remote = remoteAddress?.trim() ?? ''
  if (!LOOPBACK_ADDRESSES.has(remote.toLowerCase())) return remote
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? ''
  const segments = raw.split(',').map(segment => segment.trim()).filter(segment => segment.length > 0)
  const last = segments[segments.length - 1]
  return last === undefined ? remote : last
}

/** Generate a fresh CLI token and persist it to `${stateDir}/cli-token` (mode 0600). */
export function createCliToken(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true })
  const token = randomBytes(SESSION_BYTES).toString('base64url')
  writeFileSync(join(stateDir, 'cli-token'), token, { mode: 0o600 })
  return token
}

/** Check a `Bearer` header against the expected CLI token in constant time. */
export function checkCliToken(expected: string, header: string | undefined): boolean {
  if (!expected || !header) return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const provided = match?.[1]
  if (!provided) return false
  return constantTimeEqual(expected, provided)
}
