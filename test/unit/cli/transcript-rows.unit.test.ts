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
  opts: { renderMode?: CliTranscriptRenderMode; turnId?: string; attemptId?: string } = {},
): CliShellTranscriptMessage {
  return {
    id,
    role,
    parts: [],
    renderMode: opts.renderMode ?? "stable",
    turnId: opts.turnId,
    attemptId: opts.attemptId,
  };
}

// A tool message carrying a real tool part (so the packing guard can read toolName)
// and a STRUCTURAL turnId (scope never depends on parsing the id).
function toolMessage(id: string, toolName: string, turnId: string): CliShellTranscriptMessage {
  return {
    id,
    role: "tool",
    renderMode: "stable",
    turnId,
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

function assistantMsg(
  id: string,
  turnId: string,
  attemptId: string,
  renderMode: CliTranscriptRenderMode = "stable",
): CliShellTranscriptMessage {
  return { id, role: "assistant", parts: [], renderMode, turnId, attemptId };
}

function compactTopFor(messages: CliShellTranscriptMessage[], id: string): boolean {
  return transcriptRowHint(projectTranscriptRowHints(messages), id).compactTop;
}
function showLabelFor(messages: CliShellTranscriptMessage[], id: string): boolean {
  return transcriptRowHint(projectTranscriptRowHints(messages), id).showAssistantLabel;
}

describe("projectTranscriptRowHints — tool packing (compactTop)", () => {
  test("a lone tool message does not pack", () => {
    expect(compactTopFor([toolMessage("c1", "read", "t1")], "c1")).toBe(false);
  });

  test("a second same-turn inline tool packs against the first, which does not", () => {
    const messages = [toolMessage("c1", "read", "t1"), toolMessage("c2", "read", "t1")];
    expect(compactTopFor(messages, "c1")).toBe(false);
    expect(compactTopFor(messages, "c2")).toBe(true);
  });

  test("a run of three same-turn inline tools packs the 2nd and 3rd", () => {
    const messages = [
      toolMessage("c1", "read", "t1"),
      toolMessage("c2", "read", "t1"),
      toolMessage("c3", "read", "t1"),
    ];
    expect(compactTopFor(messages, "c1")).toBe(false);
    expect(compactTopFor(messages, "c2")).toBe(true);
    expect(compactTopFor(messages, "c3")).toBe(true);
  });

  test("a tool from a different turn never packs against the previous turn's tool", () => {
    const messages = [toolMessage("c1", "read", "t1"), toolMessage("c2", "read", "t2")];
    expect(compactTopFor(messages, "c2")).toBe(false);
  });

  test("a tool does not pack when the previous row is an assistant message", () => {
    const messages = [
      toolMessage("c1", "read", "t1"),
      assistantMsg("a0", "t1", "att"),
      toolMessage("c2", "read", "t1"),
    ];
    expect(compactTopFor(messages, "c2")).toBe(false);
  });

  test("a tool message with no structural turnId never packs (safe default)", () => {
    const messages = [message("x1", "tool"), message("x2", "tool")];
    expect(compactTopFor(messages, "x2")).toBe(false);
  });

  test("a non-tool message never packs", () => {
    const messages = [message("u", "user", { turnId: "t1" }), assistantMsg("a", "t1", "att")];
    expect(compactTopFor(messages, "u")).toBe(false);
    expect(compactTopFor(messages, "a")).toBe(false);
  });
});

describe("projectTranscriptRowHints — assistant label dedupe (showAssistantLabel)", () => {
  test("a single assistant segment shows its label", () => {
    expect(showLabelFor([assistantMsg("a0", "t1", "att")], "a0")).toBe(true);
  });

  test("only the LAST assistant segment of a turn+attempt shows the label", () => {
    const messages = [
      assistantMsg("a0", "t1", "att"),
      toolMessage("c1", "read", "t1"),
      assistantMsg("a1", "t1", "att"),
      toolMessage("c2", "read", "t1"),
      assistantMsg("a2", "t1", "att"),
    ];
    expect(showLabelFor(messages, "a0")).toBe(false);
    expect(showLabelFor(messages, "a1")).toBe(false);
    expect(showLabelFor(messages, "a2")).toBe(true);
  });

  test("different attempts of the same turn each keep their own label", () => {
    const messages = [assistantMsg("a0", "t1", "att1"), assistantMsg("a1", "t1", "att2")];
    expect(showLabelFor(messages, "a0")).toBe(true);
    expect(showLabelFor(messages, "a1")).toBe(true);
  });

  test("a streaming final assistant segment shows its label", () => {
    const messages = [
      message("u", "user", { turnId: "t1" }),
      assistantMsg("a0", "t1", "att", "streaming"),
    ];
    expect(showLabelFor(messages, "a0")).toBe(true);
  });

  test("an assistant with no structural turnId keys on its own id (always labels)", () => {
    const messages = [message("a0", "assistant"), message("a1", "assistant")];
    expect(showLabelFor(messages, "a0")).toBe(true);
    expect(showLabelFor(messages, "a1")).toBe(true);
  });

  test("a tool message never carries an assistant label", () => {
    expect(showLabelFor([toolMessage("c1", "read", "t1")], "c1")).toBe(false);
  });
});

describe("projectTranscriptRowHints — structural scope resists sentinel-bearing turnIds (P2)", () => {
  test("same sentinel-bearing turnId still groups (an id-substring split would mis-cut)", () => {
    // A channel reply turnId embeds the :tool: sentinel; splitting the id on
    // ":tool:" would cut at the wrong offset. The structural turnId compares whole.
    const t = "chan:tool:0";
    const messages = [toolMessage("c1", "read", t), toolMessage("c2", "read", t)];
    expect(compactTopFor(messages, "c2")).toBe(true);
  });

  test("DIFFERENT sentinel-bearing turnIds do NOT merge", () => {
    // Both share the prefix "chan" before ":tool:", so an id-split would wrongly
    // pack them; the structural turnId keeps the two turns apart.
    const messages = [
      toolMessage("c1", "read", "chan:tool:0"),
      toolMessage("c2", "read", "chan:tool:1"),
    ];
    expect(compactTopFor(messages, "c2")).toBe(false);
  });

  test("assistant label scope keeps sentinel-bearing turns apart", () => {
    const messages = [
      assistantMsg("a0", "chan:assistant:0", "att"),
      assistantMsg("a1", "chan:assistant:1", "att"),
    ];
    expect(showLabelFor(messages, "a0")).toBe(true);
    expect(showLabelFor(messages, "a1")).toBe(true);
  });
});

describe("projectTranscriptRowHints — interleaved turn + determinism", () => {
  test("a full text→tool→tool→text→tool→text turn packs tools and dedupes labels", () => {
    const messages = [
      message("u", "user", { turnId: "t1" }),
      assistantMsg("a0", "t1", "att"),
      toolMessage("c1", "read", "t1"),
      toolMessage("c2", "read", "t1"),
      assistantMsg("a1", "t1", "att"),
      toolMessage("c3", "read", "t1"),
      assistantMsg("a2", "t1", "att"),
    ];
    // c2 packs against c1; c3 is lone (assistant precedes it).
    expect(compactTopFor(messages, "c1")).toBe(false);
    expect(compactTopFor(messages, "c2")).toBe(true);
    expect(compactTopFor(messages, "c3")).toBe(false);
    // Only the last assistant segment shows the byline.
    expect(showLabelFor(messages, "a0")).toBe(false);
    expect(showLabelFor(messages, "a2")).toBe(true);
  });

  test("is deterministic — identical input yields an identical hint map", () => {
    const messages = [
      assistantMsg("a0", "t1", "att"),
      toolMessage("c1", "read", "t1"),
      toolMessage("c2", "read", "t1"),
      assistantMsg("a1", "t1", "att"),
    ];
    const a = projectTranscriptRowHints(messages);
    const b = projectTranscriptRowHints(messages);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  test("covers every message id in the map", () => {
    const messages = [
      message("u", "user", { turnId: "t1" }),
      toolMessage("c1", "read", "t1"),
      assistantMsg("a0", "t1", "att"),
    ];
    const hints = projectTranscriptRowHints(messages);
    expect([...hints.keys()].toSorted()).toEqual(messages.map((m) => m.id).toSorted());
  });
});

describe("projectTranscriptRowHints — packing is guarded to guaranteed-inline previous tools", () => {
  test("an inline tool after a block-capable tool (exec) does NOT pack against it", () => {
    const messages = [toolMessage("c1", "exec", "t1"), toolMessage("c2", "read", "t1")];
    expect(compactTopFor(messages, "c2")).toBe(false);
  });

  test("an inline tool after another inline tool (read) DOES pack", () => {
    const messages = [toolMessage("c1", "read", "t1"), toolMessage("c2", "read", "t1")];
    expect(compactTopFor(messages, "c2")).toBe(true);
  });

  test("write / edit / apply_patch previous tools block packing", () => {
    for (const blockTool of ["write", "edit", "apply_patch"]) {
      const messages = [toolMessage("c1", blockTool, "t1"), toolMessage("c2", "read", "t1")];
      expect(compactTopFor(messages, "c2")).toBe(false);
    }
  });

  // The allowlist's reason to exist: a GenericToolView block (open-ended tool-name
  // space) that a denylist could never enumerate must still block packing.
  test("a GenericToolView block-rendered tool (subagent / MCP / custom) does NOT get packed against", () => {
    for (const blockTool of ["subagent_run", "subagent_fanout", "my_mcp_tool"]) {
      const messages = [toolMessage("c1", blockTool, "t1"), toolMessage("c2", "read", "t1")];
      expect(compactTopFor(messages, "c2")).toBe(false);
    }
  });

  test("a previous tool message with no tool part is not known-inline, so no pack", () => {
    const messages = [message("c1", "tool", { turnId: "t1" }), toolMessage("c2", "read", "t1")];
    expect(compactTopFor(messages, "c2")).toBe(false);
  });
});
