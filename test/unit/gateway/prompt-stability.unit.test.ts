import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@brewva/brewva-std/hash";
import {
  buildPromptStabilityObservation,
  diffKeyedBlocks,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/prompt-stability.js";

// RFC: Checked Invariants And Disciplined Peer Borrowing — item A.
// Borrow opencode's baseline/update/removed diff algebra as a reusable pure
// helper, and apply it to the reachable dynamic-tail blocks so prefix/tail
// instability becomes a structured "what changed", not just a boolean.
describe("prompt stability per-block diff (RFC item A)", () => {
  test("diffKeyedBlocks reports added, updated, and removed block ids", () => {
    const diff = diffKeyedBlocks({ a: "h1", b: "h2", c: "h3" }, { a: "h1", b: "CHANGED", d: "h4" });
    expect(diff).toEqual({ added: ["d"], updated: ["b"], removed: ["c"] });
  });

  test("an undefined baseline makes every current block added (the baseline case)", () => {
    const diff = diffKeyedBlocks(undefined, { a: "h1", b: "h2" });
    expect(diff).toEqual({ added: ["a", "b"], updated: [], removed: [] });
  });

  test("observation hashes each tail block by id", () => {
    const observation = buildPromptStabilityObservation({
      systemPrompt: "sys",
      composedContent: "content",
      turn: 1,
      tailBlocks: [
        { id: "workbench", content: "w" },
        { id: "recall", content: "r" },
      ],
    });
    expect(observation.tailBlockHashes).toEqual({
      workbench: sha256Hex("w"),
      recall: sha256Hex("r"),
    });
  });

  test("omitting tailBlocks leaves tailBlockHashes absent (additive, no behavior change)", () => {
    const observation = buildPromptStabilityObservation({
      systemPrompt: "sys",
      composedContent: "content",
      turn: 1,
    });
    expect("tailBlockHashes" in observation).toBe(false);
  });
});
