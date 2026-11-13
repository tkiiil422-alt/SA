/**
 * superagent collaboration extension for Pi: a `subagent` tool that lets a ticket's main worker hand a piece of work to
 * another model. On every launch the runtime copies this file to `<PI_CODING_AGENT_DIR>/extensions/sa-collab/index.ts`,
 * where Pi discovers it, and writes the role table next to it as `collab.json` (see `src/executor/collab.ts`).
 *
 * Each task runs one `pi -p --mode json` child with its own context window; only its final answer comes back.
 * Children start with `--no-mcp --no-extensions --no-approve`, so they never see superagent's worker tools, cannot
 * delegate again and ignore repo-local Pi files. Their ticket token carries a `.<role>` suffix: the gateway books the
 * calls on this ticket under that role, and the worker MCP endpoint refuses a suffixed token outright. Roles that may
 * not change files get none of the ticket's granted secrets. Roles that may change files run one at a time.
 *
 * The modes (single, parallel, chain with `{previous}`) follow Pi's `examples/extensions/subagent` (MIT).
 * Self-contained on purpose: no Pi imports, so a Pi upgrade can only break it through `registerTool` itself, which the
 * console's Pi version page checks after every image build (`SA_COLLAB_CHECK=1`).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export type Access = 'ask' | 'read' | 'shell' | 'write'
export interface CollabRole { id: string; name: string; description: string; access: Access; model: string; prompt: string }
export interface CollabConfig { version: number; mainModel: string; maxConcurrent: number; maxCalls: number; secretNames: string[]; roles: CollabRole[] }
export interface TaskSpec { agent: string; task: string }
export interface RunResult { role: string; name: string; model: string; ok: boolean; output: string; turns: number; ms: number }
interface TextPart { type: 'text'; text: string }
export interface ToolResult { content: TextPart[]; details?: unknown; isError?: boolean }
type OnUpdate = (partial: ToolResult) => void
export interface SubagentParams { agent?: string; task?: string; tasks?: TaskSpec[]; chain?: TaskSpec[] }
export interface ToolDefinition {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute(toolCallId: string, params: SubagentParams, signal?: AbortSignal, onUpdate?: OnUpdate, ctx?: { cwd?: string }): Promise<ToolResult>
}
export interface ExtensionApi { registerTool(tool: ToolDefinition): void }

export const MAX_TASKS = 8
const OUTPUT_CAP = 50 * 1024
const RUN_TIMEOUT_MS = 20 * 60_000
/** The executor stops a worker after 30 silent minutes; a progress line every 20 s keeps a long delegation visible. */
const HEARTBEAT_MS = 20_000
const ACCESS: readonly Access[] = ['ask', 'read', 'shell', 'write']
const TOOLS: Record<Access, string[]> = {
  ask: [],
  read: ['read', 'grep', 'find', 'ls'],
  shell: ['read', 'grep', 'find', 'ls', 'bash'],
  write: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
}
const ACCESS_WORD: Record<Access, string> = { ask: '只回答', read: '只读', shell: '只读，可跑命令', write: '可改文件' }
const ACCESS_RULE: Record<Access, string> = {
  ask: '你没有任何工具，只依据任务说明里给出的内容回答。',
  read: '你只能读文件和搜索，不能修改、创建或删除任何文件。',
  shell: '你可以读文件和运行命令，但只运行查看类命令（git diff、git log、测试、类型检查），不要修改、创建或删除文件，不要安装依赖。',
  write: '你可以修改文件，但只改任务里点名的文件和范围，不做额外重构。做完列出改了哪些文件、每处改了什么、跑了什么验证以及结果。',
}

/** Where a sub-agent is. Progress updates carry the sub-agents as `details.agents` (role, name, model, state) and the
 * final result as `details.results`, so the console can show which model is working right now. */
type AgentState = 'queued' | 'running' | 'done' | 'failed'
const STATE_WORD: Record<AgentState, string> = { queued: '排队', running: '进行中', done: '完成', failed: '失败' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const configDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
const text = (value: string): TextPart[] => [{ type: 'text', text: value }]

/** `collab.json` from the Pi config directory; malformed roles are dropped, a missing or broken file is undefined. */
export function readConfig(dir: string = configDir()): CollabConfig | undefined {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(join(dir, 'collab.json'), 'utf8')) } catch { return undefined }
  if (!isRecord(raw) || !Array.isArray(raw.roles)) return undefined
  const roles: CollabRole[] = []
  for (const item of raw.roles) {
    if (!isRecord(item)) continue
    const { id, name, description, access, model, prompt } = item
    if (typeof id !== 'string' || typeof name !== 'string' || typeof model !== 'string' || !ACCESS.includes(access as Access)) continue
    roles.push({ id, name, description: typeof description === 'string' ? description : '', access: access as Access, model, prompt: typeof prompt === 'string' ? prompt : '' })
  }
  const num = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
  return {
    version: 1,
    mainModel: typeof raw.mainModel === 'string' ? raw.mainModel : '',
    maxConcurrent: Math.min(8, num(raw.maxConcurrent, 2)),
    maxCalls: num(raw.maxCalls, 20),
    secretNames: Array.isArray(raw.secretNames) ? raw.secretNames.filter((n): n is string => typeof n === 'string') : [],
    roles,
  }
}

/** The command line of one child run. Everything after `--` is the message, so a task can never be read as a flag. */
export function childArgs(role: CollabRole, task: string, promptFile: string | undefined): string[] {
  const args = ['--mode', 'json', '-p', '--no-session', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve', '--offline', '--model', role.model]
  const tools = TOOLS[role.access]
  if (tools.length === 0) args.push('--no-tools')
  else args.push('--tools', tools.join(','))
  if (promptFile !== undefined) args.push('--append-system-prompt', promptFile)
  args.push('--', `任务：${task}`)
  return args
}

/** The child's environment: the role-suffixed token, no MCP or preview wiring, and secrets only for roles that write. */
export function childEnv(base: NodeJS.ProcessEnv, role: CollabRole, config: CollabConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const token = (base.SA_TICKET_TOKEN ?? '').split('.')[0] ?? ''
  if (token) env.SA_TICKET_TOKEN = `${token}.${role.id}`
  env.SA_AGENT = role.id
  delete env.SA_MCP_URL
  delete env.SA_PREVIEW_PORTS
  if (role.access !== 'write') for (const name of config.secretNames) delete env[name]
  return env
}

export function systemPrompt(role: CollabRole): string {
  return [
    `你是 superagent 任务里的子代理，角色是「${role.name}」。主 AI 把下面这项工作交给你；你看不到它和用户的对话，只能依据任务说明和工作区里的文件。`,
    ACCESS_RULE[role.access],
    role.prompt.trim(),
    '完成后用中文给出最终结论。你的最后一条回复会原样交回主 AI，所以要完整、具体、可以直接使用。',
  ].filter(Boolean).join('\n\n')
}

/** What the main worker reads about the tool: the modes, the limits and every role. */
export function toolDescription(config: CollabConfig): string {
  return [
    '把一项具体工作交给另一个模型（子代理）去做。它有独立的上下文，做完只把结论交回给你。',
    '用法三选一：单个 {agent, task}；并行 {tasks: [{agent, task}, …]}（最多 8 个）；串联 {chain: [{agent, task}, …]}，task 里的 {previous} 会换成上一步的结论。',
    '子代理看不到你的对话：task 要写成自包含的说明，写清目标、相关文件路径、要交回什么。',
    `这张任务最多调用 ${config.maxCalls} 次，同时最多跑 ${config.maxConcurrent} 个；能改文件的角色一次只跑一个。`,
    '建议：大范围找代码先派侦察；交付前改过代码就派审查看一遍；难题或要第二意见时问顾问；边界清楚的机械改动交给帮手。',
    '可用角色：',
    ...config.roles.map(role => `- ${role.id}（${role.name}，${ACCESS_WORD[role.access]}）：${role.description}`),
  ].join('\n')
}

/** Counts calls per ticket in the Pi config directory, which outlives one Pi process. */
export function takeCalls(dir: string, count: number, max: number): { ok: boolean; used: number } {
  const file = join(dir, 'collab-usage.json')
  let used = 0
  try { used = Number((JSON.parse(readFileSync(file, 'utf8')) as { calls?: unknown }).calls) || 0 } catch { /* first call */ }
  if (used + count > max) return { ok: false, used }
  try { writeFileSync(file, JSON.stringify({ calls: used + count })) } catch { /* counting is best effort */ }
  return { ok: true, used: used + count }
}

class Gate {
  private active = 0
  private readonly waiting: (() => void)[] = []
  constructor(public limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve))
    this.active += 1
    try { return await work() } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

function piCommand(args: string[]): { command: string; args: string[] } {
  const script = process.env.SA_COLLAB_PI_SCRIPT
  if (script) return { command: process.execPath, args: [script, ...args] }
  const current = process.argv[1]
  if (current && !current.startsWith('/$bunfs/') && existsSync(current)) return { command: process.execPath, args: [current, ...args] }
  return { command: 'pi', args }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isRecord).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => String(part.text)).join('\n').trim()
}

function cap(output: string): string {
  if (Buffer.byteLength(output, 'utf8') <= OUTPUT_CAP) return output
  let cut = output.slice(0, OUTPUT_CAP)
  while (Buffer.byteLength(cut, 'utf8') > OUTPUT_CAP) cut = cut.slice(0, -200)
  return `${cut}\n\n［后面还有内容，已截断］`
}

const budgetHint = (output: string): string =>
  /\b402\b|budget/i.test(output) ? `${output}\n（这张任务的预算已用完：不要再派子代理，直接汇报现状。）` : output

/** Runs one role on one task as a child Pi process; never rejects. */
export function runRole(role: CollabRole, task: string, config: CollabConfig, opts: { cwd: string; signal?: AbortSignal; onProgress?: (note: string) => void }): Promise<RunResult> {
  const started = Date.now()
  const result: RunResult = { role: role.id, name: role.name, model: role.model, ok: false, output: '', turns: 0, ms: 0 }
  if (opts.signal?.aborted) return Promise.resolve({ ...result, output: '已取消' })
  const dir = mkdtempSync(join(tmpdir(), 'sa-collab-'))
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, systemPrompt(role), { mode: 0o600 })
  const { command, args } = piCommand(childArgs(role, task, promptFile))
  return new Promise<RunResult>(resolve => {
    let buffer = ''
    let stderr = ''
    let last = ''
    let stopReason: string | undefined
    let errorMessage: string | undefined
    let cause: string | undefined
    let done = false
    let killTimer: NodeJS.Timeout | undefined
    const proc = spawn(command, args, { cwd: opts.cwd, env: childEnv(process.env, role, config), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const kill = (why: string): void => {
      if (cause === undefined) cause = why
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => { proc.kill('SIGKILL') }, 5000)
    }
    const timeout = setTimeout(() => kill(`超过 ${RUN_TIMEOUT_MS / 60_000} 分钟没做完，已停止`), RUN_TIMEOUT_MS)
    const onAbort = (): void => kill('已取消')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const onLine = (raw: string): void => {
      if (!raw.trim()) return
      let event: unknown
      try { event = JSON.parse(raw) } catch { return }
      if (!isRecord(event)) return
      if (event.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant') {
        const message = event.message
        result.turns += 1
        const said = textOf(message.content)
        if (said) last = said
        if (typeof message.stopReason === 'string') stopReason = message.stopReason
        if (typeof message.errorMessage === 'string') errorMessage = message.errorMessage
        opts.onProgress?.(`第 ${result.turns} 轮`)
      } else if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
        opts.onProgress?.(event.toolName)
      }
    }
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    })
    proc.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 20_000) stderr += chunk.toString('utf8') })
    const finish = (code: number | null, spawnError?: Error): void => {
      if (done) return
      done = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (buffer.trim()) onLine(buffer)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp file */ }
      result.ms = Date.now() - started
      const failed = spawnError !== undefined || cause !== undefined || code !== 0 || stopReason === 'error' || stopReason === 'aborted'
      result.ok = !failed
      const stderrTail = stderr.trim().split('\n').slice(-5).join('\n')
      result.output = failed
        ? (spawnError?.message ?? cause ?? errorMessage ?? (stderrTail || last || `子进程退出码 ${code}`))
        : (last || '（没有输出）')
      resolve(result)
    }
    proc.on('error', error => finish(1, error))
    proc.on('close', code => finish(code))
  })
}

const head = (r: RunResult): string => `【${r.name}｜${r.model}｜${r.turns} 轮｜${Math.round(r.ms / 1000)} 秒${r.ok ? '' : '｜失败'}】`
const summary = (results: RunResult[]): unknown => ({ results: results.map(({ output: _output, ...rest }) => rest) })

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    agent: { type: 'string', description: '角色 id' },
    task: { type: 'string', description: '自包含的任务说明' },
  },
  required: ['agent', 'task'],
}
// Extra keys a model adds (cwd, agentScope from Pi's example) are ignored rather than refused.
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    agent: { type: 'string', description: '单个模式：角色 id' },
    task: { type: 'string', description: '单个模式：自包含的任务说明' },
    tasks: { type: 'array', items: TASK_SCHEMA, maxItems: MAX_TASKS, description: '并行模式：同时派出的子任务' },
    chain: { type: 'array', items: TASK_SCHEMA, maxItems: MAX_TASKS, description: '串联模式：按顺序执行，task 里的 {previous} 换成上一步的结论' },
  },
}

export function createCollabTool(config: CollabConfig): ToolDefinition {
  const gate = new Gate(Math.max(1, config.maxConcurrent))
  const writeLock = new Gate(1)
  return {
    name: 'subagent',
    label: '协作',
    description: toolDescription(config),
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cfg = readConfig() ?? config
      gate.limit = Math.max(1, cfg.maxConcurrent)
      const failure = (message: string): ToolResult => ({ content: text(message), isError: true })
      const given = Number(Boolean(params.chain?.length)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.agent || params.task))
      if (given !== 1) return failure('参数不对：单个用 {agent, task}，并行用 {tasks: […]}，串联用 {chain: […]}，三种只能选一种。')
      const mode = params.chain?.length ? 'chain' : params.tasks?.length ? 'parallel' : 'single'
      const specs: TaskSpec[] = mode === 'chain' ? params.chain! : mode === 'parallel' ? params.tasks! : [{ agent: params.agent ?? '', task: params.task ?? '' }]
      if (specs.length > MAX_TASKS) return failure(`一次最多 ${MAX_TASKS} 个子任务。`)
      const roles: CollabRole[] = []
      for (const spec of specs) {
        const role = cfg.roles.find(item => item.id === spec.agent)
        if (!role) return failure(`没有角色「${spec.agent}」。可用的角色：${cfg.roles.map(item => `${item.id}（${item.name}）`).join('、') || '无'}`)
        if (typeof spec.task !== 'string' || !spec.task.trim()) return failure(`给「${role.name}」的 task 是空的，要写清让它做什么。`)
        roles.push(role)
      }
      const quota = takeCalls(configDir(), specs.length, cfg.maxCalls)
      if (!quota.ok) return failure(`这张任务的子代理调用次数已用完（上限 ${cfg.maxCalls} 次，已用 ${quota.used} 次）。请自己接着完成。`)

      const status = roles.map(role => ({ role: role.id, name: role.name, model: role.model, state: 'queued' as AgentState, note: '' }))
      const t0 = Date.now()
      let lastEmit = 0
      // State changes always report; a child's step-by-step progress at most every 2 s, so the step log stays readable.
      const emit = (force = true): void => {
        if (!onUpdate) return
        const now = Date.now()
        if (!force && now - lastEmit < 2000) return
        lastEmit = now
        const line = status.map(s => `${s.name}：${STATE_WORD[s.state]}${s.note ? `（${s.note}）` : ''}`).join('；')
        const agents = status.map(s => ({ role: s.role, name: s.name, model: s.model, state: s.state }))
        onUpdate({ content: text(`${line}，已 ${Math.round((now - t0) / 1000)} 秒`), details: { mode, agents } })
      }
      const beat = setInterval(() => emit(true), HEARTBEAT_MS)
      const cwd = ctx?.cwd || process.cwd()
      const runAt = (index: number, task: string): Promise<RunResult> => {
        const role = roles[index]!
        const row = status[index]!
        const go = async (): Promise<RunResult> => {
          row.state = 'running'
          emit()
          const r = await runRole(role, task, cfg, { cwd, ...(signal ? { signal } : {}), onProgress: note => { row.note = note; emit(false) } })
          row.state = r.ok ? 'done' : 'failed'
          row.note = ''
          emit()
          return r
        }
        return role.access === 'write' ? writeLock.run(() => gate.run(go)) : gate.run(go)
      }
      try {
        if (mode === 'chain') {
          const results: RunResult[] = []
          let previous = ''
          for (let index = 0; index < specs.length; index += 1) {
            const r = await runAt(index, specs[index]!.task.split('{previous}').join(previous))
            results.push(r)
            if (!r.ok) return { content: text(`串联在第 ${index + 1} 步（${r.name}）停下：${budgetHint(r.output)}`), details: summary(results), isError: true }
            previous = r.output
          }
          return { content: text(`${results.map(head).join(' → ')}\n\n${cap(previous)}`), details: summary(results) }
        }
        const results = await Promise.all(specs.map((spec, index) => runAt(index, spec.task)))
        if (mode === 'single') {
          const r = results[0]!
          return { content: text(`${head(r)}\n${cap(r.ok ? r.output : budgetHint(r.output))}`), details: summary(results), ...(r.ok ? {} : { isError: true }) }
        }
        const ok = results.filter(r => r.ok).length
        const body = results.map((r, index) => `### ${index + 1}. ${head(r)}\n${cap(r.ok ? r.output : budgetHint(r.output))}`).join('\n\n---\n\n')
        return { content: text(`并行 ${results.length} 个，成功 ${ok} 个。\n\n${body}`), details: summary(results), ...(ok === 0 ? { isError: true } : {}) }
      } finally {
        clearInterval(beat)
      }
    },
  }
}

export default function register(pi: ExtensionApi): void {
  // A child never delegates again; `--no-extensions` already keeps this file out of it.
  if (process.env.SA_AGENT) return
  const config = readConfig()
    ?? (process.env.SA_COLLAB_CHECK ? { version: 1, mainModel: '', maxConcurrent: 1, maxCalls: 1, secretNames: [], roles: [] } : undefined)
  if (config === undefined) return
  pi.registerTool(createCollabTool(config))
}
