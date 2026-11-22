/**
 * Runtime configuration: a JSON file validated with zod.
 *
 * The upstream API key never appears in the file: only the name of the environment variable that holds it.
 * Policy settings are persisted with a stable (key-sorted) serialization, because the Policy version hashes the
 * settings' JSON text and must not change when the same object is written with a different key order.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { SettingsSchema, type Settings } from './policy.ts'

export const DEFAULT_LAUNCHER = { command: 'pi', args: ['--mode', 'rpc', '--no-approve'] } as const

export const LauncherSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
}).strict()
export type LauncherConfig = z.infer<typeof LauncherSchema>

export const ConfigFileSchema = z.object({
  stateDir: z.string().trim().min(1),
  maxSlots: z.number().int().min(1).max(64).default(3),
  /** Port of the admin console on 127.0.0.1; 0 picks a free port (tests). The public entry is the host's reverse proxy. */
  adminPort: z.number().int().min(0).max(65535).default(0),
  operatorId: z.string().trim().min(1).default('operator'),
  /** Name of the environment variable holding the real DeepSeek key; the key itself is never stored. */
  deepseekApiKeyEnv: z.string().trim().min(1).default('DEEPSEEK_API_KEY'),
  launcher: LauncherSchema.optional(),
  policy: SettingsSchema.optional(),
}).strict()
export type ConfigFile = z.infer<typeof ConfigFileSchema>

export interface Config {
  stateDir: string
  maxSlots: number
  adminPort: number
  operatorId: string
  deepseekApiKeyEnv: string
  launcher: LauncherConfig
  policy: Settings
}

/**
 * Serialize a JSON value with object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two equal settings objects built in a different order would hash
 * differently. Sorting makes the serialized form canonical.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${stableStringify(item)}`).join(',')}}`
}

/** Canonical text of the Policy settings, used when persisting them. */
export function serializeSettings(settings: Settings): string {
  return stableStringify(settings)
}

/** Parse persisted Policy settings. */
export function parseSettings(text: string): Settings {
  return SettingsSchema.parse(JSON.parse(text))
}

/** Persist Policy settings in canonical form. */
export function saveSettings(file: string, settings: Settings): void {
  writeFileSync(file, `${serializeSettings(settings)}\n`)
}

/** Load Policy settings from a canonical file. */
export function loadSettings(file: string): Settings {
  return parseSettings(readFileSync(file, 'utf8'))
}

/** Settings for a fresh installation: the CLI source admits the operator's direct requests. */
export function defaultSettings(operatorId: string): Settings {
  return SettingsSchema.parse({
    policy: { sources: { cli: { allowed: [{ id: operatorId, name: operatorId }] } } },
    eval: { mode: 'auto' },
  })
}

/** Validate a parsed JSON value as runtime configuration and fill defaults. */
export function parseConfig(value: unknown): Config {
  const parsed = ConfigFileSchema.parse(value)
  const policy = parsed.policy ?? defaultSettings(parsed.operatorId)
  // A supplied policy that says nothing about the CLI source would silently filter every `sa ask`; admit the operator.
  if (!policy.policy.sources.cli) {
    policy.policy.sources.cli = { allowed: [{ id: parsed.operatorId, name: parsed.operatorId }], admission: {} }
  }
  const launcher = parsed.launcher ?? { command: DEFAULT_LAUNCHER.command, args: [...DEFAULT_LAUNCHER.args] }
  return {
    stateDir: parsed.stateDir,
    maxSlots: parsed.maxSlots,
    adminPort: parsed.adminPort,
    operatorId: parsed.operatorId,
    deepseekApiKeyEnv: parsed.deepseekApiKeyEnv,
    launcher: { command: launcher.command, args: [...launcher.args], ...(launcher.env ? { env: { ...launcher.env } } : {}) },
    policy,
  }
}

/** Read and validate a configuration file. */
export function loadConfig(file: string): Config {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read config file ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return parseConfig(value)
  } catch (error) {
    throw new Error(`Invalid config file ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
