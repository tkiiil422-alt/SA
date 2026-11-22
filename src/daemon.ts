/**
 * `superagentd --config <path>`: start the runtime and stop it in order on SIGINT or SIGTERM.
 */
import { loadConfig } from './config.ts'
import { createRuntime } from './runtime.ts'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const configPath = option('--config')
if (!configPath) {
  console.error('Usage: superagentd --config <path>')
  process.exit(1)
}

try {
  const runtime = await createRuntime(loadConfig(configPath))
  console.log(`superagentd ready: control ${runtime.controlUrl}, state ${runtime.stateDir}`)
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
