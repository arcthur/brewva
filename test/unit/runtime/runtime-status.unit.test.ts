import { describe, expect, test } from "bun:test";
import { buildRuntimeStatusBlock } from "../../../packages/brewva-runtime/src/context/runtime-status.js";

describe("runtime status surface formatting", () => {
  test("renders task verification levels using the agent-facing surface", () => {
    const block = buildRuntimeStatusBlock({
      verification: {
        timestamp: Date.now(),
        level: "standard",
        outcome: "passed",
      },
      failures: [],
    });

    expect(block).toContain("[RuntimeStatus]");
    expect(block).toContain("level=targeted");
    expect(block).not.toContain("level=standard");
  });
});
