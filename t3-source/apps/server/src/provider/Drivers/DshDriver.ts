import { ProviderDriverKind, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import { DshHostService, makeDshAdapter } from "../Layers/DshAdapter.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";

const DRIVER = ProviderDriverKind.make("dsh");
const DshSettings = Schema.Struct({ agentPreset: Schema.optional(Schema.String) });
type DshSettings = typeof DshSettings.Type;
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null });

export type DshDriverEnv = never;

/** Model choices come from the original Host and require the session-only native capability. */
export const DshDriver: ProviderDriver<DshSettings, DshDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "DeepSeek Harness", supportsMultipleInstances: false },
  configSchema: DshSettings,
  defaultConfig: () => ({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const hostOption = yield* Effect.serviceOption(DshHostService);
      if (Option.isNone(hostOption)) {
        return yield* new ProviderDriverError({
          driver: DRIVER, instanceId, detail: "DSH Host service is unavailable",
        });
      }
      const host = hostOption.value;
      if (!host.environmentId.trim() || enabled && !config.agentPreset?.trim()) {
        return yield* new ProviderDriverError({
          driver: DRIVER, instanceId, detail: "A stable environment ID and explicit DSH agent preset are required",
        });
      }
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: DRIVER, instanceId });
      const adapter = yield* makeDshAdapter({
        instanceId, environmentId: host.environmentId, preset: config.agentPreset ?? "", host: host.port,
      });
      const snapshotValue = Effect.gen(function* () {
        const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const native = enabled
          ? yield* Effect.tryPromise({
              try: () => host.port.describe(),
              catch: () => new ProviderDriverError({ driver: DRIVER, instanceId, detail: "DSH status unavailable" }),
            }).pipe(Effect.orElseSucceed(() => null))
          : null;
        const models = native?.installed && native.authenticated ? [...native.models] : [];
        const ready = enabled && native?.installed === true && native.authenticated && models.length > 0;
        return {
          instanceId,
          driver: DRIVER,
          displayName: displayName ?? "DeepSeek Harness",
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          supportsConversationRollback: false,
          supportsTextGeneration: false,
          enabled,
          installed: native?.installed ?? false,
          version: native?.version ?? null,
          status: !enabled ? "disabled" : ready ? "ready" : "warning",
          auth: { status: native ? native.authenticated ? "authenticated" : "unauthenticated" : "unknown" },
          checkedAt,
          message: !enabled ? "DSH provider is disabled" : ready ? "DSH native Host is available" :
            "DSH Host or verified model catalog is unavailable",
          models,
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const snapshot: ProviderInstance["snapshot"] = {
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSnapshot: snapshotValue,
        refresh: snapshotValue,
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      };
      const unsupportedText = (operation: string) => Effect.fail(new TextGenerationError({
        operation, detail: "DSH text generation is not verified through this driver",
      }));
      const textGeneration: ProviderInstance["textGeneration"] = {
        generateCommitMessage: () => unsupportedText("generateCommitMessage"),
        generatePrContent: () => unsupportedText("generatePrContent"),
        generateBranchName: () => unsupportedText("generateBranchName"),
        generateThreadTitle: () => unsupportedText("generateThreadTitle"),
      };
      return {
        instanceId, driverKind: DRIVER, continuationIdentity, displayName, accentColor, enabled,
        snapshot, adapter: { ...adapter, watchNativeThread: (input, changed) => Effect.tryPromise({
          try: () => { if (!host.port.watchHistory) throw Error("Original DSH notifications unavailable"); return host.port.watchHistory(input.threadId, input.cwd, changed); },
          catch: () => new ProviderAdapterRequestError({ provider: DRIVER, method: "session/watch", detail: "Original DSH notifications unavailable" }),
        }), readNativeThread: input => Effect.tryPromise({
          try: () => { if (!host.port.readHistory) throw Error("Original DSH reader unavailable"); return host.port.readHistory(input.threadId, input.cwd, input.nativePreset ?? config.agentPreset ?? "", input.checkpoint); },
          catch: () => new ProviderAdapterRequestError({ provider: DRIVER, method: "session/page", detail: "Original DSH readonly history unavailable" }),
        }) }, textGeneration,
      } satisfies ProviderInstance;
    }),
};
