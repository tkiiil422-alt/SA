/**
 * A small GitHub REST client for the console and the worker's `sa_github_pr` tool.
 *
 * The PAT is only ever sent in the `Authorization` header. Every returned message is scrubbed of it, so a GitHub error
 * body or a thrown fetch error can never echo the token back to a page, a worker or an event. `fetch` is injectable so
 * tests exercise the protocol without a network.
 */

export interface GithubClientOptions {
  apiBase: string
  token: string
  /** Repositories the client may touch, `owner/repo`; a PR to anything else is refused locally. */
  repos: readonly string[]
  fetch?: typeof fetch
}

export interface GithubRepoAccess {
  fullName: string
  push: boolean
}

export interface GithubTestResult {
  ok: boolean
  message: string
  login?: string
  repos?: GithubRepoAccess[]
}

export type GithubPrResult =
  | { ok: true; url: string; number: number }
  | { ok: false; message: string }

export interface GithubPrInput {
  repo: string
  head: string
  base: string
  title: string
  body: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const sameRepo = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** A Chinese failure message that names the HTTP status and, when GitHub gave one, its own message. */
function failure(status: number, body: unknown): string {
  const detail = isObject(body) && typeof body.message === 'string' ? body.message : ''
  const suffix = detail === '' ? '' : `：${detail}`
  if (status === 401) return 'GitHub 拒绝了令牌（401），请检查令牌是否有效或已过期。'
  if (status === 403) return `GitHub 拒绝了这个操作（403），请检查令牌权限${suffix}`
  if (status === 404) return `GitHub 找不到这个仓库（404）${suffix}`
  if (status === 422) return `GitHub 不接受这个请求（422）${suffix}`
  return `GitHub 接口返回了 ${status}${suffix}`
}

export class GithubClient {
  private readonly doFetch: typeof fetch
  private readonly token: string

  constructor(private readonly options: GithubClientOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch
    this.token = options.token
  }

  /** Remove the PAT from anything that leaves this class. */
  private scrub(text: string): string {
    return this.token === '' ? text : text.split(this.token).join('***')
  }

  private async request(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const base = this.options.apiBase.replace(/\/+$/, '')
    let response: Response
    try {
      response = await this.doFetch(`${base}${path}`, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers as Record<string, string> | undefined),
        },
      })
    } catch (error) {
      throw new Error(this.scrub(`连不上 GitHub：${describe(error)}`))
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  }

  /** Check the token with `GET /user`, then each whitelisted repository's push permission. Never throws. */
  async testConnection(repos: readonly string[] = this.options.repos): Promise<GithubTestResult> {
    if (this.token === '') return { ok: false, message: '请先填写 GitHub 令牌。' }
    try {
      const user = await this.request('/user')
      if (user.status !== 200 || !isObject(user.body)) {
        return { ok: false, message: this.scrub(failure(user.status, user.body)) }
      }
      const login = typeof user.body.login === 'string' ? user.body.login : ''
      const access: GithubRepoAccess[] = []
      for (const repo of repos) {
        try {
          const result = await this.request(`/repos/${repo}`)
          const permissions = isObject(result.body) && isObject(result.body.permissions) ? result.body.permissions : undefined
          access.push({ fullName: repo, push: result.status === 200 && permissions?.push === true })
        } catch {
          access.push({ fullName: repo, push: false })
        }
      }
      const noPush = access.filter(item => !item.push).map(item => item.fullName)
      const message = noPush.length === 0
        ? (repos.length === 0 ? '连接正常，还没有配置仓库白名单。' : '连接正常，白名单里的仓库都有推送权限。')
        : `连接正常，但这些仓库没有推送权限：${noPush.join('、')}`
      return { ok: true, message, ...(login === '' ? {} : { login }), repos: access }
    } catch (error) {
      return { ok: false, message: this.scrub(describe(error)) }
    }
  }

  /** Open a pull request in a whitelisted repository. Never throws; failures come back as `{ ok: false }`. */
  async createPullRequest(input: GithubPrInput): Promise<GithubPrResult> {
    if (this.token === '') return { ok: false, message: '还没有配置 GitHub 令牌。' }
    if (!this.options.repos.some(repo => sameRepo(repo, input.repo))) {
      return { ok: false, message: `仓库 ${input.repo} 不在白名单里，不能创建 PR。` }
    }
    if (input.head.trim() === '' || input.base.trim() === '') {
      return { ok: false, message: '创建 PR 需要 head 和 base 分支。' }
    }
    try {
      const result = await this.request(`/repos/${input.repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ head: input.head, base: input.base, title: input.title, body: input.body }),
      })
      if ((result.status === 200 || result.status === 201) && isObject(result.body)) {
        const url = typeof result.body.html_url === 'string' ? result.body.html_url : ''
        const number = typeof result.body.number === 'number' ? result.body.number : 0
        if (url !== '') return { ok: true, url, number }
      }
      return { ok: false, message: this.scrub(failure(result.status, result.body)) }
    } catch (error) {
      return { ok: false, message: this.scrub(describe(error)) }
    }
  }
}
