import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getOrCreateNarrativeMemoryPlane,
  type NarrativeMemoryRecord,
} from "@brewva/brewva-deliberation";
import {
  NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE,
  NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE,
  NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE,
  NARRATIVE_MEMORY_RECORDED_EVENT_TYPE,
  NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE,
  BrewvaRuntime,
} from "@brewva/brewva-runtime";
import { createNarrativeMemoryTool } from "@brewva/brewva-tools";
import { createTestWorkspace } from "../../helpers/workspace.js";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function extractDetails<T>(result: { details?: unknown }): T | undefined {
  return result.details as T | undefined;
}

function createToolContext(sessionId: string) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as never;
}

describe("narrative memory tool", () => {
  test("supports explicit lifecycle flows while preserving original provenance", async () => {
    const workspace = createTestWorkspace("narrative-memory-tool");
    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "narrative-memory-session";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Keep collaboration memory explicit.",
      targets: {
        files: ["packages/brewva-tools/src/narrative-memory.ts"],
      },
    });

    const tool = createNarrativeMemoryTool({ runtime });
    const ctx = createToolContext(sessionId);

    const archiveCandidate = (await tool.execute(
      "tc-narrative-memory-remember-archive",
      {
        action: "remember",
        class: "operator_preference",
        title: "Review Findings First",
        content: "Show findings before summaries when reviewing code changes.",
      } as never,
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ type: string; text?: string }>; details?: unknown };
    const archiveRecordId = extractDetails<{ record?: NarrativeMemoryRecord }>(archiveCandidate)
      ?.record?.id;
    if (!archiveRecordId) {
      throw new Error("Expected archive candidate id.");
    }

    const retrieveResult = await tool.execute(
      "tc-narrative-memory-retrieve",
      { action: "retrieve", query: "review findings summaries", limit: 3 } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(retrieveResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("# Narrative Memory Retrieval");

    const archiveResult = await tool.execute(
      "tc-narrative-memory-archive",
      { action: "archive", record_id: archiveRecordId } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(archiveResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: archived");

    const promoteCandidate = (await tool.execute(
      "tc-narrative-memory-remember-promote",
      {
        action: "remember",
        class: "working_convention",
        title: "Use Bun Commands",
        content: "Use Bun commands instead of npm or yarn in this repository.",
      } as never,
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ type: string; text?: string }>; details?: unknown };
    const promoteRecordId = extractDetails<{ record?: NarrativeMemoryRecord }>(promoteCandidate)
      ?.record?.id;
    if (!promoteRecordId) {
      throw new Error("Expected promote candidate id.");
    }

    const promoteResult = await tool.execute(
      "tc-narrative-memory-promote",
      { action: "promote", record_id: promoteRecordId } as never,
      undefined,
      undefined,
      ctx,
    );
    const promotedText = extractText(
      promoteResult as { content: Array<{ type: string; text?: string }> },
    );
    const memoryPath = resolve(workspace, ".brewva", "agents", "default", "memory.md");
    const memoryMarkdown = readFileSync(memoryPath, "utf8");
    expect(promotedText).toContain("status: promoted");
    expect(memoryMarkdown).toContain("## Stable Memory");
    expect(memoryMarkdown).toContain(
      "- Use Bun commands instead of npm or yarn in this repository.",
    );

    const plane = getOrCreateNarrativeMemoryPlane(runtime);
    const proposedRecord = plane.addRecord({
      class: "working_convention",
      title: "Use Bun Commands",
      summary: "Run Bun commands in this repository.",
      content: "Use Bun commands instead of npm or yarn in this repository.",
      applicabilityScope: "agent",
      confidenceScore: 0.76,
      status: "proposed",
      retrievalCount: 0,
      provenance: {
        source: "passive_extraction",
        actor: "assistant",
        sessionId,
        agentId: runtime.agentId,
        targetRoots: runtime.task.getTargetDescriptor(sessionId).roots,
      },
      evidence: [
        {
          kind: "input_excerpt",
          summary: "Use Bun commands.",
          sessionId,
          timestamp: 3,
        },
      ],
    });

    const reviewResult = await tool.execute(
      "tc-narrative-memory-review",
      {
        action: "review",
        record_id: proposedRecord.id,
        decision: "accept",
      } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(reviewResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: active");

    const reviewedRecord = plane.getRecord(proposedRecord.id);
    expect(reviewedRecord?.provenance.source).toBe("passive_extraction");

    const forgetCandidate = plane.addRecord({
      class: "project_context_note",
      title: "Temporary Dashboard",
      summary: "This dashboard should not be recalled again.",
      content: "Remember the temporary incident dashboard for this task.",
      applicabilityScope: "repository",
      confidenceScore: 0.61,
      status: "proposed",
      retrievalCount: 0,
      provenance: {
        source: "passive_extraction",
        actor: "assistant",
        sessionId,
        agentId: runtime.agentId,
        targetRoots: runtime.task.getTargetDescriptor(sessionId).roots,
      },
      evidence: [
        {
          kind: "input_excerpt",
          summary: "Temporary dashboard.",
          sessionId,
          timestamp: 4,
        },
      ],
    });

    const forgetResult = await tool.execute(
      "tc-narrative-memory-forget",
      { action: "forget", record_id: forgetCandidate.id } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(forgetResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: rejected");

    const statsResult = await tool.execute(
      "tc-narrative-memory-stats",
      { action: "stats" } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(statsResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("# Narrative Memory Stats");

    expect(
      runtime.events.query(sessionId, { type: NARRATIVE_MEMORY_RECORDED_EVENT_TYPE }).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      runtime.events.query(sessionId, { type: NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE }),
    ).toHaveLength(1);
    expect(
      runtime.events.query(sessionId, { type: NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE }),
    ).toHaveLength(1);
    expect(
      runtime.events.query(sessionId, { type: NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE }),
    ).toHaveLength(1);
    expect(
      runtime.events.query(sessionId, { type: NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE }),
    ).toHaveLength(1);
  });

  test("rejects invalid lifecycle transitions and records accurate receipts", async () => {
    const workspace = createTestWorkspace("narrative-memory-tool-invalid-transitions");
    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "narrative-memory-invalid-transition-session";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Reject invalid narrative state transitions.",
      targets: {
        files: ["packages/brewva-tools/src/narrative-memory.ts"],
      },
    });

    const tool = createNarrativeMemoryTool({ runtime });
    const ctx = createToolContext(sessionId);
    const rememberResult = (await tool.execute(
      "tc-narrative-memory-remember-active",
      {
        action: "remember",
        class: "operator_preference",
        title: "Keep Reviews Direct",
        content: "Keep review feedback direct and specific.",
      } as never,
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ type: string; text?: string }>; details?: unknown };
    const activeRecordId = extractDetails<{ record?: NarrativeMemoryRecord }>(rememberResult)
      ?.record?.id;
    if (!activeRecordId) {
      throw new Error("Expected active record id.");
    }

    const invalidReview = await tool.execute(
      "tc-narrative-memory-review-invalid",
      { action: "review", record_id: activeRecordId, decision: "accept" } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(invalidReview as { content: Array<{ type: string; text?: string }> }),
    ).toContain("review only applies to proposed narrative memory records.");

    await tool.execute(
      "tc-narrative-memory-archive-valid",
      { action: "archive", record_id: activeRecordId } as never,
      undefined,
      undefined,
      ctx,
    );
    const archiveEvent = runtime.events.query(sessionId, {
      type: NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE,
      last: 1,
    })[0];
    expect(archiveEvent?.payload?.previousStatus).toBe("active");

    const plane = getOrCreateNarrativeMemoryPlane(runtime);
    const proposedRecord = plane.addRecord({
      class: "working_convention",
      title: "Throw Away",
      summary: "This proposal will be rejected.",
      content: "Prefer npm for this task.",
      applicabilityScope: "agent",
      confidenceScore: 0.51,
      status: "proposed",
      retrievalCount: 0,
      provenance: {
        source: "passive_extraction",
        actor: "assistant",
        sessionId,
        agentId: runtime.agentId,
        targetRoots: runtime.task.getTargetDescriptor(sessionId).roots,
      },
      evidence: [
        {
          kind: "input_excerpt",
          summary: "Prefer npm.",
          sessionId,
          timestamp: 10,
        },
      ],
    });

    await tool.execute(
      "tc-narrative-memory-forget-proposed",
      { action: "forget", record_id: proposedRecord.id } as never,
      undefined,
      undefined,
      ctx,
    );

    const invalidPromote = await tool.execute(
      "tc-narrative-memory-promote-invalid",
      { action: "promote", record_id: proposedRecord.id } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(invalidPromote as { content: Array<{ type: string; text?: string }> }),
    ).toContain("promote only applies to active narrative memory records.");
  });

  test("remember applies the same narrative validation boundary as passive extraction", async () => {
    const workspace = createTestWorkspace("narrative-memory-tool-validation");
    const memoryPath = resolve(workspace, ".brewva", "agents", "default", "memory.md");
    mkdirSync(dirname(memoryPath), { recursive: true });
    writeFileSync(
      memoryPath,
      [
        "# Memory",
        "",
        "## Operator Preferences",
        "- Do not use npm commands in this repository.",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "narrative-memory-validation-session";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Keep explicit narrative writes inside the RFC boundary.",
      targets: {
        files: ["packages/brewva-tools/src/narrative-memory.ts"],
      },
    });

    const tool = createNarrativeMemoryTool({ runtime });
    const ctx = createToolContext(sessionId);

    const contradiction = await tool.execute(
      "tc-narrative-memory-remember-contradiction",
      {
        action: "remember",
        class: "operator_preference",
        title: "Use npm",
        content: "Use npm commands in this repository.",
      } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(contradiction as { content: Array<{ type: string; text?: string }> }),
    ).toContain("contradicts stronger operator-authored agent memory");

    const codeDerived = await tool.execute(
      "tc-narrative-memory-remember-code-derived",
      {
        action: "remember",
        class: "project_context_note",
        title: "Source File Pointer",
        content: "The implementation lives in packages/brewva-tools/src/narrative-memory.ts.",
      } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(codeDerived as { content: Array<{ type: string; text?: string }> }),
    ).toContain("code-derived or git-derived content");

    const kernelAuthoritative = await tool.execute(
      "tc-narrative-memory-remember-kernel",
      {
        action: "remember",
        class: "project_context_note",
        title: "Task Truth",
        content: "The truth says the blocker is resolved and acceptance is complete.",
      } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(kernelAuthoritative as { content: Array<{ type: string; text?: string }> }),
    ).toContain("kernel-authoritative content");

    const precedentLike = await tool.execute(
      "tc-narrative-memory-remember-precedent",
      {
        action: "remember",
        class: "working_convention",
        title: "Incident Writeup",
        content: [
          "# Incident",
          "",
          "## Summary",
          "Document the root cause and fix.",
          "",
          "- Step one",
          "- Step two",
          "- Step three",
          "- Step four",
        ].join("\n"),
      } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(
      extractText(precedentLike as { content: Array<{ type: string; text?: string }> }),
    ).toContain("precedent-like content");

    expect(getOrCreateNarrativeMemoryPlane(runtime).list()).toHaveLength(0);
  });
});
