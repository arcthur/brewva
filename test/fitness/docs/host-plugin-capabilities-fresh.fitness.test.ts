import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

// RFC: Checked Invariants And Disciplined Peer Borrowing — item F (matrix).
// The host-plugin capability x plugin matrix is a generated authority inventory;
// a regenerate-and-diff freshness check keeps it in lockstep with the code, and
// ground-truth anchors stop a "both sides wrong the same way" drift.
describe("generated host-plugin capability matrix", () => {
  it("is fresh", () => {
    const result = spawnSync("bun", ["run", "docs:host-plugin-capabilities:check"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
  });

  it("covers every capability and marks hosted_behavior's declared set as ground truth", () => {
    const view = readFileSync(
      resolve(repoRoot, "docs/reference/host-plugin-capabilities.md"),
      "utf-8",
    );
    // No-context-source invariant: context_messages.write is the only context-write row.
    expect(view).toMatch(/context_messages\.write.+context-write.+yes/u);
    // The three capabilities outside hosted_behavior's authority surface are not declared.
    expect(view).toMatch(/message_visibility\.write.+message-visibility-write.+\bno\b/u);
    expect(view).toMatch(/turn_input\.handle.+input-handling.+\bno\b/u);
    expect(view).toMatch(/user_message\.enqueue.+message-enqueue.+\bno\b/u);
    // Completeness: every capability has a row.
    expect(view).toContain("Capabilities: 12. Internal plugins: 1.");
  });
});
