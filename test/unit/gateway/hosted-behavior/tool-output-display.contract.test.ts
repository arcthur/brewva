import { describe, expect, test } from "bun:test";
import {
  resolveToolDisplay,
  resolveToolDisplayStatus,
  resolveToolDisplayVerdict,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";

describe("tool output display", () => {
  test("prefers explicit fail verdict over channel success", () => {
    const result = {
      content: [
        {
          type: "text",
          text: Array.from({ length: 140 }, (_value, index) =>
            index % 20 === 0 ? `error: failure ${index}` : `trace ${index}`,
          ).join("\n"),
        },
      ],
      details: {
        verdict: "fail",
      },
    };

    expect(resolveToolDisplayVerdict({ isError: false, result })).toBe("fail");
    expect(resolveToolDisplayStatus({ isError: false, result })).toBe("failed");
    expect(
      resolveToolDisplay({
        toolName: "exec",
        isError: false,
        result,
      }).text.includes("status: failed"),
    ).toBe(true);
  });

  test("preserves explicit display summary and details", () => {
    const result = {
      content: [{ type: "text", text: '{"raw":true}' }],
      details: { status: "completed" },
      display: {
        summaryText: "Structured result completed",
        detailsText: "Expanded structured result",
        rawText: '{"raw":true}',
      },
    };

    expect(resolveToolDisplay({ toolName: "structured", isError: false, result })).toEqual({
      text: '{"raw":true}',
      display: {
        summaryText: "Structured result completed",
        detailsText: "Expanded structured result",
        rawText: '{"raw":true}',
      },
    });
  });

  test("does not treat long raw fallback text as a semantic summary", () => {
    const rawText = Array.from({ length: 12 }, (_value, index) => `raw line ${index + 1}`).join(
      "\n",
    );
    const result = {
      content: [{ type: "text", text: rawText }],
      details: { status: "completed" },
    };

    expect(resolveToolDisplay({ toolName: "structured", isError: false, result })).toEqual({
      text: rawText,
      display: {
        detailsText: rawText,
        rawText,
      },
    });
  });
});
