#!/bin/zsh
set -euo pipefail
PET_TRIAL_DESKTOP="$(cd "$(dirname "$0")" && pwd)"
PET_TRIAL_NODE="$(command -v node || true)"
if [[ -z "$PET_TRIAL_NODE" && -x /opt/homebrew/bin/node ]]; then PET_TRIAL_NODE=/opt/homebrew/bin/node; fi
if [[ -z "$PET_TRIAL_NODE" || ! -f "$PET_TRIAL_DESKTOP/../tools/restart-trial.mjs" ]]; then
  print '启动入口尚未就绪，请联系集成任务。'
  exit 1
fi
exec "$PET_TRIAL_NODE" "$PET_TRIAL_DESKTOP/../tools/restart-trial.mjs"
