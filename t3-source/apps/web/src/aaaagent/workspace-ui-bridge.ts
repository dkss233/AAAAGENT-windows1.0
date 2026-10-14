import { useEffect, useState } from "react";
import { useTheme } from "../hooks/useTheme";

export const managementPages = [
  ["overview", "运行总览"], ["memory", "记忆与对话"], ["projects", "项目索引"],
  ["tasks", "任务转发"], ["wechat", "微信连接"], ["models", "模型与声音"],
  ["presentation", "表情与动作"], ["events", "运行记录"],
] as const;
export function sendWorkspaceIntent(type: string, fields: Record<string, string> = {}) {
  if (window.parent === window || !window.location.pathname.startsWith("/native/")) return;
  window.parent.postMessage({ source: "aaa-workspace-ui", version: 1, type, ...fields }, window.location.origin);
}
export function useWorkspaceBridge() {
  const { appearanceMode, setAppearanceMode } = useTheme();
  const [phase, setPhase] = useState<string | null>(null);
  useEffect(() => {
    if (window.parent === window || !window.location.pathname.startsWith("/native/")) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      const value = event.data;
      if (!value || value.source !== "aaa-workspace-ui" || value.version !== 1 || value.type !== "shell.state" ||
          !["light", "dark", "system"].includes(value.mode) || !["light", "dark"].includes(value.resolved) ||
          !["idle", "connecting", "ready", "unavailable", "offline", "expired", "error"].includes(value.phase)) return;
      setPhase(value.phase);
      if (value.mode !== appearanceMode) setAppearanceMode(value.mode);
    };
    window.addEventListener("message", receive);
    sendWorkspaceIntent("shell.ready");
    return () => window.removeEventListener("message", receive);
  }, [appearanceMode, setAppearanceMode]);
  return phase;
}
