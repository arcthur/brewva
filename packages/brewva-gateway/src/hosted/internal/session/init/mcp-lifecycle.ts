import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";
import type { HostedRuntimeAdapterPort } from "../runtime-ports.js";
import type { HostedMcpOperationalEvent, HostedMcpToolBundle } from "./mcp-tools.js";
import type { HostedSession } from "./session-assembly.js";

export function recordHostedBootstrap(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  cwd: string;
  configPath?: string;
  managedToolMode: ManagedToolMode;
}): void {
  input.runtime.ops.session.lifecycle.bootstrap({
    sessionId: input.sessionId,
    payload: {
      cwd: input.cwd,
      agentId: input.runtime.identity.agentId,
      managedToolMode: input.managedToolMode,
      runtimeConfig: {
        workspaceRoot: input.runtime.identity.workspaceRoot,
        configPath: input.configPath ?? null,
        artifactRoots: {
          tapeDir: input.runtime.config.tape.dir,
          recoveryWalDir: input.runtime.config.infrastructure.recoveryWal.dir,
          projectionDir: input.runtime.config.projection.dir,
          ledgerPath: input.runtime.config.ledger.path,
        },
      },
    },
  });
}

export function createHostedMcpEventRecorder(runtime: HostedRuntimeAdapterPort): {
  setSessionId(sessionId: string): void;
  record(event: HostedMcpOperationalEvent): void;
} {
  let sessionId: string | undefined;
  const pending: HostedMcpOperationalEvent[] = [];
  const recordNow = (event: HostedMcpOperationalEvent, activeSessionId: string) => {
    const input = { sessionId: activeSessionId, payload: event.payload };
    if (event.type === "mcp_server_connected") {
      runtime.ops.session.mcp.serverConnected(input);
    } else if (event.type === "mcp_server_disconnected") {
      runtime.ops.session.mcp.serverDisconnected(input);
    } else if (event.type === "mcp_tool_list_refreshed") {
      runtime.ops.session.mcp.toolListRefreshed(input);
    } else {
      runtime.ops.session.mcp.toolCallFailed(input);
    }
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
  runtime: HostedRuntimeAdapterPort,
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
      runtime.ops.session.mcp.serverDisconnected({
        sessionId,
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
          error: toErrorMessage(error),
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
