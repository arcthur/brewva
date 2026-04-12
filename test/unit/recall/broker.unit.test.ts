import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRecallContextProvider,
  getOrCreateRecallBroker,
  RECALL_CURATION_HALFLIFE_DAYS,
} from "@brewva/brewva-recall";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
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
        }),
      ]),
    );
  });
});
