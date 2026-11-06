#!/usr/bin/env bash
# Run this ON THE HOST after copying new files into ~/superagent.
#
# Copying files (scp, unzip, an editor's "save as") rewrites them with the umask's mode, which strips the executable bit
# from deploy/*.sh and can leave node_modules inconsistent. This repairs both, checks the tree compiles, restarts the
# daemon and confirms it answers, so a deploy either ends healthy or says why.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:$PATH"

echo "== 1/5 修复脚本权限"
chmod 755 deploy/*.sh

echo "== 2/5 安装依赖"
pnpm install --frozen-lockfile

echo "== 3/5 类型检查"
pnpm exec tsc --noEmit -p .

echo "== 4/5 重启服务"
systemctl --user restart superagent.service
sleep 3
systemctl --user is-active superagent.service

echo "== 5/5 健康检查"
node -e "
fetch('http://127.0.0.1:8787/api/health')
  .then(r => r.text())
  .then(t => { console.log(t); process.exit(t.includes('\"ok\":true') ? 0 : 1) })
  .catch(e => { console.error('后台没有响应:', e.message); process.exit(1) })
"
echo "部署完成。若任务仍失败，看：journalctl --user -u superagent.service -n 50"
