import { useCallback, useEffect, useRef, useState } from "react";
import { usePrimaryEnvironment } from "../state/environments";
import { decodeSkillTrial, type SkillTrial } from "./SkillInputs";
import { lockNativeControl, nativeControlSelector, preventNativeControlEvent } from "./native-operation-guard";
export const NATIVE_READ = import.meta.env.VITE_AAA_NATIVE_READ === "1";
export function useSkillTrialCapability(targetKey: string) {
  const [trial, setTrial] = useState<SkillTrial | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!NATIVE_READ) return;
    const request = ++generation.current;
    setTrial(null);
    try {
      const response = await fetch("/api/native-mount/skill-trial", { credentials: "same-origin", cache: "no-store" });
      const next = response.ok ? decodeSkillTrial(await response.json()) : null;
      if (generation.current === request) setTrial(next);
    } catch {
      if (generation.current === request) setTrial(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { generation.current++; window.removeEventListener("focus", focus); };
  }, [targetKey, refresh]);
  useEffect(() => {
    if (!trial) return;
    const delay = Date.parse(trial.expiresAt) - Date.now();
    if (delay <= 0) { setTrial(null); return; }
    const timeout = window.setTimeout(() => setTrial(null), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [trial]);
  return { trial, refresh };
}
// UI prevention is additional to the I-owned HTTP/RPC gateway. It never replaces it.
export function NativeReadBoundary() {
  const environment = usePrimaryEnvironment();
  useEffect(() => {
    if (!NATIVE_READ) return;
    const lock = () => {
      for (const element of document.querySelectorAll<HTMLElement>(nativeControlSelector)) lockNativeControl(element);
    };
    const keys = (event: KeyboardEvent) => {
      // Original global new-task/command shortcuts are disabled in this read mode.
      if ((event.metaKey || event.ctrlKey) && ["n", "k", "o"].includes(event.key.toLowerCase()) ||
          event.altKey && event.key.toLowerCase() === "n") { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    lock();const observer = new MutationObserver(lock);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label", "title", "data-aaa-skill-trial-send", "data-aaa-native-command", "data-aaa-native-allowed", "data-aaa-native-disabled", "data-aaa-local-draft-action"] });
    document.addEventListener("click", preventNativeControlEvent, true);document.addEventListener("pointerdown", preventNativeControlEvent, true);
    document.addEventListener("keydown", keys, true);
    return () => { observer.disconnect();document.removeEventListener("click", preventNativeControlEvent, true);document.removeEventListener("pointerdown", preventNativeControlEvent, true);document.removeEventListener("keydown", keys, true); };
  }, []);
  if (!NATIVE_READ) return null;
  const phase = environment?.connection.phase;
  if (phase === "connected") return null;
  return <div className="aaa-native-read-status" role="status">
    {phase === "offline" || phase === "error" || phase === "unsupported" ? "原生连接不可用，当前记录可能已过期；可从控制台重新连接。" :
      "正在连接已有原生服务；项目与对话来自原服务。"}
  </div>;
}
