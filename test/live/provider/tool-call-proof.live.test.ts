import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCliSuccess,
  runCliSync,
  skipLiveForProviderRateLimitResult,
} from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import { isRecord, parseJsonLines, requireFinalBundle } from "../../helpers/events.js";
import { runLive } from "../../helpers/live.js";
import { cleanupWorkspace, createWorkspace } from "../../helpers/workspace.js";

describe("live: tool call proof", () => {
  runLive("agent can read secret token from workspace file", () => {
    const workspace = createWorkspace("tool-proof");
    writeMinimalConfig(workspace);

    const token = `SECRET-${randomUUID()}`;
    writeFileSync(join(workspace, "token.txt"), token, "utf8");

    try {
      const run = runCliSync(workspace, [
        "--print",
        "Read the file ./token.txt and output its exact contents. Do not guess.",
      ]);

      if (skipLiveForProviderRateLimitResult("tool-proof", run)) {
        return;
      }
      assertCliSuccess(run, "tool-proof");
      expect(run.stdout).toContain(token);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("--managed-tools direct mode still emits valid final bundle", () => {
    const workspace = createWorkspace("managed-tools-direct");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--managed-tools",
        "direct",
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: DIRECT-TOOLS-OK",
      ]);

      if (skipLiveForProviderRateLimitResult("managed-tools-direct", run)) {
        return;
      }
      assertCliSuccess(run, "managed-tools-direct");

      const lines = parseJsonLines(run.stdout, { strict: true });
      const bundle = requireFinalBundle(lines, "managed tools direct");
      expect(bundle.events.length).toBeGreaterThanOrEqual(2);
      expect(run.stdout).toContain("NO-EXT-OK");

      const nonBundleLines = lines.filter((line) => {
        if (!isRecord(line)) return false;
        return !(line.schema === "brewva.stream.v1" && line.type === "brewva_event_bundle");
      });
      expect(nonBundleLines.length).toBeGreaterThan(0);
      const nonBundleEventTypes = nonBundleLines
        .filter((line): line is Record<string, unknown> & { type: string } => {
          return isRecord(line) && typeof line.type === "string";
        })
        .map((line) => line.type);
      expect(nonBundleEventTypes).toContain("turn_end");
      expect(nonBundleEventTypes).toContain("agent_end");

      const eventTypes = bundle.events.map((event) => event.type);
      expect(eventTypes).toContain("session_start");
      expect(eventTypes).toContain("agent_end");
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
