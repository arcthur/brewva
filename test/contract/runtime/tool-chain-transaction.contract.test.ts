import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime, type ToolCommitmentDecision } from "@brewva/brewva-runtime";

function expectAllow(decision: ToolCommitmentDecision): string {
  expect(decision.kind).toBe("allow");
  if (decision.kind !== "allow") {
    throw new Error("expected_allow");
  }
  return decision.commitment.id;
}

describe("tool_chain kernel transaction (axiom 17)", () => {
  test("admits observe_compound and commits the envelope as one canonical transaction", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-tool-chain-")),
      physics: { mode: "noop" },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "chain-session",
      toolCallId: "chain-1",
      toolName: "tool_chain",
      args: {
        steps: [
          { tool: "grep", args: { pattern: "TODO" } },
          { tool: "read", args: { path: "README.md" } },
        ],
      },
    });
    const commitmentId = expectAllow(decision);

    await runtime.kernel.commitToolResult({
      commitmentId,
      result: { outcome: { kind: "ok", value: {} }, content: "ok", metadata: { rollback: null } },
    });

    // The chain envelope is exactly one canonical transaction: one proposed,
    // one committed, zero aborted. Internal steps never enter the kernel (they
    // are dispatched directly via child.execute inside the tool), so there is
    // no second tool.committed — the `single tool call` boundary holds even for
    // a compound envelope.
    expect(runtime.tape.list("chain-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "tool.committed",
    ]);
    expect(runtime.tape.project("chain-session", "tool_commitments")).toMatchObject({
      proposed: [{ type: "tool.proposed" }],
      committed: [{ type: "tool.committed" }],
      aborted: [],
    });
  });
});
