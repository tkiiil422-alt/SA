/** Paths stay relative ("api/..."), so the console works at the root, under /next/ and behind a /sa/ proxy prefix. */
export const API = (path: string) => path
export class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
async function fail(r: Response): Promise<never> {
  let msg = String(r.status)
  try {
    const j = await r.json()
    if (j?.message) msg = j.message
    if (Array.isArray(j?.issues) && j.issues.length) msg += '：' + j.issues.map((i: any) => (i.path ? `${i.path} ` : '') + i.message).join('；')
  } catch { /* not json */ }
  if (r.status === 401) window.dispatchEvent(new Event('sa-401'))
  throw new HttpError(r.status, msg)
}
export async function get<T = any>(path: string): Promise<T> {
  const r = await fetch(API(path), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
  if (!r.ok) return fail(r)
  return r.json()
}
export async function post(path: string, body: unknown = {}) {
  const r = await fetch(API(path), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sa-request': '1' }, body: JSON.stringify(body) })
  if (!r.ok) return fail(r)
  return r.json().catch(() => ({}))
}
export async function put(path: string, body: unknown) {
  const r = await fetch(API(path), { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sa-request': '1' }, body: JSON.stringify(body) })
  if (!r.ok) return fail(r)
  return r.json().catch(() => ({}))
}
export async function del(path: string, body: unknown = {}) {
  const r = await fetch(API(path), { method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sa-request': '1' }, body: JSON.stringify(body) })
  if (!r.ok) return fail(r)
  return r.json().catch(() => ({}))
}
/** Chunked project upload: create → PUT chunks (resumes from the server's offset on 409) → finish. */
export async function uploadProject(file: File, name: string, onProgress: (done: number, total: number) => void): Promise<string> {
  const created = await post('api/uploads', { name: file.name, size: file.size, kind: 'project' })
  const id = created.uploadId as string
  const size = Math.max(256 * 1024, Number(created.chunkSize) || 4 * 1024 * 1024)
  let offset = 0
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + size))
    const r = await fetch(API(`api/uploads/${encodeURIComponent(id)}?offset=${offset}`), { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-sa-request': '1' }, body: chunk })
    if (r.status === 409) { const j = await r.json().catch(() => ({})); offset = Number(j.received) || 0; continue }
    if (!r.ok) return fail(r)
    const j = await r.json(); offset = Number(j.received) || offset + chunk.size
    onProgress(offset, file.size)
  }
  const done = await post(`api/uploads/${encodeURIComponent(id)}/finish`, name.trim() ? { projectName: name.trim() } : {})
  return done.projectId as string
}
