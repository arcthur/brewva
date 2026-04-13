import { resolve } from "node:path";
import { createToolRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaToolContext } from "@brewva/brewva-substrate";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools";
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
  backend?: "host" | "sandbox" | "best_available";
  enforceIsolation?: boolean;
  fallbackToHost?: boolean;
  commandDenyList?: string[];
  boundaryCommandDenyList?: string[];
  serverUrl?: string;
  boundEnv?: Record<string, string>;
  sandboxApiKey?: string;
  cwd?: string;
  targetRoots?: string[];
}) {
  const mode = input?.mode ?? "standard";
  const enforceIsolation = input?.enforceIsolation ?? false;
  const events: RecordedExecTestEvent[] = [];
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
      sandboxApiKeyRef: "vault://sandbox/apiKey",
      gatewayTokenRef: "vault://gateway/token",
      bindings: [],
    };
    runtimeConfig.security.execution = {
      backend: input?.backend ?? "best_available",
      enforceIsolation,
      fallbackToHost: input?.fallbackToHost ?? false,
      sandbox: {
        serverUrl: input?.serverUrl ?? "http://127.0.0.1:5555",
        defaultImage: "microsandbox/node",
        memory: 64,
        cpus: 1,
        timeout: 1,
      },
    };
  });

  const runtimeFixture = createRuntimeFixture({
    config,
    inspect: {
      task: {
        getTargetDescriptor: () => ({
          primaryRoot: targetRoots[0] ?? cwd,
          roots: targetRoots,
        }),
      },
    },
  });

  const runtime: BrewvaBundledToolRuntime = {
    ...createToolRuntimePort(runtimeFixture),
    internal: {
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
      resolveCredentialBindings: () => ({ ...input?.boundEnv }),
      resolveSandboxApiKey: () => input?.sandboxApiKey,
    },
  };

  return { runtime, events };
}
