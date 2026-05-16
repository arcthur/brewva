import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCliSuccess,
  runCliSync,
  sanitizeSessionId,
  skipLiveForProviderRateLimitResult,
} from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import {
  type BrewvaEventBundle,
  parseJsonLines,
  requireFinalBundle,
} from "../../helpers/events.js";
import { runLive } from "../../helpers/live.js";
import { cleanupWorkspace, createWorkspace } from "../../helpers/workspace.js";

function isModelEditValidationFailure(run: ReturnType<typeof runCliSync>): boolean {
  const stderr = run.stderr ?? "";
  return (
    run.status !== 0 &&
    (stderr.includes("oldText must not be empty") ||
      stderr.includes("Could not find edits[") ||
      stderr.includes("Each oldText must be unique"))
  );
}

describe("live: undo", () => {
  runLive("undo restores file after llm-driven edit", () => {
    const workspace = createWorkspace("undo");
    writeMinimalConfig(workspace);

    const runId = randomUUID();
    const fixturePath = join(workspace, "undo_fixture.txt");
    const baseline = `BASELINE-${runId}\n`;
    const changed = `CHANGED-${runId}\n`;
    writeFileSync(fixturePath, baseline, "utf8");

    try {
      const prompts = [
        `Use the file editing tool on ./undo_fixture.txt. The current full file content is exactly ${JSON.stringify(baseline)}. Replace that exact oldText with exactly ${JSON.stringify(changed)}. Do not use an empty oldText.`,
        `Call the edit tool for ./undo_fixture.txt with oldText exactly ${JSON.stringify(baseline)} and newText exactly ${JSON.stringify(changed)}. Apply the edit only.`,
        `Apply one exact replacement in ./undo_fixture.txt: oldText=${JSON.stringify(baseline)} newText=${JSON.stringify(changed)}.`,
      ];

      let bundle: BrewvaEventBundle | undefined;
      let sessionId = "";
      let afterEdit = readFileSync(fixturePath, "utf8");
      let editValidationFailures = 0;

      for (const prompt of prompts) {
        writeFileSync(fixturePath, baseline, "utf8");
        const run = runCliSync(workspace, ["--mode", "json", prompt], {
          timeoutMs: 10 * 60 * 1000,
        });

        if (skipLiveForProviderRateLimitResult("undo-edit-run", run)) {
          return;
        }
        if (isModelEditValidationFailure(run)) {
          editValidationFailures += 1;
          console.warn(
            `[undo.live] retrying after model edit validation failure (${editValidationFailures}/${prompts.length})`,
          );
          continue;
        }
        assertCliSuccess(run, "undo-edit-run");

        bundle = requireFinalBundle(parseJsonLines(run.stdout, { strict: true }), "undo edit run");
        sessionId = bundle.sessionId;
        expect(sessionId.length).toBeGreaterThan(0);

        afterEdit = readFileSync(fixturePath, "utf8");
        if (afterEdit === changed) {
          break;
        }
      }

      if (editValidationFailures === prompts.length) {
        throw new Error(
          "[undo.live] all deterministic edit attempts failed model edit validation; this may indicate an edit tool contract regression.",
        );
      }

      if (afterEdit !== changed) {
        console.warn(
          [
            "[undo.live] skipped rollback assertions because model did not apply deterministic file edit after retries.",
            `[undo.live] expected: ${JSON.stringify(changed)}`,
            `[undo.live] actual: ${JSON.stringify(afterEdit)}`,
          ].join("\n"),
        );
        return;
      }

      if (!bundle) {
        throw new Error("Expected final bundle from edit run.");
      }
      expect(bundle.events.map((event) => event.type)).toContain("patch_recorded");

      const historyFile = join(
        workspace,
        ".orchestrator",
        "snapshots",
        sanitizeSessionId(sessionId),
        "patchsets.json",
      );
      expect(existsSync(historyFile)).toBe(true);

      const undo = runCliSync(workspace, ["--undo", "--session", sessionId]);
      assertCliSuccess(undo, "undo-cmd");
      const restored = readFileSync(fixturePath, "utf8") === baseline;

      expect(undo.stdout).toContain("Session undo applied");
      if (!restored) {
        throw new Error(
          [
            "[undo.live] fixture was not restored to baseline after session undo.",
            `[undo.live] current=${JSON.stringify(readFileSync(fixturePath, "utf8"))}`,
            `[undo.live] expected=${JSON.stringify(baseline)}`,
            `[undo.live] undoOutput=${JSON.stringify(undo.stdout.trim())}`,
          ].join("\n"),
        );
      }
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("undo on empty workspace reports no_checkpoint", () => {
    const workspace = createWorkspace("undo-empty");
    writeMinimalConfig(workspace);

    try {
      const undo = runCliSync(workspace, ["--undo"]);
      assertCliSuccess(undo, "undo-empty");
      expect(undo.stdout).toContain("No session undo applied (no_checkpoint).");
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
