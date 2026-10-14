#!/bin/zsh
set -euo pipefail
PET_MANAGEMENT_DESKTOP="$(cd "$(dirname "$0")" && pwd)"
PET_MANAGEMENT_NODE="$(command -v node || true)"
if [[ -z "$PET_MANAGEMENT_NODE" && -x /opt/homebrew/bin/node ]]; then PET_MANAGEMENT_NODE=/opt/homebrew/bin/node; fi
if [[ -z "$PET_MANAGEMENT_NODE" && -x /usr/local/bin/node ]]; then PET_MANAGEMENT_NODE=/usr/local/bin/node; fi
if [[ -z "$PET_MANAGEMENT_NODE" ]]; then
  print '请先启动已安装的桌宠，再打开运行管理页面。'
  exit 1
fi
exec "$PET_MANAGEMENT_NODE" "$PET_MANAGEMENT_DESKTOP/../tools/start-management.mjs"
