/**
 * 总控助手（Director）暴露给 LLM 的 6 个高内聚路由工具 Schema 定义。
 *
 * 支持通过 `PluginRegistry` 动态扩展 `platform_query` / `subsystem_action` / `high_risk_action`
 * 的枚举清单，让新插件无需改写核心 Schema 即可被 Director 发现与调用。
 */
import type { ToolDefinition } from './llm.ts'
import type { PluginRegistry } from '../plugins/registry.ts'

const BASE_QUERY_ACTIONS = [
  'platform_overview', 'system_status', 'orphans_list', 'plugins_list',
  'pi_status', 'devenv_status',
  'tickets_list', 'ticket_detail', 'ticket_receipt', 'ticket_diagnose', 'ticket_activity', 'ticket_files', 'ticket_read_file',
  'usage_summary', 'usage_calls', 'events_list', 'decisions_list',
  'projects_list', 'project_detail', 'project_files', 'project_read_file', 'project_snapshots', 'project_snapshot_diff',
  'novels_list', 'novel_detail', 'novel_chapter', 'novel_canon_get', 'fanqie_status',
  'councils_list', 'council_detail',
  'pentest_list', 'pentest_detail', 'security_task_status',
  'models_list', 'model_test', 'model_discover', 'channel_test', 'wechat_qr_status', 'secrets_overview', 'ssh_list', 'policy_get', 'settings_get',
  'followups_list',
  'web_search',
] as const

const BASE_SUBSYSTEM_ACTIONS = [
  'pi_build', 'devenv_build', 'devenv_repack',
  'council_start', 'council_cancel', 'council_commit',
  'novel_open', 'novel_start_arc', 'novel_edit_chapter', 'novel_chapter_undo',
  'fanqie_check', 'fanqie_bind', 'fanqie_sync',
  'pentest_scan', 'pentest_launch_playbook',
  'security_create_engagement', 'security_update_engagement', 'security_start_task', 'security_task_cancel',
  'security_add_finding', 'security_update_finding', 'security_send_report',
  'followup_set', 'followup_cancel',
  'channel_reconnect', 'wechat_qr_start', 'wechat_qr_verify', 'email_send', 'wechat_send',
  'system_backup',
] as const

const BASE_HIGH_RISK_ACTIONS = [
  'secret_request_decide', 'secret_manage', 'ticket_secrets_set',
  'ticket_delete', 'tickets_batch_delete', 'cleanup_workspaces', 'cleanup_orphans',
  'platform_set_paused', 'budget_update', 'settings_update', 'ssh_manage', 'wechat_qr_logout',
  'pi_apply', 'pi_remove', 'devenv_apply', 'devenv_remove',
  'project_delete', 'project_restore', 'project_snapshot_delete',
  'novel_delete', 'security_delete_engagement',
] as const

function unique(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set<string>(base)
  for (const item of extra) seen.add(item)
  return [...seen]
}

export function buildDirectorToolDefinitions(plugins?: PluginRegistry): readonly ToolDefinition[] {
  const extraQueries: string[] = []
  const extraActions: string[] = []
  const extraHighRisk: string[] = []

  if (plugins) {
    for (const desc of plugins.list()) {
      if (!desc.enabled) continue
      const plugin = plugins.get(desc.id)
      if (!plugin) continue
      extraQueries.push(...Object.keys(plugin.directorQueries ?? {}))
      extraActions.push(...Object.keys(plugin.directorActions ?? {}))
      extraHighRisk.push(...Object.keys(plugin.directorHighRiskActions ?? {}))
    }
  }

  return [
    {
      name: 'platform_query',
      description: '只读查询整个 SuperAgent 控制台与已加载插件的任意数据（总览/系统/插件/孤儿目录/Pi版本/开发环境/工单与交付物/费用/日志/决策/项目源码与快照Diff/小说与设定集/番茄/会商/防御与渗透工作台/长期记忆与技能库/定时调度与巡检/全部系统设置/模型与通道连通性测试/密钥元数据/SSH/联网搜索）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: unique(BASE_QUERY_ACTIONS, extraQueries),
            description: '要执行的查询动作名',
          },
          params_json: {
            type: 'string',
            description: '参数 JSON 对象字符串（无参数时传 "{}"），例如 {"status":"open","limit":20} 或 {"section":"director"}',
          },
        },
        required: ['action', 'params_json'],
      },
    },
    {
      name: 'dispatch_ticket',
      description: '派发一条新任务工单到本机执行引擎。请把与用户沟通明确的背景、需求与验收标准写入 prompt；可绑定项目库 projectId（推荐同一 Git 仓库并发改造用 projectMode="worktree"；direct 直接修改项目库原件；copy 独立副本）、选择本机执行器 runnerId（默认 pi；确定性数据核对/清单优先用 0 Token script + scriptId + scriptParams_json）、指定模型、开启/关闭多模型协作、或附带结构化验收目标 goal_json。若承诺任务完成后自动执行下一步（如部署、验收、发下个工单等），务必填写 onComplete 登记自动续接触发器！携带 secrets 时自动触发二次确认。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '整理后的清晰任务说明书与验收要求' },
          projectId: { type: 'string', description: '可选：项目库 ID（先经 projects_list 或实时态势快照确认存在且就绪）' },
          projectMode: { type: 'string', enum: ['copy', 'direct', 'worktree'], description: '可选：copy（默认）副本模式；worktree 推荐用于同一 Git 仓库并发开发（秒级隔离分支，改完可审 Diff 并一键合并）；direct 直接改项目原件（同一项目同时只能有一个 direct 任务）' },
          runnerId: { type: 'string', enum: ['pi', 'script', 'claude-code', 'opencode'], description: '可选：本机执行器 ID，默认 pi；确定性零 Token 核对任务用 script' },
          scriptId: { type: 'string', description: '可选：当 runnerId="script" 时必填的已登记脚本 ID（如 sales-report-check、workspace-manifest）' },
          scriptParams_json: { type: 'string', description: '可选：当 runnerId="script" 时的结构化参数 JSON 对象字符串' },
          model: { type: 'string', description: '可选：指定执行模型 ref（如 provider/model）' },
          collab: { type: 'boolean', description: '可选：是否开启工单内多模型协作，默认 true' },
          secrets: { type: 'array', items: { type: 'string' }, description: '可选：需授予该工单的已有密钥名称（触发二次确认）' },
          goal_json: { type: 'string', description: '可选：目标验收 JSON 字符串，格式 {"description":"...","criteria":["..."],"commands":["..."],"requireEvidence":true,"maxRounds":8,"maxUsd":3}' },
          onComplete: { type: 'string', description: '可选：该工单完成后自动唤醒总控执行的下一步动作说明（如“核验测试通过后执行主机部署并重启服务”）。填写后系统会在工单结束时自动唤醒你执行，无需主人再发指令！' },
          onFailure: { type: 'string', enum: ['report', 'continue'], description: '可选：配合 onComplete 使用，report（默认）表示若工单失败仅分析汇报；continue 表示无论成败都按 onComplete 继续处理' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'ticket_manage',
      description: '管理与跟进已有工单：回复人工决策、追加备注、重试、停止、设置或取消验收目标。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['ticket_reply', 'ticket_note', 'ticket_retry', 'ticket_stop', 'ticket_goal_set', 'ticket_goal_cancel'],
            description: '工单管理动作',
          },
          ticketId: { type: 'string', description: '目标工单 ID' },
          params_json: {
            type: 'string',
            description: '附加参数 JSON 字符串（无参数传 "{}"）：reply/note 传 {"text":"...","model":"?"}；stop 传 {"reason":"..."}；goal_set 传 {"description":"...","criteria":[],"commands":[]}',
          },
        },
        required: ['action', 'ticketId', 'params_json'],
      },
    },
    {
      name: 'subsystem_action',
      description: '调用控制台各子系统与扩展插件的常规执行动作：构建 Pi 版本镜像、构建或极速复用开发环境镜像、会商发起/取消/提交开票、小说开书/续写/改章/撤回、番茄检查与同步、防御与渗透工作台、记忆与技能沉淀、定时任务与主动巡检管理、通道重连、发邮件或微信通知、立即备份平台状态。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: unique(BASE_SUBSYSTEM_ACTIONS, extraActions),
            description: '子系统动作名',
          },
          params_json: {
            type: 'string',
            description: '参数 JSON 对象字符串（无参数传 "{}"）',
          },
        },
        required: ['action', 'params_json'],
      },
    },
    {
      name: 'host_ops',
      description: '宿主机与容器运维管理。只读动作（host_inspect/host_logs/host_files/host_read_file/podman_ps/podman_images/podman_logs/service_status）直接执行；写与运维动作（host_exec 执行宿主机命令、service_control 启停重启服务、podman_action 停删清理容器或镜像）自动触发代码级二次确认。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'host_inspect', 'host_logs', 'host_files', 'host_read_file',
              'podman_ps', 'podman_images', 'podman_logs', 'service_status',
              'host_exec', 'service_control', 'podman_action',
            ],
            description: '主机运维动作名',
          },
          params_json: {
            type: 'string',
            description: '参数 JSON 对象字符串（无参数传 "{}"），例如 {"command":"df -h","timeoutSec":30} 或 {"unit":"superagent.service","action":"restart"}',
          },
        },
        required: ['action', 'params_json'],
      },
    },
    {
      name: 'high_risk_action',
      description: '【需代码级二次确认】控制台高危与全局变更操作：审批密钥申请、增改删密钥、修改工单密钥授权、删除/批量删除工单、清理旧工作区或孤儿目录、全局暂停/恢复接单、修改全局预算、修改任意控制台设置分区（settings_update）、管理 SSH 连接（ssh_manage）、切换或删除 Pi/开发镜像、删除/回滚/删快照项目、删除小说、删除安全/防御项目及插件高危操作。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: unique(BASE_HIGH_RISK_ACTIONS, extraHighRisk),
            description: '高危操作名',
          },
          params_json: {
            type: 'string',
            description: '参数 JSON 对象字符串',
          },
        },
        required: ['action', 'params_json'],
      },
    },
  ]
}

export const DIRECTOR_TOOL_DEFINITIONS: readonly ToolDefinition[] = buildDirectorToolDefinitions()
