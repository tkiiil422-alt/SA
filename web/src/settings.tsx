import { useEffect, useRef, useState, type ReactNode } from 'react'
import { post, put } from './api'
import { usePoll } from './hooks'
import { toast, useAction, Empty, QrSvg, confirmAction, safeDecode, useMediaQuery } from './ui'

/* ---------- 基础表单件 ---------- */
type Ref = { provider: string; model: string } | null
const refKey = (r?: Ref | { provider?: string; model?: string }) => (r && r.provider && r.model ? `${r.provider}/${r.model}` : '')
const parseRef = (s: string): Ref => { const i = s.indexOf('/'); return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : null }
const segs = () => location.hash.replace(/^#\//, '').split('?')[0]!.split('/').slice(1).map(safeDecode)

const Hint = ({ children }: { children?: ReactNode }) => (children ? <small className="hint">{children}</small> : null)
function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="group"><h3>{title}</h3><Hint>{hint}</Hint>{children}</section>
}
function Check({ label, hint, v, set }: { label: string; hint?: string; v: any; set: (v: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={!!v} onChange={e => set(e.target.checked)} /><span><b>{label}</b><Hint>{hint}</Hint></span></label>
}
function Num({ label, hint, v, set, min, max, step }: { label: string; hint?: string; v: any; set: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(v ?? ''))
  useEffect(() => { if (Number(text) !== v) setText(String(v ?? '')) }, [v]) // eslint-disable-line react-hooks/exhaustive-deps
  return <label className="field"><span>{label}</span><Hint>{hint}</Hint>
    <input type="number" inputMode="decimal" min={min} max={max} step={step ?? 'any'} value={text}
      onChange={e => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) set(n) }} /></label>
}
function Text({ label, hint, v, set, mono, placeholder }: { label: string; hint?: string; v: any; set: (v: string) => void; mono?: boolean; placeholder?: string }) {
  return <label className="field"><span>{label}</span><Hint>{hint}</Hint><input className={mono ? 'mono' : ''} value={v ?? ''} placeholder={placeholder} onChange={e => set(e.target.value)} /></label>
}
function Area({ label, hint, v, set, rows = 4 }: { label: string; hint?: string; v: any; set: (v: string) => void; rows?: number }) {
  return <label className="field"><span>{label}</span><Hint>{hint}</Hint><textarea className="big" rows={rows} value={v ?? ''} onChange={e => set(e.target.value)} /></label>
}
function Select({ label, hint, v, set, options }: { label: string; hint?: string; v: any; set: (v: string) => void; options: [string, string][] }) {
  const opts = options.some(([k]) => k === v) || v == null ? options : [...options, [String(v), String(v)] as [string, string]]
  return <label className="field"><span>{label}</span><Hint>{hint}</Hint><select value={v ?? ''} onChange={e => set(e.target.value)}>{opts.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
}
function Lines({ label, hint, v, set, mono }: { label: string; hint?: string; v: string[]; set: (v: string[]) => void; mono?: boolean }) {
  const joined = (v || []).join('\n')
  const [text, setText] = useState(joined)
  useEffect(() => {
    const normalized = text.split('\n').map(s => s.trim()).filter(Boolean).join('\n')
    if (normalized !== joined) setText(joined)
  }, [joined]) // eslint-disable-line react-hooks/exhaustive-deps
  return <label className="field"><span>{label}</span><Hint>{hint || '一行一个'}</Hint>
    <textarea className={mono ? 'big mono' : 'big'} rows={Math.max(3, Math.min(10, (v || []).length + 1))} value={text}
      onChange={e => { setText(e.target.value); set(e.target.value.split('\n').map(s => s.trim()).filter(Boolean)) }} /></label>
}
function Secret({ label, isSet, tail, v, set }: { label: string; isSet?: boolean; tail?: string; v: any; set: (v: string) => void }) {
  return <label className="field"><span>{label}</span><Hint>{isSet ? `已设置${tail ? `（尾号 ${tail}）` : ''}，留空表示不改` : '未设置'}</Hint>
    <input type="password" autoComplete="new-password" value={v ?? ''} placeholder={isSet ? '••••••（不改就留空）' : ''} onChange={e => set(e.target.value)} /></label>
}
function RefSelect({ label, hint, v, set, options, nullLabel }: { label: string; hint?: string; v: Ref | undefined; set: (v: Ref) => void; options: [string, string][]; nullLabel?: string }) {
  const key = refKey(v ?? null)
  const opts: [string, string][] = [...(nullLabel !== undefined ? [['', nullLabel] as [string, string]] : []), ...options]
  if (key && !opts.some(([k]) => k === key)) opts.push([key, `${key}（未启用）`])
  return <label className="field"><span>{label}</span><Hint>{hint}</Hint>
    <select value={key} onChange={e => set(parseRef(e.target.value))}>{opts.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
}
function useModelOptions(): [string, string][] {
  const { d } = usePoll<any>('api/models', 600000)
  return (d?.items || []).map((m: any) => [m.ref, `${m.label || m.model}（${m.providerName}）`])
}
/** A list of editable cards with add / remove / reorder. */
function ListEdit<T>({ items, onChange, make, render, addLabel, title, empty }: {
  items: T[]; onChange: (v: T[]) => void; make: () => T; render: (item: T, upd: (patch: Partial<T>) => void, i: number) => ReactNode
  addLabel: string; title: (item: T, i: number) => string; empty?: string
}) {
  const upd = (i: number) => (patch: Partial<T>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const move = (i: number, d: number) => { const n = [...items]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); onChange(n) }
  return <div className="list">
    {!items.length && empty && <Empty>{empty}</Empty>}
    {items.map((item, i) => <details className="item" key={i} open={!title(item, i)}>
      <summary className="item__head"><b>{title(item, i) || '（未命名）'}</b>
        <span className="item__tools" onClick={e => e.preventDefault()}>
          {i > 0 && <button type="button" className="ghost small" aria-label="上移" onClick={() => move(i, -1)}>↑</button>}
          {i < items.length - 1 && <button type="button" className="ghost small" aria-label="下移" onClick={() => move(i, 1)}>↓</button>}
          <button type="button" className="ghost small danger" onClick={async () => { if (await confirmAction(`删除「${title(item, i) || '这一项'}」？`, { title: '删除条目', danger: true })) onChange(items.filter((_, j) => j !== i)) }}>删除</button>
        </span></summary>
      <div className="item__body">{render(item, upd(i), i)}</div>
    </details>)}
    <button type="button" className="addbtn" onClick={() => onChange([...items, make()])}>＋ {addLabel}</button>
  </div>
}

type FormProps = { f: any; set: (patch: any) => void; reload?: () => void; dirty?: boolean }

/* ---------- 各分区表单 ---------- */
function BudgetForm({ f, set }: FormProps) {
  return <Group title="费用上限" hint="达到上限后，任务会停下来问你要不要提高上限。0 表示不限。">
    <Check label="启用费用上限" hint="关闭时只记账，不拦截" v={f.enabled} set={v => set({ enabled: v })} />
    <div className="cols">
      <Num label="单张任务上限（美元）" v={f.perTicketUsd} min={0} set={v => set({ perTicketUsd: v })} />
      <Num label="每天上限（美元）" v={f.dailyUsd} min={0} set={v => set({ dailyUsd: v })} />
    </div>
  </Group>
}

function PolicyForm({ f, set }: FormProps) {
  const ops = (key: 'allowedOperators' | 'feishuOperators', title: string, hint: string) => <Group title={title} hint={hint}>
    <ListEdit items={f[key] || []} onChange={v => set({ [key]: v })} make={() => ({ id: '', name: '' })} addLabel="添加操作员"
      title={(o: any) => o.name ? `${o.name}（${o.id}）` : o.id} empty="还没有操作员。"
      render={(o: any, upd) => <div className="cols"><Text label="ID" mono v={o.id} set={v => upd({ id: v })} /><Text label="名字" v={o.name} set={v => upd({ name: v })} /></div>} />
  </Group>
  return <>
    <Group title="接单">
      <Check label="暂停接单" hint="暂停后新消息不会被接成任务，进行中的任务不受影响" v={f.paused} set={v => set({ paused: v })} />
      <Select label="受理方式" v={f.acceptMode} set={v => set({ acceptMode: v })}
        options={[['auto', '自动：判断后直接开工'], ['observe', '观察：只记录判断，不开工'], ['off', '关闭自动判断']]} />
      <Num label="判断超时（秒）" v={f.evalTimeoutSeconds} min={1} set={v => set({ evalTimeoutSeconds: v })} />
    </Group>
    <Group title="受理规则" hint="AI 按这些规则判断一条消息该不该接。">
      <ListEdit items={f.rules || []} onChange={v => set({ rules: v })} addLabel="添加规则"
        make={() => ({ id: `rule-${Date.now().toString(36)}`, name: '', enabled: true, instruction: '' })}
        title={(r: any) => `${r.enabled ? '' : '［停用］'}${r.name}`}
        render={(r: any, upd) => <>
          <div className="cols"><Text label="名称" v={r.name} set={v => upd({ name: v })} /><Text label="ID" hint="字母、数字、-、_" mono v={r.id} set={v => upd({ id: v })} /></div>
          <Check label="启用" v={r.enabled} set={v => upd({ enabled: v })} />
          <Area label="规则说明" rows={5} v={r.instruction} set={v => upd({ instruction: v })} />
        </>} />
    </Group>
    {ops('allowedOperators', '后台 / 命令行操作员', '这些人发的指令会被当作明确授权。')}
    {ops('feishuOperators', '飞书操作员', '填飞书用户的 open_id。')}
  </>
}

function ExecutorForm({ f, set }: FormProps) {
  return <Group title="执行环境" hint="每张任务在独立容器里运行。改同时运行数立即生效，不打断正在跑的任务。">
    <div className="cols">
      <Num label="同时运行的任务数" hint="1–8；4 核主机建议不超过 3" min={1} max={8} step={1} v={f.maxWorkers} set={v => set({ maxWorkers: v })} />
      <Text label="每个任务的 CPU" hint="如 1、1.5" v={f.cpus} set={v => set({ cpus: v })} />
      <Text label="每个任务的内存" hint="如 4g、512m" v={f.memory} set={v => set({ memory: v })} />
    </div>
    <Text label="容器镜像" mono v={f.image} set={v => set({ image: v })} />
  </Group>
}

const DEFAULT_PRICE = { input: 0, cacheRead: 0, output: 0 }
function ModelEdit({ m, upd, providerId, isNew }: { m: any; upd: (p: any) => void; providerId: string; isNew: boolean }) {
  const { busy, run } = useAction()
  const price = m.price || DEFAULT_PRICE
  return <>
    <div className="cols">
      <Text label="模型 ID" mono v={m.id} set={v => upd({ id: v })} />
      <Text label="显示名" v={m.label} set={v => upd({ label: v })} />
    </div>
    <Text label="说明" hint="发任务时选模型会看到" v={m.description} set={v => upd({ description: v })} />
    <div className="cols">
      <Num label="输入价格" hint="美元 / 百万 token" min={0} v={price.input} set={v => upd({ price: { ...price, input: v } })} />
      <Num label="缓存命中价格" min={0} v={price.cacheRead} set={v => upd({ price: { ...price, cacheRead: v } })} />
      <Num label="输出价格" min={0} v={price.output} set={v => upd({ price: { ...price, output: v } })} />
    </div>
    <div className="cols">
      <Num label="上下文长度" step={1} v={m.contextWindow} set={v => upd({ contextWindow: v })} />
      <Num label="最大输出 token" step={1} v={m.maxTokens} set={v => upd({ maxTokens: v })} />
    </div>
    <div className="cols">
      <Check label="推理模型" v={m.reasoning} set={v => upd({ reasoning: v })} />
      <Check label="能看图" v={m.vision} set={v => upd({ vision: v })} />
      <Check label="允许自动挑选" v={m.autoPick} set={v => upd({ autoPick: v })} />
    </div>
    {!isNew && m.id && <button type="button" disabled={busy} onClick={() => run(async () => {
      const r = await post('api/settings/models/test', { provider: providerId, model: m.id }); toast(r?.message || (r?.ok ? '调用成功' : '调用失败'), !r?.ok)
    })}>{busy ? '测试中…' : '测试这个模型'}</button>}
  </>
}
function ProviderEdit({ p, upd }: { p: any; upd: (patch: any) => void }) {
  const { busy, run } = useAction()
  const discover = () => run(async () => {
    const r = await post('api/settings/models/discover', {
      ...(p._new ? {} : { provider: p.id }), api: p.api, baseUrl: p.baseUrl, ...(p.apiKey ? { apiKey: p.apiKey } : {}), ...(p.sessionHeader ? { sessionHeader: p.sessionHeader } : {}),
    })
    if (!r?.ok) { toast(r?.message || '获取失败', true); return }
    const have = new Set((p.models || []).map((m: any) => m.id))
    const add = (r.models || []).filter((m: any) => !have.has(m.id)).map((m: any) => ({
      id: m.id, label: m.label || '', description: '', reasoning: !!m.reasoning, vision: !!m.vision,
      contextWindow: m.contextWindow || 1_000_000, maxTokens: m.maxTokens || 131_072, autoPick: true, price: m.price || DEFAULT_PRICE,
    }))
    upd({ models: [...(p.models || []), ...add] })
    toast(add.length ? `新增 ${add.length} 个模型，记得保存` : '没有新模型')
  })
  return <>
    <div className="cols">
      <Text label="名称" v={p.name} set={v => upd({ name: v })} />
      <Text label="ID" hint={p._new ? '小写字母、数字、-；保存后不能改' : '保存后不能改'} mono v={p.id} set={v => { if (p._new) upd({ id: v }) }} />
    </div>
    <Check label="启用这个服务商" v={p.enabled} set={v => upd({ enabled: v })} />
    <Select label="接口类型" v={p.api} set={v => upd({ api: v })} options={[['openai-completions', 'OpenAI 兼容'], ['anthropic-messages', 'Anthropic Messages']]} />
    <Text label="接口地址" mono placeholder="https://api.example.com" v={p.baseUrl} set={v => upd({ baseUrl: v })} />
    <Secret label="API Key" isSet={p.apiKeySet} tail={p.apiKeyTail} v={p.apiKey} set={v => upd({ apiKey: v })} />
    <div className="cols">
      <Text label="会话头（可选）" hint="有的网关按这个请求头把同一任务路由到同一后端，保留缓存" mono v={p.sessionHeader} set={v => upd({ sessionHeader: v })} />
      <Num label="单次请求体上限（KB，0=不限）" hint="部分中转网关会在约 192KB 处静默截断末尾消息导致总控重复回答旧问题；填入网关安全上限（如 160）后自动从最旧历史裁剪并压缩，始终保住最新提问" min={0} max={102400} step={16} v={p.maxPromptKb ?? 0} set={v => upd({ maxPromptKb: Math.max(0, Math.round(v)) })} />
    </div>
    <div className="headrow"><h4>模型 <small>{(p.models || []).length}</small></h4>
      <button type="button" disabled={busy || !p.baseUrl} onClick={discover}>{busy ? '获取中…' : '从接口获取模型列表'}</button></div>
    <ListEdit items={p.models || []} onChange={v => upd({ models: v })} addLabel="手动添加模型"
      make={() => ({ id: '', label: '', description: '', reasoning: false, vision: false, contextWindow: 1_000_000, maxTokens: 131_072, autoPick: true, price: { ...DEFAULT_PRICE } })}
      title={(m: any) => m.label ? `${m.label}（${m.id}）` : m.id}
      render={(m: any, mu) => <ModelEdit m={m} upd={mu} providerId={p.id} isNew={!!p._new} />} />
  </>
}
function ModelsForm({ f, set }: FormProps) {
  const providers: any[] = f.providers || []
  const opts: [string, string][] = providers.filter(p => p.enabled).flatMap(p => (p.models || []).filter((m: any) => m.id).map((m: any) => [`${p.id}/${m.id}`, `${m.label || m.id}（${p.name}）`] as [string, string]))
  const r = f.routing || {}
  const a = r.assessor || {}
  const setR = (patch: any) => set({ routing: { ...r, ...patch } })
  return <>
    <Group title="默认用哪个模型">
      <RefSelect label="默认执行模型" hint="任务没指定模型时用它" v={r.worker} options={opts} set={v => v && setR({ worker: v })} />
      <Check label="让它自己挑模型" hint="开启后会按任务难度在“允许自动挑选”的模型里选" v={r.autoSelect} set={v => setR({ autoSelect: v })} />
      <Check label="开工前先分析任务" hint="用一个模型先判断消息该不该接、怎么接" v={a.enabled} set={v => setR({ assessor: { ...a, enabled: v } })} />
      {a.enabled && <div className="cols">
        <RefSelect label="分析用的模型" v={{ provider: a.provider, model: a.model }} options={opts} set={v => v && setR({ assessor: { ...a, ...v } })} />
        <Num label="分析超时（秒）" min={5} max={120} step={1} v={a.timeoutSec} set={v => setR({ assessor: { ...a, timeoutSec: v } })} />
      </div>}
    </Group>
    <Group title="AI 服务商" hint="改了地址或密钥后先保存，再点“测试这个模型”。">
      <ListEdit items={providers} onChange={v => set({ providers: v })} addLabel="添加服务商"
        make={() => ({ _new: true, id: '', name: '', api: 'openai-completions', baseUrl: '', apiKey: '', sessionHeader: '', enabled: true, models: [] })}
        title={(p: any) => p.name ? `${p.enabled ? '' : '［停用］'}${p.name}（${(p.models || []).length} 个模型）` : ''}
        render={(p: any, upd) => <ProviderEdit p={p} upd={upd} />} />
    </Group>
  </>
}

function FeishuForm({ f, set }: FormProps) {
  return <>
    <Group title="飞书机器人" hint="在飞书开放平台创建应用后填写。">
      <Check label="启用飞书" v={f.enabled} set={v => set({ enabled: v })} />
      <Select label="接收方式" hint="使用长连接时，请在飞书开放平台「事件与回调 → 回调配置」中也选择「使用长连接接收回调」并勾选「卡片回传交互（card.action.trigger）」，即可在飞书里直接点击按钮一键确认高危操作、DAG 审批与密钥授权。" v={f.mode} set={v => set({ mode: v })} options={[['ws', '长连接（推荐，不需要公网回调地址）'], ['webhook', 'HTTP 回调']]} />
      <Select label="群聊里" v={f.groupMode} set={v => set({ groupMode: v })} options={[['mention', '@ 它才响应'], ['all', '所有消息都看']]} />
      <Select label="私聊消息处理方式" hint="选「总控 AI 助手」后，允许名单里的人私聊机器人即可自由对话、查进度/花费、智能派单并接收任务主动汇报；群聊仍按原方式直接建单。" v={f.routingMode || 'direct'} set={v => set({ routingMode: v })} options={[['director', '总控 AI 助手（对话、查数据、派单、主动汇报）'], ['direct', '直接建工单（原方式）']]} />
      <Text label="App ID" mono v={f.appId} set={v => set({ appId: v })} />
      <Text label="接口地址" mono v={f.apiBase} set={v => set({ apiBase: v })} />
    </Group>
    <Group title="凭据">
      <Secret label="App Secret" isSet={f.appSecretSet} v={f.appSecret} set={v => set({ appSecret: v })} />
      <Secret label="Verification Token" isSet={f.verificationTokenSet} v={f.verificationToken} set={v => set({ verificationToken: v })} />
      <Secret label="Encryption Key" isSet={f.encryptKeySet} v={f.encryptKey} set={v => set({ encryptKey: v })} />
    </Group>
  </>
}
function QqForm({ f, set }: FormProps) {
  const { d: st, reload: reloadSt } = usePoll<any>('api/settings/qq/status', 5000)
  const { busy, run } = useAction()
  const stateLabel: Record<string, string> = { off: '未连接', connecting: '连接中…', connected: '已连接', error: '连接异常' }
  return <>
    <Group title="QQ 官方机器人（q.qq.com API v2）" hint="在 QQ 开放平台创建机器人并拿到 AppID / AppSecret 即可接入，原生支持按钮点击确认与选择、自动优化手机端阅读排版。">
      {st && (
        <div className="alert" data-lv={st.state === 'error' ? 'error' : st.state === 'connected' ? 'info' : 'warn'}>
          <b>实时状态：{stateLabel[st.state] || st.state}</b>（{st.mode === 'webhook' ? 'HTTP Webhook' : 'WebSocket 长连接'} · 收 {st.received ?? 0} / 发 {st.sent ?? 0} 条{st.richDisabled ? ' · 高阶按钮未授权，已自动切换纯文本优化排版' : ''}）
          {st.lastError && <div style={{ marginTop: 4 }}>{st.lastError}</div>}
          <div style={{ marginTop: 6 }}>
            <button type="button" className="ghost small" disabled={busy} onClick={() => run(async () => { await post('api/settings/qq/reconnect', {}); reloadSt() }, '已重建 QQ 连接')}>重建连接</button>
          </div>
        </div>
      )}
      <Check label="启用 QQ 机器人" v={f.enabled} set={v => set({ enabled: v })} />
      <Select
        label="接入方式"
        hint={f.mode === 'webhook'
          ? '请在 QQ 开放平台「开发设置 → 事件订阅」配置 Webhook 地址：https://你的公网域名/qq/events（已内置 Ed25519 op=13 验证与签名校验）。'
          : '长连接模式下程序主动连向 QQ 官方网关，无需公网域名与 HTTPS 证书，开箱即用。'}
        v={f.mode || 'ws'}
        set={v => set({ mode: v })}
        options={[['ws', 'WebSocket 长连接（推荐，免公网地址）'], ['webhook', 'HTTP Webhook 回调（/qq/events）']]}
      />
      <div className="cols">
        <Text label="App ID" mono placeholder="例如：102123456" v={f.appId} set={v => set({ appId: v })} />
        <Secret label="App Secret（clientSecret）" isSet={f.appSecretSet} v={f.appSecret} set={v => set({ appSecret: v })} />
      </div>
      <div className="cols">
        <Select label="消息处理方式" v={f.routingMode || 'director'} set={v => set({ routingMode: v })} options={[['director', '总控 AI 助手（对话、按钮审批、主动汇报）'], ['direct', '直接建工单']]} />
        <Select label="QQ 群里触发方式" v={f.groupMode || 'mention'} set={v => set({ groupMode: v })} options={[['mention', '@机器人时触发（推荐）'], ['all', '读取群内全部消息']]} />
      </div>
      <Check label="启用原生可点击交互按钮与智能选项按钮" hint="发送高危确认、DAG 审批或识别到多选一提问时，自动附带可点击 QQ 按钮；若机器人尚未获官方按钮权限，网关拒绝后会自动降级为纯文本优化排版重发，绝不丢消息。" v={f.interactiveButtons !== false} set={v => set({ interactiveButtons: v })} />
      <Check label="沙箱环境" hint="仅用于 QQ 开放平台沙箱联调；正式上线请关闭" v={f.sandbox} set={v => set({ sandbox: v })} />
      <Lines label="允许访问的用户 openid 白名单（可选）" hint="一行一个 user_openid；留空表示允许所有收到消息的用户。私聊机器人发 /状态 后可在总控会话列表查看对应 openid。" mono v={f.allowedUsers || []} set={v => set({ allowedUsers: v })} />
    </Group>
    <Group title="高阶模板与网关参数（可选）" hint="仅当你在 QQ 开放平台申请并审核通过了自定义 Markdown/Keyboard 模板时填写；留空将使用内置动态按钮与无感纯文本降级。">
      <div className="cols">
        <Text label="Markdown 模板 ID（可选）" mono v={f.markdownTemplateId} set={v => set({ markdownTemplateId: v })} />
        <Text label="Keyboard 按钮模板 ID（可选）" mono v={f.keyboardTemplateId} set={v => set({ keyboardTemplateId: v })} />
      </div>
      <Text label="接口地址" mono v={f.apiBase} set={v => set({ apiBase: v })} />
    </Group>
  </>
}
function GithubForm({ f, set }: FormProps) {
  return <Group title="GitHub" hint="让 AI 拉代码、推分支、开 PR。令牌建议用 fine-grained PAT，只授权下面这些仓库。">
    <Check label="启用 GitHub" v={f.enabled} set={v => set({ enabled: v })} />
    <Lines label="允许的仓库" hint="一行一个，格式 owner/repo" mono v={f.repos || []} set={v => set({ repos: v })} />
    <div className="cols">
      <Text label="默认目标分支" v={f.defaultBase} set={v => set({ defaultBase: v })} />
      <Text label="API 地址" mono v={f.apiBase} set={v => set({ apiBase: v })} />
    </div>
    <Secret label="访问令牌" isSet={f.tokenSet} v={f.token} set={v => set({ token: v })} />
  </Group>
}
const EMAIL_PRESET_OPTS: [string, string][] = [
  ['gmail', 'Gmail（imap.gmail.com）'],
  ['qq', 'QQ 邮箱（imap.qq.com · 需开启 IMAP 并填授权码）'],
  ['163', '网易 163 邮箱（imap.163.com · 需填客户端授权码）'],
  ['outlook', 'Outlook / Office 365（STARTTLS 587）'],
  ['exmail', '腾讯企业邮（imap.exmail.qq.com）'],
  ['alimail', '阿里企业邮（imap.qiye.aliyun.com）'],
  ['custom', '自定义 IMAP / SMTP 服务器'],
]
function EmailForm({ f, set }: FormProps) {
  const custom = f.preset === 'custom'
  return <>
    <Group title="邮箱连接（通用 IMAP / SMTP）" hint="支持 Gmail、QQ、163、Outlook、企业邮与自建邮箱；可双向收指令回结果，也支持主动发邮件与安全报告推送。">
      <Check label="启用邮箱" v={f.enabled} set={v => set({ enabled: v })} />
      <Select label="邮箱服务商预设" v={f.preset || 'gmail'} set={v => set({ preset: v })} options={EMAIL_PRESET_OPTS} />
      <div className="cols">
        <Text label="邮箱地址" mono placeholder="you@example.com" v={f.address} set={v => set({ address: v })} />
        <Text label="发件显示名" placeholder="SuperAgent" v={f.displayName} set={v => set({ displayName: v })} />
      </div>
      <Secret label="应用专用密码 / 授权码" isSet={f.passwordSet} v={f.password} set={v => set({ password: v })} />
      {custom && <>
        <div className="cols">
          <Text label="IMAP 主机" mono placeholder="imap.example.com" v={f.imapHost} set={v => set({ imapHost: v })} />
          <Num label="IMAP 端口" min={1} max={65535} step={1} v={f.imapPort ?? 993} set={v => set({ imapPort: v })} />
        </div>
        <Check label="IMAP 启用 SSL/TLS" v={f.imapSecure ?? true} set={v => set({ imapSecure: v })} />
        <div className="cols">
          <Text label="SMTP 主机" mono placeholder="smtp.example.com" v={f.smtpHost} set={v => set({ smtpHost: v })} />
          <Num label="SMTP 端口" min={1} max={65535} step={1} v={f.smtpPort ?? 465} set={v => set({ smtpPort: v })} />
        </div>
        <Check label="SMTP 启用 SSL/TLS（587 STARTTLS 请取消勾选）" v={f.smtpSecure ?? true} set={v => set({ smtpSecure: v })} />
      </>}
    </Group>
    <Group title="个人收件箱保护与过滤" hint="连接个人常用邮箱时建议设置主题触发词，且不要将普通未读邮件标为已读。">
      <Lines label="允许的发件人" hint="一行一个邮箱地址；只有这些人发的邮件会被当作指令处理" mono v={f.allowedSenders || []} set={v => set({ allowedSenders: v })} />
      <div className="cols">
        <Text label="监控文件夹" hint="默认 INBOX，也可填专设文件夹名" mono v={f.folder || 'INBOX'} set={v => set({ folder: v })} />
        <Text label="主题触发关键词（可选）" hint="如 [SA] 或 superagent；留空则处理白名单发件人的全部未读" v={f.subjectPrefix || ''} set={v => set({ subjectPrefix: v })} />
      </div>
      <Check label="保护个人收件箱：忽略的普通邮件保持未读" hint="推荐开启，避免把非指令未读邮件标为已读" v={f.markIgnoredSeen === false} set={v => set({ markIgnoredSeen: !v })} />
      <div className="cols">
        <Num label="检查间隔（秒）" min={15} max={3600} step={1} v={f.pollSeconds} set={v => set({ pollSeconds: v })} />
        <Num label="附件上限（MB）" min={1} max={25} step={1} v={f.maxAttachmentMb} set={v => set({ maxAttachmentMb: v })} />
      </div>
    </Group>
  </>
}

const WECHAT_MODE_OPTS: [string, string][] = [
  ['ilink', '个人微信插件扫码直连（推荐 · 手机微信扫二维码即连，官方 iLink 长轮询免公网）'],
  ['wecom', '企业微信自建应用（企业微信后台开启微信插件）'],
  ['mp', '微信公众号 / 服务号（回调收指令 + 客服消息回复）'],
  ['webhook', '微信群机器人 / 个人微信桥接网关（企微机器人、Server酱、PushPlus 或 Wechaty/GeWeChat）'],
]
const WECHAT_ROUTE_OPTS: [string, string][] = [
  ['director', '总控 AI 助手（推荐 · 多轮对话理解需求、查全平台数据、自动派单与汇报）'],
  ['direct', '直通工单模式（旧版行为 · 每条微信消息直接进入工单队列）'],
]
const DIRECTOR_NOTIFY_OPTS: [string, string][] = [
  ['all', '全平台所有任务的重要动态（完成、失败、阻塞提问、预算熔断、密钥审批、会商结论）'],
  ['wechat_only', '仅汇报通过微信总控派发或跟进过的任务'],
  ['off', '关闭主动推送（仅写入总控记忆，等你主动问时再回答）'],
]

function WechatIlinkCard({ onBound }: { onBound?: (userId?: string) => void }) {
  const [fastPoll, setFastPoll] = useState(false)
  const [localQr, setLocalQr] = useState<any>(null)
  const [verifyCode, setVerifyCode] = useState('')
  const autoStarted = useRef(false)
  const prevStatus = useRef('')
  const qrPoll = usePoll<any>('api/settings/wechat/qr/status', fastPoll ? 1500 : 8000)
  const { busy, run } = useAction()
  const qr = qrPoll.d?.qr || localQr
  const st = qrPoll.d?.status
  const bound = Boolean(st?.ilink?.bound)
  const waitingScan = qr && (qr.status === 'waiting' || qr.status === 'scanned' || qr.status === 'need_verifycode')

  useEffect(() => {
    setFastPoll(Boolean(waitingScan))
    if (qr?.status === 'confirmed' && prevStatus.current !== 'confirmed') {
      prevStatus.current = 'confirmed'
      onBound?.(qr.userId || st?.ilink?.userId)
    } else if (qr?.status && qr.status !== 'confirmed') {
      prevStatus.current = qr.status
    }
  }, [waitingScan, qr?.status, qr?.userId, st?.ilink?.userId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!qrPoll.d || autoStarted.current) return
    autoStarted.current = true
    if (!qrPoll.d.status?.ilink?.bound && !qrPoll.d.qr?.qrSvgDataUrl) {
      post('api/settings/wechat/qr/start', { force: false })
        .then((r: any) => { if (r?.qr) { setLocalQr(r.qr); setFastPoll(true); qrPoll.reload() } })
        .catch(() => undefined)
    }
  }, [qrPoll.d]) // eslint-disable-line react-hooks/exhaustive-deps

  const startQr = (force: boolean) => run(async () => {
    prevStatus.current = ''
    const r = await post('api/settings/wechat/qr/start', { force })
    if (r?.qr) setLocalQr(r.qr)
    setFastPoll(true)
    qrPoll.reload()
  }, force ? '二维码已刷新，请用手机微信扫描' : '请用手机微信扫描下方二维码')

  const submitCode = () => run(async () => {
    const r = await post('api/settings/wechat/qr/verify', { code: verifyCode.trim() })
    if (r?.qr) setLocalQr(r.qr)
    setVerifyCode('')
    qrPoll.reload()
  }, '已提交配对码')

  const unbind = async () => {
    if (!await confirmAction('确定断开当前绑定的个人微信并清除登录凭据？', { title: '断开个人微信', danger: true, okLabel: '确认断开' })) return
    await run(async () => {
      await post('api/settings/wechat/qr/logout', {})
      prevStatus.current = ''
      setLocalQr(null)
      qrPoll.reload()
    }, '已断开个人微信连接')
  }

  return <Group title="个人微信扫码直连（微信插件 / iLink）" hint="无需注册企业微信或公众号，无需公网 IP 与回调地址。用手机个人微信扫一扫下方二维码即可直接在微信里收发消息。">
    {bound && <div className="card" style={{ marginBottom: 12 }}>
      <p><b>✅ 已连接个人微信</b></p>
      <p className="meta mono">Bot ID：{st?.ilink?.accountId || '—'}{st?.ilink?.userId ? ` · 微信用户：${st.ilink.userId}` : ''}</p>
      {st?.ilink?.pausedMinutes && <p className="warn">登录凭据已失效（冷却剩余 {st.ilink.pausedMinutes} 分钟），请点击下方「重新扫码连接」。</p>}
      <div className="actions" style={{ marginTop: 10 }}>
        <button type="button" disabled={busy} onClick={() => startQr(true)}>重新扫码换绑</button>
        <button type="button" className="danger" disabled={busy} onClick={unbind}>断开连接</button>
      </div>
    </div>}

    {!bound && <div className="actions" style={{ marginBottom: 12 }}>
      <button type="button" className="primary" disabled={busy} onClick={() => startQr(Boolean(qr?.qrSvgDataUrl))}>
        {busy ? '正在获取二维码…' : qr?.qrSvgDataUrl ? '刷新二维码' : '生成扫码二维码'}
      </button>
    </div>}

    {qr?.qrSvgDataUrl && qr.status !== 'confirmed' && <div className="card" style={{ textAlign: 'center', padding: '18px 16px', marginBottom: 12 }}>
      <QrSvg dataUrl={qr.qrSvgDataUrl} size={220} alt="个人微信扫码连接二维码" />
      <p style={{ marginTop: 10, fontWeight: 600 }}>{qr.message || '请打开手机微信「扫一扫」扫描上方二维码'}</p>
      {qr.qrcodeUrl && <p className="meta" style={{ wordBreak: 'break-all' }}>备用扫码链接：<a href={qr.qrcodeUrl} target="_blank" rel="noopener">{qr.qrcodeUrl}</a></p>}
      {qr.status === 'need_verifycode' && <div className="quick" style={{ maxWidth: 320, margin: '10px auto 0' }}>
        <input className="mono" value={verifyCode} onChange={e => setVerifyCode(e.target.value)} placeholder="输入手机微信显示的数字" onKeyDown={e => { if (e.key === 'Enter' && verifyCode.trim()) submitCode() }} />
        <button type="button" className="primary" disabled={busy || !verifyCode.trim()} onClick={submitCode}>确认配对码</button>
      </div>}
      {(qr.status === 'expired' || qr.status === 'error') && <div style={{ marginTop: 10 }}>
        <button type="button" className="primary" disabled={busy} onClick={() => startQr(true)}>重新获取二维码</button>
      </div>}
    </div>}

    {!qr?.qrSvgDataUrl && !bound && qr?.message && <p className="meta">{qr.message}</p>}
  </Group>
}

function WechatForm({ f, set, reload, dirty }: FormProps) {
  const mode = f.mode || 'ilink'
  const callbackUrl = `${location.origin}/wechat/events`
  return <>
    <Group title="微信连接" hint="连接你的微信：随时在手机微信下指令、查结果、接收任务完成与红队高危漏洞告警。">
      <Check label="启用微信" v={f.enabled} set={v => set({ enabled: v })} />
      <Select label="接入方式" v={mode} set={v => {
        const patch: Record<string, unknown> = { mode: v }
        if (v === 'mp' && (!f.apiBase || f.apiBase === 'https://qyapi.weixin.qq.com')) patch.apiBase = 'https://api.weixin.qq.com'
        if (v === 'wecom' && (!f.apiBase || f.apiBase === 'https://api.weixin.qq.com')) patch.apiBase = 'https://qyapi.weixin.qq.com'
        set(patch)
      }} options={WECHAT_MODE_OPTS} />
      <Select label="消息处理方式" hint="开启「总控 AI 助手」后可在微信里自由聊天、查进度/花费/项目/小说并智能派单；发 /直通 可临时直建工单。" v={f.routingMode || 'director'} set={v => set({ routingMode: v })} options={WECHAT_ROUTE_OPTS} />
      <Check label="任务完成/结束时自动推送结果到微信" hint="直通模式下启用；总控模式下由「设置 → 总控助手」的主动汇报策略接管" v={f.notifyOnComplete ?? true} set={v => set({ notifyOnComplete: v })} />
      {mode !== 'ilink' && <div className="field">
        <span>消息回调地址（配置到企业微信/公众号或桥接网关）</span>
        <div className="quick" style={{ marginTop: 6 }}>
          <input className="mono" readOnly value={callbackUrl} />
          <button type="button" onClick={() => navigator.clipboard?.writeText(callbackUrl).then(() => toast('已复制回调地址'), () => toast('复制失败', true))}>复制</button>
        </div>
      </div>}
    </Group>

    {mode === 'ilink' && <>
      <WechatIlinkCard onBound={uid => {
        if (!dirty && reload) { reload(); return }
        const list: string[] = Array.isArray(f.allowedUsers) ? f.allowedUsers : []
        set({ enabled: true, mode: 'ilink', ...(uid && !list.includes(uid) ? { allowedUsers: [...list, uid] } : {}) })
      }} />
      <Group title="服务器中继出口（可选）" hint="内网主机可通过固定公网服务器 HTTPS 反代转发 iLink 扫码、轮询与发信请求；留空则直连 ilinkai.weixin.qq.com。">
        <Text label="iLink 中继地址（可选）" mono placeholder="https://175.178.18.140/sa-ilink-relay" v={f.ilinkRelayUrl} set={v => set({ ilinkRelayUrl: v })} />
        <Secret label="iLink 中继密钥（可选，X-Ilink-Relay-Token）" isSet={f.ilinkRelayTokenSet} v={f.ilinkRelayToken} set={v => set({ ilinkRelayToken: v })} />
      </Group>
    </>}

    {mode === 'wecom' && <Group title="企业微信自建应用凭据" hint="在企业微信管理后台创建自建应用后，开启「微信插件」扫码关注，即可在个人微信里直接收发消息。">
      <div className="cols">
        <Text label="企业 ID（Corp ID）" mono v={f.corpId} set={v => set({ corpId: v })} />
        <Text label="应用 AgentId" mono v={f.agentId} set={v => set({ agentId: v })} />
      </div>
      <Secret label="应用 Secret（CorpSecret）" isSet={f.corpSecretSet} v={f.corpSecret} set={v => set({ corpSecret: v })} />
      <Secret label="回调 Token（可选，用于接收消息）" isSet={f.callbackTokenSet} v={f.callbackToken} set={v => set({ callbackToken: v })} />
      <Secret label="回调 EncodingAESKey（43 位，用于加密回调）" isSet={f.encodingAesKeySet} v={f.encodingAesKey} set={v => set({ encodingAesKey: v })} />
      <Text label="API 地址" mono v={f.apiBase || 'https://qyapi.weixin.qq.com'} set={v => set({ apiBase: v })} />
    </Group>}

    {mode === 'mp' && <Group title="微信公众号 / 服务号凭据">
      <Text label="AppID" mono v={f.appId} set={v => set({ appId: v })} />
      <Secret label="AppSecret" isSet={f.appSecretSet} v={f.appSecret} set={v => set({ appSecret: v })} />
      <Secret label="回调 Token" isSet={f.callbackTokenSet} v={f.callbackToken} set={v => set({ callbackToken: v })} />
      <Secret label="EncodingAESKey（安全模式必填）" isSet={f.encodingAesKeySet} v={f.encodingAesKey} set={v => set({ encodingAesKey: v })} />
      <Text label="API 地址" mono v={f.apiBase || 'https://api.weixin.qq.com'} set={v => set({ apiBase: v })} />
    </Group>}

    {mode === 'webhook' && <Group title="Webhook 推送 / 个人微信桥接" hint="支持企微群机器人、Server酱、PushPlus 一键推送；或填本地 Wechaty/GeWeChat 桥接地址实现个人微信双向收发。">
      <Secret label="推送 Webhook URL（企微群机器人 / Server酱 / PushPlus）" isSet={f.webhookUrlSet} v={f.webhookUrl} set={v => set({ webhookUrl: v })} />
      <Text label="双向桥接发送地址（可选，POST JSON {to, title, text}）" mono placeholder="http://127.0.0.1:3100/send" v={f.bridgeUrl} set={v => set({ bridgeUrl: v })} />
      <Secret label="桥接鉴权 Token（用于双向 Bearer 校验）" isSet={f.bridgeTokenSet} v={f.bridgeToken} set={v => set({ bridgeToken: v })} />
    </Group>}

    <Group title="权限控制">
      <Lines label="允许的用户 ID / OpenID（扫码直连后会自动填入你的微信用户 ID）" hint="一行一个：个人微信填扫码自动绑定的 ilink_user_id，企业微信填 UserID，公众号填 OpenID" mono v={f.allowedUsers || []} set={v => set({ allowedUsers: v })} />
    </Group>
  </>
}
function PreviewForm({ f, set }: FormProps) {
  return <Group title="网页预览" hint="AI 在容器里起的网页可以发布成临时链接。">
    <Check label="启用预览" v={f.enabled} set={v => set({ enabled: v })} />
    <div className="cols">
      <Num label="起始端口" step={1} min={1024} max={65535} v={f.portStart} set={v => set({ portStart: v })} />
      <Num label="结束端口" step={1} min={1024} max={65535} v={f.portEnd} set={v => set({ portEnd: v })} />
      <Num label="每张任务最多" step={1} min={1} max={5} v={f.perTicket} set={v => set({ perTicket: v })} />
    </div>
    <Text label="公网地址" hint="外部访问后台的地址，如 https://example.com/sa，末尾不要 /；留空则只给相对链接" mono v={f.publicBase} set={v => set({ publicBase: v })} />
  </Group>
}
function ProjectsForm({ f, set }: FormProps) {
  return <Group title="项目上传限制" hint="防止一个压缩包把磁盘撑满。">
    <div className="cols">
      <Num label="单个压缩包上限（MB）" step={1} min={1} v={f.maxUploadMb} set={v => set({ maxUploadMb: v })} />
      <Num label="解压后总大小上限（MB）" step={1} min={1} v={f.maxExtractMb} set={v => set({ maxExtractMb: v })} />
      <Num label="解压后文件数上限" step={1} min={1} v={f.maxFiles} set={v => set({ maxFiles: v })} />
    </div>
  </Group>
}
function CouncilForm({ f, set }: FormProps) {
  const opts = useModelOptions()
  return <>
    <Group title="会商" hint="让几个 AI 角色先讨论，再出任务书或建议。">
      <Check label="启用会商" v={f.enabled} set={v => set({ enabled: v })} />
      <Check label="发任务时默认勾选会商" v={f.defaultOn} set={v => set({ defaultOn: v })} />
      <div className="cols">
        <Num label="讨论轮数" hint="1–3" step={1} min={1} max={3} v={f.rounds} set={v => set({ rounds: v })} />
        <Num label="每条发言字数上限" hint="100–2000" step={1} min={100} max={2000} v={f.maxCharsPerTurn} set={v => set({ maxCharsPerTurn: v })} />
      </div>
      <RefSelect label="主持人模型" hint="主持人汇总发言、写任务书" nullLabel="跟随默认执行模型" v={f.moderator} options={opts} set={v => set({ moderator: v })} />
    </Group>
    <Group title="角色" hint="至少启用一个。">
      <ListEdit items={f.roles || []} onChange={v => set({ roles: v })} addLabel="添加角色"
        make={() => ({ id: `role-${Date.now().toString(36)}`, name: '', persona: '', enabled: true })}
        title={(r: any) => r.name ? `${r.enabled ? '' : '［停用］'}${r.name}` : ''}
        render={(r: any, upd) => <>
          <div className="cols"><Text label="名称" v={r.name} set={v => upd({ name: v })} /><Text label="ID" hint="小写字母、数字、-" mono v={r.id} set={v => upd({ id: v })} /></div>
          <Check label="启用" v={r.enabled} set={v => upd({ enabled: v })} />
          <Area label="人设" rows={5} v={r.persona} set={v => upd({ persona: v })} />
          <RefSelect label="这个角色用的模型" nullLabel="跟随主持人" v={r.model} options={opts}
            set={v => { if (v) upd({ model: v }); else { const { model: _m, ...rest } = r; upd({ ...rest, model: undefined }) } }} />
        </>} />
    </Group>
  </>
}
const ACCESS_OPTIONS: [string, string][] = [['ask', '只回答，不看文件'], ['read', '只读文件和搜索'], ['shell', '只读，可以运行命令'], ['write', '可以改文件（一次只跑一个）']]
function CollabForm({ f, set }: FormProps) {
  const opts = useModelOptions()
  return <>
    <Group title="多模型协作" hint="任务执行时，主 AI 可以把一部分工作交给下面的角色，每个角色可以用不同的模型。花费记在这张任务上，受费用上限约束。">
      <Check label="启用协作" hint="关掉后，之后启动的任务不再能叫子代理" v={f.enabled} set={v => set({ enabled: v })} />
      <div className="cols">
        <Num label="同时最多跑几个子代理" hint="1–4，容器只有 1 核时建议 2" step={1} min={1} max={4} v={f.maxConcurrent} set={v => set({ maxConcurrent: v })} />
        <Num label="每张任务最多调用几次" hint="1–200，按子代理的次数算" step={1} min={1} max={200} v={f.maxCalls} set={v => set({ maxCalls: v })} />
      </div>
    </Group>
    <Group title="角色" hint="主 AI 按说明决定叫谁。模型选“跟随任务自己的模型”时，用这张任务正在用的模型。">
      <ListEdit items={f.roles || []} onChange={v => set({ roles: v })} addLabel="添加角色" empty="还没有角色，主 AI 不会派子代理。"
        make={() => ({ id: `role-${Date.now().toString(36)}`, name: '', description: '', access: 'read', enabled: true, model: null, prompt: '' })}
        title={(r: any) => r.name ? `${r.enabled ? '' : '［停用］'}${r.name}` : ''}
        render={(r: any, upd) => <>
          <div className="cols"><Text label="名称" v={r.name} set={v => upd({ name: v })} /><Text label="ID" hint="主 AI 用它点名：小写字母、数字、-" mono v={r.id} set={v => upd({ id: v })} /></div>
          <Check label="启用" v={r.enabled} set={v => upd({ enabled: v })} />
          <div className="cols">
            <Select label="能做什么" v={r.access} options={ACCESS_OPTIONS} set={v => upd({ access: v })} />
            <RefSelect label="用的模型" nullLabel="跟随任务自己的模型" v={r.model ?? undefined} options={opts} set={v => upd({ model: v })} />
          </div>
          <Area label="给主 AI 看的说明" hint="写清它擅长什么、什么时候该叫它" rows={3} v={r.description} set={v => upd({ description: v })} />
          <Area label="给这个角色的提示词" rows={4} v={r.prompt} set={v => upd({ prompt: v })} />
        </>} />
    </Group>
    <p className="hint">“只读”“只回答”靠工具限制和提示词约束，不是安全边界：子代理和主 AI 在同一个容器里，权限不会比主 AI 更大。子代理拿不到汇报、发 PR、发邮件这些工具，也不能再往下派。</p>
  </>
}
function GoalForm({ f, set }: FormProps) {
  const opts = useModelOptions()
  return <>
    <Group title="目标" hint="发任务时可以设一个目标：执行者说做完了，宿主先跑验收命令、再让判定模型核对，没达成就让它接着干。下面是目标没写上限时用的默认值。">
      <div className="cols">
        <Num label="最多几轮检查" hint="1–50" step={1} min={1} max={50} v={f.maxRounds} set={v => set({ maxRounds: v })} />
        <Num label="一个目标最多花多少（美元）" hint="0.01–100" step={0.5} min={0.01} max={100} v={f.maxUsd} set={v => set({ maxUsd: v })} />
        <Num label="最长多少小时" hint="0.1–72" step={0.5} min={0.1} max={72} v={f.maxHours} set={v => set({ maxHours: v })} />
        <Num label="每条验收命令最多跑几秒" hint="10–1800" step={10} min={10} max={1800} v={f.commandTimeoutSec} set={v => set({ commandTimeoutSec: v })} />
      </div>
      <RefSelect label="判定模型" hint="核对目标是否达成；想更严可以换成更强的模型" nullLabel="跟随任务自己的模型" v={f.judge ?? undefined} options={opts} set={v => set({ judge: v })} />
    </Group>
    <p className="hint">到了任何一个上限，任务会停下问你；回复“继续”就再给同样一批。验收命令在执行者自己的容器里跑，权限和执行者一样。</p>
  </>
}
const WEB_ORDERS: [string, string][] = [
  ['exa,gemini,claude', '先 Exa 免费搜索，失败再用 Gemini / Claude 自带搜索（推荐）'],
  ['gemini,exa,claude', '先 Gemini 自带搜索，失败再用 Exa / Claude'],
  ['exa,gemini', '先 Exa 免费搜索，失败再用 Gemini 自带搜索'],
  ['exa,claude', '先 Exa 免费搜索，失败再让 Claude 代搜'],
  ['claude,exa', '先 Claude 代搜，失败再用 Exa'],
  ['gemini', '只用 Gemini 自带搜索'],
  ['exa', '只用 Exa'],
  ['claude', '只用 Claude 代搜'],
]
function WebForm({ f, set }: FormProps) {
  const opts = useModelOptions()
  const order = (f.backends || []).join(',')
  return <>
    <Group title="联网搜索" hint="任务里的 AI（主 AI 和子代理）可以用“搜索”和“读网页”两个工具查资料。搜索由宿主代办，读网页在执行者自己的容器里进行。">
      <Check label="允许联网搜索" hint="关掉后，新启动的执行者拿不到这两个工具" v={f.enabled} set={v => set({ enabled: v })} />
      <Select label="搜索后端顺序" hint="前一个出错或被限流，就自动换下一个" v={order} options={WEB_ORDERS} set={v => set({ backends: v.split(',').filter(Boolean) })} />
      <RefSelect label="Gemini 自带搜索用的模型" hint="支持已启用服务商上的 Gemini 模型（内置 Google 搜索）；每次约 $0.01 搜索费加少量 token" nullLabel="自动：第一个可用的 Gemini（优先 flash / neon）" v={f.geminiModel ?? undefined} options={opts} set={v => set({ geminiModel: v })} />
      <RefSelect label="Claude 代搜用的模型" hint="要选 Anthropic 协议服务商上的 Claude；每次约 $0.01 搜索费加少量 token" nullLabel="自动：第一个可用的 Haiku / Claude" v={f.claudeModel ?? undefined} options={opts} set={v => set({ claudeModel: v })} />
      <Secret label="Exa API key（可选）" isSet={f.exaKeySet} v={f.exaKey} set={v => set({ exaKey: v })} />
    </Group>
    <Group title="每张任务的额度" hint="主 AI 和子代理合计；用完后工具会提示，任务不会中断。">
      <div className="cols">
        <Num label="最多搜索几次" hint="1–500" step={1} min={1} max={500} v={f.maxSearches} set={v => set({ maxSearches: v })} />
        <Num label="最多读几次网页" hint="1–1000" step={1} min={1} max={1000} v={f.maxFetches} set={v => set({ maxFetches: v })} />
      </div>
    </Group>
    <p className="hint">搜索结果和网页内容只当资料，AI 不会照着里面的话去做。每次搜索都记在这张任务的花费里（Exa 免费记 $0）。</p>
  </>
}
const NOVEL_ROLES: [string, string, string][] = [['planner', '规划', '大纲、分弧、章纲'], ['writer', '写作', '写正文'], ['reviewer', '审稿', '打分、挑问题'], ['extractor', '提取', '从正文提取人物、设定']]
function NovelForm({ f, set }: FormProps) {
  const opts = useModelOptions()
  const cc: [number, number] = f.chapterChars || [2500, 3500]
  return <>
    <Group title="小说引擎">
      <Check label="启用小说" v={f.enabled} set={v => set({ enabled: v })} />
      <div className="cols">
        <Num label="每章最少字数" step={100} min={500} v={cc[0]} set={v => set({ chapterChars: [v, cc[1]] })} />
        <Num label="每章最多字数" step={100} max={20000} v={cc[1]} set={v => set({ chapterChars: [cc[0], v] })} />
        <Num label="最多修改次数" step={1} min={0} max={5} v={f.maxRevisions} set={v => set({ maxRevisions: v })} />
        <Num label="审稿及格分" hint="1–10" step={1} min={1} max={10} v={f.minScore} set={v => set({ minScore: v })} />
        <Num label="同时写几本" step={1} min={1} max={4} v={f.maxActiveBooks} set={v => set({ maxActiveBooks: v })} />
      </div>
    </Group>
    <Group title="各环节用的模型">
      <div className="cols">{NOVEL_ROLES.map(([k, n, h]) => <RefSelect key={k} label={n} hint={h} nullLabel="跟随默认执行模型" v={f.models?.[k]} options={opts}
        set={v => set({ models: { ...f.models, [k]: v } })} />)}</div>
    </Group>
    <Group title="小说的费用上限" hint="0 表示不限；全局每日上限仍然生效。">
      <div className="cols">
        <Num label="每天（美元）" min={0} v={f.dailyUsd} set={v => set({ dailyUsd: v })} />
        <Num label="每弧（美元）" min={0} v={f.arcUsd} set={v => set({ arcUsd: v })} />
        <Num label="每本（美元）" min={0} v={f.bookUsd} set={v => set({ bookUsd: v })} />
      </div>
    </Group>
    <Group title="额外禁用词"><Lines label="禁用词" hint="一行一个，正文里出现会被要求改写" v={f.extraBanned || []} set={v => set({ extraBanned: v })} /></Group>
  </>
}

function DirectorForm({ f, set }: FormProps) {
  const opts = useModelOptions()
  return <>
    <Group title="总控 AI 助手（Director）" hint="接管微信、飞书与控制台多轮对话：读取全平台运行数据、理解需求后自动派发任务、主动盯盘自愈并闭环汇报。">
      <Check label="启用总控助手" hint="关闭后微信与飞书私聊消息将自动退回旧版直通工单模式" v={f.enabled ?? true} set={v => set({ enabled: v })} />
      <RefSelect label="总控专用模型" hint="建议选择工具调用（Function Calling）稳定且响应快的模型；留空则跟随默认执行模型" nullLabel="跟随默认执行模型" v={f.model ?? null} options={opts} set={v => set({ model: v })} />
      <Select label="主动汇报范围（微信 / 飞书）" v={f.notifyScope || 'all'} set={v => set({ notifyScope: v })} options={DIRECTOR_NOTIFY_OPTS} />
      <Check label="复杂完工报告由总控 AI 润色提炼" hint="开启后超过 400 字的工单报告会自动整理成手机端易读的 3–5 条要点" v={f.summarizeReports ?? true} set={v => set({ summarizeReports: v })} />
      <Check label="高危操作代码级二次确认（强烈建议开启）" hint="执行宿主机命令/服务启停/容器清理、修改控制台设置、切换/删除 Pi 或开发镜像、删除工单/项目/书籍、清理工作区或审批密钥前，必须经你明确确认" v={f.confirmHighRisk ?? true} set={v => set({ confirmHighRisk: v })} />
      <Check label="飞书交互式按钮卡片一键确认" hint="开启后，高危操作确认、DAG 节点审批、密钥申请与故障升级在飞书端均以可点击按钮卡片发出，点一下即可直接执行（仍保留 /确认 短码兜底）" v={f.feishuInteractiveCards ?? true} set={v => set({ feishuInteractiveCards: v })} />
    </Group>
    <Group title="主动盯盘与故障自愈闭环" hint="后台看门狗平时 0 Token 低开销巡检；发现工单失败、卡死、阻塞或高危命令出错时，自动唤醒总控排查解决并在验证完成后汇报，同时沉淀避坑经验到长期记忆。">
      <Check label="启用故障/卡死主动发现并自愈" hint="发现任务失败、阻塞或长时间无进展时，先由总控诊断现场并自主修复重试；超出轮次上限或需你拍板时再发卡片通知" v={f.autoHeal ?? true} set={v => set({ autoHeal: v })} />
      <div className="cols">
        <Num label="单任务最多自动自愈轮次" hint="0–5 轮，默认 2（防死循环与失控扣费，超限后转人工卡片决策）" step={1} min={0} max={5} v={f.maxAutoHealRounds ?? 2} set={v => set({ maxAutoHealRounds: v })} />
        <Num label="任务静默卡死判定（分钟）" hint="2–120 分钟，默认 8（运行中工单超过此时长无新步骤活动则唤醒总控排查）" step={1} min={2} max={120} v={f.stallMinutes ?? 8} set={v => set({ stallMinutes: v })} />
        <Num label="长耗时里程碑播报（分钟）" hint="0–120 分钟，默认 5（0 表示关闭；运行超此时长自动汇报阶段进度，每单最多 2 次）" step={1} min={0} max={120} v={f.milestoneMinutes ?? 5} set={v => set({ milestoneMinutes: v })} />
      </div>
    </Group>
    <Group title="对话与成本护栏">
      <div className="cols">
        <Num label="微信连发聚合窗口（毫秒）" hint="0–10000，默认 1500ms（自动合并连续短消息）" step={100} min={0} max={10000} v={f.debounceMs ?? 1500} set={v => set({ debounceMs: v })} />
        <Num label="单轮最多工具调用步数" hint="1–15，默认 8" step={1} min={1} max={15} v={f.maxToolSteps ?? 8} set={v => set({ maxToolSteps: v })} />
        <Num label="模型请求失败最多重试次数" hint="0–20 次，默认 5（遇断连 / 5xx 自动新建连接重试）" step={1} min={0} max={20} v={f.maxRetries ?? 5} set={v => set({ maxRetries: v })} />
        <Num label="单步模型请求超时（秒）" hint="30–3600 秒，默认 1800（30 分钟，适配高推理长时间思考）" step={30} min={30} max={3600} v={f.stepTimeoutSec ?? 1800} set={v => set({ stepTimeoutSec: v })} />
        <Num label="流式首包看门狗超时（秒）" hint="0–3600 秒，默认 1500（25 分钟；0 表示关闭，等待上游思考完再吐字）" step={15} min={0} max={3600} v={f.firstByteTimeoutSec ?? 1500} set={v => set({ firstByteTimeoutSec: v })} />
        <Num label="上下文对齐比例（%）" hint="10–95%，默认 80（自动对齐当前模型上下文并缩小 20%，如 1M 模型 ≈ 800,000 tokens）" step={5} min={10} max={95} v={f.contextWindowPercent ?? 80} set={v => set({ contextWindowPercent: v })} />
        <Num label="上下文硬上限（tokens，0=自动）" hint="0 表示按上方比例自动对齐模型上下文；设正整数时再按不超过模型 95% 封顶" step={10000} min={0} max={10000000} v={f.maxContextTokens ?? 0} set={v => set({ maxContextTokens: v })} />
        <Num label="单步最大输出（tokens，0=自动）" hint="0 表示按比例自动对齐模型 maxTokens 且不超过剩余上下文余量（默认约 80%）" step={1024} min={0} max={1000000} v={f.maxOutputTokens ?? 0} set={v => set({ maxOutputTokens: v })} />
        <Num label="总控每日独立预算（美元）" hint="0 表示仅受全局每日预算约束" min={0} max={1000} v={f.dailyUsd ?? 5} set={v => set({ dailyUsd: v })} />
      </div>
      <Area label="主人附加指令（可选）" hint="追加到总控系统提示词末尾，如称呼偏好、默认模型习惯、汇报风格等" rows={4} v={f.extraPrompt || ''} set={v => set({ extraPrompt: v })} />
    </Group>
  </>
}

/* ---------- 保存前清理 ---------- */
const READ_ONLY = /^(appSecretSet|verificationTokenSet|encryptKeySet|tokenSet|passwordSet|apiKeySet|apiKeyTail|exaKeySet|corpSecretSet|callbackTokenSet|encodingAesKeySet|webhookUrlSet|bridgeTokenSet|_new)$/
const WRITE_ONLY = /^(appSecret|verificationToken|encryptKey|token|password|apiKey|exaKey|corpSecret|callbackToken|encodingAesKey|webhookUrl|bridgeToken)$/
function clean(v: any): any {
  if (Array.isArray(v)) return v.map(clean)
  if (!v || typeof v !== 'object') return v
  const out: any = {}
  for (const [k, x] of Object.entries(v)) {
    if (READ_ONLY.test(k)) continue
    if (WRITE_ONLY.test(k) && (x === '' || x == null)) continue
    if (x === undefined) continue
    out[k] = clean(x)
  }
  return out
}

/* ---------- 分区目录 ---------- */
const SECTIONS: { key: string; label: string; desc: string; form?: (p: FormProps) => JSX.Element; test?: boolean }[] = [
  { key: 'director', label: '总控助手', desc: '微信总控 AI、专用模型、主动汇报与高危确认', form: DirectorForm },
  { key: 'budget', label: '费用上限', desc: '一张任务、一天最多花多少', form: BudgetForm },
  { key: 'models', label: '模型', desc: 'AI 服务商、默认模型、开工前分析', form: ModelsForm },
  { key: 'policy', label: '受理规则', desc: '哪些消息会被接、谁能下指令', form: PolicyForm },
  { key: 'executor', label: '执行环境', desc: '同时跑几个、每个多少 CPU 和内存', form: ExecutorForm },
  { key: 'email', label: '邮箱', desc: '支持 Gmail / QQ / 163 / Outlook / 自定义邮箱', form: EmailForm, test: true },
  { key: 'wechat', label: '微信', desc: '个人微信扫码直连、企业微信、公众号与群机器人', form: WechatForm, test: true },
  { key: 'feishu', label: '飞书', desc: '在飞书里下指令、收结果', form: FeishuForm, test: true },
  { key: 'qq', label: 'QQ 机器人', desc: 'QQ 官方机器人对话、按钮直接确认与智能排版推送', form: QqForm, test: true },
  { key: 'github', label: 'GitHub', desc: '拉代码、推分支、开 PR', form: GithubForm, test: true },
  { key: 'preview', label: '网页预览', desc: '把容器里的网页发布成链接', form: PreviewForm },
  { key: 'projects', label: '项目', desc: '上传压缩包的大小限制', form: ProjectsForm },
  { key: 'council', label: '会商', desc: '角色、轮数、主持人', form: CouncilForm },
  { key: 'collab', label: '协作', desc: '任务里叫别的模型帮忙', form: CollabForm },
  { key: 'goal', label: '目标', desc: '没达成目标就不停：上限、判定模型', form: GoalForm },
  { key: 'web', label: '搜索', desc: '让 AI 联网搜索、读网页：后端、额度', form: WebForm },
  { key: 'novel', label: '小说', desc: '开关、字数、模型、预算', form: NovelForm },
  { key: 'account', label: '账号', desc: '修改后台口令' },
]

function SectionForm({ sec }: { sec: (typeof SECTIONS)[number] }) {
  const { d, err, reload } = usePoll<any>(`api/settings/${sec.key}`, 3600000)
  const [f, setF] = useState<any>(null)
  const [dirty, setDirty] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const { busy, run } = useAction()
  useEffect(() => { if (d && !dirty) setF(d) }, [d, dirty])
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    addEventListener('beforeunload', h); return () => removeEventListener('beforeunload', h)
  }, [dirty])
  if (!f) return err ? <p className="warn">读取失败：{err}</p> : <p className="meta">加载中…</p>
  const set = (patch: any) => { setF((x: any) => ({ ...x, ...patch })); setDirty(true); setSaveErr('') }
  const save = async () => {
    setSaveErr('')
    const ok = await run(() => put(`api/settings/${sec.key}`, clean(f)).catch((e: any) => { setSaveErr(e?.message || String(e)); throw e }), '已保存')
    if (ok) { setDirty(false); reload() }
  }
  const Form = sec.form!
  return <>
    <Form f={f} set={set} reload={reload} dirty={dirty} />
    {saveErr && <p className="formerr" role="alert">{saveErr}</p>}
    <div className="savebar">
      <button className="primary" disabled={busy || !dirty} onClick={save}>{busy ? '保存中…' : dirty ? '保存' : '已保存'}</button>
      {dirty && <button disabled={busy} onClick={() => { setF(d); setDirty(false); setSaveErr('') }}>撤销修改</button>}
      {sec.test && <button disabled={busy || dirty} title={dirty ? '先保存再测试' : ''} onClick={() => run(async () => { const r = await post(`api/settings/${sec.key}/test`, {}); toast(r?.message || (r?.ok ? '连接正常' : '测试失败'), !r?.ok) })}>测试连接</button>}
      {dirty && <span className="meta">有未保存的修改</span>}
    </div>
  </>
}

function Account() {
  const [o, setO] = useState(''); const [n, setN] = useState(''); const [n2, setN2] = useState('')
  const { busy, run } = useAction()
  return <Group title="修改管理口令" hint="修改后所有登录都会失效，需要重新登录。">
    <label className="field"><span>当前口令</span><input type="password" autoComplete="current-password" value={o} onChange={e => setO(e.target.value)} /></label>
    <label className="field"><span>新口令</span><input type="password" autoComplete="new-password" value={n} onChange={e => setN(e.target.value)} /></label>
    <label className="field"><span>再输一次</span><input type="password" autoComplete="new-password" value={n2} onChange={e => setN2(e.target.value)} /></label>
    {n2 && n !== n2 && <p className="warn">两次输入不一致。</p>}
    <button className="primary" disabled={busy || !o || !n || n !== n2} onClick={() => run(() => post('api/password', { old: o, new: n }), '已修改，请重新登录', () => window.dispatchEvent(new Event('sa-401')))}>修改口令</button>
  </Group>
}

export function Settings() {
  const key = segs()[0] || ''
  const wide = useMediaQuery('(min-width: 900px)')
  const cur = SECTIONS.find(s => s.key === (key || (wide ? 'budget' : '')))
  return <div className={cur ? 'settings has-sec' : 'settings'}>
    <div className="set-nav">
      <h1>设置</h1>
      {SECTIONS.map(s => <a key={s.key} className="row" aria-current={cur?.key === s.key} href={`#/settings/${s.key}`}><b>{s.label}</b><span className="meta">{s.desc}</span></a>)}
    </div>
    <div className="set-body">
      {cur && <><a className="back only-mobile" href="#/settings">← 设置</a><h1 className="set-title">{cur.label}</h1><p className="meta">{cur.desc}</p>
        {cur.key === 'account' ? <Account /> : <SectionForm key={cur.key} sec={cur} />}</>}
    </div>
  </div>
}
