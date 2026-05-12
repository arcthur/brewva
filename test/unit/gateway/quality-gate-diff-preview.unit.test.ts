import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { createBrewvaEditToolDefinition } from "@brewva/brewva-substrate/tools";
import { createQualityGateLifecycle } from "../../../packages/brewva-gateway/src/hosted/internal/session/tools/quality-gate.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("quality gate diff preview", () => {
  test("adds edit diff preview to effect commitment start input", () => {
    const workspace = createTestWorkspace("quality-gate-diff-preview");
    const filePath = join(workspace, "app.ts");
    writeFileSync(filePath, "const value = 1;\n", "utf8");

    let capturedStartInput: Record<string, unknown> | undefined;
    const runtime = {
      authority: {
        tools: {
          start(input: Record<string, unknown>) {
            capturedStartInput = input;
            return { allowed: true };
          },
        },
      },
    } as unknown as BrewvaHostedRuntimePort;

    const lifecycle = createQualityGateLifecycle(runtime, {
      toolDefinitionsByName: new Map([["edit", createBrewvaEditToolDefinition(workspace)]]),
    });

    lifecycle.toolCall(
      {
        toolCallId: "tool-call-1",
        toolName: "edit",
        input: {
          path: "app.ts",
          edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
        },
      },
      {
        cwd: workspace,
        sessionManager: {
          getSessionId: () => "session-1",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(capturedStartInput?.diffPreview).toMatchObject({
      kind: "diff",
      path: "app.ts",
    });
    expect(String((capturedStartInput?.diffPreview as { diff?: string })?.diff)).toContain(
      "-1 const value = 1;",
    );
    expect(String((capturedStartInput?.diffPreview as { diff?: string })?.diff)).toContain(
      "+1 const value = 2;",
    );
  });
});
