import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listCognitionArtifacts,
  readCognitionArtifact,
  writeCognitionArtifact,
} from "@brewva/brewva-deliberation";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createCognitionNoteTool } from "@brewva/brewva-tools";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

describe("cognition_note contract", () => {
  test("records and lists operator teaching artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-cognition-note-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s9-cognition";

    const tool = createCognitionNoteTool({ runtime });
    const recorded = await tool.execute(
      "tc-cognition-record",
      {
        action: "record",
        kind: "procedure",
        name: "verification-standard-implementation",
        lessonKey: "verification:standard:implementation",
        pattern: "reuse the standard verification path for implementation tasks",
        recommendation: "reuse the standard verification path for similar implementation work",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(recorded)).toContain("Recorded procedure cognition note");

    const artifacts = await listCognitionArtifacts(workspace, "reference");
    expect(artifacts).toHaveLength(1);
    const content = await readCognitionArtifact({
      workspaceRoot: workspace,
      lane: "reference",
      fileName: artifacts[0]!.fileName,
    });
    expect(content).toContain("[ProcedureNote]");

    const duplicate = await tool.execute(
      "tc-cognition-duplicate",
      {
        action: "record",
        kind: "procedure",
        name: "verification-standard-implementation",
        recommendation: "duplicate operator teaching should be rejected",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(duplicate)).toContain("duplicate_operator_teaching_name");

    await writeCognitionArtifact({
      workspaceRoot: workspace,
      lane: "reference",
      name: "verification-outcome-system",
      content: [
        "[ProcedureNote]",
        "profile: procedure_note",
        "note_kind: verification_outcome",
        "lesson_key: verification:standard:implementation",
        "pattern: system-generated note",
        "recommendation: system-generated recommendation",
      ].join("\n"),
      createdAt: 1_731_000_000_010,
    });

    const superseded = await tool.execute(
      "tc-cognition-supersede",
      {
        action: "supersede",
        kind: "procedure",
        name: "verification-standard-implementation",
        lessonKey: "verification:standard:implementation",
        pattern: "reuse the standard verification path for implementation tasks",
        recommendation: "superseded recommendation for the latest implementation workflow",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(superseded)).toContain("Superseded procedure cognition note");

    const listed = await tool.execute(
      "tc-cognition-list",
      {
        action: "list",
        kind: "procedure",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const listedText = extractTextContent(listed);
    expect(listedText).toContain("# Cognition Notes");
    expect(listedText).toContain("verification-standard-implementation");
    expect(listedText.includes("verification-outcome-system")).toBe(false);
    expect((listed.details as { count?: number } | undefined)?.count).toBe(1);
    expect(runtime.events.query(sessionId, { type: "cognition_note_written" })).toHaveLength(2);
  });

  test("episode notes can carry an explicit session scope for future rehydration", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-cognition-episode-tool-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s9-cognition-episode";

    const tool = createCognitionNoteTool({ runtime });
    const recorded = await tool.execute(
      "tc-cognition-episode",
      {
        action: "record",
        kind: "episode",
        name: "release-handoff",
        title: "Release Handoff",
        focus: "release readiness handoff",
        nextAction: "resume blocker review",
        sessionScope: sessionId,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(recorded)).toContain("Recorded episode cognition note");

    const artifacts = await listCognitionArtifacts(workspace, "summaries");
    expect(artifacts).toHaveLength(1);
    const content = await readCognitionArtifact({
      workspaceRoot: workspace,
      lane: "summaries",
      fileName: artifacts[0]!.fileName,
    });
    expect(content).toContain("[EpisodeNote]");
    expect(content).toContain(`session_scope: ${sessionId}`);
  });
});
