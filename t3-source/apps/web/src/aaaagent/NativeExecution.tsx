import { useCallback, useEffect, useRef, useState } from "react";
import { NATIVE_READ } from "./NativeReadBoundary";
import { renewNativeMountSession, nativeSessionRenewDelay } from "./native-session-renewal";
import {
  decodeNativeExecutionCapability, decodeNativeTargetCapability,
  type NativeExecutionCapability, type NativeTargetCapability,
} from "./native-execution-capability";

interface CapabilityState {
  readonly key: string;
  readonly capability: NativeExecutionCapability | null;
  readonly target: NativeTargetCapability | null;
}

export function useNativeExecutionCapability(environmentId: string, threadId: string | null, connected: boolean, bindingVersion = "") {
  const key = JSON.stringify([environmentId, threadId, connected, bindingVersion]);
  const [state, setState] = useState<CapabilityState | null>(null);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const refresh = useCallback(async (renew = false) => {
    const request = ++generation.current;
    abort.current?.abort();
    if (!renew) setState(null);
    if (!NATIVE_READ) return;
    const controller = new AbortController();
    abort.current = controller;
    const read = async (path: string): Promise<unknown> => {
      const response = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal });
      return response.ok ? response.json() : null;
    };
    try {
      if (renew || !connected) {
        const restored = await renewNativeMountSession(environmentId, controller.signal);
        if (renew && !restored) { if (generation.current === request) setState(null); return; }
      }
      if (!connected) return;
      let renewed = renew;
      const readWithRecovery = async (path: string): Promise<unknown> => {
        const value = await read(path);
        if (value !== null || renewed) return value;
        renewed = true;
        if (!await renewNativeMountSession(environmentId, controller.signal)) return null;
        return read(path);
      };
      const globalValue = await readWithRecovery("/api/native-mount/capabilities");
      const targetValue = threadId ? await read(`/api/native-mount/targets/${encodeURIComponent(threadId)}/capabilities`) : null;
      if (generation.current !== request) return;
      const capability = decodeNativeExecutionCapability(globalValue, environmentId);
      const target = threadId ? decodeNativeTargetCapability(targetValue, environmentId, threadId) : null;
      setState({ key, capability, target });
    } catch {
      if (generation.current === request) setState(null);
    }
  }, [connected, environmentId, key, threadId]);
  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    const offline = () => { generation.current++; abort.current?.abort(); setState(null); };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", focus);
    window.addEventListener("online", focus);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    return () => {
      generation.current++; abort.current?.abort();
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", focus);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const current = connected && state?.key === key ? state : null;
  useEffect(() => {
    if (!current?.capability) return;
    const expiresAt = Math.min(Date.parse(current.capability.expiresAt), current.target ? Date.parse(current.target.expiresAt) : Infinity);
    const timeout = window.setTimeout(() => { void refresh(true); }, nativeSessionRenewDelay(expiresAt));
    return () => window.clearTimeout(timeout);
  }, [current, refresh]);
  return { capability: current?.capability ?? null, target: current?.target ?? null, refresh };
}
