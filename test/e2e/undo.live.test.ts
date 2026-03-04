import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCliSuccess,
  cleanupWorkspace,
  createWorkspace,
  findFinalBundle,
  type BrewvaEventBundle,
  parseJsonLines,
  runCliSync,
  runLive,
  sanitizeSessionId,
  writeMinimalConfig,
} from "./helpers.js";

describe("e2e: undo", () => {
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
        `Open the file ./undo_fixture.txt and replace its entire contents with exactly '${changed.trim()}' followed by a newline. Use the file editing tool. Do not describe the change, just apply it.`,
        `Use a file editing tool now. Rewrite ./undo_fixture.txt so the full file content is exactly '${changed.trim()}' with a trailing newline.`,
      ];

      let bundle: BrewvaEventBundle | undefined;
      let sessionId = "";
      let afterEdit = readFileSync(fixturePath, "utf8");

      for (const prompt of prompts) {
        writeFileSync(fixturePath, baseline, "utf8");
        const run = runCliSync(workspace, ["--mode", "json", prompt], {
          timeoutMs: 10 * 60 * 1000,
        });

        assertCliSuccess(run, "undo-edit-run");

        bundle = findFinalBundle(parseJsonLines(run.stdout, { strict: true }));
        expect(bundle).toBeDefined();
        sessionId = bundle?.sessionId ?? "";
        expect(sessionId.length).toBeGreaterThan(0);

        afterEdit = readFileSync(fixturePath, "utf8");
        if (afterEdit === changed) {
          break;
        }
      }

      if (afterEdit !== changed) {
        throw new Error(
          [
            "[undo.live] model did not apply expected file edit after retries.",
            `[undo.live] expected: ${JSON.stringify(changed)}`,
            `[undo.live] actual: ${JSON.stringify(afterEdit)}`,
          ].join("\n"),
        );
      }

      expect(bundle).toBeDefined();
      const eventTypes = new Set((bundle?.events ?? []).map((event) => event.type));
      expect(eventTypes.has("patch_recorded")).toBe(true);

      const historyFile = join(
        workspace,
        ".orchestrator",
        "snapshots",
        sanitizeSessionId(sessionId),
        "patchsets.json",
      );
      expect(existsSync(historyFile)).toBe(true);

      let restored = readFileSync(fixturePath, "utf8") === baseline;
      let rollbackCount = 0;
      const undoTranscripts: string[] = [];
      for (let attempt = 0; !restored && attempt < 5; attempt += 1) {
        const undo = runCliSync(workspace, ["--undo", "--session", sessionId]);
        assertCliSuccess(undo, "undo-cmd");
        undoTranscripts.push(undo.stdout.trim());
        if (!undo.stdout.includes("Rolled back")) {
          break;
        }
        rollbackCount += 1;
        restored = readFileSync(fixturePath, "utf8") === baseline;
      }

      expect(rollbackCount).toBeGreaterThan(0);
      if (!restored) {
        throw new Error(
          [
            "[undo.live] fixture was not restored to baseline after rollback attempts.",
            `[undo.live] rollbackCount=${rollbackCount}`,
            `[undo.live] current=${JSON.stringify(readFileSync(fixturePath, "utf8"))}`,
            `[undo.live] expected=${JSON.stringify(baseline)}`,
            `[undo.live] undoOutput=${JSON.stringify(undoTranscripts)}`,
          ].join("\n"),
        );
      }
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("undo on empty workspace reports no_patchset", () => {
    const workspace = createWorkspace("undo-empty");
    writeMinimalConfig(workspace);

    try {
      const undo = runCliSync(workspace, ["--undo"]);
      assertCliSuccess(undo, "undo-empty");
      expect(undo.stdout.includes("No rollback applied (no_patchset).")).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
