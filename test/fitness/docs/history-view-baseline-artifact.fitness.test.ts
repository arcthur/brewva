import { describe, expect, test } from "bun:test";
import { readRepoFile } from "../gateway/shared.js";

describe("history view baseline artifact docs", () => {
  test("documents event-tape-derived baselines instead of a standalone artifact path", () => {
    const markdown = readRepoFile("docs/reference/artifacts-and-paths.md");

    expect(markdown).toContain("rebuilt from `session_compact` receipts");
    expect(markdown).toContain("`.orchestrator/projection/**`");
    expect(markdown).toContain("history-view artifact file");
    expect(markdown).not.toContain(
      ".orchestrator/history-view/sessions/sess_<base64url(sessionId)>/baseline.json",
    );
  });
});
