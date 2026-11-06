/**
 * Pi configuration for one ticket: one `models.json` provider per enabled AI provider (keyed `sa-<id>`, so it never
 * collides with Pi's built-in catalog), and the launch arguments that pick the ticket's model.
 *
 * Pure functions only; the runtime writes the result. Workers never see a real key: `apiKey` is the ticket token.
 */
import type { ModelRef, Provider } from '../admin/options.ts'

export interface PiModelEntry {
  id: string
  name: string
  reasoning: boolean
  input: ('text' | 'image')[]
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: Record<string, string | null>
}

export interface PiProviderConfig {
  baseUrl: string
  api: Provider['api']
  apiKey: string
  models: PiModelEntry[]
}

/** Raised when a requested model is not an enabled, existing model. Mapped to a 400 on field `model`. */
export class InvalidModelError extends Error {
  readonly status = 400
  readonly issues: { path: string; message: string }[]

  constructor(message = '这个模型没有启用或不存在，请重新选择。') {
    super(message)
    this.name = 'InvalidModelError'
    this.issues = [{ path: 'model', message }]
  }
}

/** The Pi provider id used for a superagent provider. */
export const piProviderId = (providerId: string): string => `sa-${providerId}`

/** The `providers` map of a ticket's models.json; disabled providers are omitted. */
export function buildPiModels(providers: readonly Provider[], gatewayUrl: string): Record<string, PiProviderConfig> {
  const out: Record<string, PiProviderConfig> = {}
  for (const provider of providers) {
    if (!provider.enabled) continue
    out[piProviderId(provider.id)] = {
      baseUrl: `${gatewayUrl}/p/${provider.id}`,
      api: provider.api,
      apiKey: '${SA_TICKET_TOKEN}',
      models: provider.models.map(model => ({
        id: model.id,
        name: model.label || model.id,
        reasoning: model.reasoning,
        input: model.vision ? ['text', 'image'] : ['text'],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      })),
    }
  }
  return out
}

/**
 * The launcher's argument list: every `--provider X` / `--model X` (or `=` form) pair is removed from the base args,
 * then the ticket's provider and model are appended; `--continue` is added on resume, as before.
 */
export function launchArgs(baseArgs: readonly string[], ref: ModelRef, resume: boolean): string[] {
  const kept: string[] = []
  for (let index = 0; index < baseArgs.length; index += 1) {
    const arg = baseArgs[index]!
    if (arg === '--provider' || arg === '--model') {
      index += 1
      continue
    }
    if (arg.startsWith('--provider=') || arg.startsWith('--model=')) continue
    kept.push(arg)
  }
  kept.push('--provider', piProviderId(ref.provider), '--model', ref.model)
  if (resume && !kept.includes('--continue')) kept.push('--continue')
  return kept
}
