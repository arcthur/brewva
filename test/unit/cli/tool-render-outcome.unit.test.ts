import { describe, expect, test } from "bun:test";
import type {
  BrewvaRenderableComponent,
  BrewvaToolDefinition,
  BrewvaToolResult,
} from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import {
  createToolRenderCache,
  renderToolComponentLines,
} from "../../../packages/brewva-cli/runtime/shell/tool-render.js";
import type { CliShellTranscriptToolPart } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

function staticComponent(line: string): BrewvaRenderableComponent {
  return {
    render() {
      return [line];
    },
    invalidate() {
      return undefined;
    },
  };
}

function toolPartWithResult(
  result: CliShellTranscriptToolPart["result"],
): CliShellTranscriptToolPart {
  return {
    type: "tool",
    id: "part-1",
    toolCallId: "call-1",
    toolName: "probe",
    safety: {} as CliShellTranscriptToolPart["safety"],
    status: "completed",
    result,
    renderMode: "stable",
  };
}

describe("CLI tool render outcome projection", () => {
  test("reconstructs inconclusive render results from session wire verdict", () => {
    let observedOutcome: BrewvaToolResult["outcome"] | undefined;
    const tool: BrewvaToolDefinition = {
      name: "probe",
      label: "Probe",
      description: "Probe renderer",
      parameters: Type.Object({}),
      outputSchema: Type.Object({ verdict: Type.String(), reason: Type.String() }),
      errorSchema: Type.Object({ verdict: Type.String(), reason: Type.String() }),
      outcomeVersion: "v1",
      async execute() {
        return {
          content: [],
          outcome: { kind: "ok", value: {} },
        };
      },
      renderResult(result) {
        observedOutcome = result.outcome;
        return staticComponent(result.outcome.kind);
      },
    };

    const lines = renderToolComponentLines({
      kind: "result",
      toolDefinitions: new Map([[tool.name, tool]]),
      toolRenderCache: createToolRenderCache(),
      part: toolPartWithResult({
        content: [],
        details: { reason: "partial evidence" },
        verdict: "inconclusive",
        isError: false,
      }),
      width: 80,
    });

    expect(lines).toEqual(["inconclusive"]);
    expect(observedOutcome).toEqual({
      kind: "inconclusive",
      reason: "partial evidence",
      value: { reason: "partial evidence" },
    });
  });
});
