/**
 * The workspace `AGENTS.md` a ticket gets.
 *
 * Pi's coding agent loads `AGENTS.md` from its working directory and its ancestors (`resource-loader.ts` candidates and
 * `loadProjectContextFiles`, with `cwd` = the RPC process's directory = `/workspace`), so the launcher writes this file
 * into the workspace root instead of injecting the same text into every assignment message.
 */

/** The text written to `<workspace>/AGENTS.md`; `withProject` adds the project-specific rules. */
export function agentsFileText(withProject: boolean): string {
  const lines: string[] = [
    '# 工作区约定',
    '',
    '你在一台隔离的容器里工作，工作目录是 `/workspace`。',
    '',
  ]
  if (withProject) {
    lines.push(
      '- `/workspace/project/`：用户上传的成熟项目。需要改动时都在这里进行；保留 `.git` 与提交历史，不要重写历史、不要删除 `.git`。不要在这个目录里放与项目无关的临时文件。',
    )
  }
  lines.push(
    '- `/workspace/output/`：给人看的产出（报告、说明、总结）。完成时**必须**在这里至少留一份 `.md` 总结文档。',
    '- `/workspace/inbox/`：邮件附件，只作参考。',
    '',
  )
  if (withProject) {
    lines.push(
      '## 阅读大项目的规则',
      '',
      '- 先看 `/workspace/project/README*`、`package.json` / `pyproject.toml` / `go.mod` 等清单，再看目录结构。',
      '- 用 `rg`、`find`、`ls` 按目录分批读取；禁止一次读取整个仓库，禁止把整个仓库塞进上下文。',
      '- 需要全貌时先列目录，再按需打开文件；单次读取的文件总量保持小。',
      '',
    )
  }
  return `${lines.join('\n')}`
}
