/**
 * `superagentd --config <path>`: start the runtime and stop it in order on SIGINT or SIGTERM.
 */
import { loadConfig } from './config.ts'
import { createRuntime } from './runtime.ts'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const configPath = option('--config') ?? process.env.SA_CONFIG_PATH ?? 'examples/config.local.json'

function applyEnvOverrides(config: ReturnType<typeof loadConfig>): ReturnType<typeof loadConfig> {
  const hostEnv = process.env.SA_ADMIN_HOST?.trim() || process.env.HOST?.trim()
  const portRaw = process.env.SA_ADMIN_PORT?.trim() || process.env.PORT?.trim()
  const parsedPort = portRaw !== undefined && portRaw !== '' ? Number(portRaw) : undefined
  const adminPort = parsedPort !== undefined && Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
    ? parsedPort
    : config.adminPort
  return {
    ...config,
    adminHost: hostEnv || config.adminHost,
    adminPort,
  }
}

try {
  const runtime = await createRuntime(applyEnvOverrides(loadConfig(configPath)))
  console.log(`superagentd ready: admin ${runtime.adminUrl}, control ${runtime.controlUrl}, state ${runtime.stateDir}`)
  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    console.log(`superagentd: ${signal}, stopping`)
    try {
      await runtime.stop(signal)
    } catch (error) {
      console.error(`superagentd: shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
} catch (error) {
  console.error(`superagentd: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
