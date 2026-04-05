import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { buildReadPathDiscoveryObservationPayload } from "@brewva/brewva-tools";
import {
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
  analyzeReadPathRecoveryState,
  createReadPathRecoveryLifecycle,
} from "../../../packages/brewva-gateway/src/runtime-plugins/read-path-recovery.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("read path recovery lifecycle", () => {
  test("records a gate arm event after repeated missing-path read failures", async () => {
    const workspace = createTestWorkspace("read-path-gate-arm");
    try {
      const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
      const lifecycle = createReadPathRecoveryLifecycle(runtime);
      const sessionId = "read-path-gate-arm";

      for (const path of ["src/missing-a.ts", "src/missing-b.ts"]) {
        recordRuntimeEvent(runtime, {
          sessionId,
          type: "tool_result_recorded",
          payload: {
            toolName: "read",
            verdict: "fail",
            failureContext: {
              args: { path },
              outputText: `ENOENT: no such file or directory, open '${path}'`,
              failureClass: "execution",
            },
          },
        });
      }

      await lifecycle.toolResult?.(
        {
          toolCallId: "read-tool-call",
          toolName: "read",
          input: { path: "src/missing-b.ts" },
          content: [{ type: "text", text: "ENOENT: no such file or directory" }],
          isError: true,
        } as never,
        {
          cwd: workspace,
          sessionManager: {
            getSessionId: () => sessionId,
          },
        } as never,
      );

      const armEvents = runtime.inspect.events.query(sessionId, {
        type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
      });
      expect(armEvents).toHaveLength(1);
      expect(armEvents[0]?.payload).toMatchObject({
        consecutiveMissingPathFailures: 2,
        failedPaths: ["src/missing-b.ts", "src/missing-a.ts"],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("does not activate the read gate without an explicit arm event", async () => {
    const workspace = createTestWorkspace("read-path-no-arm");
    try {
      const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
      const sessionId = "read-path-no-arm";

      for (const path of ["src/missing-a.ts", "src/missing-b.ts"]) {
        recordRuntimeEvent(runtime, {
          sessionId,
          type: "tool_result_recorded",
          payload: {
            toolName: "read",
            verdict: "fail",
            failureContext: {
              args: { path },
              outputText: `ENOENT: no such file or directory, open '${path}'`,
              failureClass: "execution",
            },
          },
        });
      }

      expect(analyzeReadPathRecoveryState(runtime, sessionId)).toMatchObject({
        active: false,
        phase: "inactive",
        consecutiveMissingPathFailures: 2,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("records discovery evidence and marks the gate satisfied when a real path is observed", async () => {
    const workspace = createTestWorkspace("read-path-evidence");
    try {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src/index.ts"), "export const index = true;\n", "utf8");
      const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
      const sessionId = "read-path-evidence";

      recordRuntimeEvent(runtime, {
        sessionId,
        type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
        payload: {
          consecutiveMissingPathFailures: 2,
          failedPaths: ["src/missing-a.ts", "src/missing-b.ts"],
        },
      });

      const discoveryPayload = buildReadPathDiscoveryObservationPayload({
        baseCwd: workspace,
        toolName: "grep",
        evidenceKind: "search_match",
        observedPaths: ["src/index.ts"],
      });
      expect(discoveryPayload).not.toBeNull();
      recordRuntimeEvent(runtime, {
        sessionId,
        type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
        payload: discoveryPayload ?? undefined,
      });

      const evidenceEvents = runtime.inspect.events.query(sessionId, {
        type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
      });
      expect(evidenceEvents).toHaveLength(1);
      expect(evidenceEvents[0]?.payload).toMatchObject({
        toolName: "grep",
        observedPaths: ["src/index.ts"],
        observedDirectories: ["src"],
      });

      expect(analyzeReadPathRecoveryState(runtime, sessionId)).toMatchObject({
        active: true,
        phase: "satisfied",
        observedPaths: ["src/index.ts"],
        observedDirectories: ["src"],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("uses the explicit arm receipt as the single source of active gate failure state", async () => {
    const workspace = createTestWorkspace("read-path-arm-receipt-source");
    try {
      const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
      const sessionId = "read-path-arm-receipt-source";

      for (const path of ["src/missing-a.ts", "src/missing-b.ts"]) {
        recordRuntimeEvent(runtime, {
          sessionId,
          type: "tool_result_recorded",
          payload: {
            toolName: "read",
            verdict: "fail",
            failureContext: {
              args: { path },
              outputText: `ENOENT: no such file or directory, open '${path}'`,
              failureClass: "execution",
            },
          },
        });
      }

      recordRuntimeEvent(runtime, {
        sessionId,
        type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
        payload: {
          consecutiveMissingPathFailures: 1,
          failedPaths: ["src/explicit-arm-path.ts"],
        },
      });

      expect(analyzeReadPathRecoveryState(runtime, sessionId)).toMatchObject({
        active: true,
        phase: "required",
        consecutiveMissingPathFailures: 1,
        failedPaths: ["src/explicit-arm-path.ts"],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
