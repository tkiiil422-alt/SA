/**
 * The development environment of worker containers (the console's 开发环境 page).
 *
 * Workers run in `localhost/superagent-pi:<tag>`, which is built on top of `localhost/superagent-dev:<tag>`
 * (`deploy/Containerfile.dev`: Python, Node, compilers, database clients, ssh, patch). A worker cannot install system
 * packages (read-only root, not root), so extra Debian packages and optional parts (browser, database servers, Go, Java)
 * are added here: build the dev image, self-test it offline in a read-only container, rebuild the Pi image on top of it
 * with the Pi version in use, check the Pi extensions load, then switch new tickets to it (`apply`). Running tickets
 * keep their container; switching back to the previous image is the rollback.
 *
 * What a build used is kept as labels on the image (`io.superagent.dev.*`, `io.superagent.base`), so the page can show
 * the current packages, repack an existing dev image with a newer Pi version in ~20s without re-downloading gigabytes
 * of toolchains, and the Pi version page can automatically inherit the current dev base when upgrading Pi.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultRunner, parsePiVersion, PI_REPO, type Runner } from './pi-versions.ts'

export const DEV_REPO = 'localhost/superagent-dev'
export const DEV_FEATURES = ['browser', 'dbserver', 'go', 'java'] as const
export type DevFeature = (typeof DEV_FEATURES)[number]
const PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]{0,63}$/
const DEV_TAG_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/
const MAX_PACKAGES = 60
const LOG_LINES = 600
const BUILD_TIMEOUT_MS = 60 * 60_000
const PROBE_TIMEOUT_MS = 120_000
const LIST_TIMEOUT_MS = 15_000

export interface DevBuildInput { packages?: unknown; features?: unknown; mirrors?: unknown }
export interface DevJobView {
  tag: string
  devImage: string
  piImage: string
  piVersion?: string
  packages: string[]
  features: DevFeature[]
  mirrors: boolean
  /** `repack` reuses an existing local dev image and only layers the current Pi version on top. */
  mode?: 'build' | 'repack'
  state: 'running' | 'done' | 'failed'
  startedAt: string
  endedAt?: string
  log: string[]
  error?: string
}
export interface DevImageView {
  image: string
  tag: string
  id: string
  createdAt: string
  size: string
  packages: string[]
  features: string[]
}
export const SHARED_CACHE_BUCKETS = [
  { id: 'npm', label: 'npm 缓存', desc: 'Node.js npm 包下载缓存' },
  { id: 'pnpm-store', label: 'pnpm 存储', desc: 'pnpm 内容寻址全局包仓库' },
  { id: 'yarn', label: 'Yarn 缓存', desc: 'Yarn 离线包缓存' },
  { id: 'bun', label: 'Bun 缓存', desc: 'Bun 安装包缓存' },
  { id: 'pip', label: 'pip 缓存', desc: 'Python wheel 与源码包缓存' },
  { id: 'uv', label: 'uv 缓存', desc: 'uv 极速 Python 依赖缓存' },
  { id: 'go-mod', label: 'Go 模块缓存', desc: 'GOMODCACHE 下载模块缓存' },
  { id: 'go-build', label: 'Go 编译缓存', desc: 'GOCACHE 增量编译缓存' },
  { id: 'cargo', label: 'Cargo 缓存', desc: 'Rust crates 与索引缓存' },
  { id: 'huggingface', label: 'HF 模型缓存', desc: 'HuggingFace 模型与数据集缓存' },
  { id: 'playwright', label: 'Playwright 缓存', desc: '浏览器二进制缓存' },
] as const

export type SharedCacheBucketId = (typeof SHARED_CACHE_BUCKETS)[number]['id']

export interface SharedCacheBucketView {
  id: SharedCacheBucketId
  label: string
  desc: string
  bytes: number
  files: number
  exists: boolean
}

export interface SharedEnvView {
  enabled: boolean
  mirrorsEnabled: boolean
  cacheDir: string
  toolsDir: string
  totalCacheBytes: number
  totalToolsBytes: number
  buckets: SharedCacheBucketView[]
  tools: string[]
}

export interface DevStatusView {
  /** The image new tickets start with. */
  image: string
  /** The dev image it was built on, and what that build added; absent for an image built without one. */
  base?: string
  packages: string[]
  features: string[]
  devImages: DevImageView[]
  /** Suggested local dev image to reuse when the active Pi image has no dev base (e.g. after a bare Pi upgrade). */
  recommendedDev?: DevImageView
  imagesError?: string
  available: { features: readonly DevFeature[] }
  shared?: SharedEnvView
  job?: DevJobView
}

export class DevEnvError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export interface DevEnvDeps {
  getImage(): string
  setImage(image: string): void
  devContainerfile: string
  piContainerfile: string
  context: string
  /** Pi extensions a new image must load (collab.ts, web.ts). */
  extensions: string[]
  run?: Runner
  now?: () => Date
  note?: (level: 'info' | 'warn' | 'error', text: string, data?: Record<string, unknown>) => void
  /** Override host shared cache directory (default: SA_CACHE_ROOT or ~/superagent-cache). */
  cacheDir?: string
  /** Override host shared global tools directory (default: SA_TOOLS_ROOT or ~/superagent-tools). */
  toolsDir?: string
}

/** Offline self-test of a dev image, in a container shaped like a worker's (read-only root, tmpfs HOME, keep-id). */
export function selfTestScript(features: readonly string[]): string {
  const lines = [
    'set -e',
    'cd /tmp',
    `printf '#include <stdio.h>\\nint main(void){puts("gcc ok");return 0;}\\n' > a.c && gcc a.c -o a && ./a`,
    'python3 -m venv v && v/bin/pip --version >/dev/null && echo "python venv ok"',
    'UV_PYTHON_DOWNLOADS=never uv venv -q uvv && echo "uv ok"',
    `node -e 'console.log("node ok")'`,
    'pnpm --version >/dev/null && echo "pnpm ok"',
    'tsx --version >/dev/null && echo "tsx ok"',
    'touch "$HOME/.probe" && echo "home writable"',
    'for c in curl wget jq zip unzip make patch sqlite3 psql mysql redis-cli ssh ssh-agent rsync git rg; do command -v "$c" >/dev/null || { echo "missing $c"; exit 1; }; done',
    'echo "tools ok"',
  ]
  if (features.includes('go')) lines.push('go version')
  if (features.includes('java')) lines.push('javac -version 2>&1 && mvn -v >/dev/null && echo "maven ok"')
  if (features.includes('browser')) lines.push('ls /opt/playwright | grep -q chromium && echo "chromium ok"')
  if (features.includes('dbserver')) lines.push('ls /usr/lib/postgresql/*/bin/postgres >/dev/null && command -v redis-server >/dev/null && echo "db servers ok"')
  lines.push('echo SELFTEST_PASSED')
  return lines.join('\n')
}

/** Checks and normalizes what the page asked for. */
export function parseBuildInput(input: DevBuildInput): { packages: string[]; features: DevFeature[]; mirrors: boolean } {
  const rawPackages = input.packages === undefined ? [] : input.packages
  if (!Array.isArray(rawPackages)) throw new DevEnvError('packages 要是包名列表。')
  const packages = [...new Set(rawPackages.map(item => String(item).trim().toLowerCase()).filter(Boolean))]
  if (packages.length > MAX_PACKAGES) throw new DevEnvError(`额外系统包最多 ${MAX_PACKAGES} 个。`)
  const bad = packages.filter(name => !PACKAGE_RE.test(name))
  if (bad.length > 0) throw new DevEnvError(`这些不是合法的 Debian 包名：${bad.join('、')}`)
  const rawFeatures = input.features === undefined ? [] : input.features
  if (!Array.isArray(rawFeatures)) throw new DevEnvError('features 要是列表。')
  const features = [...new Set(rawFeatures.map(String))]
  const unknown = features.filter(item => !(DEV_FEATURES as readonly string[]).includes(item))
  if (unknown.length > 0) throw new DevEnvError(`没有这些可选项：${unknown.join('、')}`)
  return { packages: packages.sort(), features: features as DevFeature[], mirrors: input.mirrors !== false }
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)
const lastLines = (out: string, n = 3): string => out.trim().split(/\r?\n/).slice(-n).join(' ').slice(0, 300)
const words = (value: unknown): string[] => typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []

/** Pick the best local dev image to recommend (prefer non-probe images that carry features/packages, then newest). */
export function pickRecommendedDev(devImages: readonly DevImageView[]): DevImageView | undefined {
  const nonProbe = devImages.filter(i => i.tag !== 'probe')
  const candidates = nonProbe.length > 0 ? nonProbe : [...devImages]
  const rich = candidates.find(i => i.features.length > 0 || i.packages.length > 0)
  return rich ?? candidates[0]
}

const VALID_BUCKET_SET = new Set<string>(SHARED_CACHE_BUCKETS.map(b => b.id))

function dirStats(root: string, maxEntries = 8_000): { bytes: number; files: number; exists: boolean } {
  if (!existsSync(root)) return { bytes: 0, files: 0, exists: false }
  let bytes = 0
  let files = 0
  let visited = 0
  const stack = [root]
  while (stack.length > 0 && visited < maxEntries) {
    const dir = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (++visited > maxEntries) break
      const full = join(dir, name)
      try {
        const st = lstatSync(full)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) stack.push(full)
        else if (st.isFile()) { bytes += st.size; files += 1 }
      } catch { /* ignore unreadable entries */ }
    }
  }
  return { bytes, files, exists: true }
}

/** Pure inspection of shared worker cache & global tools directories on the host. */
export function inspectSharedEnv(cacheDir: string, toolsDir: string): SharedEnvView {
  const buckets: SharedCacheBucketView[] = SHARED_CACHE_BUCKETS.map(b => {
    const st = dirStats(join(cacheDir, b.id), 4_000)
    return { id: b.id, label: b.label, desc: b.desc, bytes: st.bytes, files: st.files, exists: st.exists }
  })
  const totalCacheBytes = buckets.reduce((acc, b) => acc + b.bytes, 0)
  const toolsStat = dirStats(toolsDir, 6_000)

  const binDirs = [
    join(toolsDir, 'bin'),
    join(toolsDir, 'npm', 'bin'),
    join(toolsDir, 'pnpm'),
    join(toolsDir, 'go', 'bin'),
  ]
  const toolNames = new Set<string>()
  for (const d of binDirs) {
    if (!existsSync(d)) continue
    try {
      for (const entry of readdirSync(d)) {
        if (!entry.startsWith('.') && toolNames.size < 60) toolNames.add(entry)
      }
    } catch { /* ignore */ }
  }

  return {
    enabled: process.env.SA_DEV_SHARED !== '0',
    mirrorsEnabled: process.env.SA_DEV_MIRRORS !== '0',
    cacheDir,
    toolsDir,
    totalCacheBytes,
    totalToolsBytes: toolsStat.bytes,
    buckets,
    tools: [...toolNames].sort(),
  }
}

/** Safely cleans one allowlisted shared cache bucket (or 'all' cache buckets). Never touches shared global tools. */
export function cleanSharedCache(cacheDir: string, bucket: string): { cleaned: string[]; freedBytes: number } {
  const targets: string[] = bucket === 'all'
    ? SHARED_CACHE_BUCKETS.map(b => b.id)
    : (VALID_BUCKET_SET.has(bucket) ? [bucket] : [])
  if (targets.length === 0) {
    throw new DevEnvError(`不允许清理缓存桶「${bucket}」，仅支持：all 或 ${SHARED_CACHE_BUCKETS.map(b => b.id).join('、')}。`, 400)
  }
  let freedBytes = 0
  const cleaned: string[] = []
  for (const id of targets) {
    const dir = join(cacheDir, id)
    const before = dirStats(dir, 6_000)
    if (before.exists) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      freedBytes += before.bytes
      cleaned.push(id)
    }
  }
  return { cleaned, freedBytes }
}

export class DevEnvService {
  private readonly run: Runner
  private readonly now: () => Date
  private readonly labelCache = new Map<string, Record<string, string>>()
  private job: DevJobView | undefined

  constructor(private readonly deps: DevEnvDeps) {
    this.run = deps.run ?? defaultRunner
    this.now = deps.now ?? (() => new Date())
  }

  /** Labels of a local image; empty when it cannot be read. Cached by image id when supplied. */
  async labels(image: string, id?: string): Promise<Record<string, string>> {
    if (id && this.labelCache.has(id)) return this.labelCache.get(id)!
    const r = await this.run('podman', ['image', 'inspect', '--format', '{{json .Labels}}', image], { timeoutMs: LIST_TIMEOUT_MS })
    if (r.code !== 0) return {}
    try {
      const parsed = JSON.parse(r.out.trim().split(/\r?\n/).at(-1) ?? '{}') as Record<string, unknown> | null
      const clean = Object.fromEntries(Object.entries(parsed ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      if (id) this.labelCache.set(id, clean)
      return clean
    } catch {
      return {}
    }
  }

  /** Local `superagent-dev` images with their packages & features labels, newest first. */
  async listDevImages(): Promise<{ items: DevImageView[]; error?: string }> {
    const list = await this.run(
      'podman',
      ['images', '--filter', `reference=${DEV_REPO}`, '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}'],
      { timeoutMs: LIST_TIMEOUT_MS },
    )
    if (list.code !== 0) {
      return { items: [], error: `读不到本机镜像：${lastLines(list.out) || `podman 退出码 ${list.code}`}` }
    }
    const raw = list.out.split(/\r?\n/)
      .map(line => line.split('\t'))
      .filter(p => p.length >= 4 && p[0]!.startsWith(`${DEV_REPO}:`) && !p[0]!.endsWith(':<none>'))
      .map(([img = '', id = '', createdAt = '', size = '']) => ({
        image: img,
        tag: img.slice(DEV_REPO.length + 1),
        id,
        createdAt: createdAt.replace(/ \+0000 UTC$/, 'Z').replace(' ', 'T').replace(' ', ''),
        size,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const labelList = await Promise.all(raw.map(item => this.labels(item.image, item.id)))
    const items: DevImageView[] = raw.map((item, idx) => ({
      ...item,
      packages: words(labelList[idx]?.['io.superagent.dev.packages']),
      features: words(labelList[idx]?.['io.superagent.dev.features']),
    }))
    return { items }
  }

  /** The dev image the current worker image was built on (verified present locally), for Pi version rebuilds. */
  async currentBase(): Promise<string | undefined> {
    const base = (await this.labels(this.deps.getImage()))['io.superagent.base']
    if (!base || !base.startsWith(`${DEV_REPO}:`)) return undefined
    const exists = await this.run('podman', ['image', 'exists', base], { timeoutMs: LIST_TIMEOUT_MS })
    return exists.code === 0 ? base : undefined
  }

  private resolveCacheDir(): string {
    return this.deps.cacheDir ?? process.env.SA_CACHE_ROOT ?? join(homedir(), 'superagent-cache')
  }

  private resolveToolsDir(): string {
    return this.deps.toolsDir ?? process.env.SA_TOOLS_ROOT ?? join(homedir(), 'superagent-tools')
  }

  async status(): Promise<DevStatusView> {
    const image = this.deps.getImage()
    const [labels, devList] = await Promise.all([this.labels(image), this.listDevImages()])
    const base = labels['io.superagent.base']
    const hasBase = Boolean(base && base.startsWith(`${DEV_REPO}:`))
    const recommendedDev = !hasBase ? pickRecommendedDev(devList.items) : undefined
    const shared = inspectSharedEnv(this.resolveCacheDir(), this.resolveToolsDir())
    return {
      image,
      ...(hasBase ? { base } : {}),
      packages: words(labels['io.superagent.dev.packages']),
      features: words(labels['io.superagent.dev.features']),
      devImages: devList.items,
      ...(recommendedDev ? { recommendedDev } : {}),
      ...(devList.error ? { imagesError: devList.error } : {}),
      available: { features: DEV_FEATURES },
      shared,
      ...(this.job ? { job: { ...this.job, log: [...this.job.log] } } : {}),
    }
  }

  cleanSharedCache(bucket: string): { ok: true; cleaned: string[]; freedBytes: number; shared: SharedEnvView } {
    const cacheDir = this.resolveCacheDir()
    const toolsDir = this.resolveToolsDir()
    const result = cleanSharedCache(cacheDir, bucket)
    this.deps.note?.('info', `清理共享缓存（${bucket}），释放 ${Math.round(result.freedBytes / 1024)} KB`, {
      bucket,
      cleaned: result.cleaned.join(','),
      freedBytes: result.freedBytes,
    })
    return { ok: true, ...result, shared: inspectSharedEnv(cacheDir, toolsDir) }
  }

  /** Starts a full dev+Pi build in the background; one at a time. */
  async startBuild(input: DevBuildInput): Promise<DevJobView> {
    const spec = parseBuildInput(input)
    if (this.job?.state === 'running') throw new DevEnvError('正在构建开发环境，等它结束再试。', 409)
    const at = this.now()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const tag = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
    const job: DevJobView = {
      tag, devImage: `${DEV_REPO}:${tag}`, piImage: '', ...spec, mode: 'build', state: 'running', startedAt: at.toISOString(), log: [],
    }
    this.job = job
    this.deps.note?.('info', '开始构建开发环境', { tag, packages: spec.packages.join(' '), features: spec.features.join(' ') })
    void this.build(job, false)
    return { ...job, log: [...job.log] }
  }

  /**
   * Reuses an existing local `superagent-dev:<tag>` image and layers the active Pi version on top,
   * restoring all preinstalled toolchains & features in seconds without re-downloading them.
   */
  async startRepack(devImage: string, opts: { mirrors?: boolean } = {}): Promise<DevJobView> {
    const trimmed = devImage.trim()
    const tag = trimmed.startsWith(`${DEV_REPO}:`) ? trimmed.slice(DEV_REPO.length + 1) : ''
    if (!DEV_TAG_RE.test(tag)) throw new DevEnvError(`只能基于 ${DEV_REPO}:<标签> 的开发镜像重新封装。`)
    if (this.job?.state === 'running') throw new DevEnvError('正在构建开发环境，等它结束再试。', 409)
    const exists = await this.run('podman', ['image', 'exists', trimmed], { timeoutMs: LIST_TIMEOUT_MS })
    if (exists.code !== 0) throw new DevEnvError(`本机没有开发镜像 ${trimmed}。`, 404)
    const labels = await this.labels(trimmed)
    const packages = words(labels['io.superagent.dev.packages'])
    const features = words(labels['io.superagent.dev.features']).filter((f): f is DevFeature => (DEV_FEATURES as readonly string[]).includes(f))
    const job: DevJobView = {
      tag,
      devImage: trimmed,
      piImage: '',
      packages,
      features,
      mirrors: opts.mirrors !== false,
      mode: 'repack',
      state: 'running',
      startedAt: this.now().toISOString(),
      log: [],
    }
    this.job = job
    this.deps.note?.('info', `基于已有开发镜像 ${trimmed} 重新封装当前 Pi 版本`, { tag, devImage: trimmed })
    void this.build(job, true)
    return { ...job, log: [...job.log] }
  }

  private async build(job: DevJobView, reuseDevImage: boolean): Promise<void> {
    const push = (line: string): void => {
      job.log.push(line.slice(0, 500))
      if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES)
    }
    const fail = (error: string): void => {
      job.state = 'failed'
      job.error = error
      job.endedAt = this.now().toISOString()
      push(`× ${error}`)
      this.deps.note?.('error', `开发环境构建失败：${error}`, { tag: job.tag })
    }
    try {
      // The Pi version the new worker image must carry: the one in use now.
      push('$ pi --version（当前镜像）')
      const current = this.deps.getImage()
      const v = await this.run('podman', ['run', '--rm', '--network=none', '--pull=never', current, 'pi', '--version'], { timeoutMs: PROBE_TIMEOUT_MS })
      const piVersion = v.code === 0 ? parsePiVersion(v.out) : undefined
      if (!piVersion) { fail(`读不出当前镜像 ${current} 里的 Pi 版本：${lastLines(v.out) || `退出码 ${v.code}`}`); return }
      job.piVersion = piVersion
      job.piImage = `${PI_REPO}:${piVersion}-dev${job.tag}`
      if (job.piImage === current) {
        fail(`目标镜像 ${job.piImage} 正在使用，无需重复封装（或请先切换到其他镜像再重建）。`)
        return
      }
      push(`✓ 当前 Pi 版本 ${piVersion}`)

      const devMirrorArgs = job.mirrors ? [] : ['--build-arg', 'APT_MIRROR=', '--build-arg', 'PIP_INDEX=', '--build-arg', 'NPM_REGISTRY=']
      const piMirrorArgs = job.mirrors ? [] : ['--build-arg', 'APT_MIRROR=', '--build-arg', 'NPM_REGISTRY=']

      if (reuseDevImage) {
        push(`✓ 复用本机已有开发镜像 ${job.devImage}（跳过系统包重下）`)
      } else {
        push(`$ podman build -f Containerfile.dev -t ${job.devImage}`)
        const dev = await this.run('podman', [
          'build', '--build-arg', `EXTRA_PACKAGES=${job.packages.join(' ')}`, '--build-arg', `FEATURES=${job.features.join(' ')}`, ...devMirrorArgs,
          '-f', this.deps.devContainerfile, '-t', job.devImage, this.deps.context,
        ], { timeoutMs: BUILD_TIMEOUT_MS, onLine: push })
        if (dev.code !== 0) { fail(`开发镜像构建失败（podman build 退出码 ${dev.code}）`); return }
      }

      push('$ 自检（只读容器、断网、和执行者一样的挂载方式）')
      const test = await this.run('podman', [
        'run', '--rm', '--network=none', '--pull=never', '--userns=keep-id', '--read-only',
        '--tmpfs', '/tmp:rw,size=512m', '--tmpfs', '/home/node:rw,size=128m,U', '--user', 'node',
        job.devImage, 'sh', '-c', selfTestScript(job.features),
      ], { timeoutMs: PROBE_TIMEOUT_MS, onLine: push })
      if (test.code !== 0 || !test.out.includes('SELFTEST_PASSED')) { fail(`自检没通过：${lastLines(test.out) || `退出码 ${test.code}`}`); return }
      push('✓ 自检通过')

      push(`$ podman build -f Containerfile.pi --build-arg BASE_IMAGE=${job.devImage} --build-arg PI_VERSION=${piVersion} -t ${job.piImage}`)
      const pi = await this.run('podman', [
        'build', '--build-arg', `BASE_IMAGE=${job.devImage}`, '--build-arg', `PI_VERSION=${piVersion}`, ...piMirrorArgs,
        '-f', this.deps.piContainerfile, '-t', job.piImage, this.deps.context,
      ], { timeoutMs: BUILD_TIMEOUT_MS, onLine: push })
      if (pi.code !== 0) { fail(`执行者镜像构建失败（podman build 退出码 ${pi.code}）`); return }
      const got = await this.run('podman', ['run', '--rm', '--network=none', '--pull=never', job.piImage, 'pi', '--version'], { timeoutMs: PROBE_TIMEOUT_MS })
      if (parsePiVersion(got.out) !== piVersion) { fail(`新镜像里的 Pi 版本不对：${lastLines(got.out)}`); return }
      push(`✓ 执行者镜像能启动，Pi ${piVersion}`)

      for (const extension of this.deps.extensions) {
        const name = extension.split(/[\\/]/).at(-1) ?? 'ext.ts'
        push(`$ 加载扩展 ${name}`)
        const ext = await this.run('podman', [
          'run', '--rm', '--network=none', '--pull=never', '--userns=keep-id', '-v', `${extension}:/ext/${name}:ro`,
          '-e', 'SA_COLLAB_CHECK=1', '-e', 'SA_WEB_CHECK=1', '-e', 'PI_OFFLINE=1', '-e', 'PI_CODING_AGENT_DIR=/tmp/pc',
          job.piImage, 'pi', '--no-session', '-e', `/ext/${name}`, '--list-models',
        ], { timeoutMs: PROBE_TIMEOUT_MS })
        if (ext.code !== 0 || /Failed to load extension/i.test(ext.out)) { fail(`新镜像加载不了扩展 ${name}：${lastLines(ext.out) || `退出码 ${ext.code}`}`); return }
        push(`✓ ${name} 能加载`)
      }
      job.state = 'done'
      job.endedAt = this.now().toISOString()
      push(`完成。点“应用”后新任务改用 ${job.piImage}。`)
      this.deps.note?.('info', `开发环境构建完成：${job.piImage}`, { image: job.piImage, mode: job.mode })
    } catch (error) {
      fail(describe(error))
    }
  }

  /** Makes a worker image built on a dev image the one new tickets start with. */
  async apply(image: string): Promise<{ image: string; previous: string }> {
    if (!image.startsWith(`${PI_REPO}:`)) throw new DevEnvError(`只能切换到 ${PI_REPO} 的镜像。`)
    if (this.job?.state === 'running' && this.job.piImage === image) throw new DevEnvError('这个镜像还在构建。', 409)
    const exists = await this.run('podman', ['image', 'exists', image], { timeoutMs: LIST_TIMEOUT_MS })
    if (exists.code !== 0) throw new DevEnvError(`本机没有镜像 ${image}。`, 404)
    const previous = this.deps.getImage()
    if (previous !== image) {
      this.deps.setImage(image)
      this.deps.note?.('info', `新任务改用 ${image}（之前是 ${previous}）`, { image, previous })
    }
    return { image, previous }
  }

  /** Deletes an unused local `superagent-dev` image. */
  async removeDevImage(image: string): Promise<{ ok: true }> {
    const trimmed = image.trim()
    const tag = trimmed.startsWith(`${DEV_REPO}:`) ? trimmed.slice(DEV_REPO.length + 1) : ''
    if (!DEV_TAG_RE.test(tag)) throw new DevEnvError(`只能删除 ${DEV_REPO}:<标签> 的开发镜像。`)
    if (this.job?.state === 'running' && this.job.devImage === trimmed) throw new DevEnvError('这个开发镜像正在构建，不能删除。', 409)
    const currentBase = await this.currentBase()
    if (currentBase && currentBase === trimmed) throw new DevEnvError('当前执行者镜像正基于这个开发镜像运行，不能删除。')
    const r = await this.run('podman', ['rmi', trimmed], { timeoutMs: 60_000 })
    if (r.code !== 0) throw new DevEnvError(`删除失败：${lastLines(r.out) || `退出码 ${r.code}`}`, 502)
    this.deps.note?.('info', `删除了开发镜像 ${trimmed}`, { image: trimmed })
    return { ok: true }
  }
}
