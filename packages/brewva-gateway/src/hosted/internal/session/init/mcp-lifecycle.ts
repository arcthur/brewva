import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { ManagedToolMode } from "@brewva/brewva-runtime/session";
import type { HostedMcpOperationalEvent, HostedMcpToolBundle } from "./mcp-tools.js";
import type { HostedSession } from "./session-assembly.js";

export function recordHostedBootstrap(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  cwd: string;
  configPath?: string;
  managedToolMode: ManagedToolMode;
}): void {
  input.runtime.extensions.hosted.events.record({
    sessionId: input.sessionId,
    type: "session_bootstrap",
    payload: {
      cwd: input.cwd,
      agentId: input.runtime.identity.agentId,
      managedToolMode: input.managedToolMode,
      runtimeConfig: {
        workspaceRoot: input.runtime.identity.workspaceRoot,
        configPath: input.configPath ?? null,
        artifactRoots: {
          eventsDir: input.runtime.config.infrastructure.events.dir,
          recoveryWalDir: input.runtime.config.infrastructure.recoveryWal.dir,
          projectionDir: input.runtime.config.projection.dir,
          ledgerPath: input.runtime.config.ledger.path,
        },
      },
    },
  });
}

export function createHostedMcpEventRecorder(runtime: BrewvaHostedRuntimePort): {
  setSessionId(sessionId: string): void;
  record(event: HostedMcpOperationalEvent): void;
} {
  let sessionId: string | undefined;
  const pending: HostedMcpOperationalEvent[] = [];
  const recordNow = (event: HostedMcpOperationalEvent, activeSessionId: string) => {
    runtime.extensions.hosted.events.record({
      sessionId: activeSessionId,
      type: event.type,
      payload: event.payload,
    });
  };
  return {
    setSessionId(nextSessionId) {
      sessionId = nextSessionId;
      for (const event of pending.splice(0)) {
        recordNow(event, nextSessionId);
      }
    },
    record(event) {
      if (!sessionId) {
        pending.push(event);
        return;
      }
      recordNow(event, sessionId);
    },
  };
}

const MCP_BUNDLE_DISPOSE_TIMEOUT_MS = 5_000;

export function installHostedMcpBundleDisposal(
  session: HostedSession,
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
  bundle: HostedMcpToolBundle | undefined,
  options: { shouldRecordDisposeFailure?: () => boolean } = {},
): HostedSession {
  if (!bundle) {
    return session;
  }
  const originalDispose = session.dispose.bind(session);
  let disposed = false;
  session.dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;

    const disposePromise = bundle.dispose();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const recordDisposeFailure = (payload: Record<string, unknown>) => {
      if (options.shouldRecordDisposeFailure && !options.shouldRecordDisposeFailure()) {
        return;
      }
      runtime.extensions.hosted.events.record({
        sessionId,
        type: "mcp_server_disconnected",
        payload: {
          disposeFailed: true,
          ...payload,
        },
      });
    };

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      recordDisposeFailure({
        disposeTimedOut: true,
        timeoutMs: MCP_BUNDLE_DISPOSE_TIMEOUT_MS,
      });
    }, MCP_BUNDLE_DISPOSE_TIMEOUT_MS);

    void disposePromise
      .catch((error: unknown) => {
        recordDisposeFailure({
          error: error instanceof Error ? error.message : String(error),
          ...(timedOut ? { afterTimeout: true } : {}),
        });
      })
      .finally(() => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      });

    originalDispose();
  };
  return session;
}
