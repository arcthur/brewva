import { resolve } from "node:path";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function extractTextContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

export function fakeContext(sessionId: string): ExtensionContext {
  return {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  } as unknown as ExtensionContext;
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
  const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const cwd = resolve(input?.cwd ?? process.cwd());
  const targetRoots =
    input?.targetRoots && input.targetRoots.length > 0
      ? input.targetRoots.map((root) => resolve(root))
      : [cwd];
  const runtime = {
    cwd,
    workspaceRoot: cwd,
    config: {
      security: {
        mode,
        sanitizeContext: true,
        boundaryPolicy: {
          commandDenyList: input?.boundaryCommandDenyList ?? input?.commandDenyList ?? [],
          filesystem: {
            readAllow: [],
            writeAllow: [],
            writeDeny: [],
          },
          network: {
            mode: "inherit",
            allowLoopback: true,
            outbound: [],
          },
        },
        loopDetection: {
          exactCall: {
            enabled: true,
            threshold: 3,
            mode: "warn",
            exemptTools: [],
          },
        },
        credentials: {
          path: ".brewva/credentials.vault",
          masterKeyEnv: "BREWVA_VAULT_KEY",
          allowDerivedKeyFallback: true,
          sandboxApiKeyRef: "vault://sandbox/apiKey",
          gatewayTokenRef: "vault://gateway/token",
          bindings: [],
        },
        execution: {
          backend: input?.backend ?? "best_available",
          enforceIsolation,
          fallbackToHost: input?.fallbackToHost ?? false,
          commandDenyList: [],
          sandbox: {
            serverUrl: input?.serverUrl ?? "http://127.0.0.1:5555",
            defaultImage: "microsandbox/node",
            memory: 64,
            cpus: 1,
            timeout: 1,
          },
        },
      },
    },
    events: {
      record: (event: { type?: string; payload?: Record<string, unknown> }) => {
        events.push(event);
        return undefined;
      },
    },
    session: {
      resolveCredentialBindings: () => ({ ...input?.boundEnv }),
      resolveSandboxApiKey: () => input?.sandboxApiKey,
    },
    task: {
      getTargetDescriptor: () => ({
        primaryRoot: targetRoots[0] ?? cwd,
        roots: targetRoots,
      }),
    },
  };
  return { runtime: runtime as unknown as BrewvaToolRuntime, events };
}
