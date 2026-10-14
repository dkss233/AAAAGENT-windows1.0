#!/bin/zsh
set -euo pipefail
PET_START_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PET_START_NODE=/opt/homebrew/opt/node@20/bin/node
if [[ ! -x "$PET_START_NODE" ]]; then PET_START_NODE="$(command -v node || true)"; fi
if [[ -z "$PET_START_NODE" ]]; then
  print '未找到已安装的 Node，请联系集成任务。'
  exit 1
fi
# Both source and user entry sit three directories below the project root.
exec "$PET_START_NODE" "$PET_START_ROOT/code/desktop-pet/tools/restart-trial.mjs" --root "$PET_START_ROOT"
