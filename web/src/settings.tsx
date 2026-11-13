import { useEffect, useState, type ReactNode } from 'react'
import { post, put } from './api'
import { usePoll } from './hooks'
import { toast, useAction, Empty } from './ui'

/* ---------- 基础表单件 ---------- */
type Ref = { provider: string; model: string } | null
const refKey = (r?: Ref | { provider?: string; model?: string }) => (r && r.provider && r.model ? `${r.provider}/${r.model}` : '')
const parseRef = (s: string): Ref => { const i = s.indexOf('/'); return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : null }
const segs = () => location.hash.replace(/^#\//, '').split('?')[0]!.split('/').slice(1).map(decodeURIComponent)

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
  const [text, setText] = useState((v || []).join('\n'))
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
          <button type="button" className="ghost small danger" onClick={() => { if (confirm(`删除「${title(item, i) || '这一项'}」？`)) onChange(items.filter((_, j) => j !== i)) }}>删除</button>
        </span></summary>
      <div className="item__body">{render(item, upd(i), i)}</div>
    </details>)}
    <button type="button" className="addbtn" onClick={() => onChange([...items, make()])}>＋ {addLabel}</button>
  </div>
}

type FormProps = { f: any; set: (patch: any) => void }

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
    <Text label="会话头（可选）" hint="有的网关按这个请求头把同一任务路由到同一后端，保留缓存" mono v={p.sessionHeader} set={v => upd({ sessionHeader: v })} />
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
      <Select label="接收方式" v={f.mode} set={v => set({ mode: v })} options={[['ws', '长连接（推荐，不需要公网回调地址）'], ['webhook', 'HTTP 回调']]} />
      <Select label="群聊里" v={f.groupMode} set={v => set({ groupMode: v })} options={[['mention', '@ 它才响应'], ['all', '所有消息都看']]} />
      <Text label="App ID" mono v={f.appId} set={v => set({ appId: v })} />
      <Text label="接口地址" mono v={f.apiBase} set={v => set({ apiBase: v })} />
    </Group>
    <Group title="凭据">
      <Secret label="App Secret" isSet={f.appSecretSet} v={f.appSecret} set={v => set({ appSecret: v })} />
      <Secret label="Verification Token" isSet={f.verificationTokenSet} v={f.verificationToken} set={v => set({ verificationToken: v })} />
      <Secret label="Encrypt Key" isSet={f.encryptKeySet} v={f.encryptKey} set={v => set({ encryptKey: v })} />
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
function EmailForm({ f, set }: FormProps) {
  return <Group title="邮箱（Gmail）" hint="标题或正文里带 superagent 的邮件会被当作指令，结果回信。">
    <Check label="启用邮箱" v={f.enabled} set={v => set({ enabled: v })} />
    <div className="cols">
      <Text label="邮箱地址" v={f.address} set={v => set({ address: v })} />
      <Text label="显示名" v={f.displayName} set={v => set({ displayName: v })} />
    </div>
    <Secret label="应用专用密码" isSet={f.passwordSet} v={f.password} set={v => set({ password: v })} />
    <Lines label="允许的发件人" hint="一行一个邮箱地址；只有这些人发的邮件会被处理" v={f.allowedSenders || []} set={v => set({ allowedSenders: v })} />
    <div className="cols">
      <Num label="检查间隔（秒）" min={15} max={3600} step={1} v={f.pollSeconds} set={v => set({ pollSeconds: v })} />
      <Num label="附件上限（MB）" min={1} max={25} step={1} v={f.maxAttachmentMb} set={v => set({ maxAttachmentMb: v })} />
    </div>
  </Group>
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

/* ---------- 保存前清理 ---------- */
const READ_ONLY = /^(appSecretSet|verificationTokenSet|encryptKeySet|tokenSet|passwordSet|apiKeySet|apiKeyTail|_new)$/
const WRITE_ONLY = /^(appSecret|verificationToken|encryptKey|token|password|apiKey)$/
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
  { key: 'budget', label: '费用上限', desc: '一张任务、一天最多花多少', form: BudgetForm },
  { key: 'models', label: '模型', desc: 'AI 服务商、默认模型、开工前分析', form: ModelsForm },
  { key: 'policy', label: '受理规则', desc: '哪些消息会被接、谁能下指令', form: PolicyForm },
  { key: 'executor', label: '执行环境', desc: '同时跑几个、每个多少 CPU 和内存', form: ExecutorForm },
  { key: 'feishu', label: '飞书', desc: '在飞书里下指令、收结果', form: FeishuForm, test: true },
  { key: 'github', label: 'GitHub', desc: '拉代码、推分支、开 PR', form: GithubForm, test: true },
  { key: 'email', label: '邮箱', desc: '用 Gmail 收指令、回结果', form: EmailForm, test: true },
  { key: 'preview', label: '网页预览', desc: '把容器里的网页发布成链接', form: PreviewForm },
  { key: 'projects', label: '项目', desc: '上传压缩包的大小限制', form: ProjectsForm },
  { key: 'council', label: '会商', desc: '角色、轮数、主持人', form: CouncilForm },
  { key: 'collab', label: '协作', desc: '任务里叫别的模型帮忙', form: CollabForm },
  { key: 'goal', label: '目标', desc: '没达成目标就不停：上限、判定模型', form: GoalForm },
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
    <Form f={f} set={set} />
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
  const wide = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 900px)').matches
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
