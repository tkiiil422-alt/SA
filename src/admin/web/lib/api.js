/**
 * API client. Paths are always relative ("api/...") so the page works under
 * any mount prefix such as /sa/. Writes carry the CSRF header and JSON body.
 */

export class ApiError extends Error {
  constructor(status, code, message, { issues = null, body = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.issues = issues
    this.body = body
  }
}

let unauthorizedHandler = null
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler
}

function queryString(params) {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function fallbackMessage(status) {
  if (status === 401) return '登录已失效，请重新登录。'
  if (status === 403) return '请求被拒绝，请刷新页面后重试。'
  if (status === 404) return '找不到请求的内容。'
  if (status === 409) return '当前状态不允许这个操作。'
  if (status === 429) return '操作太频繁，请稍后再试。'
  if (status >= 500) return '服务暂时出错了，请稍后重试。'
  return '请求没有成功，请重试。'
}

/**
 * Low-level request. Resolves with the parsed JSON body (or null for an empty
 * response). Rejects with ApiError, including a human message from the server.
 */
export async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    signal,
    headers = {},
    redirectOn401 = true,
  } = options
  const write = method !== 'GET' && method !== 'HEAD'
  const init = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...headers },
    signal,
  }
  if (write) {
    init.headers['Content-Type'] = 'application/json'
    init.headers['X-SA-Request'] = '1'
    init.body = JSON.stringify(body ?? {})
  }

  let response
  try {
    response = await fetch(path, init)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new ApiError(0, 'network_error', '连不上后台服务，请检查网络后重试。', { body: error })
  }

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    const payload = data && typeof data === 'object' ? data : {}
    const message = typeof payload.message === 'string' && payload.message
      ? payload.message
      : fallbackMessage(response.status)
    if (response.status === 401 && redirectOn401) unauthorizedHandler?.()
    throw new ApiError(response.status, payload.error ?? `http_${response.status}`, message, {
      issues: Array.isArray(payload.issues) ? payload.issues : null,
      body: data,
    })
  }
  return data
}

export function get(path, params, options = {}) {
  return request(`${path}${queryString(params)}`, { ...options, method: 'GET' })
}

export function post(path, body, options = {}) {
  return request(path, { ...options, method: 'POST', body })
}

export function put(path, body, options = {}) {
  return request(path, { ...options, method: 'PUT', body })
}

/** DELETE with the same JSON body and CSRF headers as POST. */
export function del(path, body, options = {}) {
  return request(path, { ...options, method: 'DELETE', body })
}

/** GET /api/me never redirects on 401: the shell handles that response itself. */
export function me() {
  return request('api/me', { redirectOn401: false })
}

/** Login errors are shown in the form, so no global redirect here either. */
export function login(password) {
  return post('api/login', { password }, { redirectOn401: false })
}

export function logout() {
  return post('api/logout', {}, { redirectOn401: false })
}

/**
 * A short-lived cache so the top bar and the overview page do not issue the
 * same request twice inside one polling tick. Inflight requests are shared.
 */
let overviewCache = { at: 0, value: null, inflight: null }
export function loadOverview({ maxAge = 900, force = false } = {}) {
  const now = Date.now()
  if (!force && overviewCache.value && now - overviewCache.at < maxAge) {
    return Promise.resolve(overviewCache.value)
  }
  if (overviewCache.inflight) return overviewCache.inflight
  const pending = get('api/overview')
    .then((value) => {
      overviewCache = { at: Date.now(), value, inflight: null }
      return value
    })
    .catch((error) => {
      overviewCache.inflight = null
      throw error
    })
  overviewCache.inflight = pending
  return pending
}

export function invalidateOverview() {
  overviewCache = { at: 0, value: null, inflight: null }
}
