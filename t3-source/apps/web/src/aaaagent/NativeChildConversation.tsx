import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, NativeChildFlowConversation, NativeChildFlowRelations, type NativeChildFlowNode } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environment-http-auth";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import { AsyncResult } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "../state/session";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { useTheme } from "../hooks/useTheme";
import { nativeChildEndpoint, nativeChildKey, nativeChildSessionLabel, nativeChildTurnLabel, projectNativeChildConversation,
  runIsolatedNativeChildRead, type NativeChildReader, type NativeChildTarget } from "./native-child-flow";

const nativeChildRequest = Effect.fn("aaaagent.readOriginalNativeChild")(function* (input: {
  target: NativeChildTarget; childId?: string;
}, prepared: PreparedConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const target = input.target;
  const payload = { environmentId: target.environmentId, projectId: target.projectId, instanceId: target.providerInstanceId };
  const common = { prepared, signer, remoteAuthorization, group: "orchestration" as const, method: "GET" as const,
    url: (base: string) => environmentEndpointUrl(base, nativeChildEndpoint(target, input.childId).split("?")[0]!), timeoutMs: 45_000 };
  if (input.childId !== undefined) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({ ...common,
      request: ({ client, headers }) => client.nativeChildConversation({ params: { threadId: target.parentThreadId, childId: input.childId! }, payload, headers }),
    }).pipe(Effect.provide(FetchHttpClient.layer));
  }
  return yield* executeAuthenticatedEnvironmentHttpRequest({ ...common,
    request: ({ client, headers }) => client.nativeChildRelations({ params: { threadId: target.parentThreadId }, payload, headers }),
  }).pipe(Effect.provide(FetchHttpClient.layer));
});
export function useNativeChildReader(): NativeChildReader {
  const registry = useContext(RegistryContext);
  return useMemo(() => {
    const request = (input: Parameters<typeof nativeChildRequest>[0], options?: { signal?: AbortSignal }) =>
      runIsolatedNativeChildRead(registry, () => connectionAtomRuntime.atom(get => {
        const result = get(environmentSession.preparedConnectionAtom(EnvironmentId.make(input.target.environmentId)));
        return Effect.gen(function* () {
          if (AsyncResult.isFailure(result)) return yield* Effect.failCause(result.cause);
          const prepared = Option.getOrNull(Option.getOrElse(AsyncResult.value(result), () => Option.none()));
          return yield* (prepared === null ? Effect.never : nativeChildRequest(input, prepared));
        });
      }), options);
    return ({
    relations: async (target: NativeChildTarget, options?: { signal?: AbortSignal }) => Schema.decodeUnknownSync(NativeChildFlowRelations)(await request({ target }, options)),
    conversation: async (target: NativeChildTarget, childId: string, options?: { signal?: AbortSignal }) => Schema.decodeUnknownSync(NativeChildFlowConversation)(await request({ target, childId }, options)),
    subscribeConnection: (targets: readonly NativeChildTarget[], onChange: () => void) => {
      const releases = [...new Set(targets.map(target => target.environmentId))].map(id => {
        const atom = environmentSession.preparedConnectionValueAtom(EnvironmentId.make(id));
        let previous = Option.getOrNull(registry.get(atom));
        return registry.subscribe(atom, value => {
          const next = Option.getOrNull(value);
          if (next === previous) return;
          previous = next; onChange();
        });
      });
      return () => releases.forEach(release => release());
    },
    });
  }, [registry]);
}

export function NativeChildConversation({ target, child, reader, onClose, onOpenParent, onLoaded }: {
  target: NativeChildTarget; child: NativeChildFlowNode; reader: NativeChildReader;
  onClose: () => void; onOpenParent: () => void;
  onLoaded?: (response: NativeChildFlowConversation) => void;
}) {
  const key = nativeChildKey(target, child.nativeThreadId);
  const [result, setResult] = useState<{ key: string; response: NativeChildFlowConversation } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLElement>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const onLoadedRef = useRef(onLoaded); onLoadedRef.current = onLoaded;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    let active = true, pending = true;
    const controller = new AbortController();
    setResult(null); setError(null);
    if (child.relationship !== "verified") { setError({ key, message: "父子归属尚未核实，无法读取完整对话。" }); return; }
    const unsubscribe = reader.subscribeConnection?.([target], () => {
      if (active && !pending) setRetry(value => value + 1);
    });
    void reader.conversation(target, child.nativeThreadId, { signal: controller.signal }).then(response => {
      projectNativeChildConversation(response, target, child.nativeThreadId);
      if (active) { pending = false; setResult({ key, response }); onLoadedRef.current?.(response); }
    }).catch(() => { if (active) { pending = false; setError({ key, message: "原子会话读取失败。请检查原连接后重试。" }); } });
    return () => { active = false; controller.abort(); unsubscribe?.(); };
  }, [key, reader, retry]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input,select,summary,[tabindex='0']") ?? [])]
        .filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    // Consume the top layer before the parent Sheet's React/bubble dismissal.
    document.addEventListener("keydown", handle, true);
    return () => { document.removeEventListener("keydown", handle, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const response = result?.key === key ? result.response : null;
  const projection = useMemo(() => response ? projectNativeChildConversation(response, target, child.nativeThreadId) : null, [response, key]);
  const loadedChild = response?.child ?? child;
  const noop = () => {};
  return createPortal(<section ref={dialog} role="dialog" aria-modal="true" aria-label={`完整子对话 ${child.title}`}
    className="aaa-native-child-dialog aaa-workspace-shell" data-native-child-key={key}>
    <header className="aaa-native-child-heading"><div><span className="aaa-eyebrow">子 Agent · 原完整对话 · 只读</span>
      <h2>{child.title || child.agentPath || "子Agent"}</h2><p>{child.agentPath ?? "执行者路径待核"} · {child.model ?? "模型待核"} {child.effort ?? ""}</p>
      <p>{nativeChildSessionLabel(loadedChild.sessionStatus)} · {nativeChildTurnLabel(projection?.lastTurnStatus ?? loadedChild.lastTurnStatus)}</p></div>
      <div><button type="button" onClick={onOpenParent}>查看父对话</button><button type="button" ref={closeButton} onClick={onClose}>返回</button></div></header>
    {error?.key === key ? <div className="aaa-native-child-message" role="alert"><p>{error.message}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></div>
      : !projection ? <p className="aaa-native-child-message" role="status">正在读取原完整子对话…</p>
      : <><div className="aaa-native-child-source" role="status">原生完整历史 · {projection.turnCount} 轮 · {projection.items.length} 项
        {!projection.hasOriginalUserMessage && <p>原记录未返回独立的初始任务提示。任务下达记录可在父对话查看。</p>}</div>
        <div className="aaa-native-child-timeline"><MessagesTimeline isWorking={false} activeTurnStartedAt={null}
          listRef={listRef} timelineEntries={projection.entries} latestTurn={null} runningTurnId={null} turnDiffSummaries={[]}
          routeThreadKey={key} displayThreadKey={key} onOpenTurnDiff={noop} supportsConversationRollback={false}
          onRevertToTurnCount={noop} isRevertingCheckpoint={false} onImageExpand={noop}
          activeThreadEnvironmentId={EnvironmentId.make(target.environmentId)} markdownCwd={undefined} resolvedTheme={resolvedTheme}
          timestampFormat="locale" workspaceRoot={undefined} anchorMessageId={null} onAnchorReady={noop}
          contentInsetEndAdjustment={0} liveFollowEnabled={false} onIsAtEndChange={noop} onManualNavigation={noop} />
        </div>
        <details className="aaa-native-child-original"><summary>展开原始轮次、项目和完整字段</summary>
          <p>保留原记录的身份、正文、命令与输出。原项目未给出时间时，时间线沿原活动时间显示。</p>
          {projection.items.filter(item => !item.recognized).map(item => <details key={item.key} data-unknown-native-item={item.id}>
            <summary>原生项目 {item.type || "未知类型"} · {item.id || "未提供ID"}</summary><pre>{JSON.stringify(item.original, null, 2)}</pre></details>)}
          <pre data-native-complete-record="true">{JSON.stringify(response?.nativeThread, null, 2)}</pre>
        </details></>}
  </section>, document.body);
}
