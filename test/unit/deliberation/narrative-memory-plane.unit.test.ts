import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  FileNarrativeMemoryStore,
  createNarrativeMemoryContextProvider,
  getOrCreateNarrativeMemoryPlane,
  resolveNarrativeMemoryStatePath,
} from "@brewva/brewva-deliberation";
import { BrewvaRuntime, CONTEXT_SOURCES } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("narrative memory plane", () => {
  test("persists records, retrieves active records by default, and exposes a recall provider", () => {
    const workspace = createTestWorkspace("narrative-memory-plane");
    const runtime = new BrewvaRuntime({ cwd: workspace, agentId: "default" });
    const sessionId = "narrative-plane-session";
    const statePath = resolveNarrativeMemoryStatePath(workspace);

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Keep collaboration memory explicit and non-authoritative.",
      targets: {
        files: ["packages/brewva-tools/src/narrative-memory.ts"],
      },
    });

    const plane = getOrCreateNarrativeMemoryPlane(runtime);
    const activeRecord = plane.addRecord({
      class: "operator_preference",
      title: "Review Findings First",
      summary: "Show findings before summaries in code review responses.",
      content: "Show findings before summaries when you review code changes.",
      applicabilityScope: "operator",
      confidenceScore: 1,
      status: "active",
      retrievalCount: 0,
      provenance: {
        source: "explicit_tool",
        actor: "operator",
        sessionId,
        agentId: runtime.agentId,
        targetRoots: runtime.task.getTargetDescriptor(sessionId).roots,
      },
      evidence: [
        {
          kind: "input_excerpt",
          summary: "Findings should appear before summaries.",
          sessionId,
          timestamp: 1,
        },
      ],
    });
    plane.addRecord({
      class: "operator_preference",
      title: "Archived Review Style",
      summary: "An outdated archived preference.",
      content: "Show findings before summaries when you review code changes.",
      applicabilityScope: "operator",
      confidenceScore: 0.62,
      status: "archived",
      retrievalCount: 0,
      provenance: {
        source: "explicit_tool",
        actor: "operator",
        sessionId,
        agentId: runtime.agentId,
        targetRoots: runtime.task.getTargetDescriptor(sessionId).roots,
      },
      evidence: [
        {
          kind: "input_excerpt",
          summary: "Archived preference.",
          sessionId,
          timestamp: 2,
        },
      ],
    });

    expect(existsSync(statePath)).toBe(true);
    const reloaded = new FileNarrativeMemoryStore(workspace).read();
    expect(reloaded?.records).toHaveLength(2);

    const retrievals = plane.retrieve("review findings before summaries", {
      targetRoots: runtime.task.getTargetDescriptor(sessionId).roots,
    });
    expect(retrievals).toHaveLength(1);
    expect(retrievals[0]?.record.id).toBe(activeRecord.id);

    const duplicates = plane.findNearDuplicates({
      class: "operator_preference",
      scope: "operator",
      title: "Review Findings First",
      content: "Show findings before summaries when you review code changes.",
      minimumScore: 0.2,
    });
    expect(duplicates[0]?.record.id).toBe(activeRecord.id);

    const provider = createNarrativeMemoryContextProvider({ runtime, maxRecords: 2 });
    const collected: Array<{ id: string; content: string }> = [];
    provider.collect({
      sessionId,
      promptText: "remember the review findings ordering preference",
      register: (entry) => {
        collected.push(entry);
      },
    });

    expect(provider.source).toBe(CONTEXT_SOURCES.narrativeMemory);
    expect(provider.budgetClass).toBe("recall");
    expect(collected).toHaveLength(1);
    expect(collected[0]?.content).toContain("[NarrativeMemory]");
    expect(collected[0]?.content).toContain("provenance_source: explicit_tool");
    expect(collected[0]?.content).toContain("updated_at:");
    expect(collected[0]?.content).toContain("verify_before_applying: yes");
    expect(collected[0]?.content).toContain("Review Findings First");
  });

  test("drops malformed persisted records while preserving promotion metadata", () => {
    const workspace = createTestWorkspace("narrative-memory-store-normalization");
    const statePath = resolveNarrativeMemoryStatePath(workspace);
    mkdirSync(`${workspace}/.brewva/deliberation`, { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          schema: "brewva.deliberation.narrative.v1",
          updatedAt: 42,
          records: [
            {
              id: "narrative-valid-1",
              class: "working_convention",
              title: "Use Bun",
              summary: "Use Bun commands for this repository.",
              content: "Use Bun commands for this repository.",
              applicabilityScope: "agent",
              confidenceScore: 0.92,
              status: "promoted",
              createdAt: 10,
              updatedAt: 20,
              retrievalCount: 3,
              lastRetrievedAt: 21,
              provenance: {
                source: "promotion",
                actor: "operator",
                sessionId: "s-store",
                agentId: "default",
                targetRoots: ["packages/brewva-runtime/src/runtime.ts"],
              },
              evidence: [
                {
                  kind: "event_ref",
                  summary: "Promotion receipt",
                  sessionId: "s-store",
                  timestamp: 12,
                  eventId: "evt-1",
                },
              ],
              promotionTarget: {
                agentId: "default",
                path: `${workspace}/.brewva/agents/default/memory.md`,
                heading: "Stable Memory",
                promotedAt: 22,
              },
            },
            {
              id: "narrative-invalid-1",
              class: "invalid_class",
              title: "Invalid",
              summary: "Invalid",
              content: "Invalid",
              applicabilityScope: "agent",
              confidenceScore: 0.5,
              status: "active",
              createdAt: 1,
              updatedAt: 1,
              retrievalCount: 0,
              provenance: {
                source: "explicit_tool",
                actor: "operator",
                targetRoots: [],
              },
              evidence: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const state = new FileNarrativeMemoryStore(workspace).read();
    expect(state?.records).toHaveLength(1);
    expect(state?.records[0]?.id).toBe("narrative-valid-1");
    expect(state?.records[0]?.promotionTarget?.heading).toBe("Stable Memory");
  });
});
