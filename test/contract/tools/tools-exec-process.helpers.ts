import { resolve } from "node:path";
import type { BrewvaToolContext } from "@brewva/brewva-substrate/tools";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools/contracts";
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
  boxDetach?: boolean;
}) {
  const mode = input?.mode ?? "standard";
  const events: RecordedExecTestEvent[] = [];
  const clearStateListeners: Array<(sessionId: string) => void> = [];
  const cwd = resolve(input?.cwd ?? process.cwd());
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
    inspect: {
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

  const runtime: BrewvaBundledToolRuntime = {
    identity: runtimeFixture.identity,
    config: runtimeFixture.config,
    authority: runtimeFixture.authority,
    inspect: runtimeFixture.inspect,
    boxPlane: input?.boxPlane ?? createInMemoryBoxPlane(),
    extensions: {
      tools: {
        recordEvent: (event) => {
          events.push({
            sessionId: event.sessionId,
            type: event.type,
            turn: event.turn,
            payload: event.payload as Record<string, unknown> | undefined,
            timestamp: event.timestamp,
            skipTapeCheckpoint: event.skipTapeCheckpoint,
          });
          return undefined;
        },
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
