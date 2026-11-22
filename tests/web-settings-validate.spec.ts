import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const moduleUrl = pathToFileURL(join(process.cwd(), 'src/admin/web/lib/settings-validate.js')).href

async function load(): Promise<any> {
  return import(moduleUrl)
}

const projects = (over: Record<string, unknown> = {}) => ({
  maxUploadMb: 4096,
  maxExtractMb: 12288,
  maxFiles: 300000,
  ...over,
})

const role = (over: Record<string, unknown> = {}) => ({
  id: 'analyst',
  name: '需求分析师',
  persona: '把需求还原成可验收的目标。',
  enabled: true,
  ...over,
})

const council = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  defaultOn: false,
  rounds: 2,
  maxCharsPerTurn: 600,
  moderator: null,
  roles: [role()],
  ...over,
})

const paths = (issues: Array<{ path: string }>) => issues.map((issue) => issue.path)

describe('validateProjects', () => {
  it('accepts the defaults', async () => {
    const { validateProjects } = await load()
    expect(validateProjects(projects())).toEqual([])
  })

  it('checks maxUploadMb boundaries', async () => {
    const { validateProjects } = await load()
    expect(validateProjects(projects({ maxUploadMb: 1 }))).toEqual([])
    expect(validateProjects(projects({ maxUploadMb: 65536 }))).toEqual([])
    expect(paths(validateProjects(projects({ maxUploadMb: 0 })))).toEqual(['maxUploadMb'])
    expect(paths(validateProjects(projects({ maxUploadMb: 65537 })))).toEqual(['maxUploadMb'])
  })

  it('checks maxExtractMb boundaries', async () => {
    const { validateProjects } = await load()
    expect(validateProjects(projects({ maxExtractMb: 1048576 }))).toEqual([])
    expect(paths(validateProjects(projects({ maxExtractMb: 0 })))).toEqual(['maxExtractMb'])
    expect(paths(validateProjects(projects({ maxExtractMb: 1048577 })))).toEqual(['maxExtractMb'])
  })

  it('checks maxFiles boundaries', async () => {
    const { validateProjects } = await load()
    expect(validateProjects(projects({ maxFiles: 5000000 }))).toEqual([])
    expect(paths(validateProjects(projects({ maxFiles: 0 })))).toEqual(['maxFiles'])
    expect(paths(validateProjects(projects({ maxFiles: 5000001 })))).toEqual(['maxFiles'])
  })

  it('rejects decimals and strings', async () => {
    const { validateProjects } = await load()
    expect(paths(validateProjects(projects({ maxUploadMb: 1.5 })))).toEqual(['maxUploadMb'])
    expect(paths(validateProjects(projects({ maxFiles: '100' })))).toEqual(['maxFiles'])
  })

  it('formats sizes and gives a non-blocking hint when extraction is smaller than upload', async () => {
    const { formatMb, formatFiles, projectsHint } = await load()
    expect(formatMb(4096)).toBe('4096 MB ≈ 4 GB')
    expect(formatFiles(300000)).toBe('300000 个')
    expect(projectsHint(projects({ maxUploadMb: 4096, maxExtractMb: 1024 }))).toContain('大概率会解压失败')
    expect(projectsHint(projects())).toBe('')
  })
})

describe('validateCouncil', () => {
  it('accepts a valid council', async () => {
    const { validateCouncil } = await load()
    expect(validateCouncil(council())).toEqual([])
  })

  it('checks rounds boundaries', async () => {
    const { validateCouncil } = await load()
    expect(validateCouncil(council({ rounds: 1 }))).toEqual([])
    expect(validateCouncil(council({ rounds: 3 }))).toEqual([])
    expect(paths(validateCouncil(council({ rounds: 0 })))).toContain('rounds')
    expect(paths(validateCouncil(council({ rounds: 4 })))).toContain('rounds')
    expect(paths(validateCouncil(council({ rounds: 1.5 })))).toContain('rounds')
  })

  it('checks maxCharsPerTurn boundaries', async () => {
    const { validateCouncil } = await load()
    expect(validateCouncil(council({ maxCharsPerTurn: 100 }))).toEqual([])
    expect(validateCouncil(council({ maxCharsPerTurn: 2000 }))).toEqual([])
    expect(paths(validateCouncil(council({ maxCharsPerTurn: 99 })))).toContain('maxCharsPerTurn')
    expect(paths(validateCouncil(council({ maxCharsPerTurn: 2001 })))).toContain('maxCharsPerTurn')
  })

  it('checks role id format and duplicates', async () => {
    const { validateCouncil } = await load()
    expect(paths(validateCouncil(council({ roles: [role({ id: 'Bad' })] })))).toEqual(['roles.0.id'])
    expect(paths(validateCouncil(council({ roles: [role({ id: '-x' })] })))).toEqual(['roles.0.id'])
    expect(paths(validateCouncil(council({ roles: [role({ id: 'a'.repeat(33) })] })))).toEqual(['roles.0.id'])
    expect(validateCouncil(council({ roles: [role({ id: 'a'.repeat(32) })] }))).toEqual([])
    const dup = validateCouncil(council({ roles: [role(), role({ name: '另一个' })] }))
    expect(paths(dup)).toEqual(['roles.1.id'])
  })

  it('requires at least one enabled role', async () => {
    const { validateCouncil } = await load()
    expect(paths(validateCouncil(council({ roles: [role({ enabled: false })] })))).toEqual(['roles'])
  })

  it('checks name and persona emptiness and length', async () => {
    const { validateCouncil } = await load()
    expect(paths(validateCouncil(council({ roles: [role({ name: '  ' })] })))).toEqual(['roles.0.name'])
    expect(paths(validateCouncil(council({ roles: [role({ name: 'x'.repeat(61) })] })))).toEqual(['roles.0.name'])
    expect(validateCouncil(council({ roles: [role({ name: 'x'.repeat(60) })] }))).toEqual([])
    expect(paths(validateCouncil(council({ roles: [role({ persona: '' })] })))).toEqual(['roles.0.persona'])
    expect(paths(validateCouncil(council({ roles: [role({ persona: 'x'.repeat(2001) })] })))).toEqual(['roles.0.persona'])
    expect(validateCouncil(council({ roles: [role({ persona: 'x'.repeat(2000) })] }))).toEqual([])
  })

  it('checks the role count: zero and twenty-one fail, twenty passes', async () => {
    const { validateCouncil } = await load()
    expect(paths(validateCouncil(council({ roles: [] })))).toContain('roles')
    const many = Array.from({ length: 21 }, (_, i) => role({ id: `r${i}` }))
    expect(paths(validateCouncil(council({ roles: many })))).toContain('roles')
    const twenty = Array.from({ length: 20 }, (_, i) => role({ id: `r${i}` }))
    expect(validateCouncil(council({ roles: twenty }))).toEqual([])
  })

  it('accepts a null moderator and a well-formed role model, rejects a malformed one', async () => {
    const { validateCouncil } = await load()
    expect(validateCouncil(council({ moderator: null }))).toEqual([])
    expect(validateCouncil(council({ moderator: { provider: 'p', model: 'm' } }))).toEqual([])
    expect(paths(validateCouncil(council({ moderator: { provider: '', model: 'm' } })))).toContain('moderator')
    expect(validateCouncil(council({ roles: [role({ model: { provider: 'p', model: 'm' } })] }))).toEqual([])
    expect(paths(validateCouncil(council({ roles: [role({ model: { provider: 'p' } })] })))).toEqual(['roles.0.model'])
  })
})
