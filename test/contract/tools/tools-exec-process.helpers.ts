import { resolve } from "node:path";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { BrewvaToolContext } from "@brewva/brewva-substrate/tools";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools/contracts";
import { createManagedExecProcessRegistryRuntime } from "@brewva/brewva-tools/execution";
import { BOX_RELEASED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import { TURN_INPUT_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import {
  createInMemoryBoxPlane,
  type BoxPlane,
} from "../../../packages/brewva-tools/src/internal/box/index.js";
import { createRuntimeConfig, createRuntimeFixture } from "../../helpers/runtime.js";

type RecordedExecTestEvent = {
  sessionId?: string;
  type?: string;
  turn?: number;
  payload?: Record<string, unknown>;
  timestamp?: number;
  skipTapeCheckpoint?: boolean;
};

type RuntimeExecTestEventInput = Omit<RecordedExecTestEvent, "payload"> & {
  payload?: object;
};

export function extractTextContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

export function fakeContext(sessionId: string): BrewvaToolContext {
  return {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  } as unknown as BrewvaToolContext;
}

export function createRuntimeForExecTests(input?: {
  mode?: "permissive" | "standard" | "strict";
  backend?: "host" | "box";
  commandDenyList?: string[];
  boundaryCommandDenyList?: string[];
  boundEnv?: Record<string, string>;
  boxPlane?: BoxPlane;
  cwd?: string;
  targetRoots?: string[];
  turnPromptText?: string;
  boxDetach?: boolean;
  autoBackgroundForegroundWaitMs?: number;
}) {
  const mode = input?.mode ?? "standard";
  const events: RecordedExecTestEvent[] = [];
  const clearStateListeners: Array<(sessionId: string) => void> = [];
  const cwd = resolve(input?.cwd ?? process.cwd());
  const turnPromptText = input?.turnPromptText;
  const targetRoots =
    input?.targetRoots && input.targetRoots.length > 0
      ? input.targetRoots.map((root) => resolve(root))
      : [cwd];
  const config = createRuntimeConfig((runtimeConfig) => {
    runtimeConfig.security.mode = mode;
    runtimeConfig.security.sanitizeContext = true;
    runtimeConfig.security.boundaryPolicy.commandDenyList =
      input?.boundaryCommandDenyList ?? input?.commandDenyList ?? [];
    runtimeConfig.security.boundaryPolicy.filesystem = {
      readAllow: [],
      writeAllow: [],
      writeDeny: [],
    };
    runtimeConfig.security.boundaryPolicy.network = {
      mode: "inherit",
      allowLoopback: true,
      outbound: [],
    };
    runtimeConfig.security.loopDetection = {
      exactCall: {
        enabled: true,
        threshold: 3,
        mode: "warn",
        exemptTools: [],
      },
    };
    runtimeConfig.security.credentials = {
      path: ".brewva/credentials.vault",
      masterKeyEnv: "BREWVA_VAULT_KEY",
      allowDerivedKeyFallback: true,
      boxSecretsRef: "vault://box/secrets",
      gatewayTokenRef: "vault://gateway/token",
      bindings: [],
    };
    runtimeConfig.security.execution = {
      backend: input?.backend ?? "box",
      autoBackground: {
        foregroundWaitMs: input?.autoBackgroundForegroundWaitMs ?? 10_000,
      },
      box: {
        home: "~/.brewva/boxes-test",
        image: "ghcr.io/arcthur/box-default:latest",
        cpus: 1,
        memoryMib: 512,
        diskGb: 4,
        workspaceGuestPath: "/workspace",
        scopeDefault: "session",
        network: { mode: "off" },
        detach: input?.boxDetach ?? true,
        autoSnapshotOnRelease: false,
        perSessionLifetime: "session",
        gc: {
          maxStoppedBoxes: 8,
          maxAgeDays: 7,
        },
      },
    };
  });

  const runtimeFixture = createRuntimeFixture({
    config,
    capabilities: {
      events:
        turnPromptText === undefined
          ? undefined
          : {
              records: {
                query: (sessionId, query?: { type?: string }) =>
                  query?.type === TURN_INPUT_RECORDED_EVENT_TYPE
                    ? [
                        {
                          id: "evt-turn-input-test",
                          sessionId: asBrewvaSessionId(sessionId),
                          type: TURN_INPUT_RECORDED_EVENT_TYPE,
                          timestamp: 0,
                          payload: { promptText: turnPromptText },
                        },
                      ]
                    : [],
              },
            },
      task: {
        target: {
          getDescriptor: () => ({
            primaryRoot: targetRoots[0] ?? cwd,
            roots: targetRoots,
          }),
        },
      },
    },
  });

  const recordEvent = (event: RuntimeExecTestEventInput): undefined => {
    events.push({
      sessionId: event.sessionId,
      type: event.type,
      turn: event.turn,
      payload: event.payload as Record<string, unknown> | undefined,
      timestamp: event.timestamp,
      skipTapeCheckpoint: event.skipTapeCheckpoint,
    });
    return undefined;
  };
  const runtimeOps = runtimeFixture.ops;
  runtimeOps.tools.execution.recordAudit = (event: RuntimeExecTestEventInput) => recordEvent(event);
  runtimeOps.tools.lifecycle.boxReleased = (event: RuntimeExecTestEventInput) =>
    recordEvent({ ...event, type: BOX_RELEASED_EVENT_TYPE });

  const runtime: BrewvaBundledToolRuntime = {
    identity: runtimeFixture.identity,
    config: runtimeFixture.config,
    capabilities: runtimeOps,
    boxPlane: input?.boxPlane ?? createInMemoryBoxPlane(),
    execProcessRegistry: createManagedExecProcessRegistryRuntime(),
    extensions: {
      tools: {
        onClearState: (listener) => {
          clearStateListeners.push(listener);
        },
        resolveCredentialBindings: () => ({ ...input?.boundEnv }),
      },
    },
  };

  return {
    runtime,
    events,
    clearSession: (sessionId: string) => {
      for (const listener of clearStateListeners) {
        listener(sessionId);
      }
    },
  };
}
