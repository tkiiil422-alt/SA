// @vitest-environment jsdom
/** Renders the new console in jsdom against a real runtime (fake Pi) and walks every page and the main actions. */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

const info = JSON.parse(readFileSync(process.env.SA_UI_INFO!, 'utf8')) as { url: string; password: string }
const nodeFetch = globalThis.fetch
let cookie = ''
const calls: string[] = []
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(String(input), info.url + '/')
  calls.push(`${init.method || 'GET'} ${u.pathname}`)
  const r = await nodeFetch(u, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } })
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!.endsWith('=') ? '' : sc.split(';')[0]!
  return r
}) as typeof fetch

const go = (h: string) => { location.hash = h; window.dispatchEvent(new HashChangeEvent('hashchange')) }
const noError = () => expect(document.body.textContent).not.toMatch(/读取失败|连不上后台/)

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  await import('../src/main.tsx')
})

describe('new console in a browser DOM against a real daemon', () => {
  it('logs in, sends a task, shows its steps, walks every page, logs out', async () => {
    const pw = await screen.findByPlaceholderText('管理口令', {}, { timeout: 5000 })
    fireEvent.change(pw, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await screen.findByText(/口令|错误|不对/, {}, { timeout: 5000 })
    fireEvent.change(pw, { target: { value: info.password } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await screen.findByRole('heading', { name: '今日' }, { timeout: 5000 })
    expect(cookie).toMatch(/^sa_session=/)

    go('#/new')
    const box = await screen.findByPlaceholderText(/想让它做什么/)
    fireEvent.change(box, { target: { value: '写个 hello.py' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(location.hash).toMatch(/^#\/tickets\/[0-9a-f]+/), { timeout: 5000 })
    await screen.findByRole('heading', { name: /hello/ }, { timeout: 8000 })
    fireEvent.click(await screen.findByRole('tab', { name: '过程' }))
    await screen.findByText('执行过程', { exact: false })
    await waitFor(() => expect(document.querySelectorAll('.steps li').length).toBeGreaterThan(0), { timeout: 10000 })
    expect(document.querySelectorAll('.steps li').length).toBeLessThanOrEqual(10)
    for (const t of ['结果', '文件', '会商', '信息']) { fireEvent.click(screen.getByRole('tab', { name: t })); await new Promise(r => setTimeout(r, 300)); noError() }
    fireEvent.click(screen.getByRole('tab', { name: '文件' }))
    await screen.findByText(/AGENTS\.md/, {}, { timeout: 5000 })
    noError()

    const reply = screen.getByRole('textbox')
    fireEvent.change(reply, { target: { value: '再加一行注释' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText(/已发送|已重新打开/, {}, { timeout: 5000 })

    for (const [hash, heading] of [['#/today', '今日'], ['#/tickets', '任务'], ['#/projects', '项目'], ['#/usage', '花费'], ['#/events', '事件'],
      ['#/decisions', '判断记录'], ['#/system', '系统'], ['#/connections', '连接'], ['#/secrets', '密钥'], ['#/novels', '书库'], ['#/settings', '设置'], ['#/councils', '会商'], ['#/fanqie', '番茄发布'], ['#/more', '更多']]) {
      go(hash!)
      await screen.findByRole('heading', { name: heading }, { timeout: 5000 })
      await waitFor(() => expect(document.body.textContent).not.toContain('加载中…'), { timeout: 5000 })
      noError()
    }

    go('#/tickets'); await screen.findByRole('heading', { name: '任务' })
    fireEvent.click(screen.getByRole('tab', { name: '全部' }))
    await waitFor(() => expect(document.querySelector('main')?.textContent || '').toMatch(/hello|写个/), { timeout: 8000 }).catch(e => { console.log('MAIN:', document.querySelector('main')?.textContent?.slice(0, 600)); throw e })

    for (const sec of ['models', 'policy', 'executor', 'feishu', 'github', 'email', 'preview', 'projects', 'council', 'novel', 'account']) {
      go(`#/settings/${sec}`)
      await waitFor(() => expect(document.querySelector('.set-title')).not.toBeNull(), { timeout: 5000 })
      await waitFor(() => expect(document.body.textContent).not.toContain('加载中…'), { timeout: 5000 })
      noError()
      expect(document.body.textContent).not.toContain('（JSON）')
    }
    go('#/settings/council'); await screen.findAllByText('需求分析师', { exact: false }, { timeout: 5000 })
    go('#/settings/budget'); await screen.findByLabelText(/每天上限/)
    fireEvent.change(screen.getByLabelText(/每天上限/), { target: { value: '321' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findAllByText('已保存', {}, { timeout: 5000 })
    const b = await (await globalThis.fetch('api/settings/budget')).json()
    expect(b.dailyUsd).toBe(321)

    go('#/secrets'); fireEvent.click(await screen.findByRole('button', { name: '新增' }))
    fireEvent.change(screen.getByPlaceholderText('API_TOKEN'), { target: { value: 'ui_test_key' } })
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: 'v1' } })
    fireEvent.click(screen.getAllByRole('button', { name: '保存' }).at(-1)!)
    await screen.findByText('UI_TEST_KEY', {}, { timeout: 5000 })
    go('#/more'); fireEvent.click((await screen.findAllByRole('button', { name: '退出登录' }))[0]!)
    await screen.findByPlaceholderText('管理口令', {}, { timeout: 5000 })
    expect(calls.every(c => !c.includes('/next/') && !c.includes('/legacy/'))).toBe(true)
  }, 60_000)
})
