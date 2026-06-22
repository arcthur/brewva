import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// RFC: Checked Invariants And Disciplined Peer Borrowing — item G.
// The hosted provider request is a HYBRID, not `PromptPlan` alone: the dispatch
// path supplies the baseline (restored history + current user message + plugin
// transforms) and the environment-derived system prompt; `materialize()`
// contributes only the post-cursor committed tape delta. So `PromptPlan` is the
// runtime.turn projection, never a byte-exact record of the hosted provider
// request. These guards keep that boundary from silently drifting — e.g. someone
// folding the environment system prompt into the pure tape projection.
const REPO_ROOT = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("hosted materialize boundary (RFC item G)", () => {
  test("the hosted provider systemPrompt is dispatch-derived and merged outside materialize", () => {
    const providerContext = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/turn/runtime-provider-context.ts",
    );
    // The system prompt comes from the dispatch overlay on agent state, not from
    // the tape projection alone.
    expect(providerContext).toContain("toolContext.getSystemPrompt()");
    // The hosted baseline owns history; materialize contributes only the
    // post-cursor delta.
    expect(providerContext).toContain("appendRuntimeTurnDelta");
  });

  test("materialize() never assembles the environment-derived systemPrompt", () => {
    const materializeImpl = readRepoFile("packages/brewva-runtime/src/runtime/model/impl.ts");
    expect(materializeImpl).not.toMatch(
      /appendTargetScopedProjectInstructions|applyPromptOverlay|getBaseSystemPrompt/,
    );
  });
});
