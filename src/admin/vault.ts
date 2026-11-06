/**
 * The secret vault: write-only values encrypted at rest, per-ticket grants, and AI requests.
 *
 * Everything lives in one JSON file (normally `state/vault.json`), written atomically with mode 0600. Each value is
 * encrypted with AES-256-GCM under a master key that comes from `SA_VAULT_KEY` (base64, 32 bytes) or from
 * `state/vault.key` (32 random bytes, created on first use). Values are only ever returned by `reveal`, which the
 * launch path and the redactor use internally; no public view or event carries a value.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The environment-variable shape every secret name must have. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

/** Exact names that would break the worker process if a secret overrode them. */
const RESERVED_EXACT = new Set(['PATH', 'HOME'])
/** Prefixes owned by the runtime, the Pi worker, or Node itself. */
const RESERVED_PREFIXES = ['PI_', 'SA_', 'NODE_']

export type SecretOrigin = 'operator' | 'ai'

export interface EncryptedValue {
  iv: string
  tag: string
  data: string
}

export interface SecretRecord {
  value: EncryptedValue
  description: string
  origin: SecretOrigin
  createdAt: string
  rotatedAt?: string
  lastUsedAt?: string
}

export interface SecretListItem {
  name: string
  description: string
  origin: SecretOrigin
  createdAt: string
  rotatedAt?: string
  lastUsedAt?: string
  grantedTickets: number
}

export interface SecretRequest {
  id: string
  ticketId: string
  name: string
  why: string
  at: string
  status: 'pending' | 'granted' | 'denied'
}

export interface VaultFile {
  version: 1
  secrets: Record<string, SecretRecord>
  grants: Record<string, string[]>
  requests: SecretRequest[]
}

export interface VaultEvent {
  kind: string
  level: 'info'
  text: string
  data?: Record<string, unknown>
}

export interface VaultOptions {
  /** Environment holding `SA_VAULT_KEY`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Master-key file; defaults to `vault.key` beside the vault file. */
  keyFile?: string
  now?: () => Date
  /** Receives `secret.*` events; the caller decides where they go. Never receives a value. */
  onEvent?: (event: VaultEvent) => void
}

export type VaultErrorCode = 'exists' | 'not_found' | 'invalid_name' | 'reserved_name' | 'invalid_value' | 'not_pending' | 'decrypt' | 'corrupt'

/** A vault failure with a stable code; messages are Chinese and never contain a stored value. */
export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

const MAX_VALUE = 8192

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Write `data` through a sibling temporary file, then rename it into place with mode 0600. */
function writeAtomic(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temporary file may not exist; the original error is the one worth reporting.
    }
    throw error
  }
}

/** The master key from the environment or the key file, creating the file on first use. */
function loadKey(keyFile: string, env: NodeJS.ProcessEnv): Buffer {
  const fromEnv = env.SA_VAULT_KEY?.trim()
  if (fromEnv !== undefined && fromEnv !== '') {
    const key = Buffer.from(fromEnv, 'base64')
    if (key.length !== 32) throw new Error('SA_VAULT_KEY 必须是 32 字节的 base64 编码主密钥。')
    return key
  }
  try {
    const key = readFileSync(keyFile)
    if (key.length !== 32) throw new Error('主密钥文件损坏：vault.key 必须是 32 字节。')
    return key
  } catch (error) {
    if (!isEnoent(error)) throw error
    const key = randomBytes(32)
    writeAtomic(keyFile, key)
    return key
  }
}

function encrypt(key: Buffer, plain: string): EncryptedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function decrypt(key: Buffer, value: EncryptedValue): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultError('decrypt', '无法解密密钥库：主密钥不匹配或数据已损坏。')
  }
}

function emptyFile(): VaultFile {
  return { version: 1, secrets: {}, grants: {}, requests: [] }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Load and shape-check the vault file; a missing file is an empty vault. */
function loadFile(file: string): VaultFile {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return emptyFile()
    throw new Error(`无法读取密钥库 ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new VaultError('corrupt', '无法解析密钥库文件，文件可能已损坏。')
  }
  if (!isObject(parsed) || !isObject(parsed.secrets) || !isObject(parsed.grants) || !Array.isArray(parsed.requests)) {
    throw new VaultError('corrupt', '密钥库文件结构不正确。')
  }
  return parsed as unknown as VaultFile
}

/** Whether a name would override an environment variable the worker needs. */
export function isReservedSecretName(name: string): boolean {
  return RESERVED_EXACT.has(name) || RESERVED_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** Validate a secret name; returns a Chinese reason, or undefined when it is acceptable. */
export function secretNameProblem(name: string): string | undefined {
  if (!SECRET_NAME.test(name)) return '名称只能是大写字母、数字和下划线，以字母开头，最长 64 位'
  if (isReservedSecretName(name)) return '这个名称是系统保留的环境变量，不能用作密钥名'
  return undefined
}

function validateName(name: string): void {
  const problem = secretNameProblem(name)
  if (problem === undefined) return
  throw new VaultError(isReservedSecretName(name) ? 'reserved_name' : 'invalid_name', problem)
}

function validateValue(value: string): void {
  if (value.length < 1) throw new VaultError('invalid_value', '密钥值不能为空')
  if (value.length > MAX_VALUE) throw new VaultError('invalid_value', `密钥值不能超过 ${MAX_VALUE} 个字符`)
}

/** Replace every occurrence of a stored value (length >= 6) with `***`, longest values first. */
export function redactValues(text: string, values: readonly string[]): string {
  if (text === '') return text
  const unique = [...new Set(values.filter(value => value.length >= 6))].sort((a, b) => b.length - a.length)
  let result = text
  for (const value of unique) {
    if (result.includes(value)) result = result.split(value).join('***')
  }
  return result
}

/**
 * Build the launch environment for granted names: one entry per name plus `SA_SECRET_NAMES`. Invalid, reserved and
 * missing names are skipped, so this can never override a runtime variable. Pure, for tests.
 */
export function secretLaunchEnv(
  names: readonly string[],
  reveal: (name: string) => string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {}
  const valid: string[] = []
  for (const name of names) {
    if (SECRET_NAME.test(name) && !isReservedSecretName(name)) {
      const value = reveal(name)
      if (value !== undefined) {
        env[name] = value
        valid.push(name)
      }
    }
  }
  if (valid.length > 0) env.SA_SECRET_NAMES = valid.join(',')
  return env
}

/** Encrypted secret storage with per-ticket grants and AI requests. */
export class Vault {
  private readonly file: string
  private readonly key: Buffer
  private readonly now: () => Date
  private readonly onEvent: VaultOptions['onEvent']
  private data: VaultFile
  /** Decrypted values, so the redactor does not pay for AES on every outbound line. */
  private readonly plain = new Map<string, string>()

  constructor(file: string, options: VaultOptions = {}) {
    this.file = file
    this.key = loadKey(options.keyFile ?? join(dirname(file), 'vault.key'), options.env ?? process.env)
    this.now = options.now ?? (() => new Date())
    this.onEvent = options.onEvent
    this.data = loadFile(file)
  }

  private emit(kind: string, text: string, data?: Record<string, unknown>): void {
    try {
      this.onEvent?.({ kind, level: 'info', text, ...(data === undefined ? {} : { data }) })
    } catch {
      // Recording an event must never fail the vault operation that already happened.
    }
  }

  private persist(): void {
    writeAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`)
  }

  /** Public list: metadata only, never a value. Sorted by name. */
  list(): SecretListItem[] {
    const counts = new Map<string, number>()
    for (const names of Object.values(this.data.grants)) {
      for (const name of new Set(names)) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return Object.keys(this.data.secrets).sort().map(name => {
      const record = this.data.secrets[name]!
      return {
        name,
        description: record.description,
        origin: record.origin,
        createdAt: record.createdAt,
        ...(record.rotatedAt === undefined ? {} : { rotatedAt: record.rotatedAt }),
        ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
        grantedTickets: counts.get(name) ?? 0,
      }
    })
  }

  has(name: string): boolean {
    return Object.hasOwn(this.data.secrets, name)
  }

  /** Add a secret. An existing name is refused, which is how an AI store cannot overwrite the operator's value. */
  create(name: string, value: string, description: string, origin: SecretOrigin): void {
    validateName(name)
    validateValue(value)
    if (this.has(name)) throw new VaultError('exists', '同名密钥已存在。')
    this.data.secrets[name] = {
      value: encrypt(this.key, value),
      description,
      origin,
      createdAt: this.now().toISOString(),
    }
    this.plain.set(name, value)
    this.persist()
    this.emit('secret.stored', `已保存密钥 ${name}`, { name })
  }

  /** Change a value (a rotation), the description, and/or who owns it. */
  update(name: string, patch: { value?: string; description?: string; origin?: SecretOrigin }): void {
    const record = this.data.secrets[name]
    if (!record) throw new VaultError('not_found', '找不到这个密钥。')
    let rotated = false
    if (patch.value !== undefined) {
      validateValue(patch.value)
      record.value = encrypt(this.key, patch.value)
      record.rotatedAt = this.now().toISOString()
      this.plain.set(name, patch.value)
      rotated = true
    }
    if (patch.description !== undefined) record.description = patch.description
    // The console owns the fixed integration secrets; rotating one through its page marks it operator-owned.
    if (patch.origin !== undefined) record.origin = patch.origin
    this.persist()
    if (rotated) this.emit('secret.rotated', `已轮换密钥 ${name}`, { name })
  }

  /** Delete a secret and revoke it from every ticket. */
  remove(name: string): void {
    if (!this.has(name)) throw new VaultError('not_found', '找不到这个密钥。')
    delete this.data.secrets[name]
    this.plain.delete(name)
    this.revokeAll(name)
    this.persist()
    this.emit('secret.deleted', `已删除密钥 ${name}`, { name })
  }

  /** The plaintext value. Internal: only the launch path and the redactor call this. */
  reveal(name: string): string {
    const record = this.data.secrets[name]
    if (!record) throw new VaultError('not_found', '找不到这个密钥。')
    const cached = this.plain.get(name)
    if (cached !== undefined) return cached
    const value = decrypt(this.key, record.value)
    this.plain.set(name, value)
    return value
  }

  /** Record that a ticket's container received the secret at `at`. */
  markUsed(name: string, at: string, ticketId?: string): void {
    const record = this.data.secrets[name]
    if (!record) return
    record.lastUsedAt = at
    this.persist()
    this.emit('secret.used', `使用了密钥 ${name}`, { name, ...(ticketId === undefined ? {} : { ticketId }) })
  }

  /** Names granted to one ticket, in grant order. */
  grants(ticketId: string): string[] {
    return [...(this.data.grants[ticketId] ?? [])]
  }

  /** Replace a ticket's grants. Every name must exist; an unknown one is a `not_found` error. */
  setGrants(ticketId: string, names: readonly string[]): string[] {
    const next: string[] = []
    for (const name of names) {
      if (!this.has(name)) throw new VaultError('not_found', `找不到密钥 ${name}。`)
      if (!next.includes(name)) next.push(name)
    }
    const before = new Set(this.data.grants[ticketId] ?? [])
    this.data.grants[ticketId] = next
    this.persist()
    for (const name of next) {
      if (!before.has(name)) this.emit('secret.granted', `已授权密钥 ${name}`, { name, ticketId })
    }
    return [...next]
  }

  /** Grant one secret to one ticket; idempotent. */
  grant(ticketId: string, name: string): void {
    if (!this.has(name)) throw new VaultError('not_found', '找不到这个密钥。')
    const current = this.data.grants[ticketId] ?? []
    if (current.includes(name)) return
    this.data.grants[ticketId] = [...current, name]
    this.persist()
    this.emit('secret.granted', `已授权密钥 ${name}`, { name, ticketId })
  }

  /** Remove one name from every ticket's grants. */
  revokeAll(name: string): void {
    let changed = false
    for (const [ticketId, names] of Object.entries(this.data.grants)) {
      if (!names.includes(name)) continue
      this.data.grants[ticketId] = names.filter(item => item !== name)
      changed = true
    }
    if (changed) this.persist()
  }

  /** AI requests, newest first. */
  requests(): SecretRequest[] {
    return [...this.data.requests]
      .map((request, index) => ({ request, index }))
      .sort((a, b) => b.request.at.localeCompare(a.request.at) || b.index - a.index)
      .map(item => ({ ...item.request }))
  }

  /** Record an AI request for a secret; it waits for the operator's decision. */
  addRequest(input: { ticketId: string; name: string; why: string }): SecretRequest {
    validateName(input.name)
    const request: SecretRequest = {
      id: `req_${randomBytes(9).toString('hex')}`,
      ticketId: input.ticketId,
      name: input.name,
      why: input.why,
      at: this.now().toISOString(),
      status: 'pending',
    }
    this.data.requests.push(request)
    this.persist()
    this.emit('secret.requested', `AI 请求密钥 ${request.name}`, { name: request.name, ticketId: request.ticketId })
    return { ...request }
  }

  /** Decide one pending request. Granting also grants the name to the requesting ticket. */
  decide(id: string, decision: 'grant' | 'deny'): SecretRequest {
    const request = this.data.requests.find(item => item.id === id)
    if (!request) throw new VaultError('not_found', '找不到这条密钥请求。')
    if (request.status !== 'pending') throw new VaultError('not_pending', '这条密钥请求已经处理过了。')
    if (decision === 'grant') {
      request.status = 'granted'
      if (this.has(request.name)) this.grant(request.ticketId, request.name)
    } else {
      request.status = 'denied'
    }
    this.persist()
    if (decision === 'deny') {
      this.emit('secret.denied', `已拒绝密钥 ${request.name}`, { name: request.name, ticketId: request.ticketId })
    }
    return { ...request }
  }

  /** Replace every stored value (length >= 6) in `text` with `***`. */
  redactSecrets(text: string): string {
    if (text === '') return text
    const values: string[] = []
    for (const name of Object.keys(this.data.secrets)) {
      try {
        values.push(this.reveal(name))
      } catch {
        // A value that cannot be decrypted cannot leak; skip it rather than fail an outbound message.
      }
    }
    return redactValues(text, values)
  }

  /** The environment a ticket's launch receives: granted values plus `SA_SECRET_NAMES`. */
  launchEnv(ticketId: string): { env: Record<string, string>; names: string[] } {
    const names: string[] = []
    const env = secretLaunchEnv(this.grants(ticketId), name => {
      try {
        const value = this.reveal(name)
        names.push(name)
        return value
      } catch {
        return undefined
      }
    })
    return { env, names }
  }
}
