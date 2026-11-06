/**
 * Mock routes for the project library (F2 owns this file).
 *
 * mock.js calls install(registry) once at mock start. Register a route with:
 *
 *   registry.add('GET', '/api/projects/:id', ({ params, state }) => ({ id: params.id }))
 *
 * A handler receives { path, method, params, body, url, state, json, ok, fail }.
 * It may return a plain object (sent as 200 JSON) or a Response.
 *
 * Query parameters used by the screenshots / checks:
 *   mockUpload=slow|fast|fail409|failnet   upload pacing and failure rehearsal
 *   mockProjects=empty                     no seeded projects
 *
 * Uploads and projects live in sessionStorage so a page reload can still offer
 * "choose the same file to continue" (the server side is faked here).
 */
const MIB = 1024 * 1024
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const STORAGE_PREFIX = 'sa:mock:projects:v1'

/* ---------- seed data ---------- */

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString()
}

function seedReadme(name) {
  return `# ${name}

一个已经跑了一段时间的项目，现在要在它上面继续改。

## 怎么跑

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

## 目录

- \`src/\` 业务代码
- \`tests/\` 测试
- \`docs/\` 文档
`
}

function seedProfile(name, files, bytes) {
  return {
    files,
    bytes,
    topLevel: [
      'README.md',
      'package.json',
      'pyproject.toml',
      'src/',
      'src/main.ts',
      'src/api/',
      'src/api/client.ts',
      'src/api/types.ts',
      'docs/',
      'docs/guide.md',
      'docs/architecture.md',
      'tests/',
      'tests/app.test.ts',
      'assets/',
      'assets/logo.png',
      'data/',
      'data/sample.bin',
      '.git/',
    ],
    languages: [
      { ext: 'py', files: Math.round(files * 0.46) },
      { ext: 'ts', files: Math.round(files * 0.18) },
      { ext: 'md', files: Math.round(files * 0.12) },
      { ext: 'json', files: Math.round(files * 0.09) },
      { ext: 'yml', files: Math.round(files * 0.06) },
      { ext: 'js', files: Math.round(files * 0.04) },
      { ext: 'css', files: Math.round(files * 0.03) },
      { ext: 'sh', files: Math.round(files * 0.02) },
    ],
    readme: seedReadme(name),
    manifests: [
      { file: 'package.json', summary: 'name: trade-desk\nscripts: dev, build, test, lint' },
      { file: 'pyproject.toml', summary: '[project]\nname = "ai-ak47"\nversion = "1.4.2"\nrequires-python = ">=3.11"' },
    ],
    git: {
      branch: 'main',
      recent: [
        { hash7: 'a1b2c3d', message: '修正回测里的手续费计算' },
        { hash7: '9f8e7d6', message: '补上策略参数的边界测试' },
        { hash7: '5c4b3a2', message: '把数据源切到新的接口' },
        { hash7: '0e9d8c7', message: '整理 README 的启动步骤' },
        { hash7: '6b5a4f3', message: '初始化项目' },
      ],
    },
  }
}

function seededProjects() {
  return [
    {
      id: 'p_demo000001',
      name: 'ai-ak47-main',
      status: 'ready',
      files: 52270,
      bytes: 2_440_000_000,
      createdAt: isoAgo(2 * DAY),
      updatedAt: isoAgo(2 * DAY),
      sourceName: 'ai-ak47-main.zip',
      archiveBytes: 834_000_000,
      warnings: ['42 个文件名按 GBK 解码', '跳过了 2 个符号链接'],
      progress: { done: 52270, total: 52270 },
      profile: seedProfile('ai-ak47-main', 52270, 2_440_000_000),
    },
    {
      id: 'p_demo000002',
      name: '交易台前端',
      status: 'extracting',
      files: 0,
      bytes: 0,
      createdAt: isoAgo(HOUR),
      updatedAt: isoAgo(HOUR),
      sourceName: 'trade-desk.zip',
      archiveBytes: 190_000_000,
      warnings: [],
      progress: { done: 12340, total: 55161 },
      extractStartedAt: Date.now() - 10 * 60 * 1000,
      extractDurationMs: 45 * 60 * 1000,
      extractTotal: 55161,
    },
    {
      id: 'p_demo000003',
      name: '旧版爬虫',
      status: 'failed',
      files: 0,
      bytes: 0,
      createdAt: isoAgo(5 * DAY),
      updatedAt: isoAgo(5 * DAY),
      sourceName: 'spider-old.zip',
      archiveBytes: 9_000_000_000,
      error: '压缩包超过 12 GB 解压上限，可在设置→项目里调高。',
      warnings: [],
      progress: { done: 0, total: 0 },
    },
    {
      id: 'p_demo000004',
      name: '小工具',
      status: 'ready',
      files: 128,
      bytes: 1_200_000,
      createdAt: isoAgo(3 * HOUR),
      updatedAt: isoAgo(3 * HOUR),
      sourceName: 'tool.zip',
      archiveBytes: 1_400_000,
      warnings: [],
      progress: { done: 128, total: 128 },
      profile: seedProfile('小工具', 128, 1_200_000),
    },
  ]
}

/* ---------- a small fake project tree ---------- */

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg=='

function fakeFiles() {
  return {
    'README.md': {
      text: '# 示例项目\n\n这是一个只用于演示的文件树。\n\n- `src/` 放代码\n- `docs/` 放文档\n- `assets/logo.png` 是一张图\n',
    },
    'package.json': { text: '{\n  "name": "demo-project",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest"\n  }\n}\n' },
    'src/index.ts': { text: "export { createApp } from './app.ts'\n\nexport const version = '1.0.0'\n" },
    'src/app.ts': { text: "import { client } from './api/client.ts'\n\nexport function createApp() {\n  return { client }\n}\n" },
    'src/api/client.ts': { text: "export const client = {\n  async get(path: string) {\n    const response = await fetch(path)\n    return response.json()\n  },\n}\n" },
    'src/api/types.ts': { text: 'export interface Project {\n  id: string\n  name: string\n}\n' },
    'src/styles.css': { text: 'body { margin: 0; font-family: system-ui, sans-serif; }\n' },
    'docs/guide.md': { text: '# 使用说明\n\n1. 安装依赖\n2. 启动开发服务器\n3. 打开浏览器\n\n> 这是一段引用。\n' },
    'docs/architecture.md': { text: '# 架构\n\n前端调用 `src/api/client.ts`，后端在 `server/`。\n\n```ts\nexport const client = {}\n```\n' },
    'tests/app.test.ts': { text: "import { describe, expect, it } from 'vitest'\nimport { createApp } from '../src/index.ts'\n\ndescribe('app', () => {\n  it('creates an app', () => {\n    expect(createApp()).toBeTruthy()\n  })\n})\n" },
    'assets/logo.png': { binary: true, mime: 'image/png' },
    'data/sample.bin': { binary: true, mime: 'application/octet-stream', size: 4096 },
  }
}

function normalizePath(value) {
  return String(value ?? '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\\/g, '/')
}

function directoryEntries(files, path) {
  const prefix = path === '' ? '' : `${path}/`
  const names = new Map()
  for (const filePath of Object.keys(files)) {
    if (!filePath.startsWith(prefix)) continue
    const rest = filePath.slice(prefix.length)
    if (!rest) continue
    const slash = rest.indexOf('/')
    const name = slash >= 0 ? rest.slice(0, slash) : rest
    const isDir = slash >= 0
    const current = names.get(name)
    if (current === undefined || (isDir && current.type !== 'dir')) {
      names.set(name, { name, type: isDir ? 'dir' : 'file' })
    }
  }
  const entries = [...names.values()].map((entry) => {
    if (entry.type === 'dir') return entry
    const data = files[joinPath(path, entry.name)] ?? {}
    return { ...entry, size: typeof data.size === 'number' ? data.size : (data.text ? new TextEncoder().encode(data.text).byteLength : 1024) }
  })
  entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name, 'zh-CN'))
  return entries
}

function joinPath(parent, name) {
  return [parent, name].filter(Boolean).join('/')
}

function pngResponse() {
  const body = Uint8Array.from(atob(PNG_1PX), (char) => char.charCodeAt(0))
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(body.byteLength), 'cache-control': 'no-store' },
  })
}

/* ---------- persistence ---------- */

function storageKey(empty) {
  return empty ? `${STORAGE_PREFIX}:empty` : STORAGE_PREFIX
}

function loadState(empty) {
  const base = { seq: 0, uploads: {}, projects: empty ? [] : seededProjects(), settings: { maxUploadMb: 4096, maxExtractMb: 12288, maxFiles: 300000 } }
  if (empty) return base
  try {
    const raw = sessionStorage.getItem(storageKey(false))
    if (!raw) return base
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object') return base
    return {
      seq: Number(saved.seq) || 0,
      uploads: saved.uploads && typeof saved.uploads === 'object' ? saved.uploads : {},
      projects: Array.isArray(saved.projects) && saved.projects.length ? saved.projects : base.projects,
      settings: { ...base.settings, ...(saved.settings ?? {}) },
    }
  } catch {
    return base
  }
}

function persist(state, empty) {
  if (empty) return
  try {
    sessionStorage.setItem(storageKey(false), JSON.stringify({
      seq: state.seq,
      uploads: state.uploads,
      projects: state.projects,
      settings: state.settings,
    }))
  } catch {
    // The in-memory state still works.
  }
}

/* ---------- dynamic extraction ---------- */

function settleProject(project) {
  if (project.status !== 'extracting') return false
  if (!project.extractStartedAt || !project.extractDurationMs) return false
  const elapsed = Date.now() - project.extractStartedAt
  const total = Number(project.extractTotal) || 1
  if (elapsed >= project.extractDurationMs) {
    project.status = 'ready'
    project.files = Math.max(12, Number(project.extractFiles) || 180)
    project.bytes = Math.max(1024, Number(project.extractBytes) || 8 * MIB)
    project.progress = { done: project.files, total: project.files }
    project.warnings = Array.isArray(project.warnings) && project.warnings.length
      ? project.warnings
      : ['2 个文件名按 GBK 解码']
    project.profile = seedProfile(project.name, project.files, project.bytes)
    project.updatedAt = new Date().toISOString()
    return true
  }
  project.progress = {
    done: Math.max(0, Math.min(total, Math.round((elapsed / project.extractDurationMs) * total))),
    total,
  }
  return false
}

function settleAll(state) {
  let changed = false
  for (const project of state.projects) {
    if (settleProject(project)) changed = true
  }
  return changed
}

function listView(project) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    files: project.files,
    bytes: project.bytes,
    createdAt: project.createdAt,
    ...(project.error ? { error: project.error } : {}),
  }
}

/* ---------- install ---------- */

export function install(registry) {
  let params
  try {
    params = new URLSearchParams(globalThis.location?.search ?? '')
  } catch {
    params = new URLSearchParams()
  }
  const uploadMode = params.get('mockUpload') ?? 'normal'
  const empty = params.get('mockProjects') === 'empty'
  const state = loadState(empty)
  const maxMb = Number(params.get('mockMaxMb'))
  if (Number.isFinite(maxMb) && maxMb > 0) state.settings.maxUploadMb = maxMb
  const files = fakeFiles()

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const save = () => persist(state, empty)
  const nextId = (prefix) => {
    state.seq += 1
    return `${prefix}${String(state.seq).padStart(8, '0')}`
  }

  async function bodyBytes(body) {
    if (body === undefined || body === null) return new Uint8Array(0)
    if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    return new Uint8Array(0)
  }

  function projectById(id) {
    return state.projects.find((project) => project.id === id)
  }

  function createProjectFromUpload(upload, projectName) {
    const id = nextId('p_')
    const fallback = String(upload.name || '').replace(/\.zip$/i, '').trim() || '未命名项目'
    const name = String(projectName || fallback).slice(0, 120)
    const now = new Date().toISOString()
    const slow = uploadMode === 'slow'
    const project = {
      id,
      name,
      status: 'extracting',
      files: 0,
      bytes: 0,
      createdAt: now,
      updatedAt: now,
      sourceName: upload.name,
      archiveBytes: upload.size,
      warnings: ['1 个文件名按 GBK 解码'],
      progress: { done: 0, total: 0 },
      extractStartedAt: Date.now(),
      extractDurationMs: slow ? 6000 : 1800,
      extractTotal: 4321,
      extractFiles: Math.round(120 + (upload.size % 900)),
      extractBytes: Math.round(upload.size * 1.8),
    }
    state.projects.unshift(project)
    return project
  }

  /* ----- uploads ----- */

  registry.add('POST', '/api/uploads', ({ body, fail }) => {
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const size = Number(body?.size)
    const maxMb = Number(state.settings.maxUploadMb) || 4096
    if (!name) return fail(400, 'invalid', '请填写压缩包文件名。')
    if (!Number.isFinite(size) || size <= 0) return fail(400, 'invalid', '文件大小必须大于 0。')
    if (size > maxMb * MIB) return fail(413, 'too_large', `压缩包超过 ${maxMb} MB 上传上限，可在设置→项目里调高。`)
    const uploadId = nextId('u_')
    state.uploads[uploadId] = {
      uploadId,
      name: name.slice(0, 255),
      size,
      received: 0,
      createdAt: new Date().toISOString(),
      puts: 0,
      conflicted: false,
    }
    save()
    return { uploadId, chunkSize: 8 * MIB }
  })

  registry.add('GET', '/api/uploads/:id', ({ params, fail }) => {
    const upload = state.uploads[params.id]
    if (!upload) return fail(404, 'not_found', '找不到这个上传任务，请重新开始。')
    return {
      uploadId: upload.uploadId,
      name: upload.name,
      size: upload.size,
      received: upload.received,
      state: upload.received >= upload.size ? 'uploaded' : 'uploading',
    }
  })

  registry.add('PUT', '/api/uploads/:id', async ({ params, body, url, fail, json }) => {
    const upload = state.uploads[params.id]
    if (!upload) return fail(404, 'not_found', '找不到这个上传任务，请重新开始。')
    const offset = Number(url.searchParams.get('offset'))
    if (!Number.isInteger(offset) || offset < 0) return fail(400, 'invalid_offset', 'offset 必须是从 0 开始的整数。')
    const bytes = await bodyBytes(body)
    upload.puts += 1

    if (uploadMode === 'failnet') {
      return fail(503, 'mock_network', '演示模式：模拟网络中断，分块没有传上去。')
    }
    if (offset !== upload.received) {
      return json(409, {
        error: 'offset_mismatch',
        message: `这一块的位置不对，服务端已收到 ${upload.received} 字节，请从这里继续。`,
        received: upload.received,
      })
    }
    if (upload.received >= upload.size) return fail(400, 'upload_finished', '这个压缩包已经上传完成。')
    if (upload.received + bytes.byteLength > upload.size) return fail(400, 'too_large', '这一块超过了压缩包的声明大小。')

    upload.received += bytes.byteLength

    // Rehearse a retry race: the chunk is committed, but the client hears 409.
    if (uploadMode === 'fail409' && upload.puts === 2 && !upload.conflicted) {
      upload.conflicted = true
      save()
      return json(409, {
        error: 'offset_mismatch',
        message: `这一块的位置不对，服务端已收到 ${upload.received} 字节，请从这里继续。`,
        received: upload.received,
      })
    }

    save()
    const delay = uploadMode === 'slow' ? 380 : uploadMode === 'fast' ? 15 : 90
    await sleep(delay)
    return { received: upload.received }
  })

  registry.add('POST', '/api/uploads/:id/finish', ({ params, body, fail }) => {
    const upload = state.uploads[params.id]
    if (!upload) return fail(404, 'not_found', '找不到这个上传任务，请重新开始。')
    if (upload.received !== upload.size) {
      return fail(400, 'incomplete', `上传还没完成（已收到 ${upload.received} / 共 ${upload.size} 字节）。`)
    }
    const project = createProjectFromUpload(upload, body?.projectName)
    delete state.uploads[params.id]
    save()
    return { projectId: project.id }
  })

  registry.add('DELETE', '/api/uploads/:id', ({ params, fail }) => {
    if (!state.uploads[params.id]) return fail(404, 'not_found', '找不到这个上传任务。')
    delete state.uploads[params.id]
    save()
    return { ok: true }
  })

  /* ----- projects ----- */

  registry.add('GET', '/api/projects', () => {
    const changed = settleAll(state)
    if (changed) save()
    return { items: state.projects.map(listView) }
  })

  registry.add('GET', '/api/projects/:id', ({ params, fail }) => {
    const project = projectById(params.id)
    if (!project) return fail(404, 'not_found', '找不到这个项目。')
    if (settleProject(project)) save()
    return {
      ...listView(project),
      sourceName: project.sourceName,
      archiveBytes: project.archiveBytes,
      updatedAt: project.updatedAt,
      warnings: Array.isArray(project.warnings) ? project.warnings : [],
      progress: project.progress ?? { done: project.files, total: project.files },
      ...(project.profile ? { profile: project.profile } : {}),
    }
  })

  registry.add('DELETE', '/api/projects/:id', ({ params, fail }) => {
    const index = state.projects.findIndex((project) => project.id === params.id)
    if (index < 0) return fail(404, 'not_found', '找不到这个项目。')
    state.projects.splice(index, 1)
    save()
    return { ok: true }
  })

  registry.add('GET', '/api/projects/:id/files', ({ params, url, fail }) => {
    const project = projectById(params.id)
    if (!project) return fail(404, 'not_found', '项目还没准备好，或找不到这个项目。')
    const path = normalizePath(url.searchParams.get('path') ?? '')
    const raw = url.searchParams.get('raw') === '1'
    const download = url.searchParams.get('download') === '1'
    const entry = path === '' ? null : files[path]

    if (raw) {
      if (entry && entry.binary && entry.mime === 'image/png') return pngResponse()
      return fail(415, 'not_previewable', '只有图片可以直接预览。')
    }
    if (entry) {
      const name = path.split('/').pop() ?? path
      if (download) {
        const bytes = entry.binary
          ? Uint8Array.from(atob(PNG_1PX), (char) => char.charCodeAt(0))
          : new TextEncoder().encode(entry.text ?? '')
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': entry.mime ?? 'text/plain; charset=utf-8',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'x-content-type-options': 'nosniff',
          },
        })
      }
      if (entry.binary) {
        return {
          exists: true, type: 'file', path, name,
          size: entry.size ?? 1024,
          modifiedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
          binary: true,
        }
      }
      return {
        exists: true, type: 'file', path, name,
        size: new TextEncoder().encode(entry.text).byteLength,
        modifiedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
        text: entry.text,
        truncated: false,
      }
    }
    const entries = directoryEntries(files, path)
    if (entries.length === 0 && path !== '') {
      return { exists: false, type: 'dir', path, name: path.split('/').pop() ?? '', entries: [] }
    }
    return { exists: true, type: 'dir', path, name: path.split('/').pop() ?? '', entries }
  })

  /* ----- settings ----- */

  registry.add('GET', '/api/settings/projects', () => ({ ...state.settings }))
  registry.add('PUT', '/api/settings/projects', ({ body }) => {
    const before = { ...state.settings }
    for (const key of ['maxUploadMb', 'maxExtractMb', 'maxFiles']) {
      if (Number(body?.[key]) > 0) state.settings[key] = Number(body[key])
    }
    save()
    const changed = Object.keys(state.settings)
      .filter((key) => before[key] !== state.settings[key])
      .map((key) => `projects.${key}`)
    return { ok: true, changed, note: '项目设置已保存；下一次上传和解压按新上限执行。' }
  })

  // Council settings and POST /api/councils live in mock-council.js (F3). mock.js matches the
  // most recently installed route, so F3's implementation replaces anything older here.
}
