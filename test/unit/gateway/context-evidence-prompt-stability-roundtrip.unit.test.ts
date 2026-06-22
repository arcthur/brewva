import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readContextEvidenceSamples,
  resolveEvidenceDir,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence/store.js";

// RFC: Checked Invariants And Disciplined Peer Borrowing — item A (P2#2).
// changedTailBlocks is written to the prompt_stability evidence sample; the sidecar
// parser must read it back, or the typed-evidence closure is round-trip lossy.
describe("prompt_stability evidence round-trip", () => {
  test("changedTailBlocks survives a write/read round-trip through the disk parser", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-evidence-"));
    const sessionId = "round-trip-session";
    const dir = resolveEvidenceDir(workspaceRoot);
    mkdirSync(dir, { recursive: true });
    const sample = {
      schema: "brewva.context_evidence.sample.v2",
      kind: "prompt_stability",
      sessionId,
      turn: 1,
      timestamp: 1,
      scopeKey: `${sessionId}::root`,
      stablePrefixHash: "p",
      dynamicTailHash: "d",
      stablePrefix: true,
      stableTail: false,
      changedTailBlocks: ["recall", "workbench"],
      compactionAdvised: false,
      forcedCompaction: false,
      usageRatio: null,
      pendingCompactionReason: null,
      gateRequired: false,
    };
    writeFileSync(join(dir, `session-${sessionId}.jsonl`), `${JSON.stringify(sample)}\n`);

    const promptStability = readContextEvidenceSamples({
      workspaceRoot,
      sessionIds: [sessionId],
    }).filter((entry) => entry.kind === "prompt_stability");

    expect(promptStability).toHaveLength(1);
    expect(promptStability[0]).toMatchObject({ changedTailBlocks: ["recall", "workbench"] });
  });
});
