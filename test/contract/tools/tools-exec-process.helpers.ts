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
  serverUrl?: string;
}) {
  const mode = input?.mode ?? "standard";
  const enforceIsolation = input?.enforceIsolation ?? false;
  const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const runtime = {
    config: {
      security: {
        mode,
        sanitizeContext: true,
        execution: {
          backend: input?.backend ?? "best_available",
          enforceIsolation,
          fallbackToHost: input?.fallbackToHost ?? false,
          commandDenyList: input?.commandDenyList ?? [],
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
  };
  return { runtime: runtime as unknown as BrewvaToolRuntime, events };
}
