import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  deriveAppliedPatchSetIds,
  ROLLBACK_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";

function event(input: {
  readonly id: string;
  readonly type: string;
  readonly timestamp: number;
  readonly payload: Record<string, unknown>;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: "session-workbench-applied-patch-sets",
    type: input.type,
    timestamp: input.timestamp,
    payload: input.payload,
  };
}

describe("deriveAppliedPatchSetIds", () => {
  test("returns an empty array over an empty tape", () => {
    expect(deriveAppliedPatchSetIds([])).toEqual([]);
  });

  test("collects patchSetIds from ok=true applied events, in tape order", () => {
    const events = [
      event({
        id: "e1",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
      event({
        id: "e2",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 200,
        payload: { ok: true, patchSetId: "ps-2" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual(["ps-1", "ps-2"]);
  });

  test("ignores applied events with ok=false (a failed apply committed no patch set)", () => {
    const events = [
      event({
        id: "e1",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: false, patchSetId: "ps-1" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual([]);
  });

  test("ignores applied events missing a patchSetId", () => {
    const events = [
      event({
        id: "e1",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: true },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual([]);
  });

  test("a successful rollback (ok=true) removes its patchSetId from the applied set", () => {
    const events = [
      event({
        id: "e1",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
      event({
        id: "e2",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 200,
        payload: { ok: true, patchSetId: "ps-2" },
      }),
      event({
        id: "e3",
        type: ROLLBACK_EVENT_TYPE,
        timestamp: 300,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual(["ps-2"]);
  });

  test("a FAILED rollback (ok=false) never removed the files, so the patch set stays applied", () => {
    const events = [
      event({
        id: "e1",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
      event({
        id: "e2",
        type: ROLLBACK_EVENT_TYPE,
        timestamp: 200,
        payload: { ok: false, patchSetId: "ps-1", reason: "rollback_artifact_missing" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual(["ps-1"]);
  });

  test("a rollback with no ok field at all is treated the same as ok=false (never honored)", () => {
    const events = [
      event({
        id: "e1",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
      event({
        id: "e2",
        type: ROLLBACK_EVENT_TYPE,
        timestamp: 200,
        payload: { patchSetId: "ps-1" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual(["ps-1"]);
  });

  test("a successful rollback for a patch set never applied is a no-op", () => {
    const events = [
      event({
        id: "e1",
        type: ROLLBACK_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: true, patchSetId: "ps-never-applied" },
      }),
      event({
        id: "e2",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 200,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual(["ps-1"]);
  });

  test("re-applying a successfully rolled-back patch set restores it", () => {
    const events = [
      event({
        id: "e1",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
      event({
        id: "e2",
        type: ROLLBACK_EVENT_TYPE,
        timestamp: 200,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
      event({
        id: "e3",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 300,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual(["ps-1"]);
  });

  test("a duplicate applied event for the same patchSetId is not double-counted", () => {
    const events = [
      event({
        id: "e1",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 100,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
      event({
        id: "e2",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 200,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual(["ps-1"]);
  });

  test("ignores unrelated event types entirely", () => {
    const events = [
      event({ id: "e1", type: "turn.started", timestamp: 100, payload: {} }),
      event({
        id: "e2",
        type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
        timestamp: 200,
        payload: { ok: true, patchSetId: "ps-1" },
      }),
    ];
    expect(deriveAppliedPatchSetIds(events)).toEqual(["ps-1"]);
  });
});
