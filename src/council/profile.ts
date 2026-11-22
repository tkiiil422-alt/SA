/**
 * Read-only view of a project's `profile.json` for the council.
 *
 * The profile is written by the project library and is already capped at 24 KB; the council keeps at most 6 KB of it so
 * five parallel seats plus the moderator stay well inside the model's context. Nothing in the project is executed and
 * no path from the profile is opened here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectProfile } from '../projects/profile.ts'

/** The council prompt's share of the project profile. */
export const COUNCIL_PROFILE_BYTES = 6 * 1024
const PROJECT_ID = /^p_[A-Za-z0-9]{1,32}$/

function isProfile(value: unknown): value is ProjectProfile {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Cut text to at most `maxBytes` of UTF-8, adding a marker when something was dropped. */
function cutToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const marker = '\n…（档案已截断）'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker))
  let out = ''
  let bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > budget) break
    out += character
    bytes += size
  }
  return `${out.trimEnd()}${marker}`
}

/** A compact text form of the profile; the field order is stable so prompts are reproducible. */
export function formatProjectProfile(profile: ProjectProfile): string {
  const lines: string[] = [
    '项目档案（只读）：',
    `- 文件数：${profile.files}；总字节：${profile.bytes}`,
  ]
  if (profile.languages.length > 0) {
    lines.push(`- 主要语言：${profile.languages.map(item => `${item.ext}（${item.files} 个文件）`).join('、')}`)
  }
  if (profile.manifests.length > 0) {
    lines.push('- 清单文件：')
    for (const manifest of profile.manifests) lines.push(`  - ${manifest.file}：${manifest.summary.replace(/\s+/g, ' ').trim()}`)
  }
  if (profile.topLevel.length > 0) {
    lines.push('- 顶层结构（前两层）：')
    for (const entry of profile.topLevel) lines.push(`  - ${entry}`)
  }
  if (profile.git !== undefined) {
    const recent = profile.git.recent.length > 0
      ? profile.git.recent.map(commit => `${commit.hash7} ${commit.message}`).join('；')
      : '无'
    lines.push(`- git：分支 ${profile.git.branch || '（未知）'}；最近提交：${recent}`)
  }
  if (profile.readme.trim() !== '') {
    lines.push('- README 节选：')
    lines.push(profile.readme.trim())
  }
  return cutToBytes(lines.join('\n'), COUNCIL_PROFILE_BYTES)
}

/**
 * Read `<root>/<projectId>/profile.json` and format it. A missing or unreadable profile is not an error: the council
 * simply runs without a `<project>` block.
 */
export function readProjectProfile(root: string, projectId: string): string | undefined {
  if (!PROJECT_ID.test(projectId)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(root, projectId, 'profile.json'), 'utf8')) as unknown
  } catch {
    return undefined
  }
  if (!isProfile(parsed)) return undefined
  return formatProjectProfile(parsed)
}
