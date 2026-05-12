import { describe, expect, test } from "bun:test";
import { readRepoFile } from "../gateway/shared.js";

describe("history view baseline artifact docs", () => {
  test("documents the baseline artifact path instead of the pre-phase-2 no-file wording", () => {
    const markdown = readRepoFile("docs/reference/artifacts-and-paths.md");

    expect(markdown).toContain(
      ".orchestrator/history-view/sessions/sess_<base64url(sessionId)>/baseline.json",
    );
    expect(markdown).not.toContain("no standalone baseline snapshot file");
  });
});
