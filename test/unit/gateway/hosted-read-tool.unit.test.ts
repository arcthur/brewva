import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  createBrewvaReadToolDefinition,
  type BrewvaReadToolOptions,
} from "@brewva/brewva-substrate/tools";
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
    runtime.extensions.hosted.events.record({
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

    runtime.extensions.hosted.events.record({
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

    runtime.extensions.hosted.events.record({
      sessionId,
      type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
      payload: {
        consecutiveMissingPathFailures: 2,
        failedPaths: ["src/missing-a.ts", "src/missing-b.ts"],
      },
    });
    runtime.extensions.hosted.events.record({
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

  test("invalidates unchanged reads when runtime visible-read epoch advances", async () => {
    const workspace = createTestWorkspace("hosted-read-unchanged-compaction");
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "hosted-read-unchanged-compaction";
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/app.ts"), "export const app = true;\n", "utf8");
    const templateTool = createBrewvaReadToolDefinition(workspace);
    let delegateCalls = 0;

    const compactReadTool = createCompactReadTool({
      cwd: workspace,
      runtime,
      createReadDelegate: () => ({
        ...templateTool,
        execute: async () => {
          delegateCalls += 1;
          return {
            content: [{ type: "text", text: "export const app = true;" }],
            details: { ok: true },
          };
        },
      }),
    });
    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    } as never;

    await compactReadTool.execute("read-call-1", { path: "src/app.ts" }, undefined, undefined, ctx);
    const unchanged = await compactReadTool.execute(
      "read-call-2",
      { path: "src/app.ts" },
      undefined,
      undefined,
      ctx,
    );

    expect(delegateCalls).toBe(1);
    expect(extractText(unchanged)).toContain("File unchanged since previous visible read");

    runtime.maintain.context.advanceVisibleReadEpoch(sessionId, "history_pruned");

    const afterCompact = await compactReadTool.execute(
      "read-call-3",
      { path: "src/app.ts" },
      undefined,
      undefined,
      ctx,
    );

    expect(delegateCalls).toBe(2);
    expect(extractText(afterCompact)).toBe("export const app = true;");
  });

  test("invalidates unchanged reads when content changes without mtime or size changes", async () => {
    const workspace = createTestWorkspace("hosted-read-unchanged-content-hash");
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createOpsRuntimeConfig() });
    const sessionId = "hosted-read-unchanged-content-hash";
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src/app.ts");
    const fixedMtime = new Date("2026-01-01T00:00:00.000Z");
    writeFileSync(filePath, "aaaa\n", "utf8");
    utimesSync(filePath, fixedMtime, fixedMtime);
    const templateTool = createBrewvaReadToolDefinition(workspace);
    let delegateCalls = 0;

    const compactReadTool = createCompactReadTool({
      cwd: workspace,
      runtime,
      createReadDelegate: () => ({
        ...templateTool,
        execute: async () => {
          delegateCalls += 1;
          return {
            content: [{ type: "text", text: readFileSync(filePath, "utf8") }],
            details: { ok: true },
          };
        },
      }),
    });
    const ctx = {
      cwd: workspace,
      sessionManager: {
        getSessionId: () => sessionId,
      },
    } as never;

    await compactReadTool.execute(
      "read-call-content-1",
      { path: "src/app.ts" },
      undefined,
      undefined,
      ctx,
    );
    writeFileSync(filePath, "bbbb\n", "utf8");
    expect(statSync(filePath).size).toBe(5);
    utimesSync(filePath, fixedMtime, fixedMtime);

    const afterContentChange = await compactReadTool.execute(
      "read-call-content-2",
      { path: "src/app.ts" },
      undefined,
      undefined,
      ctx,
    );

    expect(delegateCalls).toBe(2);
    expect(extractText(afterContentChange)).toBe("bbbb\n");
  });
});
