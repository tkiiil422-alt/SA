/**
 * Pi version management for the worker image.
 *
 * Every ticket runs Pi inside `localhost/superagent-pi:<tag>`, and the Pi version is pinned inside that image. This
 * service answers three questions and does two things:
 *   - which image new tickets use (`executor.image`) and which Pi version it really carries (`pi --version` inside it);
 *   - which `superagent-pi` images exist on this machine;
 *   - what npm offers for the Pi package;
 *   - build an image for a chosen version (`podman build --build-arg PI_VERSION=…`), then check it starts and reports
 *     that version;
 *   - switch `executor.image` to a local image. Running tickets keep the container they started with; the next launch
 *     uses the new image, so switching back to the previous image is the rollback.
 */
import { spawn } from 'node:child_process'

export const PI_PACKAGE = '@earendil-works/pi-coding-agent'
export const PI_REPO = 'localhost/superagent-pi'
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/
const TAG_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/
const LOG_LINES = 400
const REGISTRY_TTL_MS = 10 * 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
const PROBE_TIMEOUT_MS = 90_000
const LIST_TIMEOUT_MS = 15_000
const RELEASES_SHOWN = 12

export interface RunResult { code: number; out: string }
/** Runs a command to completion; never rejects. `onLine` receives stdout and stderr line by line. */
export type Runner = (file: string, args: string[], opts: { timeoutMs: number; onLine?: (line: string) => void }) => Promise<RunResult>

export const defaultRunner: Runner = (file, args, { timeoutMs, onLine }) => new Promise(resolve => {
  let out = ''
  let pending = ''
  let settled = false
  const finish = (result: RunResult): void => { if (!settled) { settled = true; resolve(result) } }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    finish({ code: 127, out: error instanceof Error ? error.message : String(error) })
    return
  }
  const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
  const feed = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    if (out.length < 2_000_000) out += text
    if (!onLine) return
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) onLine(line)
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', feed)
  child.on('error', error => { clearTimeout(timer); finish({ code: 127, out: `${out}${error.message}` }) })
  child.on('close', code => {
    clearTimeout(timer)
    if (onLine && pending.trim()) onLine(pending)
    finish({ code: code ?? 1, out })
  })
})

/** Compares two versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string] => {
    const [core = '', pre = ''] = v.split('-', 2)
    return [core.split('.').map(n => Number(n) || 0), pre]
  }
  const [ac, ap] = split(a)
  const [bc, bp] = split(b)
  for (let i = 0; i < 3; i++) {
    const d = (ac[i] ?? 0) - (bc[i] ?? 0)
    if (d !== 0) return d
  }
  if (ap === bp) return 0
  if (!ap) return 1
  if (!bp) return -1
  return ap < bp ? -1 : 1
}

export const isPiVersion = (v: string): boolean => VERSION_RE.test(v)

/** The version `pi --version` printed: the last version-looking token in its output. */
export function parsePiVersion(out: string): string | undefined {
  const found = out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g)
  return found?.at(-1)
}

export interface PiImageView { image: string; tag: string; id: string; createdAt: string; size: string; version?: string; current: boolean }
export interface PiJobView { version: string; image: string; state: 'running' | 'done' | 'failed'; startedAt: string; endedAt?: string; log: string[]; error?: string }
export interface PiReleaseView { version: string; publishedAt?: string }
export interface PiStatusView {
  /** The image new tickets start with. */
  image: string
  /** Pi version inside that image, from `pi --version`. */
  version?: string
  versionError?: string
  images: PiImageView[]
  imagesError?: string
  package: string
  latest?: string
  latestPublishedAt?: string
  checkedAt?: string
  registryError?: string
  /** Newest stable releases, newest first. */
  releases: PiReleaseView[]
  /** Set to `latest` when it is newer than the version in use. */
  upgrade?: string
  job?: PiJobView
}

export class PiVersionError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export interface PiVersionDeps {
  getImage(): string
  setImage(image: string): void
  /** `deploy/Containerfile.pi` and its build context directory. */
  containerfile: string
  context: string
  /** The collaboration extension (`deploy/pi-ext/collab.ts`); a new image must load it before the build counts. */
  extension?: string
  run?: Runner
  fetch?: typeof fetch
  now?: () => Date
  note?: (level: 'info' | 'warn' | 'error', text: string, data?: Record<string, unknown>) => void
  repo?: string
  pkg?: string
  registry?: string
}

interface RegistryInfo { latest?: string; latestPublishedAt?: string; releases: PiReleaseView[]; all: Set<string>; checkedAt: string; at: number; error?: string }

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)
const lastLines = (out: string, n = 3): string => out.trim().split(/\r?\n/).slice(-n).join(' ').slice(0, 300)

export class PiVersionService {
  private readonly run: Runner
  private readonly fetcher: typeof fetch
  private readonly now: () => Date
  private readonly repo: string
  private readonly pkg: string
  private readonly registryUrl: string
  /** Image id → Pi version; an image id never changes its contents. */
  private readonly versions = new Map<string, string>()
  private registry: RegistryInfo | undefined
  private job: PiJobView | undefined

  constructor(private readonly deps: PiVersionDeps) {
    this.run = deps.run ?? defaultRunner
    this.fetcher = deps.fetch ?? fetch
    this.now = deps.now ?? (() => new Date())
    this.repo = deps.repo ?? PI_REPO
    this.pkg = deps.pkg ?? PI_PACKAGE
    this.registryUrl = (deps.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
  }

  /** Local `superagent-pi` images, newest first; `<none>` tags are skipped. */
  private async images(): Promise<{ items: Omit<PiImageView, 'current' | 'version'>[]; error?: string }> {
    const r = await this.run('podman', ['images', '--filter', `reference=${this.repo}`, '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}'], { timeoutMs: LIST_TIMEOUT_MS })
    if (r.code !== 0) return { items: [], error: `读不到本机镜像：${lastLines(r.out) || `podman 退出码 ${r.code}`}` }
    const items = r.out.split(/\r?\n/).map(line => line.split('\t')).filter(p => p.length >= 4 && !p[0]!.endsWith(':<none>') && p[0]!.startsWith(`${this.repo}:`))
      .map(([image = '', id = '', createdAt = '', size = '']) => ({ image, tag: image.slice(this.repo.length + 1), id, createdAt: createdAt.replace(/ \+0000 UTC$/, 'Z').replace(' ', 'T').replace(' ', ''), size }))
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { items }
  }

  /** `pi --version` inside an image, without network; cached by image id. */
  private async versionOf(image: string, id?: string): Promise<string> {
    if (id && this.versions.has(id)) return this.versions.get(id)!
    const r = await this.run('podman', ['run', '--rm', '--network=none', '--pull=never', image, 'pi', '--version'], { timeoutMs: PROBE_TIMEOUT_MS })
    const version = r.code === 0 ? parsePiVersion(r.out) : undefined
    if (!version) throw new PiVersionError(`镜像 ${image} 跑不起来 Pi：${lastLines(r.out) || `退出码 ${r.code}`}`)
    if (id) this.versions.set(id, version)
    return version
  }

  private async registryInfo(force: boolean): Promise<RegistryInfo> {
    const cached = this.registry
    if (cached && !force && Date.now() - cached.at < REGISTRY_TTL_MS) return cached
    const checkedAt = this.now().toISOString()
    try {
      const response = await this.fetcher(`${this.registryUrl}/${this.pkg.replace('/', '%2f')}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`npm 返回 ${response.status}`)
      const doc = await response.json() as { 'dist-tags'?: Record<string, string>; versions?: Record<string, unknown>; time?: Record<string, string> }
      const all = new Set(Object.keys(doc.versions ?? {}).filter(isPiVersion))
      const time = doc.time ?? {}
      const latest = doc['dist-tags']?.latest
      const releases = [...all].filter(v => !v.includes('-')).sort((a, b) => compareVersions(b, a)).slice(0, RELEASES_SHOWN)
        .map(version => ({ version, ...(time[version] ? { publishedAt: time[version] } : {}) }))
      this.registry = { ...(latest ? { latest } : {}), ...(latest && time[latest] ? { latestPublishedAt: time[latest] } : {}), releases, all, checkedAt, at: Date.now() }
    } catch (error) {
      // Keep what an earlier check found; say why this one failed.
      this.registry = { ...(cached ?? { releases: [], all: new Set<string>() }), checkedAt, at: Date.now(), error: `查不到 npm 上的版本：${describe(error)}` }
    }
    return this.registry
  }

  async status(force = false): Promise<PiStatusView> {
    const image = this.deps.getImage()
    const [list, reg] = await Promise.all([this.images(), this.registryInfo(force)])
    const versions = await Promise.all(list.items.map(item => this.versionOf(item.image, item.id).then(v => v, () => undefined)))
    const images: PiImageView[] = list.items.map((item, i) => ({ ...item, current: item.image === image, ...(versions[i] ? { version: versions[i] } : {}) }))
    const cur = images.find(item => item.current)
    let version: string | undefined
    let versionError: string | undefined
    if (cur) {
      version = cur.version
      if (!version) versionError = await this.versionOf(cur.image, cur.id).then(() => undefined, describe)
    } else if (!list.error) {
      versionError = `本机没有镜像 ${image}，新任务会启动失败。`
    }
    const upgrade = version && reg.latest && compareVersions(reg.latest, version) > 0 ? reg.latest : undefined
    return {
      image,
      ...(version ? { version } : {}),
      ...(versionError ? { versionError } : {}),
      images,
      ...(list.error ? { imagesError: list.error } : {}),
      package: this.pkg,
      ...(reg.latest ? { latest: reg.latest } : {}),
      ...(reg.latestPublishedAt ? { latestPublishedAt: reg.latestPublishedAt } : {}),
      checkedAt: reg.checkedAt,
      ...(reg.error ? { registryError: reg.error } : {}),
      releases: reg.releases,
      ...(upgrade ? { upgrade } : {}),
      ...(this.job ? { job: { ...this.job, log: [...this.job.log] } } : {}),
    }
  }

  /** Ask npm again now, instead of using the last answer. */
  check(): Promise<PiStatusView> {
    return this.status(true)
  }

  /** Starts building `<repo>:<version>` in the background; one build at a time. */
  async startBuild(version: string): Promise<PiJobView> {
    if (!isPiVersion(version)) throw new PiVersionError('版本号格式不对，应该像 1.5.2。')
    if (this.job?.state === 'running') throw new PiVersionError(`正在构建 ${this.job.version}，等它结束再试。`, 409)
    const reg = await this.registryInfo(false)
    if (reg.all.size > 0 && !reg.all.has(version)) throw new PiVersionError(`npm 上没有 ${this.pkg}@${version}。`)
    const image = `${this.repo}:${version}`
    if (image === this.deps.getImage()) throw new PiVersionError('这个版本的镜像正在使用，不能在原地重建。先切换到别的镜像再重建。')
    const job: PiJobView = { version, image, state: 'running', startedAt: this.now().toISOString(), log: [] }
    this.job = job
    this.deps.note?.('info', `开始构建 Pi ${version} 镜像`, { version, image })
    void this.build(job)
    return { ...job, log: [...job.log] }
  }

  private async build(job: PiJobView): Promise<void> {
    const push = (line: string): void => {
      job.log.push(line.slice(0, 500))
      if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES)
    }
    const fail = (error: string): void => {
      job.state = 'failed'
      job.error = error
      job.endedAt = this.now().toISOString()
      push(`× ${error}`)
      this.deps.note?.('error', `Pi ${job.version} 镜像构建失败：${error}`, { version: job.version, image: job.image })
    }
    try {
      push(`$ podman build --build-arg PI_VERSION=${job.version} -t ${job.image}`)
      const r = await this.run('podman', ['build', '--build-arg', `PI_VERSION=${job.version}`, '-f', this.deps.containerfile, '-t', job.image, this.deps.context], { timeoutMs: BUILD_TIMEOUT_MS, onLine: push })
      if (r.code !== 0) { fail(`podman build 退出码 ${r.code}`); return }
      push('$ pi --version（在新镜像里试跑）')
      const list = await this.images()
      const id = list.items.find(item => item.image === job.image)?.id
      if (id) this.versions.delete(id)
      const got = await this.versionOf(job.image, id)
      if (got !== job.version) { fail(`新镜像里的 Pi 报告版本 ${got}，不是 ${job.version}`); return }
      push(`✓ 镜像能启动，Pi 版本 ${got}`)
      if (this.deps.extension) {
        // Pi prints the load error and still exits 0, so the output decides.
        push('$ 加载协作扩展（在新镜像里试跑）')
        const ext = await this.run('podman', [
          'run', '--rm', '--network=none', '--pull=never', '--userns=keep-id',
          '-v', `${this.deps.extension}:/ext/collab.ts:ro`,
          '-e', 'SA_COLLAB_CHECK=1', '-e', 'PI_OFFLINE=1', '-e', 'PI_CODING_AGENT_DIR=/tmp/pc',
          job.image, 'pi', '--no-session', '-e', '/ext/collab.ts', '--list-models',
        ], { timeoutMs: PROBE_TIMEOUT_MS })
        if (ext.code !== 0 || /Failed to load extension/i.test(ext.out)) {
          fail(`新镜像加载不了协作扩展：${lastLines(ext.out) || `退出码 ${ext.code}`}`)
          return
        }
        push('✓ 协作扩展能加载')
      }
      job.state = 'done'
      job.endedAt = this.now().toISOString()
      this.deps.note?.('info', `Pi ${job.version} 镜像构建完成`, { version: job.version, image: job.image })
    } catch (error) {
      fail(describe(error))
    }
  }

  /** Makes `image` the one new tickets start with, after checking it exists and runs Pi. */
  async apply(image: string): Promise<{ image: string; version: string; previous: string }> {
    const tag = image.startsWith(`${this.repo}:`) ? image.slice(this.repo.length + 1) : ''
    if (!TAG_RE.test(tag)) throw new PiVersionError(`只能切换到 ${this.repo}:<标签> 的镜像。`)
    if (this.job?.state === 'running' && this.job.image === image) throw new PiVersionError('这个镜像还在构建。', 409)
    const list = await this.images()
    if (list.error) throw new PiVersionError(list.error, 502)
    const found = list.items.find(item => item.image === image)
    if (!found) throw new PiVersionError(`本机没有镜像 ${image}。`, 404)
    const version = await this.versionOf(image, found.id)
    const previous = this.deps.getImage()
    if (previous !== image) {
      this.deps.setImage(image)
      this.deps.note?.('info', `新任务改用 Pi ${version}（${image}），之前是 ${previous}`, { image, version, previous })
    }
    return { image, version, previous }
  }

  /** Deletes a local image that is neither in use nor being built. */
  async remove(image: string): Promise<{ ok: true }> {
    if (!image.startsWith(`${this.repo}:`)) throw new PiVersionError(`只能删除 ${this.repo} 的镜像。`)
    if (image === this.deps.getImage()) throw new PiVersionError('正在使用的镜像不能删除。')
    if (this.job?.state === 'running' && this.job.image === image) throw new PiVersionError('这个镜像还在构建。', 409)
    const r = await this.run('podman', ['rmi', image], { timeoutMs: 60_000 })
    if (r.code !== 0) throw new PiVersionError(`删除失败：${lastLines(r.out) || `退出码 ${r.code}`}`, 502)
    this.deps.note?.('info', `删除了镜像 ${image}`, { image })
    return { ok: true }
  }
}
