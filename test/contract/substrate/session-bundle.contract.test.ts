import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertSessionBundleManifest,
  isLegacyPiSessionArtifactPath,
  readSessionBundleArtifact,
  type BrewvaSessionBundleManifest,
} from "@brewva/brewva-substrate";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("substrate native session bundle contract", () => {
  test("accepts a Brewva-native session bundle manifest", () => {
    const manifest: BrewvaSessionBundleManifest = {
      format: "brewva.session.bundle.v1",
      sessionId: "sess_01",
      workspaceRoot: "/workspace/project",
      tapePath: "authority/tape.jsonl",
      checkpointPath: "authority/checkpoint.json",
      recoveryWalPath: "authority/recovery-wal.jsonl",
      projectionsDir: "projections",
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:01.000Z",
    };

    expect(assertSessionBundleManifest(manifest)).toEqual(manifest);
  });

  test("fails fast for legacy Pi JSONL session artifacts", () => {
    expect(
      isLegacyPiSessionArtifactPath("/Users/example/.pi/agent/sessions/foo/session.jsonl"),
    ).toBe(true);
    expect(() =>
      assertSessionBundleManifest({
        format: "pi.session.jsonl",
        sessionId: "sess_legacy",
      }),
    ).toThrow("legacy Pi session artifacts are not supported");
  });

  test("reads a native bundle manifest file with resolved artifact paths", () => {
    const workspace = createTestWorkspace("session-bundle-manifest-import");
    const manifestPath = join(workspace, "bundle.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        format: "brewva.session.bundle.v1",
        sessionId: "sess_02",
        workspaceRoot: workspace,
        tapePath: "authority/tape.jsonl",
        checkpointPath: "authority/checkpoint.json",
        recoveryWalPath: "authority/recovery-wal.jsonl",
        projectionsDir: "projections",
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:01.000Z",
      }),
      "utf8",
    );

    const artifact = readSessionBundleArtifact(manifestPath);

    expect(artifact.kind).toBe("brewva_bundle");
    if (artifact.kind !== "brewva_bundle") {
      throw new Error("expected native bundle artifact");
    }
    expect(artifact.bundleRoot).toBe(workspace);
    expect(artifact.resolvedPaths).toEqual({
      tapePath: join(workspace, "authority", "tape.jsonl"),
      checkpointPath: join(workspace, "authority", "checkpoint.json"),
      recoveryWalPath: join(workspace, "authority", "recovery-wal.jsonl"),
      projectionsDir: join(workspace, "projections"),
    });
  });

  test("imports legacy Pi JSONL sessions into Brewva session entries", () => {
    const workspace = createTestWorkspace("session-bundle-legacy-pi-import");
    const sessionPath = join(workspace, "legacy-session.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-session-1",
          timestamp: "2026-04-10T00:00:00.000Z",
          cwd: "/workspace/pi-project",
        }),
        JSON.stringify({
          type: "model_change",
          id: "m1",
          parentId: null,
          timestamp: "2026-04-10T00:00:01.000Z",
          provider: "openai",
          modelId: "gpt-5.4",
        }),
        JSON.stringify({
          type: "thinking_level_change",
          id: "t1",
          parentId: "m1",
          timestamp: "2026-04-10T00:00:02.000Z",
          thinkingLevel: "high",
        }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: "t1",
          timestamp: "2026-04-10T00:00:03.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello from pi" }],
            timestamp: 1,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-04-10T00:00:04.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "reply from pi" }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          },
        }),
        JSON.stringify({
          type: "custom_message",
          id: "c1",
          parentId: "a1",
          timestamp: "2026-04-10T00:00:05.000Z",
          customType: "note",
          content: "carry this context",
          display: true,
          details: { source: "pi" },
        }),
        JSON.stringify({
          type: "compaction",
          id: "cmp1",
          parentId: "c1",
          timestamp: "2026-04-10T00:00:06.000Z",
          summary: "Pi compacted earlier history",
          firstKeptEntryId: "u1",
          tokensBefore: 2048,
        }),
        JSON.stringify({
          type: "branch_summary",
          id: "b1",
          parentId: "u1",
          timestamp: "2026-04-10T00:00:07.000Z",
          fromId: "cmp1",
          summary: "Pi explored an alternate branch",
        }),
        JSON.stringify({
          type: "custom",
          id: "x1",
          parentId: "b1",
          timestamp: "2026-04-10T00:00:08.000Z",
          customType: "extension-state",
          data: { ignored: true },
        }),
      ].join("\n"),
      "utf8",
    );

    const artifact = readSessionBundleArtifact(sessionPath);

    expect(artifact.kind).toBe("legacy_pi_jsonl");
    if (artifact.kind !== "legacy_pi_jsonl") {
      throw new Error("expected legacy Pi artifact");
    }
    expect(artifact.sessionId).toBe("pi-session-1");
    expect(artifact.workspaceRoot).toBe("/workspace/pi-project");
    expect(artifact.context.model).toEqual({ provider: "openai", modelId: "gpt-5.4" });
    expect(artifact.context.thinkingLevel).toBe("high");
    expect(artifact.context.messages.map((message) => message.role)).toEqual([
      "user",
      "branchSummary",
    ]);
    expect(artifact.warnings).toEqual(["ignored unsupported Pi session entry type: custom"]);
  });
});
