import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  buildUserFactEntry,
  buildUserModelProjection,
  parseUserFactEvent,
  USER_FACT_RECORDED_EVENT_TYPE,
  type UserFactEntry,
  type UserFactGrade,
  type UserFactScope,
} from "@brewva/brewva-vocabulary/user-model";

const BASE_AT = 1_700_000_000_000;

function userFactEvent(
  id: string,
  input: {
    scope: UserFactScope;
    factKey: string;
    value: string;
    grade?: UserFactGrade;
    supersedesId?: string;
    createdAt?: number;
    sessionId?: string;
  },
): BrewvaEventRecord {
  const createdAt = input.createdAt ?? BASE_AT;
  const payload: UserFactEntry = {
    id,
    scope: input.scope,
    factKey: input.factKey,
    value: input.value,
    grade: input.grade ?? "estimated",
    sourceRefs: ["turn:1"],
    reason: "authored from the conversation",
    ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
    createdAt,
  };
  return {
    id: `evt-${id}`,
    sessionId: input.sessionId ?? "session-1",
    type: USER_FACT_RECORDED_EVENT_TYPE,
    timestamp: createdAt,
    payload,
  };
}

describe("parseUserFactEvent", () => {
  test("accepts a well-formed user_fact payload", () => {
    const event = userFactEvent("f1", { scope: "user", factKey: "style", value: "terse" });
    expect(parseUserFactEvent(event)?.factKey).toBe("style");
  });

  test("rejects a malformed payload, an unknown scope, or an unknown grade", () => {
    expect(
      parseUserFactEvent({
        ...userFactEvent("f1", { scope: "user", factKey: "s", value: "v" }),
        payload: { id: "x" },
      }),
    ).toBe(null);
    expect(
      parseUserFactEvent({
        id: "e",
        sessionId: "s",
        type: USER_FACT_RECORDED_EVENT_TYPE,
        timestamp: BASE_AT,
        payload: {
          id: "f",
          scope: "global",
          factKey: "s",
          value: "v",
          grade: "estimated",
          reason: "r",
          sourceRefs: [],
          createdAt: BASE_AT,
        },
      }),
    ).toBe(null);
    expect(
      parseUserFactEvent({
        id: "e",
        sessionId: "s",
        type: USER_FACT_RECORDED_EVENT_TYPE,
        timestamp: BASE_AT,
        payload: {
          id: "f",
          scope: "user",
          factKey: "s",
          value: "v",
          grade: "certain",
          reason: "r",
          sourceRefs: [],
          createdAt: BASE_AT,
        },
      }),
    ).toBe(null);
  });
});

describe("buildUserFactEntry", () => {
  test("assigns the estimated grade, copies fields, and keeps an explicit supersedesId", () => {
    const entry = buildUserFactEntry(
      {
        scope: "project",
        factKey: "build_tool",
        value: "bun",
        reason: "used throughout",
        sourceRefs: ["turn:2"],
        supersedesId: "fact-1",
      },
      { id: "fact-2", createdAt: BASE_AT },
    );
    expect(entry).toMatchObject({
      id: "fact-2",
      scope: "project",
      factKey: "build_tool",
      value: "bun",
      grade: "estimated", // system-assigned, never a parameter
      reason: "used throughout",
      sourceRefs: ["turn:2"],
      supersedesId: "fact-1",
      createdAt: BASE_AT,
    });
  });

  test("omits supersedesId and defaults sourceRefs to empty when absent", () => {
    const entry = buildUserFactEntry(
      { scope: "user", factKey: "k", value: "v", reason: "r" },
      { id: "fact-1", createdAt: 1 },
    );
    expect(entry.supersedesId).toBe(undefined);
    expect(entry.sourceRefs).toEqual([]);
  });
});

describe("buildUserModelProjection", () => {
  test("folds nothing into an empty, schema-versioned projection", () => {
    const projection = buildUserModelProjection([]);
    expect(projection.schema).toBe("brewva.user-model.projection.v1");
    expect(projection.version).toBe(1);
    expect(projection.facts).toEqual([]);
  });

  test("ignores non-user_fact events", () => {
    const projection = buildUserModelProjection([
      { id: "e", sessionId: "s", type: "turn.ended", timestamp: BASE_AT, payload: {} },
      userFactEvent("f1", { scope: "user", factKey: "style", value: "terse" }),
    ]);
    expect(projection.facts.length).toBe(1);
    expect(projection.facts[0]?.value).toBe("terse");
  });

  test("latest-wins per (scope, factKey), retaining the supersession chain oldest-first", () => {
    const projection = buildUserModelProjection([
      userFactEvent("f1", { scope: "user", factKey: "style", value: "terse", createdAt: BASE_AT }),
      userFactEvent("f2", {
        scope: "user",
        factKey: "style",
        value: "verbose",
        createdAt: BASE_AT + 1_000,
      }),
      userFactEvent("f3", {
        scope: "user",
        factKey: "style",
        value: "balanced",
        createdAt: BASE_AT + 2_000,
      }),
    ]);
    expect(projection.facts.length).toBe(1);
    const fact = projection.facts[0];
    expect(fact?.value).toBe("balanced"); // latest wins
    expect(fact?.entryId).toBe("f3");
    expect(fact?.supersededEntryIds).toEqual(["f1", "f2"]); // retained, oldest first
    expect(fact?.createdAt).toBe(BASE_AT); // first authorship preserved
    expect(fact?.updatedAt).toBe(BASE_AT + 2_000); // latest authorship
  });

  test("keys distinctly by scope: the same factKey under user vs project are separate facts", () => {
    const projection = buildUserModelProjection([
      userFactEvent("f1", { scope: "user", factKey: "verbosity", value: "low" }),
      userFactEvent("f2", { scope: "project", factKey: "verbosity", value: "high" }),
    ]);
    expect(projection.facts.length).toBe(2);
    expect(projection.facts.map((fact) => `${fact.scope}:${fact.value}`)).toEqual([
      "project:high",
      "user:low",
    ]);
  });

  test("rebuilds identically from the same events and sorts facts by (scope, factKey)", () => {
    const events = [
      userFactEvent("f1", { scope: "user", factKey: "b_key", value: "1" }),
      userFactEvent("f2", { scope: "user", factKey: "a_key", value: "2" }),
      userFactEvent("f3", { scope: "project", factKey: "a_key", value: "3" }),
    ];
    const forward = buildUserModelProjection(events);
    const rebuilt = buildUserModelProjection([...events]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(rebuilt));
    // Output is sorted by (scope, factKey): project a_key, user a_key, user b_key.
    expect(forward.facts.map((fact) => `${fact.scope} ${fact.factKey}`)).toEqual([
      "project a_key",
      "user a_key",
      "user b_key",
    ]);
  });

  test("latest-wins follows INPUT order — the caller must pass events in tape order", () => {
    const a = userFactEvent("fa", {
      scope: "user",
      factKey: "style",
      value: "terse",
      createdAt: BASE_AT,
    });
    const b = userFactEvent("fb", {
      scope: "user",
      factKey: "style",
      value: "verbose",
      createdAt: BASE_AT + 1_000,
    });
    // The fold is order-DEPENDENT: the last event for a key wins by input position, not by
    // timestamp. Reordering the same events flips the current value — which is why the
    // production caller (the session index) must pass them in tape (append) order.
    expect(buildUserModelProjection([a, b]).facts[0]?.value).toBe("verbose");
    expect(buildUserModelProjection([b, a]).facts[0]?.value).toBe("terse");
  });
});

describe("buildUserModelProjection cross-session grade", () => {
  test("grades a single-session fact estimated (the honest floor)", () => {
    const projection = buildUserModelProjection([
      userFactEvent("f1", { scope: "user", factKey: "style", value: "terse", sessionId: "s1" }),
    ]);
    expect(projection.facts[0]?.grade).toBe("estimated");
  });

  test("promotes to measured when >=2 distinct sessions author the same value", () => {
    const projection = buildUserModelProjection([
      userFactEvent("f1", {
        scope: "user",
        factKey: "style",
        value: "terse",
        sessionId: "s1",
        createdAt: BASE_AT,
      }),
      userFactEvent("f2", {
        scope: "user",
        factKey: "style",
        value: "terse",
        sessionId: "s2",
        createdAt: BASE_AT + 1_000,
      }),
    ]);
    expect(projection.facts[0]?.value).toBe("terse");
    expect(projection.facts[0]?.grade).toBe("measured");
  });

  test("a fact restated in the same session stays estimated, never promoted", () => {
    const projection = buildUserModelProjection([
      userFactEvent("f1", {
        scope: "user",
        factKey: "style",
        value: "terse",
        sessionId: "s1",
        createdAt: BASE_AT,
      }),
      userFactEvent("f2", {
        scope: "user",
        factKey: "style",
        value: "terse",
        sessionId: "s1",
        createdAt: BASE_AT + 1_000,
      }),
    ]);
    // One session repeating itself is not cross-session corroboration.
    expect(projection.facts[0]?.grade).toBe("estimated");
  });

  test("grades a conflicting, uncorroborated current value inconclusive", () => {
    const projection = buildUserModelProjection([
      userFactEvent("f1", {
        scope: "user",
        factKey: "style",
        value: "terse",
        sessionId: "s1",
        createdAt: BASE_AT,
      }),
      userFactEvent("f2", {
        scope: "user",
        factKey: "style",
        value: "verbose",
        sessionId: "s2",
        createdAt: BASE_AT + 1_000,
      }),
    ]);
    expect(projection.facts[0]?.value).toBe("verbose"); // latest wins
    expect(projection.facts[0]?.grade).toBe("inconclusive"); // two sessions disagree
  });

  test("grades measured when the current value is corroborated despite an intervening dissent", () => {
    const projection = buildUserModelProjection([
      userFactEvent("f1", {
        scope: "user",
        factKey: "style",
        value: "terse",
        sessionId: "s1",
        createdAt: BASE_AT,
      }),
      userFactEvent("f2", {
        scope: "user",
        factKey: "style",
        value: "verbose",
        sessionId: "s2",
        createdAt: BASE_AT + 1_000,
      }),
      userFactEvent("f3", {
        scope: "user",
        factKey: "style",
        value: "terse",
        sessionId: "s3",
        createdAt: BASE_AT + 2_000,
      }),
    ]);
    expect(projection.facts[0]?.value).toBe("terse"); // latest wins, corroborated by s1
    expect(projection.facts[0]?.grade).toBe("measured"); // terse authored by s1 + s3
  });
});
