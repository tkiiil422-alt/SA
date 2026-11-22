import { describe, expect, it } from 'vitest'
import { DEV_REPO, DevEnvError, DevEnvService, pickRecommendedDev, selfTestScript } from '../src/executor/dev-env.ts'
import { PI_REPO, type Runner } from '../src/executor/pi-versions.ts'

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i += 1) await new Promise(r => setTimeout(r, 5))
}

describe('DevEnvService', () => {
  it('checks ssh, ssh-agent, patch, rsync and optional features in selfTestScript', () => {
    const script = selfTestScript(['browser', 'dbserver'])
    expect(script).toContain('ssh')
    expect(script).toContain('ssh-agent')
    expect(script).toContain('patch')
    expect(script).toContain('rsync')
    expect(script).toContain('/opt/playwright')
    expect(script).toContain('redis-server')
  })

  it('prefers non-probe rich dev image as recommendedDev when active Pi image has no dev base', () => {
    const picked = pickRecommendedDev([
      { image: `${DEV_REPO}:probe`, tag: 'probe', id: 'id0', createdAt: '2026-11-22T02:00:00Z', size: '880 MB', features: [], packages: [] },
      { image: `${DEV_REPO}:20261122-104002`, tag: '20261122-104002', id: 'id1', createdAt: '2026-11-22T02:40:02Z', size: '880 MB', features: [], packages: [] },
      { image: `${DEV_REPO}:20261114-125853`, tag: '20261114-125853', id: 'id2', createdAt: '2026-11-14T05:05:17Z', size: '3.11 GB', features: ['browser', 'dbserver'], packages: [] },
    ])
    expect(picked?.tag).toBe('20261114-125853')
  })

  it('repacks an existing local dev image with the current Pi version without rebuilding Containerfile.dev', async () => {
    const devImg = `${DEV_REPO}:20261114-125853`
    const bareImg = `${PI_REPO}:1.6.0`
    let current = bareImg
    const calls: string[][] = []
    const existing = new Set([devImg, `${DEV_REPO}:20261122-104002`, bareImg])
    const labelsMap: Record<string, Record<string, string>> = {
      [bareImg]: { 'io.superagent.base': 'docker.io/library/node:22-bookworm-slim' },
      [devImg]: { 'io.superagent.dev': '1', 'io.superagent.dev.features': 'browser dbserver', 'io.superagent.dev.packages': 'ffmpeg' },
      [`${DEV_REPO}:20261122-104002`]: { 'io.superagent.dev': '1', 'io.superagent.dev.features': '', 'io.superagent.dev.packages': '' },
    }

    const run: Runner = async (file, args, { onLine }) => {
      calls.push([file, ...args])
      if (args[0] === 'images') {
        const lines = [...existing]
          .filter(img => img.startsWith(`${DEV_REPO}:`))
          .map((img, i) => `${img}\tid_${i}\t2026-11-${img.includes('1114') ? '14' : '22'} 05:00:00 +0000 UTC\t${img.includes('1114') ? '3.11 GB' : '880 MB'}`)
        return { code: 0, out: lines.join('\n') }
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        const target = args.at(-1)!
        return { code: 0, out: JSON.stringify(labelsMap[target] ?? {}) }
      }
      if (args[0] === 'image' && args[1] === 'exists') {
        return { code: existing.has(args[2]!) ? 0 : 1, out: '' }
      }
      if (args[0] === 'run') {
        if (args.includes('sh')) {
          onLine?.('SELFTEST_PASSED')
          return { code: 0, out: 'SELFTEST_PASSED\n' }
        }
        return { code: 0, out: '1.6.0\n' }
      }
      if (args[0] === 'build') {
        const outTag = args[args.indexOf('-t') + 1]!
        existing.add(outTag)
        labelsMap[outTag] = {
          'io.superagent.base': devImg,
          'io.superagent.dev': '1',
          'io.superagent.dev.features': 'browser dbserver',
          'io.superagent.dev.packages': 'ffmpeg',
        }
        return { code: 0, out: 'COMMIT' }
      }
      if (args[0] === 'rmi') {
        existing.delete(args[1]!)
        return { code: 0, out: '' }
      }
      return { code: 0, out: '' }
    }

    const svc = new DevEnvService({
      getImage: () => current,
      setImage: next => { current = next },
      devContainerfile: '/x/Containerfile.dev',
      piContainerfile: '/x/Containerfile.pi',
      context: '/x',
      extensions: ['/x/collab.ts', '/x/web.ts'],
      run,
    })

    const before = await svc.status()
    expect(before.base).toBeUndefined()
    expect(before.recommendedDev?.image).toBe(devImg)
    expect(before.recommendedDev?.features).toEqual(['browser', 'dbserver'])
    expect(before.recommendedDev?.packages).toEqual(['ffmpeg'])

    // 极速复用已有开发镜像封装当前 Pi 1.6.0
    const job = await svc.startRepack(devImg, { mirrors: true })
    expect(job.mode).toBe('repack')
    await until(() => (svc as any).job.state !== 'running')

    const after = await svc.status()
    expect(after.job?.state).toBe('done')
    expect(after.job?.piImage).toBe(`${PI_REPO}:1.6.0-dev20261114-125853`)
    // 只构建了 Containerfile.pi，完全跳过了 Containerfile.dev
    const buildCalls = calls.filter(c => c[1] === 'build')
    expect(buildCalls).toHaveLength(1)
    expect(buildCalls[0]).toContain('/x/Containerfile.pi')
    expect(buildCalls[0]).toContain(`BASE_IMAGE=${devImg}`)
    expect(buildCalls[0]).toContain('PI_VERSION=1.6.0')

    // 切换生效后，保护正在使用的 devImg 不可删除，但允许删除闲置旧镜像
    await svc.apply(`${PI_REPO}:1.6.0-dev20261114-125853`)
    expect(current).toBe(`${PI_REPO}:1.6.0-dev20261114-125853`)
    await expect(svc.removeDevImage(devImg)).rejects.toThrow(DevEnvError)
    await svc.removeDevImage(`${DEV_REPO}:20261122-104002`)
    expect(existing.has(`${DEV_REPO}:20261122-104002`)).toBe(false)
  })
})
