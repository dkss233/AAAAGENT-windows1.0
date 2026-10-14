import { useContext, useMemo } from "react";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type BlackboardScope } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environment-http-auth";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import { AsyncResult } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "../state/session";
import { runIsolatedNativeChildRead } from "./native-child-flow";
import { boardEndpoint, validateBoard } from "./independent-blackboard";
import { BoardReadError, type BlackboardReader } from "./blackboard-poll";

const requestBoard = Effect.fn("aaaagent.readIndependentBlackboard")(function* (scope: BlackboardScope, prepared: PreparedConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({ prepared, signer, remoteAuthorization,
    group: "orchestration", method: "GET", timeoutMs: 45_000,
    url: base => environmentEndpointUrl(base, boardEndpoint(scope).split("?")[0]!),
    request: ({ client, headers }) => client.independentBlackboard({
      params: { projectId: scope.projectId }, payload: { environmentId: scope.environmentId }, headers,
    }),
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.match({
    onSuccess: snapshot => ({ ok: true as const, snapshot }),
    onFailure: error => ({ ok: false as const, status: "status" in error && typeof error.status === "number" ? error.status : 0 }),
  }));
});

export function useBlackboardReader(): BlackboardReader {
  const registry = useContext(RegistryContext);
  return useMemo(() => ({
    snapshot: async (scope, options) => {
      const result = await runIsolatedNativeChildRead(registry, () => connectionAtomRuntime.atom(get => {
        // Follow the raw original prepared atom: a cold None is pending, not a local failure.
        const current = get(environmentSession.preparedConnectionAtom(EnvironmentId.make(scope.environmentId)));
        return Effect.gen(function* () {
          if (AsyncResult.isFailure(current)) return yield* Effect.failCause(current.cause);
          const prepared = Option.getOrNull(Option.getOrElse(AsyncResult.value(current), () => Option.none()));
          return yield* (prepared === null ? Effect.never : requestBoard(scope, prepared));
        });
      }), options);
      if (!result.ok) throw new BoardReadError(result.status);
      return validateBoard(result.snapshot, scope);
    },
    watchConnection: (scope, change) => {
      const atom = environmentSession.preparedConnectionValueAtom(EnvironmentId.make(scope.environmentId));
      let previous = Option.getOrNull(registry.get(atom));
      const release = registry.subscribe(atom, value => {
        const next = Option.getOrNull(value);
        if (next === previous) return;
        previous = next; change(next !== null);
      });
      change(previous !== null);
      return release;
    },
  }), [registry]);
}
