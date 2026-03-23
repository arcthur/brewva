import { describe, expect, test } from "bun:test";
import {
  registerLedgerWriter,
  registerToolResultDistiller,
} from "@brewva/brewva-gateway/runtime-plugins";
import { createMockExtensionAPI } from "../../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function invokeToolResultMiddleware(
  handlers: ReturnType<typeof createMockExtensionAPI>["handlers"],
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): {
  currentEvent: Record<string, unknown>;
  results: unknown[];
} {
  const list = handlers.get("tool_result") ?? [];
  const currentEvent = { ...event };
  const results: unknown[] = [];

  for (const handler of list) {
    const result = handler(currentEvent, ctx);
    results.push(result);
    if (!result || typeof result !== "object") continue;
    const patch = result as Record<string, unknown>;
    if (patch.content !== undefined) {
      currentEvent.content = patch.content;
    }
    if (patch.details !== undefined) {
      currentEvent.details = patch.details;
    }
    if (patch.isError !== undefined) {
      currentEvent.isError = patch.isError;
    }
  }

  return { currentEvent, results };
}

describe("tool result inline distiller", () => {
  test("records raw evidence before any optional inline distillation patch runs", () => {
    const { api, handlers } = createMockExtensionAPI();
    const finished: Array<Record<string, unknown>> = [];
    const runtime = createRuntimeFixture({
      tools: {
        finish: (input: Record<string, unknown>) => {
          finished.push(input);
        },
      },
    });

    registerLedgerWriter(api, runtime);
    registerToolResultDistiller(api, runtime);

    const output = Array.from({ length: 220 }, (_value, index) =>
      index % 17 === 0 ? `error: failed at step ${index}` : `trace line ${index}`,
    ).join("\n");
    const { results } = invokeToolResultMiddleware(
      handlers,
      {
        toolCallId: "tc-inline-distill",
        toolName: "exec",
        input: { command: "npm test" },
        isError: true,
        content: [{ type: "text", text: output }],
        details: { durationMs: 1200 },
      },
      {
        sessionManager: {
          getSessionId: () => "distill-1",
        },
      },
    );

    expect(finished).toHaveLength(1);
    expect(String(finished[0]?.outputText)).toContain("trace line 219");
    expect(String(finished[0]?.outputText)).toContain("error: failed at step 204");
    expect(results[0]).toBeUndefined();
    expect(results).toHaveLength(2);
    if (results[1] !== undefined) {
      expect(results[1]).toMatchObject({
        content: [{ type: "text", text: expect.any(String) }],
      });
    }
  });

  test("skips inline distillation for mixed-content tool results", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();

    registerToolResultDistiller(api, runtime);

    const { currentEvent, results } = invokeToolResultMiddleware(
      handlers,
      {
        toolCallId: "tc-mixed",
        toolName: "exec",
        input: { command: "npm test" },
        isError: false,
        content: [
          { type: "text", text: "plain text" },
          { type: "image", imageUrl: "artifact://image" },
        ],
        details: undefined,
      },
      {
        sessionManager: {
          getSessionId: () => "distill-2",
        },
      },
    );

    expect(results).toEqual([undefined]);
    expect(currentEvent.content).toEqual([
      { type: "text", text: "plain text" },
      { type: "image", imageUrl: "artifact://image" },
    ]);
  });

  test("returns undefined when text-only content is not eligible for distillation", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();

    registerToolResultDistiller(api, runtime);

    const { currentEvent, results } = invokeToolResultMiddleware(
      handlers,
      {
        toolCallId: "tc-noop",
        toolName: "edit",
        input: { file_path: "src/a.ts" },
        isError: false,
        content: [{ type: "text", text: "edited src/a.ts" }],
        details: { durationMs: 4 },
      },
      {
        sessionManager: {
          getSessionId: () => "distill-3",
        },
      },
    );

    expect(results).toEqual([undefined]);
    expect(currentEvent.content).toEqual([{ type: "text", text: "edited src/a.ts" }]);
  });

  test("applies inline browser snapshot distillation for long DOM snapshots", () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture();

    registerToolResultDistiller(api, runtime);

    const snapshotText = [
      "[Browser Snapshot]",
      "session: browser-session-3",
      "artifact: .orchestrator/browser-artifacts/browser-session-3/snapshot.txt",
      "interactive: true",
      "snapshot:",
      ...Array.from(
        { length: 160 },
        (_value, index) => `[@e${index}]<input>Field ${index}</input>`,
      ),
    ].join("\n");

    const { results } = invokeToolResultMiddleware(
      handlers,
      {
        toolCallId: "tc-browser-inline",
        toolName: "browser_snapshot",
        input: {},
        isError: false,
        content: [{ type: "text", text: snapshotText }],
        details: {
          artifactRef: ".orchestrator/browser-artifacts/browser-session-3/snapshot.txt",
        },
      },
      {
        sessionManager: {
          getSessionId: () => "distill-browser-1",
        },
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("[BrowserSnapshotDistilled]") }],
    });
  });
});
