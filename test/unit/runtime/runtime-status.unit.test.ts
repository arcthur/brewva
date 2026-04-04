import { describe, expect, test } from "bun:test";
import { buildRuntimeStatusBlock } from "../../../packages/brewva-runtime/src/context/runtime-status.js";

describe("runtime status surface formatting", () => {
  test("renders canonical verification levels without agent-facing aliases", () => {
    const block = buildRuntimeStatusBlock({
      verification: {
        timestamp: Date.now(),
        level: "standard",
        outcome: "passed",
      },
      failures: [],
    });

    expect(block).toContain("[RuntimeStatus]");
    expect(block).toContain("level=standard");
    expect(block).not.toContain("level=targeted");
  });

  test("renders missing checks separately from failed checks", () => {
    const block = buildRuntimeStatusBlock({
      verification: {
        timestamp: Date.now(),
        level: "standard",
        outcome: "fail",
        failedChecks: [],
        missingChecks: ["tests"],
        missingEvidence: ["tests"],
      },
      failures: [],
    });

    expect(block).toContain("missing=tests");
    expect(block).toContain("missing_evidence: tests");
    expect(block).not.toContain("failed=tests");
  });
});
