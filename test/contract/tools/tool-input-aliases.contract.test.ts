import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  createGrepTool,
  createLookAtTool,
  createLspTools,
  createObsSloAssertTool,
  createScheduleIntentTool,
  createTaskLedgerTools,
} from "@brewva/brewva-tools";
import { createScheduleToolRuntime } from "./tools-flow.helpers.js";

const requireFromBrewvaTools = createRequire(
  new URL("../../../packages/brewva-tools/package.json", import.meta.url),
);
const { Value } = requireFromBrewvaTools("@sinclair/typebox/value") as {
  Value: {
    Check(schema: unknown, value: unknown): boolean;
  };
};

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

function fakeContext(sessionId: string, cwd?: string): any {
  return {
    cwd,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function requireTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error(`Expected tool '${name}' to exist.`);
  }
  return tool;
}

describe("tool input alias contracts", () => {
  test("look_at accepts camelCase filePath alias in schema and execution", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-look-at-alias-"));
    const filePath = join(workspace, "sample.ts");
    writeFileSync(filePath, "export const alpha = 1;\n", "utf8");

    const tool = createLookAtTool();
    const params = {
      filePath,
      goal: "trace transaction rollback boundary",
    };

    expect(Value.Check(tool.parameters, params)).toBe(true);
    const result = await tool.execute(
      "tc-look-at-file-path-alias",
      params as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("look_at unavailable");
  });

  test("task_set_spec accepts snake_case expected_behavior alias and stores canonical field", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "task-set-spec-case-alias";
    const tool = requireTool(createTaskLedgerTools({ runtime }), "task_set_spec");
    const params = {
      goal: "Verify docs stay aligned with implementation.",
      expected_behavior: "Produce a review report grouped by severity.",
    };

    expect(Value.Check(tool.parameters, params)).toBe(true);
    await tool.execute(
      "tc-task-set-spec-case-alias",
      params as never,
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(runtime.task.getState(sessionId).spec?.expectedBehavior).toBe(params.expected_behavior);
  });

  test("canonical top-level fields win when canonical and alias spellings are both present", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "task-set-spec-canonical-wins";
    const tool = requireTool(createTaskLedgerTools({ runtime }), "task_set_spec");
    const params = {
      goal: "Keep canonical field precedence deterministic.",
      expectedBehavior: "canonical value",
      expected_behavior: "alias value",
    };

    expect(Value.Check(tool.parameters, params)).toBe(true);
    await tool.execute(
      "tc-task-set-spec-canonical-wins",
      params as never,
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(runtime.task.getState(sessionId).spec?.expectedBehavior).toBe("canonical value");
  });

  test("lsp_diagnostics accepts file_path and warn aliases and normalizes them to canonical values", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-lsp-alias-"));
    writeFileSync(
      join(workspace, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
      "utf8",
    );
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src", "broken.ts");
    writeFileSync(filePath, "export const broken: string = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = requireTool(createLspTools({ runtime }), "lsp_diagnostics");
    const params = {
      file_path: filePath,
      severity: "warn",
    };

    expect(Value.Check(tool.parameters, params)).toBe(true);
    const result = await tool.execute(
      "tc-lsp-diagnostics-alias",
      params as never,
      undefined,
      undefined,
      fakeContext("lsp-diagnostics-alias", workspace),
    );

    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.filePath).toBe(filePath);
    expect(details?.severity).toBe("warning");
    expect(details?.reason).toBe("diagnostics_scope_mismatch");
  });

  test("obs_slo_assert accepts snake_case keys and severity aliases, then records canonical severity", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-obs-alias-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "obs-slo-assert-alias";
    runtime.events.record({
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 920,
      },
    });

    const tool = createObsSloAssertTool({ runtime });
    const params = {
      types: ["startup_sample"],
      where: { service: "api" },
      metric: "startupMs",
      aggregation: "p95",
      operator: "<=",
      threshold: 1_000,
      window_minutes: 5,
      min_samples: 1,
      severity: "warning",
    };

    expect(Value.Check(tool.parameters, params)).toBe(true);
    const result = await tool.execute(
      "tc-obs-slo-assert-alias",
      params as never,
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const details = (result as { details?: Record<string, unknown> }).details;
    const assertion = details?.observabilityAssertion as
      | { severity?: unknown; spec?: { windowMinutes?: unknown } }
      | undefined;
    expect(assertion?.severity).toBe("warn");
    expect(assertion?.spec?.windowMinutes).toBe(5);
  });

  test("schedule_intent accepts canceled status alias and renders canonical cancelled state", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-intent-alias-");
    const sessionId = "schedule-intent-status-alias";
    const tool = createScheduleIntentTool({ runtime });

    const createResult = await tool.execute(
      "tc-schedule-intent-alias-create",
      {
        action: "create",
        reason: "wait for CI",
        delayMs: 60_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(createResult)).toContain("Schedule intent created.");

    const intentId = (await runtime.schedule.listIntents({ parentSessionId: sessionId }))[0]
      ?.intentId;
    expect(typeof intentId).toBe("string");
    if (!intentId) return;

    await tool.execute(
      "tc-schedule-intent-alias-cancel",
      {
        action: "cancel",
        intentId,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const listParams = {
      action: "list",
      status: "canceled",
    };
    expect(Value.Check(tool.parameters, listParams)).toBe(true);
    const listResult = await tool.execute(
      "tc-schedule-intent-alias-list",
      listParams as never,
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const listText = extractTextContent(listResult);
    expect(listText).toContain("status: cancelled");
    expect(listText).toContain(intentId);
  });

  test("grep schema accepts camelCase numeric keys and explicit case-mode aliases", () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const tool = createGrepTool({ runtime });
    expect(
      Value.Check(tool.parameters, {
        query: "needle",
        case: "case_sensitive",
        maxLines: 25,
        timeoutMs: 500,
      }),
    ).toBe(true);
  });
});
