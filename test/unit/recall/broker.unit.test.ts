import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateNarrativeMemoryPlane } from "@brewva/brewva-deliberation";
import {
  createRecallContextProvider,
  getOrCreateRecallBroker,
  RECALL_CURATION_HALFLIFE_DAYS,
} from "@brewva/brewva-recall";
import {
  BrewvaRuntime,
  CONTEXT_INJECTED_EVENT_TYPE,
  PROJECTION_REFRESHED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";

describe("recall broker", () => {
  test("context injection does not create self-reinforcing curation signals", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const priorSessionId = "recall-broker-prior";
    const currentSessionId = "recall-broker-current";

    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Fix gateway bootstrap flake",
      targets: {
        files: ["packages/gateway"],
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.inspect.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-prior-item",
          text: "Fix gateway bootstrap flake",
          status: "todo",
        },
      } as Record<string, unknown>,
    });

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Investigate gateway bootstrap flake",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const provider = createRecallContextProvider({ runtime });
    const injectedIds: string[] = [];
    provider.collect({
      sessionId: currentSessionId,
      promptText: "gateway bootstrap flake",
      register: (entry) => {
        injectedIds.push(entry.id);
      },
    });

    expect(injectedIds.length).toBeGreaterThan(0);
    expect(
      runtime.inspect.events.query(currentSessionId, {
        type: "recall_utility_observed",
      }),
    ).toHaveLength(0);

    const broker = getOrCreateRecallBroker(runtime);
    expect(broker.sync().curation).toHaveLength(0);
  });

  test("excludes recall, context, and projection signals from searchable tape evidence", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const priorSessionId = "recall-broker-noise-prior";
    const currentSessionId = "recall-broker-noise-current";

    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
      payload: {
        source: "context_provider",
        stableIds: ["poisoned gateway recall marker"],
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: CONTEXT_INJECTED_EVENT_TYPE,
      payload: {
        source: "brewva.recall-broker",
        text: "poisoned gateway context marker",
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: PROJECTION_REFRESHED_EVENT_TYPE,
      payload: {
        summary: "poisoned gateway projection marker",
      } as Record<string, unknown>,
    });

    const broker = getOrCreateRecallBroker(runtime);
    const digest = broker.sync().sessionDigests.find((entry) => entry.sessionId === priorSessionId);
    expect(digest).toBeUndefined();

    const result = broker.search({
      sessionId: currentSessionId,
      query: "poisoned gateway marker",
      scope: "workspace_wide",
      limit: 6,
    });

    expect(result.results).toHaveLength(0);
  });

  test("ranks strong runtime evidence above precedent and precedent above weak tape notes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    mkdirSync(join(workspace, "docs", "solutions", "gateway"), { recursive: true });
    writeFileSync(
      join(workspace, "docs", "solutions", "gateway", "authority-ranking.md"),
      [
        "---",
        "title: Authority ranking precedent",
        "tags: [gateway, authority]",
        "---",
        "# Authority ranking precedent",
        "Gamma authority ranking precedent keeps repository guidance above advisory memory.",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const priorSessionId = "recall-broker-ranking-prior";
    const currentSessionId = "recall-broker-ranking-current";
    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Gamma authority ranking runtime evidence",
      targets: {
        files: ["packages/gateway"],
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-ranking-item",
          text: "Gamma authority ranking runtime evidence",
          status: "done",
        },
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "verification_outcome_recorded",
      payload: {
        schema: "brewva.verification.outcome.v1",
        passed: true,
        summary: "Gamma authority ranking verified evidence",
      } as Record<string, unknown>,
    });

    getOrCreateNarrativeMemoryPlane(runtime).addRecord({
      class: "project_context_note",
      title: "Gamma authority ranking advisory memory",
      summary: "Gamma authority ranking advisory memory",
      content: "Gamma authority ranking advisory memory should not outrank repository precedent.",
      applicabilityScope: "repository",
      confidenceScore: 1,
      status: "active",
      retrievalCount: 0,
      provenance: {
        source: "passive_extraction",
        actor: "assistant",
        sessionId: priorSessionId,
        targetRoots: [join(workspace, "packages", "gateway")],
      },
      evidence: [
        {
          kind: "input_excerpt",
          summary: "Gamma authority ranking advisory memory",
          sessionId: priorSessionId,
          timestamp: 1_000,
        },
      ],
    });

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Gamma authority ranking lookup",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const result = getOrCreateRecallBroker(runtime).search({
      sessionId: currentSessionId,
      query: "Gamma authority ranking",
      limit: 6,
    });
    const strongRuntimeIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "tape_evidence" && entry.evidenceStrength === "strong",
    );
    const precedentIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "repository_precedent",
    );
    const weakTapeIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "tape_evidence" && entry.evidenceStrength === "weak",
    );
    const advisoryIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "narrative_memory",
    );

    expect(strongRuntimeIndex).toBeGreaterThanOrEqual(0);
    expect(precedentIndex).toBeGreaterThan(strongRuntimeIndex);
    expect(weakTapeIndex).toBeGreaterThan(precedentIndex);
    expect(advisoryIndex).toBeGreaterThan(precedentIndex);
    expect(result.results[precedentIndex]?.trustLabel).toBe("Repository precedent");
  });

  test("classifies kernel truth and patch receipts as strong runtime evidence", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    mkdirSync(join(workspace, "docs", "solutions", "gateway"), { recursive: true });
    writeFileSync(
      join(workspace, "docs", "solutions", "gateway", "durable-receipts.md"),
      [
        "---",
        "title: Durable receipt precedent",
        "tags: [gateway, receipt]",
        "---",
        "# Durable receipt precedent",
        "Epsilon durable receipt marker belongs to repository precedent.",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const priorSessionId = "recall-broker-strong-receipts-prior";
    const currentSessionId = "recall-broker-strong-receipts-current";

    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Epsilon durable receipt marker",
      targets: {
        files: ["packages/gateway"],
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "truth_event",
      payload: {
        schema: "brewva.truth.ledger.v1",
        summary: "Epsilon durable receipt marker entered kernel truth.",
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "patch_recorded",
      payload: {
        schema: "brewva.patch.recorded.v1",
        summary: "Epsilon durable receipt marker patch was recorded.",
      } as Record<string, unknown>,
    });

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Epsilon durable receipt marker lookup",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const result = getOrCreateRecallBroker(runtime).search({
      sessionId: currentSessionId,
      query: "Epsilon durable receipt marker",
      scope: "workspace_wide",
      intent: "durable_runtime_receipts",
      limit: 8,
    });
    const truthIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "tape_evidence" && entry.title.startsWith("truth_event"),
    );
    const patchIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "tape_evidence" && entry.title.startsWith("patch_recorded"),
    );
    const precedentIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "repository_precedent",
    );

    expect(truthIndex).toBeGreaterThanOrEqual(0);
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(precedentIndex).toBeGreaterThanOrEqual(0);
    expect(result.results[truthIndex]).toEqual(
      expect.objectContaining({
        trustLabel: "Kernel truth",
        evidenceStrength: "strong",
      }),
    );
    expect(result.results[patchIndex]).toEqual(
      expect.objectContaining({
        trustLabel: "Verified evidence",
        evidenceStrength: "strong",
      }),
    );
    expect(truthIndex).toBeLessThan(precedentIndex);
    expect(patchIndex).toBeLessThan(precedentIndex);
  });

  test("current-session intent only boosts tape evidence from the active session", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    mkdirSync(join(workspace, "docs", "solutions", "gateway"), { recursive: true });
    writeFileSync(
      join(workspace, "docs", "solutions", "gateway", "current-session-ranking.md"),
      [
        "---",
        "title: Current session ranking precedent",
        "tags: [gateway, ranking]",
        "---",
        "# Current session ranking precedent",
        "Delta current session ranking marker belongs to repository precedent.",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const priorSessionId = "recall-broker-current-intent-prior";
    const currentSessionId = "recall-broker-current-intent-current";

    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Delta current session ranking marker",
      targets: {
        files: ["packages/gateway"],
      },
    });
    const priorEvent = recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-current-intent-prior-item",
          text: "Delta current session ranking marker",
          status: "done",
        },
      } as Record<string, unknown>,
    });

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Delta current session ranking marker",
      targets: {
        files: ["packages/gateway"],
      },
    });
    const currentEvent = recordRuntimeEvent(runtime, {
      sessionId: currentSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-current-intent-current-item",
          text: "Delta current session ranking marker",
          status: "done",
        },
      } as Record<string, unknown>,
    });

    const result = getOrCreateRecallBroker(runtime).search({
      sessionId: currentSessionId,
      query: "Delta current session ranking marker",
      scope: "workspace_wide",
      intent: "current_session_evidence",
      limit: 8,
    });

    const currentTapeIndex = result.results.findIndex(
      (entry) => entry.stableId === `tape:${currentSessionId}:${currentEvent!.id}`,
    );
    const priorTapeIndex = result.results.findIndex(
      (entry) => entry.stableId === `tape:${priorSessionId}:${priorEvent!.id}`,
    );
    const precedentIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "repository_precedent",
    );

    expect(currentTapeIndex).toBeGreaterThanOrEqual(0);
    expect(priorTapeIndex).toBeGreaterThanOrEqual(0);
    expect(precedentIndex).toBeGreaterThanOrEqual(0);
    expect(currentTapeIndex).toBeLessThan(priorTapeIndex);
    expect(precedentIndex).toBeLessThan(priorTapeIndex);
    expect(result.results[currentTapeIndex]?.rankReasons).toContain(
      "intent:current_session_evidence",
    );
    expect(result.results[priorTapeIndex]?.rankReasons).toContain(
      "intent:current_session_evidence",
    );
  });

  test("context provider passes inferred recall intent into rendered entries and events", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "recall-broker-provider-intent-current";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Inspect current session gateway trace marker",
      targets: {
        files: ["packages/gateway"],
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-provider-intent-item",
          text: "Current session gateway trace marker",
          status: "done",
        },
      } as Record<string, unknown>,
    });

    const provider = createRecallContextProvider({ runtime });
    const injectedContent: string[] = [];
    provider.collect({
      sessionId,
      promptText: "Find current session evidence for gateway trace marker",
      register: (entry) => {
        injectedContent.push(entry.content);
      },
    });

    expect(injectedContent).toEqual(
      expect.arrayContaining([expect.stringContaining("search_intent: current_session_evidence")]),
    );
    expect(
      runtime.inspect.events.query(sessionId, {
        type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            source: "context_provider",
            intent: "current_session_evidence",
          }),
        }),
      ]),
    );
  });

  test("curation aggregates are time-decayed and inspectable by stable id", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const priorSessionId = "recall-broker-decay-prior";
    const currentSessionId = "recall-broker-decay-current";

    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Fix gateway recall regression",
      targets: {
        files: ["packages/gateway"],
      },
    });
    const sourceEvent = recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.inspect.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-decay-item",
          text: "Fix gateway recall regression",
          status: "todo",
        },
      } as Record<string, unknown>,
    });
    expect(sourceEvent).toBeDefined();

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Inspect recall curation for the gateway regression",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const stableId = `tape:${priorSessionId}:${sourceEvent!.id}`;
    recordRuntimeEvent(runtime, {
      sessionId: currentSessionId,
      type: "recall_curation_recorded",
      timestamp: Date.now() - RECALL_CURATION_HALFLIFE_DAYS * 24 * 60 * 60 * 1000 * 2,
      payload: {
        source: "recall_curate",
        signal: "helpful",
        stableIds: [stableId],
      } as Record<string, unknown>,
    });

    const broker = getOrCreateRecallBroker(runtime);
    const curation = broker.sync().curation[0];
    expect(curation?.stableId).toBe(stableId);
    expect(curation?.helpfulSignals).toBe(1);
    expect(curation?.helpfulWeight).toBeLessThan(0.3);

    const inspection = broker.inspectStableIds({
      sessionId: currentSessionId,
      stableIds: [stableId],
      scope: "workspace_wide",
    });
    expect(inspection.unresolvedStableIds).toEqual([]);
    expect(inspection.results).toEqual([
      expect.objectContaining({
        stableId,
        sourceFamily: "tape_evidence",
        trustLabel: "Advisory posture",
        evidenceStrength: "weak",
        curation: expect.objectContaining({
          helpfulSignals: 1,
        }),
      }),
    ]);
    expect(inspection.results[0]?.curation?.scoreAdjustment).toBeGreaterThan(0);
    expect(inspection.results[0]?.curation?.scoreAdjustment).toBeLessThan(0.04);
  });

  test("default repository-root scope still recalls prior nested targets inside the workspace root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const priorSessionId = "recall-broker-scope-prior";
    const currentSessionId = "recall-broker-scope-current";

    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Fix the hosted bootstrap regression",
      targets: {
        files: ["packages/gateway/bootstrap.ts"],
      },
    });
    const priorEvent = recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-scope-item",
          text: "Rebuilt the hosted bootstrap path to remove duplicate startup hooks",
          status: "done",
        },
      } as Record<string, unknown>,
    });
    expect(priorEvent).toBeDefined();

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Trace the latest startup regression",
      targets: {
        files: ["packages/gateway/bootstrap.ts"],
      },
    });

    const broker = getOrCreateRecallBroker(runtime);
    const result = broker.search({
      sessionId: currentSessionId,
      query: "hosted bootstrap duplicate startup hooks",
      limit: 6,
    });

    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableId: `tape:${priorSessionId}:${priorEvent!.id}`,
          sourceFamily: "tape_evidence",
          evidenceStrength: "weak",
        }),
      ]),
    );
  });

  test("compound query tokens do not match unrelated query subtokens", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const priorSessionId = "recall-broker-compound-prior";
    const currentSessionId = "recall-broker-compound-current";

    runtime.maintain.context.onTurnStart(priorSessionId, 1);
    runtime.authority.task.setSpec(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Investigate foo telemetry",
      targets: {
        files: ["packages/gateway"],
      },
    });
    const priorEvent = recordRuntimeEvent(runtime, {
      sessionId: priorSessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-compound-item",
          text: "Review foo telemetry wiring",
          status: "done",
        },
      } as Record<string, unknown>,
    });

    runtime.maintain.context.onTurnStart(currentSessionId, 1);
    runtime.authority.task.setSpec(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Search for foo-bar telemetry",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const broker = getOrCreateRecallBroker(runtime);
    const result = broker.search({
      sessionId: currentSessionId,
      query: "foo-bar",
      limit: 6,
    });

    expect(result.results).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableId: `tape:${priorSessionId}:${priorEvent!.id}`,
          sourceFamily: "tape_evidence",
        }),
      ]),
    );
  });
});
