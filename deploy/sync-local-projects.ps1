<#
.SYNOPSIS
  把本机的项目目录同步到 SuperAgent 项目库（192.168.31.66）。

.DESCRIPTION
  每个项目：本机 tar（排除依赖、缓存、私钥与 .env）→ SSH 流式传到主机 <项目库>/.imports/ → 调用
  POST /api/projects/import 原地替换项目库里的 tree（已有项目保留编号；替换前自动快照，可在项目页回滚）。

  用法：
    pwsh deploy/sync-local-projects.ps1                 # 同步下面 $Projects 里的全部项目
    pwsh deploy/sync-local-projects.ps1 -Only ai-ak47   # 只同步一个（按名称）
#>
param(
  [string]$HostName = 'ghost@192.168.31.66',
  [string]$Key = "$env:USERPROFILE\.ssh\superagent_debian",
  [string]$Only = ''
)
$ErrorActionPreference = 'Stop'

# Id 留空表示首次导入（新建项目）；之后填上返回的编号，同步时就会原地更新同一个项目。
$Projects = @(
  @{ Name = 'ai-ak47';        Path = 'F:\ai-ak47-main';   Id = 'p_dacefc82fd5f'; Extra = @() },
  @{ Name = 'Claude code px'; Path = 'F:\Claude code px'; Id = 'p_f6c87fefe0d0'; Extra = @() },
  @{ Name = 'SUPER AGENT';    Path = 'F:\SUPER AGENT';    Id = 'p_670cd8a43a54'; Extra = @('./scratch') }
)

# 依赖、缓存、构建中间物，以及不该交给 AI 工人的私钥 / 环境变量文件。
$CommonExcludes = @(
  'node_modules', '.venv', 'venv', '.mitmvenv', '__pycache__', '*.pyc', '.pytest_cache', '.ruff_cache',
  '.mypy_cache', '.hypothesis', '.vite', '.turbo', '.next', '.cache',
  '*.pem', '*.key', '*.p12', '*.pfx', '.env', '.env.local', '.env.production'
)

$ssh = "ssh -i `"$Key`" -o BatchMode=yes -o ServerAliveInterval=30 $HostName"
$ProjectsRoot = (& ssh -i $Key -o BatchMode=yes $HostName 'echo ${SA_PROJECTS_ROOT:-$HOME/superagent-projects}').Trim()

foreach ($p in $Projects) {
  if ($Only -and $p.Name -ne $Only) { continue }
  if (-not (Test-Path $p.Path)) { Write-Warning "跳过：找不到 $($p.Path)"; continue }
  $slug = ($p.Name -replace '[^A-Za-z0-9_-]', '_')
  $stage = "$ProjectsRoot/.imports/$slug-$(Get-Date -Format 'yyyyMMddHHmmss')"
  $excludes = ($CommonExcludes + $p.Extra | ForEach-Object { "--exclude=`"$_`"" }) -join ' '

  Write-Host "== $($p.Name)：打包并传输 $($p.Path) → $stage"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  # 用 cmd 管道保证二进制流不被 PowerShell 改写；主机端解包到暂存目录。
  cmd /c "tar --no-fflags --no-xattrs --no-acls -cf - -C `"$($p.Path)`" $excludes . | $ssh `"mkdir -p '$stage' && tar --warning=no-unknown-keyword -xf - -C '$stage'`""
  if ($LASTEXITCODE -ne 0) { throw "$($p.Name) 传输失败（退出码 $LASTEXITCODE）" }
  Write-Host ("   传输完成，用时 {0:n0} 秒" -f $sw.Elapsed.TotalSeconds)

  $body = @{ path = $stage; name = $p.Name }
  if ($p.Id) { $body.projectId = $p.Id }
  $json = ($body | ConvertTo-Json -Compress)
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $remote = @"
cd ~/superagent && node -e '
const body = Buffer.from(process.argv[1], "base64").toString("utf8");
const token = require("fs").readFileSync("state/cli-token", "utf8").trim();
fetch("http://127.0.0.1:8787/api/projects/import", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body })
  .then(async r => { const t = await r.text(); console.log(r.status, t); if (!r.ok) process.exit(1) })
  .catch(e => { console.error(e.message); process.exit(1) })
' $b64
"@
  & ssh -i $Key -o BatchMode=yes $HostName $remote
  if ($LASTEXITCODE -ne 0) { throw "$($p.Name) 导入失败" }
}
