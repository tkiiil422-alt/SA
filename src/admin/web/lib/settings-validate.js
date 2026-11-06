/**
 * Front-end checks for the project-library and council settings (F5a-2).
 *
 * These mirror ProjectsSchema / CouncilSchema in src/admin/options.ts. They are
 * pure functions with no DOM, so tests can load this file directly. Each issue
 * is { path, message } with the same shape validateGithub() returns in settings.js.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const isInt = (value) => typeof value === 'number' && Number.isInteger(value)
const inRange = (value, min, max) => isInt(value) && value >= min && value <= max
const isText = (value) => typeof value === 'string' && value.trim() !== ''

const PROJECT_LIMITS = [
  { key: 'maxUploadMb', min: 1, max: 65536, label: '单个压缩包上传上限' },
  { key: 'maxExtractMb', min: 1, max: 1048576, label: '解压后总大小上限' },
  { key: 'maxFiles', min: 1, max: 5000000, label: '解压后文件数上限' },
]

export function validateProjects(draft) {
  const issues = []
  const value = draft ?? {}
  for (const { key, min, max, label } of PROJECT_LIMITS) {
    if (!isInt(value[key])) issues.push({ path: key, message: `${label}必须是整数。` })
    else if (value[key] < min || value[key] > max) issues.push({ path: key, message: `${label}要在 ${min}–${max} 之间。` })
  }
  return issues
}

/** Non-blocking hint: extraction smaller than the upload limit usually fails. */
export function projectsHint(draft) {
  const value = draft ?? {}
  if (!isInt(value.maxUploadMb) || !isInt(value.maxExtractMb)) return ''
  return value.maxExtractMb < value.maxUploadMb ? '解压上限比上传上限还小，大概率会解压失败。' : ''
}

const trimNumber = (number) => (Number.isInteger(number) ? String(number) : number.toFixed(1))

/** 4096 -> "4096 MB ≈ 4 GB"; empty when the value is not a usable integer. */
export function formatMb(value) {
  if (!isInt(value) || value < 1) return ''
  if (value < 1024) return `${value} MB`
  const gb = value / 1024
  if (gb < 1024) return `${value} MB ≈ ${trimNumber(gb)} GB`
  return `${value} MB ≈ ${trimNumber(gb / 1024)} TB`
}

export function formatFiles(value) {
  if (!isInt(value) || value < 1) return ''
  return `${value} 个`
}

const isRef = (value) => value !== null && typeof value === 'object' && isText(value.provider) && isText(value.model)

export function validateCouncil(draft) {
  const issues = []
  const value = draft ?? {}
  if (!inRange(value.rounds, 1, 3)) issues.push({ path: 'rounds', message: '轮数要是 1–3 之间的整数。' })
  if (!inRange(value.maxCharsPerTurn, 100, 2000)) {
    issues.push({ path: 'maxCharsPerTurn', message: '每条发言字数要在 100–2000 之间（整数）。' })
  }
  if (value.moderator !== null && value.moderator !== undefined && !isRef(value.moderator)) {
    issues.push({ path: 'moderator', message: '主持人模型格式不对，请重新选择，或选「跟随默认工作模型」。' })
  }

  const roles = Array.isArray(value.roles) ? value.roles : []
  if (roles.length < 1) issues.push({ path: 'roles', message: '至少需要一个会商角色。' })
  if (roles.length > 20) issues.push({ path: 'roles', message: '最多 20 个角色。' })

  const seen = new Set()
  roles.forEach((role, index) => {
    const id = String(role?.id ?? '')
    if (!ID_RE.test(id)) {
      issues.push({ path: `roles.${index}.id`, message: `角色 id「${id}」只能是小写字母、数字和连字符，且不超过 32 位。` })
    } else if (seen.has(id)) {
      issues.push({ path: `roles.${index}.id`, message: `角色 id「${id}」重复了。` })
    }
    seen.add(id)

    const name = String(role?.name ?? '').trim()
    if (!name) issues.push({ path: `roles.${index}.name`, message: '角色名称不能为空。' })
    else if (name.length > 60) issues.push({ path: `roles.${index}.name`, message: '角色名称不能超过 60 个字。' })

    const persona = String(role?.persona ?? '').trim()
    if (!persona) issues.push({ path: `roles.${index}.persona`, message: '人设不能为空。' })
    else if (persona.length > 2000) issues.push({ path: `roles.${index}.persona`, message: '人设不能超过 2000 字。' })

    if (role?.model !== undefined && !isRef(role.model)) {
      issues.push({ path: `roles.${index}.model`, message: '这个角色的模型格式不对，请重新选择。' })
    }
  })

  if (roles.length && !roles.some((role) => role?.enabled === true)) {
    issues.push({ path: 'roles', message: '至少要启用一个角色。' })
  }
  return issues
}
