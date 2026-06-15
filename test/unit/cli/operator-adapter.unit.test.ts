import { describe, expect, test } from "bun:test";
import { createCliInspectPort } from "../../../packages/brewva-cli/src/runtime/cli-runtime-ports.js";
import { createOperatorSurfacePort } from "../../../packages/brewva-cli/src/shell/ports/operator-adapter.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/api.js";

describe("operator adapter", () => {
  test("getSnapshot does not trigger accepted approval recovery", async () => {
    const runtime = {
      ops: {
        proposals: {
          requests: {
            listPending() {
              return [];
            },
            list(_sessionId: string, query?: { state?: string }) {
              if (query?.state === "accepted") {
                throw new Error("accepted recovery must be explicit");
              }
              return [];
            },
          },
        },
        events: {
          records: {
            query() {
              return [];
            },
          },
          replay: {
            listSessions() {
              return [];
            },
          },
        },
      },
    } as unknown as HostedRuntimeAdapterPort;
    const session = {
      sessionManager: {
        getSessionId() {
          return "operator-session";
        },
      },
    };
    const port = createOperatorSurfacePort({
      getSessionBundle() {
        return {
          session,
          runtime,
          inspect: createCliInspectPort(runtime),
          toolDefinitions: new Map(),
          initPhases: [],
          phase: "ready",
        } as never;
      },
      async openSession() {
        throw new Error("not used");
      },
      async createSession() {
        throw new Error("not used");
      },
    });

    const snapshot = await port.getSnapshot();

    expect(snapshot).toEqual({
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [],
    });
  });
});
