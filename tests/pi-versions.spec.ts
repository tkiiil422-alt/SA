import { describe, expect, it } from 'vitest'
import { compareVersions, parsePiVersion, PiVersionError, PiVersionService, type Runner } from '../src/executor/pi-versions.ts'

const REPO = 'localhost/superagent-pi'

/** A fake podman: a table of images (tag → Pi version), `build` adds one, `rmi` removes one. */
function fakePodman(images: Record<string, string>, opts: { buildFails?: boolean; buildVersion?: string } = {}) {
  const calls: string[][] = []
  let n = 0
  const run: Runner = async (file, args, { onLine }) => {
    calls.push([file, ...args])
    if (args[0] === 'images') {
      const out = Object.keys(images).map((tag, i) => `${REPO}:${tag}\tid${tag}\t2026-11-0${(i % 9) + 1} 10:00:00 +0000 UTC\t600 MB`).join('\n')
      return { code: 0, out }
    }
    if (args[0] === 'run') {
      const image = args.find(a => a.startsWith(`${REPO}:`))!
      const v = images[image.slice(REPO.length + 1)]
      return v ? { code: 0, out: `${v}\n` } : { code: 125, out: 'Error: image not known' }
    }
    if (args[0] === 'build') {
      onLine?.('STEP 1/6: FROM node:22')
      if (opts.buildFails) return { code: 1, out: 'npm ERR! 404' }
      const tag = args[args.indexOf('-t') + 1]!.slice(REPO.length + 1)
      const version = args[args.indexOf('--build-arg') + 1]!.split('=')[1]!
      images[tag] = opts.buildVersion ?? version
      n += 1
      return { code: 0, out: 'COMMIT' }
    }
    if (args[0] === 'rmi') { delete images[args[1]!.slice(REPO.length + 1)]; return { code: 0, out: '' } }
    return { code: 1, out: 'unknown' }
  }
  return { run, calls, builds: () => n }
}

const registry = (versions: string[], latest = versions.at(-1)!) => (async () => new Response(JSON.stringify({
  'dist-tags': { latest },
  versions: Object.fromEntries(versions.map(v => [v, {}])),
  time: Object.fromEntries(versions.map(v => [v, '2026-11-10T00:00:00.000Z'])),
}), { status: 200 })) as unknown as typeof fetch

function service(images: Record<string, string>, opts: Parameters<typeof fakePodman>[1] & { image?: string; versions?: string[]; fetch?: typeof fetch } = {}) {
  const podman = fakePodman(images, opts)
  let image = opts.image ?? `${REPO}:1.5.0`
  const notes: string[] = []
  const svc = new PiVersionService({
    getImage: () => image,
    setImage: next => { image = next },
    containerfile: '/x/Containerfile.pi',
    context: '/x',
    run: podman.run,
    fetch: opts.fetch ?? registry(opts.versions ?? ['1.4.0', '1.5.0', '1.5.1', '1.5.2']),
    note: (_l, text) => notes.push(text),
  })
  return { svc, podman, notes, image: () => image }
}

const until = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 5)) }

describe('pi version helpers', () => {
  it('compares versions with pre-releases before releases', () => {
    expect(compareVersions('1.5.2', '1.5.10')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.5.0-rc.1', '1.5.0')).toBeLessThan(0)
    expect(compareVersions('1.5.0', '1.5.0')).toBe(0)
  })
  it('reads the version from pi --version output', () => {
    expect(parsePiVersion('pi 1.5.2\n')).toBe('1.5.2')
    expect(parsePiVersion('nothing here')).toBeUndefined()
  })
})

describe('PiVersionService', () => {
  it('reports the image in use, its Pi version, local images and an available upgrade', async () => {
    const { svc } = service({ '1.5.0': '1.5.0', '1.5.0-prev': '1.5.0' })
    const s = await svc.status()
    expect(s.image).toBe(`${REPO}:1.5.0`)
    expect(s.version).toBe('1.5.0')
    expect(s.latest).toBe('1.5.2')
    expect(s.upgrade).toBe('1.5.2')
    expect(s.images.map(i => i.tag).sort()).toEqual(['1.5.0', '1.5.0-prev'])
    expect(s.images.find(i => i.current)?.tag).toBe('1.5.0')
    expect(s.releases[0]!.version).toBe('1.5.2')
  })

  it('says when the configured image is missing and when npm cannot be reached', async () => {
    const down = (async () => { throw new Error('ETIMEDOUT') }) as unknown as typeof fetch
    const { svc } = service({ '1.4.0': '1.4.0' }, { fetch: down })
    const s = await svc.status()
    expect(s.versionError).toContain('本机没有镜像')
    expect(s.registryError).toContain('ETIMEDOUT')
    expect(s.upgrade).toBeUndefined()
  })

  it('builds a version, checks it inside the new image, then applies it and can roll back', async () => {
    const images: Record<string, string> = { '1.5.0': '1.5.0' }
    const { svc, podman, image, notes } = service(images)
    const job = await svc.startBuild('1.5.2')
    expect(job.state).toBe('running')
    await expect(svc.startBuild('1.5.1')).rejects.toBeInstanceOf(PiVersionError)
    await until(() => (svc as any).job.state !== 'running')
    const s = await svc.status()
    expect(s.job?.state).toBe('done')
    expect(s.job?.log.join('\n')).toContain('Pi 版本 1.5.2')
    const build = podman.calls.find(c => c[1] === 'build')!
    expect(build).toContain('PI_VERSION=1.5.2')
    expect(build).toContain(`${REPO}:1.5.2`)

    const applied = await svc.apply(`${REPO}:1.5.2`)
    expect(applied).toEqual({ image: `${REPO}:1.5.2`, version: '1.5.2', previous: `${REPO}:1.5.0` })
    expect(image()).toBe(`${REPO}:1.5.2`)
    await svc.apply(`${REPO}:1.5.0`)
    expect(image()).toBe(`${REPO}:1.5.0`)
    expect(notes.some(t => t.includes('新任务改用 Pi 1.5.2'))).toBe(true)
  })

  it('fails a build whose image reports another version, and a failed podman build', async () => {
    const wrong = service({ '1.5.0': '1.5.0' }, { buildVersion: '1.4.0' })
    await wrong.svc.startBuild('1.5.2')
    await until(() => (wrong.svc as any).job.state !== 'running')
    expect((await wrong.svc.status()).job?.error).toContain('1.4.0')

    const broken = service({ '1.5.0': '1.5.0' }, { buildFails: true })
    await broken.svc.startBuild('1.5.2')
    await until(() => (broken.svc as any).job.state !== 'running')
    expect((await broken.svc.status()).job?.state).toBe('failed')
  })

  it('refuses bad input: unknown versions, the image in use, foreign images, missing images', async () => {
    const { svc, image } = service({ '1.5.0': '1.5.0', '1.4.0': '1.4.0' })
    await expect(svc.startBuild('latest')).rejects.toThrow('版本号格式')
    await expect(svc.startBuild('9.9.9')).rejects.toThrow('npm 上没有')
    await expect(svc.startBuild('1.5.0')).rejects.toThrow('正在使用')
    await expect(svc.apply('docker.io/evil:1')).rejects.toThrow('只能切换')
    await expect(svc.apply(`${REPO}:1.5.1`)).rejects.toThrow('本机没有')
    await expect(svc.remove(`${REPO}:1.5.0`)).rejects.toThrow('正在使用')
    await svc.remove(`${REPO}:1.4.0`)
    expect((await svc.status()).images.map(i => i.tag)).toEqual(['1.5.0'])
    expect(image()).toBe(`${REPO}:1.5.0`)
  })
})
