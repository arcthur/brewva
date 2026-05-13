import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECALL_CURATION_HALFLIFE_DAYS } from "@brewva/brewva-recall";
import { getOrCreateRecallBroker, type RecallBrokerRuntime } from "@brewva/brewva-recall/broker";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import {
  CONTEXT_COMPOSED_EVENT_TYPE,
  PROJECTION_REFRESHED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import {
  buildToolResultRecordedPayload,
  buildVerificationOutcomeRecordedPayload,
} from "../../helpers/events.js";

describe("recall broker", () => {
  test("excludes recall, context, and projection signals from searchable tape evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const priorSessionId = "recall-broker-noise-prior";
    const currentSessionId = "recall-broker-noise-current";

    runtime.extensions.hosted.events.record({
      sessionId: priorSessionId,
      type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
      payload: {
        source: "context_provider",
        stableIds: ["poisoned gateway recall marker"],
      } as Record<string, unknown>,
    });
    runtime.extensions.hosted.events.record({
      sessionId: priorSessionId,
      type: CONTEXT_COMPOSED_EVENT_TYPE,
      payload: {
        source: "brewva-workbench-context",
        text: "poisoned gateway context marker",
      } as Record<string, unknown>,
    });
    runtime.extensions.hosted.events.record({
      sessionId: priorSessionId,
      type: PROJECTION_REFRESHED_EVENT_TYPE,
      payload: {
        summary: "poisoned gateway projection marker",
      } as Record<string, unknown>,
    });

    const broker = getOrCreateRecallBroker(runtime);
    const digest = (await broker.sync()).sessionDigests.find(
      (entry) => entry.sessionId === priorSessionId,
    );
    expect(digest).toBeUndefined();

    const result = await broker.search({
      sessionId: currentSessionId,
      query: "poisoned gateway marker",
      scope: "workspace_wide",
      limit: 6,
    });

    expect(result.results).toHaveLength(0);
  });

  test("ranks strong runtime evidence above precedent and precedent above weak tape notes", async () => {
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

    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const priorSessionId = "recall-broker-ranking-prior";
    const currentSessionId = "recall-broker-ranking-current";
    runtime.operator.context.lifecycle.onTurnStart(priorSessionId, 1);
    runtime.authority.task.spec.set(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Gamma authority ranking runtime evidence",
      targets: {
        files: ["packages/gateway"],
      },
    });
    runtime.extensions.hosted.events.record({
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
    runtime.extensions.hosted.events.record({
      sessionId: priorSessionId,
      type: "verification_outcome_recorded",
      payload: buildVerificationOutcomeRecordedPayload({
        evidence: "Gamma authority ranking verified evidence",
      }),
    });

    runtime.operator.context.lifecycle.onTurnStart(currentSessionId, 1);
    runtime.authority.task.spec.set(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Gamma authority ranking lookup",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const result = await getOrCreateRecallBroker(runtime).search({
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

    expect(strongRuntimeIndex).toBeGreaterThanOrEqual(0);
    expect(precedentIndex).toBeGreaterThan(strongRuntimeIndex);
    expect(weakTapeIndex).toBeGreaterThan(precedentIndex);
    expect(result.results[precedentIndex]?.trustLabel).toBe("Repository precedent");
  });

  test("classifies kernel claim and patch receipts as strong runtime evidence", async () => {
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

    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const priorSessionId = "recall-broker-strong-receipts-prior";
    const currentSessionId = "recall-broker-strong-receipts-current";

    runtime.operator.context.lifecycle.onTurnStart(priorSessionId, 1);
    runtime.authority.task.spec.set(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Epsilon durable receipt marker",
      targets: {
        files: ["packages/gateway"],
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId: priorSessionId,
      type: "claim_event",
      payload: {
        schema: "brewva.claim.ledger.v1",
        summary: "Epsilon durable receipt marker entered kernel claim.",
      } as Record<string, unknown>,
    });
    runtime.extensions.hosted.events.record({
      sessionId: priorSessionId,
      type: "patch_recorded",
      payload: {
        schema: "brewva.patch.recorded.v1",
        summary: "Epsilon durable receipt marker patch was recorded.",
      } as Record<string, unknown>,
    });

    runtime.operator.context.lifecycle.onTurnStart(currentSessionId, 1);
    runtime.authority.task.spec.set(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Epsilon durable receipt marker lookup",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const result = await getOrCreateRecallBroker(runtime).search({
      sessionId: currentSessionId,
      query: "Epsilon durable receipt marker",
      scope: "workspace_wide",
      intent: "durable_runtime_receipts",
      limit: 8,
    });
    const claimIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "tape_evidence" && entry.title.startsWith("claim_event"),
    );
    const patchIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "tape_evidence" && entry.title.startsWith("patch_recorded"),
    );
    const precedentIndex = result.results.findIndex(
      (entry) => entry.sourceFamily === "repository_precedent",
    );

    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(precedentIndex).toBeGreaterThanOrEqual(0);
    expect(result.results[claimIndex]).toEqual(
      expect.objectContaining({
        trustLabel: "Kernel claim",
        evidenceStrength: "strong",
      }),
    );
    expect(result.results[patchIndex]).toEqual(
      expect.objectContaining({
        trustLabel: "Verified evidence",
        evidenceStrength: "strong",
      }),
    );
    expect(claimIndex).toBeLessThan(precedentIndex);
    expect(patchIndex).toBeLessThan(precedentIndex);
  });

  test("current-session intent only boosts tape evidence from the active session", async () => {
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

    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const priorSessionId = "recall-broker-current-intent-prior";
    const currentSessionId = "recall-broker-current-intent-current";

    runtime.operator.context.lifecycle.onTurnStart(priorSessionId, 1);
    runtime.authority.task.spec.set(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Delta current session ranking marker",
      targets: {
        files: ["packages/gateway"],
      },
    });
    const priorEvent = runtime.extensions.hosted.events.record({
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

    runtime.operator.context.lifecycle.onTurnStart(currentSessionId, 1);
    runtime.authority.task.spec.set(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Delta current session ranking marker",
      targets: {
        files: ["packages/gateway"],
      },
    });
    const currentEvent = runtime.extensions.hosted.events.record({
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

    const result = await getOrCreateRecallBroker(runtime).search({
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

  test("curation aggregates are time-decayed and inspectable by stable id", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const priorSessionId = "recall-broker-decay-prior";
    const currentSessionId = "recall-broker-decay-current";

    runtime.operator.context.lifecycle.onTurnStart(priorSessionId, 1);
    runtime.authority.task.spec.set(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Fix gateway recall regression",
      targets: {
        files: ["packages/gateway"],
      },
    });
    const sourceEvent = runtime.extensions.hosted.events.record({
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

    runtime.operator.context.lifecycle.onTurnStart(currentSessionId, 1);
    runtime.authority.task.spec.set(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Inspect recall curation for the gateway regression",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const stableId = `tape:${priorSessionId}:${sourceEvent!.id}`;
    runtime.extensions.hosted.events.record({
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
    const curation = (await broker.sync()).curation[0];
    expect(curation?.stableId).toBe(stableId);
    expect(curation?.helpfulSignals).toBe(1);
    expect(curation?.helpfulWeight).toBeLessThan(0.3);

    const inspection = await broker.inspectStableIds({
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

  test("default repository-root scope still recalls prior nested targets inside the workspace root", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const priorSessionId = "recall-broker-scope-prior";
    const currentSessionId = "recall-broker-scope-current";

    runtime.operator.context.lifecycle.onTurnStart(priorSessionId, 1);
    runtime.authority.task.spec.set(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Fix the hosted bootstrap regression",
      targets: {
        files: ["packages/gateway/bootstrap.ts"],
      },
    });
    const priorEvent = runtime.extensions.hosted.events.record({
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

    runtime.operator.context.lifecycle.onTurnStart(currentSessionId, 1);
    runtime.authority.task.spec.set(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Trace the latest startup regression",
      targets: {
        files: ["packages/gateway/bootstrap.ts"],
      },
    });

    const broker = getOrCreateRecallBroker(runtime);
    const result = await broker.search({
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

  test("recalls tape evidence from long sessions even when the match is beyond digest snippets", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const priorSessionId = "recall-broker-long-session-prior";
    const currentSessionId = "recall-broker-long-session-current";

    runtime.operator.context.lifecycle.onTurnStart(priorSessionId, 1);
    runtime.authority.task.spec.set(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Run a long generic maintenance session",
      targets: {
        files: ["packages/gateway"],
      },
    });

    let lateEvent: BrewvaEventRecord | undefined;
    for (let index = 0; index < 25; index += 1) {
      const event = runtime.extensions.hosted.events.record({
        sessionId: priorSessionId,
        type: "tool_result_recorded",
        payload: buildToolResultRecordedPayload({
          outputText:
            index === 24
              ? "rareanchor durable indexed receipt"
              : `generic maintenance output ${index}`,
        }),
      });
      if (index === 24) {
        lateEvent = event;
      }
    }
    expect(lateEvent).toBeDefined();

    runtime.operator.context.lifecycle.onTurnStart(currentSessionId, 1);
    runtime.authority.task.spec.set(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Find rare indexed receipt evidence",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const result = await getOrCreateRecallBroker(runtime).search({
      sessionId: currentSessionId,
      query: "rareanchor durable indexed receipt",
      scope: "workspace_wide",
      limit: 8,
    });

    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableId: `tape:${priorSessionId}:${lateEvent!.id}`,
          sourceFamily: "tape_evidence",
        }),
      ]),
    );
  });

  test("recall result surfaced events do not invalidate broker state", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const sessionId = "recall-broker-dirty-current";

    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    runtime.authority.task.spec.set(sessionId, {
      schema: "brewva.task.v1",
      goal: "Track broker dirty invalidation",
      targets: {
        files: ["packages/gateway"],
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "task_event",
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "item_added",
        item: {
          id: "recall-dirty-item",
          text: "Track broker dirty invalidation",
          status: "done",
        },
      } as Record<string, unknown>,
    });

    let listSessionIdsCalls = 0;
    const brokerRuntime: RecallBrokerRuntime = {
      identity: runtime.identity,
      inspect: {
        events: {
          ...runtime.inspect.events,
          log: {
            ...runtime.inspect.events.log,
            listSessionIds() {
              listSessionIdsCalls += 1;
              return runtime.inspect.events.log.listSessionIds();
            },
          },
        },
        task: runtime.inspect.task,
        skills: runtime.inspect.skills,
      },
    };
    const broker = getOrCreateRecallBroker(brokerRuntime);
    await broker.sync();
    const afterInitialSync = listSessionIdsCalls;

    runtime.extensions.hosted.events.record({
      sessionId,
      type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
      payload: {
        source: "recall_search",
        stableIds: ["tape:example:result"],
      } as Record<string, unknown>,
    });
    await broker.sync();
    expect(listSessionIdsCalls).toBe(afterInitialSync);

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "recall_curation_recorded",
      payload: {
        source: "recall_curate",
        signal: "helpful",
        stableIds: ["tape:example:result"],
      } as Record<string, unknown>,
    });
    await broker.sync();
    expect(listSessionIdsCalls).toBeGreaterThan(afterInitialSync);
  });

  test("compound query tokens do not match unrelated query subtokens", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-broker-"));
    mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const priorSessionId = "recall-broker-compound-prior";
    const currentSessionId = "recall-broker-compound-current";

    runtime.operator.context.lifecycle.onTurnStart(priorSessionId, 1);
    runtime.authority.task.spec.set(priorSessionId, {
      schema: "brewva.task.v1",
      goal: "Investigate foo telemetry",
      targets: {
        files: ["packages/gateway"],
      },
    });
    const priorEvent = runtime.extensions.hosted.events.record({
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

    runtime.operator.context.lifecycle.onTurnStart(currentSessionId, 1);
    runtime.authority.task.spec.set(currentSessionId, {
      schema: "brewva.task.v1",
      goal: "Search for foo-bar telemetry",
      targets: {
        files: ["packages/gateway"],
      },
    });

    const broker = getOrCreateRecallBroker(runtime);
    const result = await broker.search({
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
