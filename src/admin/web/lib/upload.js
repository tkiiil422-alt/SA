/**
 * Project archive upload: one module-level singleton shared by every view and the shell.
 *
 * Flow: POST api/uploads -> PUT api/uploads/:id?offset=N in chunks -> POST .../finish ->
 * poll api/projects/:id until the background extraction is `ready` or `failed`.
 *
 * The browser is the source of truth for the file, the server for how many bytes were committed.
 * A paused upload keeps its record in localStorage so a page refresh can offer "choose the same file
 * to continue"; the server is asked for `received` before resuming.
 *
 * `crypto.subtle` only exists in a secure context. The deployed console is plain HTTP, so the
 * per-chunk SHA-256 is optional: when subtle is missing we simply omit the header (the server treats
 * it as optional and still checks content-length).
 */
import { bus } from './bus.js'

const STORAGE_KEY = 'sa-upload'
const MIB = 1024 * 1024
/** Never send more than 4 MiB per request, even if the server offers 8 MiB. */
const MAX_CHUNK = 4 * MIB
const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]
const ABORTED = Symbol('aborted')

const config = {
  /** Injected in tests; defaults to globalThis.fetch. */
  fetch: null,
  /** Injected in tests; '' means same-origin relative paths. */
  base: '',
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  /** Test-only override. */
  chunkSize: null,
  retryDelays: [...DEFAULT_RETRY_DELAYS],
  pollInterval: 1000,
  now: () => Date.now(),
}

function blankState() {
  return {
    active: false,
    phase: 'idle',
    name: '',
    size: 0,
    sent: 0,
    percent: 0,
    speedBps: 0,
    etaSec: null,
    extractDone: 0,
    extractTotal: 0,
    projectId: null,
    uploadId: null,
    error: null,
    notice: '',
    done: false,
  }
}

let uploadState = blankState()
const listeners = new Set()
let readyListeners = []
let current = null
/** Set while the create/resume request is in flight, so a quick second click or send sees "busy". */
let starting = null
let speedSamples = []
let beforeUnloadBound = false

/* ---------- small helpers ---------- */

function emit() {
  const snapshot = stateView()
  for (const listener of [...listeners]) {
    try {
      listener(snapshot)
    } catch {
      // A broken subscriber must not break the upload.
    }
  }
}

function stateView() {
  return { ...uploadState }
}

function urlFor(path) {
  const base = String(config.base ?? '').replace(/\/+$/, '')
  return base === '' ? path : `${base}/${path}`
}

function doFetch(path, init) {
  const fetcher = config.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('这个环境没有可用的网络请求。')
  return fetcher(urlFor(path), init)
}

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function readRecord() {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const name = typeof value.name === 'string' ? value.name : ''
    const size = Number(value.size)
    if (!name || !Number.isFinite(size) || size <= 0) return null
    return {
      uploadId: typeof value.uploadId === 'string' ? value.uploadId : null,
      projectId: typeof value.projectId === 'string' ? value.projectId : null,
      name,
      size,
      lastModified: Number.isFinite(Number(value.lastModified)) ? Number(value.lastModified) : null,
      phase: typeof value.phase === 'string' ? value.phase : 'uploading',
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

function saveRecord(record) {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }))
  } catch {
    // A private window may refuse storage; the in-memory upload still works.
  }
}

function clearRecord() {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do.
  }
}

function bindBeforeUnload() {
  if (beforeUnloadBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  window.addEventListener('beforeunload', onBeforeUnload)
  beforeUnloadBound = true
}

function unbindBeforeUnload() {
  if (!beforeUnloadBound || typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return
  window.removeEventListener('beforeunload', onBeforeUnload)
  beforeUnloadBound = false
}

function onBeforeUnload(event) {
  if (!uploadState.active) return
  event.preventDefault()
  event.returnValue = ''
}

async function acquireWakeLock() {
  if (!current) return
  if (typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return
  try {
    const lock = await navigator.wakeLock.request('screen')
    if (current && uploadState.active) current.wakeLock = lock
    else lock?.release?.()
  } catch {
    // Not supported, not permitted, or not a secure context: ignore.
  }
}

function releaseWakeLock(ctx = current) {
  if (!ctx || !ctx.wakeLock) return
  try {
    ctx.wakeLock.release?.()
  } catch {
    // Already released.
  }
  ctx.wakeLock = null
}

function subtleCrypto() {
  const cryptoObject = globalThis.crypto
  if (!cryptoObject || !cryptoObject.subtle || typeof cryptoObject.subtle.digest !== 'function') return null
  return cryptoObject.subtle
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function digestOf(blob) {
  const subtle = subtleCrypto()
  if (!subtle) return null
  try {
    const data = await blob.arrayBuffer()
    return toHex(await subtle.digest('SHA-256', data))
  } catch {
    // A missing or broken subtle implementation must never fail the upload.
    return null
  }
}

function isBusy() {
  return uploadState.phase === 'uploading' || uploadState.phase === 'paused' || uploadState.phase === 'finishing' || uploadState.phase === 'extracting'
}

function uploadPercent() {
  if (!(uploadState.size > 0)) return 0
  return Math.min(90, (uploadState.sent / uploadState.size) * 90)
}

function extractPercent() {
  if (uploadState.phase === 'done') return 100
  if (!(uploadState.extractTotal > 0)) return 90
  return Math.min(99.5, 90 + (Math.min(uploadState.extractDone, uploadState.extractTotal) / uploadState.extractTotal) * 10)
}

function setPercent() {
  if (uploadState.phase === 'uploading' || uploadState.phase === 'paused') uploadState.percent = uploadPercent()
  else if (uploadState.phase === 'finishing') uploadState.percent = 90
  else if (uploadState.phase === 'extracting') uploadState.percent = extractPercent()
  else if (uploadState.phase === 'done') uploadState.percent = 100
}

function recordSpeed() {
  const at = config.now()
  speedSamples.push({ at, sent: uploadState.sent })
  while (speedSamples.length > 2 && at - speedSamples[0].at > 5000) speedSamples.shift()
  const first = speedSamples[0]
  const seconds = (at - first.at) / 1000
  if (seconds >= 0.4) {
    uploadState.speedBps = Math.max(0, (uploadState.sent - first.sent) / seconds)
  } else {
    uploadState.speedBps = 0
  }
  uploadState.etaSec = uploadState.speedBps > 1024 ? Math.max(1, Math.round((uploadState.size - uploadState.sent) / uploadState.speedBps)) : null
}

class UploadError extends Error {
  constructor(status, message, body = null) {
    super(message)
    this.name = 'UploadError'
    this.status = status
    this.body = body
  }
}

function messageForStatus(status) {
  if (status === 401) return '登录已失效，请重新登录后继续。'
  if (status === 403) return '请求被拒绝，请刷新页面后重试。'
  if (status === 404) return '找不到这个上传任务，请重新开始。'
  if (status === 413) return '压缩包超过了上传上限。'
  if (status === 507) return '磁盘空间不足，暂时放不下这个压缩包。'
  if (status >= 500) return '后台暂时出错了，请稍后重试。'
  return '这个请求没有成功，请重试。'
}

async function parseResponse(response) {
  const text = await response.text()
  let body = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return body
}

async function requestJson(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' }
  const init = { method, credentials: 'same-origin', headers, signal }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['X-SA-Request'] = '1'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await doFetch(path, init)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new UploadError(0, '连不上后台服务，请检查网络后重试。', error)
  }
  const data = await parseResponse(response)
  if (!response.ok) {
    const message = data && typeof data === 'object' && typeof data.message === 'string' && data.message
      ? data.message
      : messageForStatus(response.status)
    throw new UploadError(response.status, message, data)
  }
  return data
}

/* ---------- the chunk loop ---------- */

async function putChunk(ctx, offset, blob, runId) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-SA-Request': '1',
  }
  const claimed = await digestOf(blob)
  if (claimed) headers['x-chunk-sha256'] = claimed

  const controller = new AbortController()
  if (ctx.controller) ctx.controller.abort()
  ctx.controller = controller

  let response
  try {
    response = await doFetch(`api/uploads/${encodeURIComponent(ctx.uploadId)}?offset=${offset}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers,
      body: blob,
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw ABORTED
    throw new UploadError(0, '连不上后台服务，请检查网络后重试。', error)
  }
  const data = await parseResponse(response)
  if (response.status === 409) {
    const received = Number(data && typeof data === 'object' ? data.received : NaN)
    if (!Number.isFinite(received)) throw new UploadError(409, '上传进度对不上，请重新开始。', data)
    return { conflict: true, received }
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && typeof data.message === 'string' && data.message
      ? data.message
      : messageForStatus(response.status)
    throw new UploadError(response.status, message, data)
  }
  const received = Number(data && typeof data === 'object' ? data.received : offset + blob.size)
  return { conflict: false, received: Number.isFinite(received) ? received : offset + blob.size }
}

async function putWithRetry(ctx, offset, blob, runId) {
  let attempt = 0
  for (;;) {
    if (current !== ctx || ctx.runId !== runId || ctx.paused || ctx.cancelled) throw ABORTED
    try {
      return await putChunk(ctx, offset, blob, runId)
    } catch (error) {
      if (error === ABORTED) throw ABORTED
      if (current !== ctx || ctx.runId !== runId || ctx.paused || ctx.cancelled) throw ABORTED
      if (error.status === 401) {
        pauseInternal('登录已失效，请重新登录后继续。')
        throw ABORTED
      }
      const retryable = error.status === 0 || error.status === undefined || error.status >= 500
      if (!retryable || attempt >= config.retryDelays.length) throw error
      const delay = Number(config.retryDelays[attempt] ?? 0)
      attempt += 1
      uploadState.notice = `网络不稳，${Math.max(1, Math.round(delay / 1000))} 秒后重试（第 ${attempt} 次）`
      emit()
      await config.sleep(delay)
      if (current !== ctx || ctx.runId !== runId || ctx.paused || ctx.cancelled) throw ABORTED
    }
  }
}

async function uploadLoop(ctx, runId) {
  while (current === ctx && ctx.runId === runId && !ctx.paused && !ctx.cancelled) {
    if (ctx.offset >= ctx.file.size) break
    uploadState.phase = 'uploading'
    uploadState.active = true
    uploadState.notice = ''
    setPercent()
    emit()

    const end = Math.min(ctx.offset + ctx.chunkSize, ctx.file.size)
    const blob = ctx.file.slice(ctx.offset, end)
    let result
    try {
      result = await putWithRetry(ctx, ctx.offset, blob, runId)
    } catch (error) {
      if (error === ABORTED || current !== ctx || ctx.runId !== runId) return
      fail(error, { keepRecord: error.status !== 404 })
      return
    }
    if (result === ABORTED || current !== ctx || ctx.runId !== runId) return
    if (result.conflict) {
      ctx.offset = result.received
      uploadState.sent = result.received
      recordSpeed()
      setPercent()
      emit()
      continue
    }
    ctx.offset = result.received
    uploadState.sent = result.received
    recordSpeed()
    setPercent()
    emit()
  }

  if (current !== ctx || ctx.runId !== runId || ctx.cancelled) return
  if (ctx.paused) return
  if (ctx.offset < ctx.file.size) return
  await finish(ctx, runId)
}

async function finish(ctx, runId) {
  uploadState.phase = 'finishing'
  uploadState.percent = 90
  uploadState.notice = ''
  setPercent()
  emit()
  let result
  try {
    result = await requestJson(`api/uploads/${encodeURIComponent(ctx.uploadId)}/finish`, {
      method: 'POST',
      body: ctx.opts.projectName ? { projectName: ctx.opts.projectName } : {},
    })
  } catch (error) {
    if (current !== ctx || ctx.runId !== runId) return
    if (error?.status === 401) {
      pauseInternal('登录已失效，请重新登录后继续。')
      return
    }
    fail(error, { keepRecord: error.status !== 404 })
    return
  }
  if (current !== ctx || ctx.runId !== runId) return
  const projectId = typeof result?.projectId === 'string' ? result.projectId : ''
  if (!projectId) {
    fail(new Error('上传完成了，但后台没有返回项目编号。'), { keepRecord: false })
    return
  }
  ctx.projectId = projectId
  ctx.uploadId = null
  uploadState.projectId = projectId
  uploadState.phase = 'extracting'
  uploadState.percent = 90
  uploadState.extractDone = 0
  uploadState.extractTotal = 0
  emit()
  saveRecord({
    uploadId: null,
    projectId,
    name: ctx.file.name,
    size: ctx.file.size,
    lastModified: Number.isFinite(ctx.file.lastModified) ? ctx.file.lastModified : null,
    phase: 'extracting',
  })
  await pollProject(ctx, projectId, runId)
}

async function pollProject(ctx, projectId, runId) {
  let misses = 0
  for (;;) {
    if (current !== ctx || ctx.runId !== runId || ctx.cancelled) return
    let detail
    try {
      detail = await requestJson(`api/projects/${encodeURIComponent(projectId)}`)
      misses = 0
    } catch (error) {
      if (error?.status === 401) {
        pauseInternal('登录已失效，请重新登录后继续。')
        return
      }
      if (error?.status === 404) {
        fail(new Error('项目在上传后不见了，请重新上传。'), { keepRecord: false })
        return
      }
      misses += 1
      if (misses > 60) {
        fail(new Error('后台一直没有返回解压进度，请稍后到项目页看看。'), { keepRecord: true })
        return
      }
      await config.sleep(config.pollInterval)
      continue
    }
    if (current !== ctx || ctx.runId !== runId || ctx.cancelled) return
    if (detail?.status === 'ready') {
      complete(projectId)
      return
    }
    if (detail?.status === 'failed') {
      const reason = typeof detail.error === 'string' && detail.error ? detail.error : '解压失败'
      fail(new Error(reason), { keepRecord: false })
      return
    }
    const progress = detail?.progress ?? {}
    uploadState.extractDone = Number(progress.done) || 0
    uploadState.extractTotal = Number(progress.total) || 0
    uploadState.phase = 'extracting'
    setPercent()
    emit()
    await config.sleep(config.pollInterval)
  }
}

function complete(projectId) {
  const ctx = current
  uploadState.phase = 'done'
  uploadState.active = false
  uploadState.done = true
  uploadState.error = null
  uploadState.notice = ''
  uploadState.percent = 100
  uploadState.sent = uploadState.size
  uploadState.projectId = projectId
  uploadState.extractDone = uploadState.extractTotal || uploadState.extractDone
  clearRecord()
  unbindBeforeUnload()
  releaseWakeLock(ctx)
  current = null
  emit()
  const listenersForReady = readyListeners
  readyListeners = []
  for (const listener of listenersForReady) {
    try {
      listener(projectId)
    } catch {
      // A listener's own failure must not change the upload result.
    }
  }
}

function fail(error, { keepRecord = true } = {}) {
  const ctx = current
  uploadState.phase = 'failed'
  uploadState.active = false
  uploadState.done = false
  uploadState.error = error?.message || '上传失败，请重试。'
  uploadState.notice = ''
  unbindBeforeUnload()
  releaseWakeLock(ctx)
  current = null
  readyListeners = []
  if (!keepRecord) clearRecord()
  emit()
}

function pauseInternal(notice = '已暂停，点「继续」接着传。') {
  const ctx = current
  if (!ctx) return
  ctx.paused = true
  ctx.runId += 1
  try {
    ctx.controller?.abort()
  } catch {
    // Nothing in flight.
  }
  uploadState.phase = 'paused'
  uploadState.active = true
  uploadState.notice = notice
  setPercent()
  unbindBeforeUnload()
  releaseWakeLock(ctx)
  emit()
}

/* ---------- public API ---------- */

/** Override fetch / base / timings. Only the given keys change. */
export function configure(options = {}) {
  if (!options || typeof options !== 'object') return
  if ('fetch' in options) config.fetch = options.fetch
  if ('base' in options) config.base = String(options.base ?? '')
  if ('sleep' in options && typeof options.sleep === 'function') config.sleep = options.sleep
  if ('chunkSize' in options) config.chunkSize = options.chunkSize === null ? null : Number(options.chunkSize) || null
  if (Array.isArray(options.retryDelays)) config.retryDelays = options.retryDelays.map((value) => Number(value) || 0)
  if (Number.isFinite(Number(options.pollInterval))) config.pollInterval = Math.max(10, Number(options.pollInterval))
  if (typeof options.now === 'function') config.now = options.now
}

/** The current full upload state (also used by the shell's upload capsule). */
export function state() {
  return stateView()
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** One-shot: called with the project id when the current upload becomes ready. */
export function onReady(listener) {
  if (typeof listener !== 'function') return () => {}
  if (uploadState.phase === 'done' && uploadState.projectId) {
    const projectId = uploadState.projectId
    Promise.resolve().then(() => listener(projectId))
    return () => {}
  }
  readyListeners.push(listener)
  return () => {
    readyListeners = readyListeners.filter((item) => item !== listener)
  }
}

/** The unfinished upload recorded by a previous page load, if any. */
export function pending() {
  const record = readRecord()
  if (!record) return null
  if (!record.uploadId && !record.projectId) return null
  return record
}

/** Drop the persisted record without touching an active upload. */
export function forgetPending() {
  if (!isBusy()) clearRecord()
}

/** Hide a finished/failed upload card without deleting the resumable record. */
export function dismiss() {
  if (isBusy()) return
  uploadState = blankState()
  emit()
}

/**
 * Start (or continue) uploading a project archive.
 * Resolves when the upload reaches `done`, `failed` or `paused`.
 */
export async function start(file, options = {}) {
  if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function') {
    throw new Error('没有选择文件。')
  }
  if (isBusy()) throw new Error('已有一个项目在上传。')

  const record = readRecord()
  let resumeRecord = null
  if (record && record.uploadId && !record.projectId) {
    const sameName = record.name === file.name
    const sameSize = record.size === file.size
    const sameTime = record.lastModified == null || file.lastModified == null
      ? true
      : Number(record.lastModified) === Number(file.lastModified)
    if (!sameName || !sameSize || !sameTime) {
      throw new Error(`上次的上传还没完成：${record.name}。要换文件，请先取消上次的上传。`)
    }
    resumeRecord = record
  } else if (record?.projectId && !record.uploadId) {
    // The archive was already uploaded; the old record only described extraction.
    clearRecord()
  }

  // Make the state "busy" before the first network round-trip: a person can hit send
  // immediately after choosing the file, and that send must wait for this upload.
  const token = { cancelled: false }
  starting = token
  uploadState = {
    ...blankState(),
    active: true,
    phase: 'uploading',
    name: file.name,
    size: file.size,
  }
  bindBeforeUnload()
  emit()

  try {
    let created
    let received = 0
    if (resumeRecord) {
      let info
      try {
        info = await requestJson(`api/uploads/${encodeURIComponent(resumeRecord.uploadId)}`)
      } catch (error) {
        if (error?.status === 404) {
          clearRecord()
          throw new Error('上次的上传已经被清理了，请重新选择文件上传。')
        }
        throw error
      }
      if (token.cancelled || starting !== token) return
      if (!info || info.name !== file.name || Number(info.size) !== Number(file.size)) {
        clearRecord()
        throw new Error('服务端记录的文件和这次选的不一样，请取消后重新上传。')
      }
      created = { uploadId: resumeRecord.uploadId, chunkSize: options.chunkSize || config.chunkSize || MAX_CHUNK }
      received = Number(info.received) || 0
    } else {
      created = await requestJson('api/uploads', {
        method: 'POST',
        body: { name: file.name, size: file.size, kind: 'project' },
      })
      if (token.cancelled || starting !== token) {
        // Cancelled while the create request was in flight: remove the staging file too.
        if (typeof created?.uploadId === 'string') {
          try {
            await requestJson(`api/uploads/${encodeURIComponent(created.uploadId)}`, { method: 'DELETE', body: {} })
          } catch {
            // The 24-hour cleanup will get it.
          }
        }
        return
      }
      if (!created || typeof created.uploadId !== 'string') throw new Error('后台没有返回上传编号。')
      saveRecord({
        uploadId: created.uploadId,
        projectId: null,
        name: file.name,
        size: file.size,
        lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
        phase: 'uploading',
      })
    }

    const offered = Number(created?.chunkSize)
    const chosen = options.chunkSize || config.chunkSize
    const chunkSize = Math.max(1, Math.floor(
      chosen ? Number(chosen) : Math.min(Number.isFinite(offered) && offered > 0 ? offered : MAX_CHUNK, MAX_CHUNK),
    ))

    starting = null
    uploadState = {
      ...blankState(),
      active: true,
      phase: 'uploading',
      name: file.name,
      size: file.size,
      sent: received,
      uploadId: created.uploadId,
      percent: file.size > 0 ? Math.min(90, (received / file.size) * 90) : 0,
    }
    speedSamples = [{ at: config.now(), sent: received }]
    current = {
      file,
      uploadId: created.uploadId,
      chunkSize,
      offset: received,
      opts: options,
      paused: false,
      cancelled: false,
      runId: 1,
      controller: null,
      wakeLock: null,
      projectId: null,
    }
    void acquireWakeLock()
    emit()
    await uploadLoop(current, 1)
  } catch (error) {
    if (token.cancelled) return
    if (starting === token) {
      starting = null
      if (current === null) {
        uploadState = blankState()
        unbindBeforeUnload()
        emit()
      }
    }
    throw error
  }
}

/** Stop after the in-flight chunk is aborted; progress is kept on the server. */
export function pause() {
  if (!current || uploadState.phase !== 'uploading') return
  pauseInternal()
}

/** Ask the server how many bytes it has, then continue from there. */
export async function resume() {
  const ctx = current
  if (!ctx || uploadState.phase !== 'paused') return
  let info
  try {
    info = await requestJson(`api/uploads/${encodeURIComponent(ctx.uploadId)}`)
  } catch (error) {
    if (error?.status === 404) {
      clearRecord()
      fail(new Error('这个上传已经过期了，请重新选择文件上传。'), { keepRecord: false })
      return
    }
    fail(error, { keepRecord: true })
    return
  }
  if (!info || Number(info.size) !== Number(ctx.file.size)) {
    clearRecord()
    fail(new Error('服务端的文件和这次选的不一样，请重新上传。'), { keepRecord: false })
    return
  }
  ctx.offset = Number(info.received) || 0
  ctx.paused = false
  ctx.runId += 1
  uploadState.sent = ctx.offset
  uploadState.phase = 'uploading'
  uploadState.active = true
  uploadState.error = null
  uploadState.notice = ''
  speedSamples = [{ at: config.now(), sent: ctx.offset }]
  setPercent()
  bindBeforeUnload()
  void acquireWakeLock()
  emit()
  await uploadLoop(ctx, ctx.runId)
}

/** Abort, delete the server-side staging file, and forget the record. */
export async function cancel() {
  if (starting) {
    starting.cancelled = true
    starting = null
  }
  const ctx = current
  const uploadId = ctx?.uploadId ?? readRecord()?.uploadId ?? null
  if (ctx) {
    ctx.cancelled = true
    ctx.runId += 1
    try {
      ctx.controller?.abort()
    } catch {
      // Nothing in flight.
    }
    releaseWakeLock(ctx)
    current = null
  }
  const hadRecord = readRecord() !== null
  clearRecord()
  unbindBeforeUnload()
  readyListeners = []
  uploadState = blankState()
  emit()
  if (uploadId) {
    try {
      await requestJson(`api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', body: {} })
    } catch {
      // The server may already have expired it; the local record is gone either way.
    }
  }
  if (!uploadId && !hadRecord) return
}

/* The shell owns its original object; overwrite these two methods in place. */
Object.assign(bus.upload, { state, subscribe })
