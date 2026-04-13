import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  createBrewvaReadToolDefinition,
  type BrewvaReadToolOptions,
} from "@brewva/brewva-substrate";
import { createCompactReadTool } from "../../../packages/brewva-gateway/src/host/hosted-session-bootstrap.js";
import {
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
} from "../../../packages/brewva-gateway/src/runtime-plugins/read-path-recovery.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("hosted compact read tool", () => {
  test("reads session-scoped read options at execute time", async () => {
    let autoResizeImages = true;
    const observedOptions: Array<BrewvaReadToolOptions | undefined> = [];
    const templateTool = createBrewvaReadToolDefinition(process.cwd());

    const compactReadTool = createCompactReadTool({
      cwd: process.cwd(),
      getReadToolOptions: () => ({
        autoResizeImages,
      }),
      createReadDelegate: (_cwd, options) => {
        observedOptions.push(options);
        return {
          ...templateTool,
          execute: async () => ({
            content: [{ type: "text", text: "ok" }],
            details: undefined,
          }),
        };
      },
    });

    await compactReadTool.execute(
      "read-call-1",
      { path: "README.md" },
      undefined,
      undefined,
      undefined as never,
    );

    autoResizeImages = false;

    await compactReadTool.execute(
      "read-call-2",
      { path: "README.md" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(observedOptions).toEqual([
      undefined,
      { autoResizeImages: true },
      { autoResizeImages: false },
    ]);
  });

  test("blocks another missing-path read after repeated ENOENT failures", async () => {
    const workspace = createTestWorkspace("hosted-read-path-guard");
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "hosted-read-path-guard";
    const templateTool = createBrewvaReadToolDefinition(workspace);
    let delegateCalls = 0;

    for (const path of ["src/missing-a.ts", "src/missing-b.ts"]) {
      runtime.authority.tools.recordResult({
        sessionId,
        toolName: "read",
        args: { path },
        outputText: `ENOENT: no such file or directory, open '${path}'`,
        channelSuccess: false,
      });
    }
    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
      payload: {
        consecutiveMissingPathFailures: 2,
        failedPaths: ["src/missing-b.ts", "src/missing-a.ts"],
      },
    });

    const compactReadTool = createCompactReadTool({
      cwd: workspace,
      runtime,
      createReadDelegate: () => ({
        ...templateTool,
        execute: async () => {
          delegateCalls += 1;
          return {
            content: [{ type: "text", text: "delegate" }],
            details: undefined,
          };
        },
      }),
    });

    const result = await compactReadTool.execute(
      "read-call-guard",
      { path: "src/missing-c.ts" },
      undefined,
      undefined,
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      } as never,
    );

    expect(delegateCalls).toBe(0);
    expect(extractText(result)).toContain("[ReadPathGuard]");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
    const warning = runtime.inspect.events.query(sessionId, {
      type: "tool_contract_warning",
      last: 1,
    })[0];
    expect(warning?.payload?.reason).toBe("path_discovery_required_after_missing_path_failures");
  });

  test("blocks an existing but unverified path when the read recovery guard is active", async () => {
    const workspace = createTestWorkspace("hosted-read-unverified-path");
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "hosted-read-unverified-path";
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src/existing.ts");
    writeFileSync(filePath, "export const existing = true;\n", "utf8");
    const templateTool = createBrewvaReadToolDefinition(workspace);
    let delegateCalls = 0;

    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
      payload: {
        consecutiveMissingPathFailures: 2,
        failedPaths: ["src/missing-a.ts", "src/missing-b.ts"],
      },
    });

    const compactReadTool = createCompactReadTool({
      cwd: workspace,
      runtime,
      createReadDelegate: () => ({
        ...templateTool,
        execute: async () => {
          delegateCalls += 1;
          return {
            content: [{ type: "text", text: "ok" }],
            details: undefined,
          };
        },
      }),
    });

    const result = await compactReadTool.execute(
      "read-call-existing",
      { path: "src/existing.ts" },
      undefined,
      undefined,
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      } as never,
    );

    expect(delegateCalls).toBe(0);
    expect(extractText(result)).toContain("[ReadPathGuard]");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  test("allows a read under an observed directory after discovery evidence is recorded", async () => {
    const workspace = createTestWorkspace("hosted-read-verified-path");
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "hosted-read-verified-path";
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/index.ts"), "export const index = true;\n", "utf8");
    writeFileSync(join(workspace, "src/existing.ts"), "export const existing = true;\n", "utf8");
    const templateTool = createBrewvaReadToolDefinition(workspace);
    let delegateCalls = 0;

    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
      payload: {
        consecutiveMissingPathFailures: 2,
        failedPaths: ["src/missing-a.ts", "src/missing-b.ts"],
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
      payload: {
        toolName: "grep",
        observedPaths: ["src/index.ts"],
        observedDirectories: ["src"],
      },
    });

    const compactReadTool = createCompactReadTool({
      cwd: workspace,
      runtime,
      createReadDelegate: () => ({
        ...templateTool,
        execute: async () => {
          delegateCalls += 1;
          return {
            content: [{ type: "text", text: "ok" }],
            details: undefined,
          };
        },
      }),
    });

    const result = await compactReadTool.execute(
      "read-call-verified",
      { path: "src/existing.ts" },
      undefined,
      undefined,
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => sessionId,
        },
      } as never,
    );

    expect(delegateCalls).toBe(1);
    expect(extractText(result)).toBe("ok");
  });
});
