import { describe, expect, test } from "bun:test";
import {
  projectTranscriptRowHints,
  transcriptRowHint,
} from "../../../packages/brewva-cli/runtime/shell/transcript-rows.js";
import { buildOperatorSafetyShellToolView } from "../../../packages/brewva-cli/src/shell/domain/operator-safety/shell-view.js";
import type {
  CliShellTranscriptMessage,
  CliShellTranscriptRole,
  CliTranscriptRenderMode,
} from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

function message(
  id: string,
  role: CliShellTranscriptRole,
  renderMode: CliTranscriptRenderMode = "stable",
): CliShellTranscriptMessage {
  return { id, role, parts: [], renderMode };
}

// A tool message carrying a real tool part, so projectTranscriptRowHints can read
// its toolName (used by the block-capable packing guard).
function toolMessage(id: string, toolName: string): CliShellTranscriptMessage {
  return {
    id,
    role: "tool",
    renderMode: "stable",
    parts: [
      {
        type: "tool",
        id: `${id}:part`,
        toolCallId: id,
        toolName,
        status: "completed",
        renderMode: "stable",
        safety: buildOperatorSafetyShellToolView({ toolName, status: "completed" }),
      },
    ],
  };
}

// id builders mirror wire-fold.ts:96-146
const toolId = (turn: string, callId: string) => `wire:s1:${turn}:tool:${callId}`;
const assistantId = (turn: string, attempt: string, seq: string) =>
  `wire:s1:${turn}:${attempt}:assistant:${seq}`;
const userId = (turn: string) => `wire:s1:${turn}:user`;

function compactTopFor(messages: CliShellTranscriptMessage[], id: string): boolean {
  return transcriptRowHint(projectTranscriptRowHints(messages), id).compactTop;
}
function showLabelFor(messages: CliShellTranscriptMessage[], id: string): boolean {
  return transcriptRowHint(projectTranscriptRowHints(messages), id).showAssistantLabel;
}

describe("projectTranscriptRowHints — tool packing (compactTop)", () => {
  test("a lone tool message does not pack", () => {
    const messages = [message(toolId("t1", "c1"), "tool")];
    expect(compactTopFor(messages, toolId("t1", "c1"))).toBe(false);
  });

  test("a second same-turn inline tool packs against the first, which does not", () => {
    const messages = [
      toolMessage(toolId("t1", "c1"), "read"),
      toolMessage(toolId("t1", "c2"), "read"),
    ];
    expect(compactTopFor(messages, toolId("t1", "c1"))).toBe(false);
    expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(true);
  });

  test("a run of three same-turn inline tools packs the 2nd and 3rd", () => {
    const messages = [
      toolMessage(toolId("t1", "c1"), "read"),
      toolMessage(toolId("t1", "c2"), "read"),
      toolMessage(toolId("t1", "c3"), "read"),
    ];
    expect(compactTopFor(messages, toolId("t1", "c1"))).toBe(false);
    expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(true);
    expect(compactTopFor(messages, toolId("t1", "c3"))).toBe(true);
  });

  test("a tool from a different turn never packs against the previous turn's tool", () => {
    const messages = [message(toolId("t1", "c1"), "tool"), message(toolId("t2", "c1"), "tool")];
    expect(compactTopFor(messages, toolId("t2", "c1"))).toBe(false);
  });

  test("a tool does not pack when the previous row is an assistant message", () => {
    const messages = [
      message(toolId("t1", "c1"), "tool"),
      message(assistantId("t1", "a1", "0"), "assistant"),
      message(toolId("t1", "c2"), "tool"),
    ];
    expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(false);
  });

  test("an unparseable tool id never packs (safe default)", () => {
    const messages = [message("weird-1", "tool"), message("weird-2", "tool")];
    expect(compactTopFor(messages, "weird-2")).toBe(false);
  });

  test("a non-tool message never packs", () => {
    const messages = [
      message(userId("t1"), "user"),
      message(assistantId("t1", "a1", "0"), "assistant"),
    ];
    expect(compactTopFor(messages, userId("t1"))).toBe(false);
    expect(compactTopFor(messages, assistantId("t1", "a1", "0"))).toBe(false);
  });
});

describe("projectTranscriptRowHints — assistant label dedupe (showAssistantLabel)", () => {
  test("a single assistant segment shows its label", () => {
    const messages = [message(assistantId("t1", "a1", "0"), "assistant")];
    expect(showLabelFor(messages, assistantId("t1", "a1", "0"))).toBe(true);
  });

  test("only the LAST assistant segment of a turn+attempt shows the label", () => {
    const messages = [
      message(assistantId("t1", "a1", "0"), "assistant"),
      message(toolId("t1", "c1"), "tool"),
      message(assistantId("t1", "a1", "1"), "assistant"),
      message(toolId("t1", "c2"), "tool"),
      message(assistantId("t1", "a1", "2"), "assistant"),
    ];
    expect(showLabelFor(messages, assistantId("t1", "a1", "0"))).toBe(false);
    expect(showLabelFor(messages, assistantId("t1", "a1", "1"))).toBe(false);
    expect(showLabelFor(messages, assistantId("t1", "a1", "2"))).toBe(true);
  });

  test("committed segment ids in the same scope dedupe to the last one", () => {
    const first = assistantId("t1", "a1", "0");
    const committed = `wire:s1:t1:a1:assistant:committed:evt:index:0`;
    const messages = [message(first, "assistant"), message(committed, "assistant")];
    expect(showLabelFor(messages, first)).toBe(false);
    expect(showLabelFor(messages, committed)).toBe(true);
  });

  test("different attempts of the same turn each keep their own label", () => {
    const messages = [
      message(assistantId("t1", "a1", "0"), "assistant"),
      message(assistantId("t1", "a2", "0"), "assistant"),
    ];
    expect(showLabelFor(messages, assistantId("t1", "a1", "0"))).toBe(true);
    expect(showLabelFor(messages, assistantId("t1", "a2", "0"))).toBe(true);
  });

  test("a streaming final assistant segment shows its label", () => {
    const messages = [
      message(userId("t1"), "user"),
      message(assistantId("t1", "a1", "0"), "assistant", "streaming"),
    ];
    expect(showLabelFor(messages, assistantId("t1", "a1", "0"))).toBe(true);
  });

  test("a tool message never carries an assistant label", () => {
    const messages = [message(toolId("t1", "c1"), "tool")];
    expect(showLabelFor(messages, toolId("t1", "c1"))).toBe(false);
  });
});

describe("projectTranscriptRowHints — interleaved turn + determinism", () => {
  test("a full text→tool→tool→text→tool→text turn packs tools and dedupes labels", () => {
    const messages = [
      message(userId("t1"), "user"),
      message(assistantId("t1", "a1", "0"), "assistant"),
      toolMessage(toolId("t1", "c1"), "read"),
      toolMessage(toolId("t1", "c2"), "read"),
      message(assistantId("t1", "a1", "1"), "assistant"),
      toolMessage(toolId("t1", "c3"), "read"),
      message(assistantId("t1", "a1", "2"), "assistant"),
    ];
    // c2 packs against c1; c3 is lone (assistant precedes it).
    expect(compactTopFor(messages, toolId("t1", "c1"))).toBe(false);
    expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(true);
    expect(compactTopFor(messages, toolId("t1", "c3"))).toBe(false);
    // Only the last assistant segment shows the byline.
    expect(showLabelFor(messages, assistantId("t1", "a1", "0"))).toBe(false);
    expect(showLabelFor(messages, assistantId("t1", "a1", "2"))).toBe(true);
  });

  test("is deterministic — identical input yields an identical hint map", () => {
    const messages = [
      message(assistantId("t1", "a1", "0"), "assistant"),
      message(toolId("t1", "c1"), "tool"),
      message(toolId("t1", "c2"), "tool"),
      message(assistantId("t1", "a1", "1"), "assistant"),
    ];
    const a = projectTranscriptRowHints(messages);
    const b = projectTranscriptRowHints(messages);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  test("covers every message id in the map", () => {
    const messages = [
      message(userId("t1"), "user"),
      message(toolId("t1", "c1"), "tool"),
      message(assistantId("t1", "a1", "0"), "assistant"),
    ];
    const hints = projectTranscriptRowHints(messages);
    expect([...hints.keys()].toSorted()).toEqual(messages.map((m) => m.id).toSorted());
  });
});

describe("projectTranscriptRowHints — packing is guarded to guaranteed-inline previous tools", () => {
  test("an inline tool after a block-capable tool (exec) does NOT pack against it", () => {
    const messages = [
      toolMessage(toolId("t1", "c1"), "exec"),
      toolMessage(toolId("t1", "c2"), "read"),
    ];
    expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(false);
  });

  test("an inline tool after another inline tool (read) DOES pack", () => {
    const messages = [
      toolMessage(toolId("t1", "c1"), "read"),
      toolMessage(toolId("t1", "c2"), "read"),
    ];
    expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(true);
  });

  test("write / edit / apply_patch previous tools block packing", () => {
    for (const blockTool of ["write", "edit", "apply_patch"]) {
      const messages = [
        toolMessage(toolId("t1", "c1"), blockTool),
        toolMessage(toolId("t1", "c2"), "read"),
      ];
      expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(false);
    }
  });

  // The allowlist's reason to exist: a GenericToolView block (open-ended tool-name
  // space) that a denylist could never enumerate must still block packing.
  test("a GenericToolView block-rendered tool (subagent / MCP / custom) does NOT get packed against", () => {
    for (const blockTool of ["subagent_run", "subagent_fanout", "my_mcp_tool"]) {
      const messages = [
        toolMessage(toolId("t1", "c1"), blockTool),
        toolMessage(toolId("t1", "c2"), "read"),
      ];
      expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(false);
    }
  });

  test("a previous tool message with no tool part is not known-inline, so no pack", () => {
    const messages = [message(toolId("t1", "c1"), "tool"), toolMessage(toolId("t1", "c2"), "read")];
    expect(compactTopFor(messages, toolId("t1", "c2"))).toBe(false);
  });
});
