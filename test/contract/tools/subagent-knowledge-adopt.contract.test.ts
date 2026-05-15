import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { createSubagentKnowledgeAdoptTool } from "@brewva/brewva-tools/delegation";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function fakeContext(sessionId: string): any {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (
    result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text ??
    ""
  );
}

describe("subagent_knowledge_adopt tool", () => {
  let workspace = "";

  beforeEach(() => {
    workspace = createTestWorkspace("subagent-knowledge-adopt");
  });

  afterEach(() => {
    if (workspace) {
      cleanupWorkspace(workspace);
    }
  });

  test("requires an artifact link when accepting knowledge", async () => {
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const tool = createSubagentKnowledgeAdoptTool({
      runtime,
    });

    const result = await tool.execute(
      "tc-knowledge-adopt-missing-link",
      {
        runId: "knowledge-run-1",
        decision: "accept",
        reason: "The proposal is useful but has no authoritative artifact yet.",
      },
      undefined,
      undefined,
      fakeContext("session-knowledge-adopt"),
    );

    expect(extractText(result)).toContain("accept requires");
    expect(result.details).toMatchObject({
      ok: false,
      decision: "accept",
    });
    expect(runtime.inspect.events.records.list("session-knowledge-adopt")).toEqual([]);
  });

  test("records accept receipts without writing knowledge artifacts", async () => {
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const tool = createSubagentKnowledgeAdoptTool({
      runtime,
    });

    const result = await tool.execute(
      "tc-knowledge-adopt-accept",
      {
        runId: "knowledge-run-2",
        decision: "accept",
        reason: "The proposal was promoted through the parent knowledge-capture path.",
        knowledgeCaptureArtifactRef: "docs/solutions/subagent-routing.md",
      },
      undefined,
      undefined,
      fakeContext("session-knowledge-adopt"),
    );

    expect(extractText(result)).toContain("recorded accept");
    expect(result.details).toMatchObject({
      ok: true,
      runId: "knowledge-run-2",
      decision: "accept",
      artifactRefs: ["docs/solutions/subagent-routing.md"],
    });
    const recordedEvents = runtime.inspect.events.records.query("session-knowledge-adopt", {
      type: "subagent_knowledge_adoption_recorded",
    });
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]).toMatchObject({
      sessionId: "session-knowledge-adopt",
      type: "subagent_knowledge_adoption_recorded",
      payload: {
        runId: "knowledge-run-2",
        decision: "accept",
        reason: "The proposal was promoted through the parent knowledge-capture path.",
        artifactRefs: ["docs/solutions/subagent-routing.md"],
        knowledgeCaptureArtifactRef: "docs/solutions/subagent-routing.md",
        workerPatchArtifactRef: null,
        finalArtifactRef: null,
      },
    });
  });

  test("records reject receipts without requiring artifacts", async () => {
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const tool = createSubagentKnowledgeAdoptTool({
      runtime,
    });

    const result = await tool.execute(
      "tc-knowledge-adopt-reject",
      {
        runId: "knowledge-run-3",
        decision: "reject",
        reason: "The proposal conflicts with fresher project guidance.",
      },
      undefined,
      undefined,
      fakeContext("session-knowledge-adopt"),
    );

    expect(extractText(result)).toContain("recorded reject");
    expect(
      runtime.inspect.events.records.query("session-knowledge-adopt", {
        type: "subagent_knowledge_adoption_recorded",
      }),
    ).toHaveLength(1);
  });
});
