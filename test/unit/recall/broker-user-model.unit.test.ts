import { describe, expect, test } from "bun:test";
import { RecallBroker } from "@brewva/brewva-recall/broker";
import type { RecallBrokerRuntime } from "@brewva/brewva-recall/broker";
import type {
  FilterSessionIdsByScopeInput,
  ListTapeEventsByTypeInput,
  SessionIndex,
  SessionIndexTapeEvidence,
} from "@brewva/brewva-session-index";
import { USER_FACT_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/user-model";

// Phase 3 of rfc-user-model-as-a-tape-folded-advisory-projection: RecallBroker.userModel()
// folds the cross-session user model from user.fact.recorded events the session index holds.
// This pins the two scope rules in one fold — user facts corroborate across every session
// (a global trait), project facts only within the current repository (so a same-key project
// fact authored in another repo must not collide) — plus the honesty grade that follows from
// genuinely independent sessions. The fake index implements only the two methods userModel()
// touches; filterSessionIdsByScope models the repo->session map a real index derives.

const REPO_A = "/repo/a";
const REPO_B = "/repo/b";
const SESSION_ROOTS: Record<string, string> = { s1: REPO_A, s2: REPO_B, s3: REPO_B };

function userFactEvidence(input: {
  eventId: string;
  sessionId: string;
  scope: "user" | "project";
  factKey: string;
  value: string;
  timestamp: number;
}): SessionIndexTapeEvidence {
  return {
    eventId: input.eventId,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    type: USER_FACT_RECORDED_EVENT_TYPE,
    payload: {
      id: input.eventId,
      scope: input.scope,
      factKey: input.factKey,
      value: input.value,
      grade: "estimated",
      sourceRefs: ["turn:1"],
      reason: "authored from the conversation",
      createdAt: input.timestamp,
    },
    searchText: input.value,
    sourceUri: "",
    sourceSequence: input.timestamp,
    tokenScore: 0,
  };
}

function fakeIndex(evidence: readonly SessionIndexTapeEvidence[]): SessionIndex {
  return {
    dbPath: ":fake-session-index:",
    async listTapeEventsByType(
      input: ListTapeEventsByTypeInput,
    ): Promise<SessionIndexTapeEvidence[]> {
      let rows = evidence.filter((row) => row.type === input.type);
      if (input.sessionIds) {
        const allow = new Set(input.sessionIds);
        rows = rows.filter((row) => allow.has(row.sessionId));
      }
      return rows.toSorted((left, right) => left.timestamp - right.timestamp);
    },
    async filterSessionIdsByScope(input: FilterSessionIdsByScopeInput): Promise<string[]> {
      if (input.scope === "workspace_wide") return [...input.sessionIds];
      const roots = new Set(input.targetRoots);
      return input.sessionIds.filter((id) => roots.has(SESSION_ROOTS[id] ?? ""));
    },
  } as unknown as SessionIndex;
}

function fakeRuntime(): RecallBrokerRuntime {
  return {
    identity: { workspaceRoot: REPO_A, agentId: "agent-test" },
    events: {
      records: {
        listSessionIds: () => [],
        list: () => [],
        subscribe: () => () => {},
      },
    },
    // The current session is rooted in REPO_A, so user_repository_root scopes to REPO_A.
    task: { target: { getDescriptor: () => ({ primaryRoot: REPO_A, roots: [REPO_A] }) } },
    skills: { catalog: undefined },
  } as unknown as RecallBrokerRuntime;
}

describe("RecallBroker.userModel() — cross-session fold", () => {
  test("user facts corroborate across repos; project facts stay repo-scoped", async () => {
    const broker = new RecallBroker(
      fakeRuntime(),
      fakeIndex([
        // A user trait authored in two different repos (s1 in REPO_A, s2 in REPO_B).
        userFactEvidence({
          eventId: "f1",
          sessionId: "s1",
          scope: "user",
          factKey: "style",
          value: "terse",
          timestamp: 1_000,
        }),
        userFactEvidence({
          eventId: "f2",
          sessionId: "s2",
          scope: "user",
          factKey: "style",
          value: "terse",
          timestamp: 2_000,
        }),
        // A project fact with the SAME key but different values in two repos. Only the
        // REPO_A authoring (s1) is in scope for a REPO_A session; the REPO_B one (s3) must
        // not enter the fold and spuriously conflict it to inconclusive.
        userFactEvidence({
          eventId: "f3",
          sessionId: "s1",
          scope: "project",
          factKey: "build",
          value: "bun",
          timestamp: 1_500,
        }),
        userFactEvidence({
          eventId: "f4",
          sessionId: "s3",
          scope: "project",
          factKey: "build",
          value: "cargo",
          timestamp: 2_500,
        }),
      ]),
    );

    const model = await broker.userModel({ sessionId: "current" });

    expect(model.facts.map((fact) => `${fact.scope}/${fact.factKey}`)).toEqual([
      "project/build",
      "user/style",
    ]);
    const userStyle = model.facts.find((fact) => fact.scope === "user");
    expect(userStyle?.value).toBe("terse");
    expect(userStyle?.grade).toBe("measured"); // corroborated across s1 + s2 (two repos)
    const projectBuild = model.facts.find((fact) => fact.scope === "project");
    expect(projectBuild?.value).toBe("bun"); // REPO_B's cargo was scoped out
    expect(projectBuild?.grade).toBe("estimated"); // only s1 in scope, no collision
  });

  test("folds an empty model when no user facts exist", async () => {
    const broker = new RecallBroker(fakeRuntime(), fakeIndex([]));
    const model = await broker.userModel({ sessionId: "current" });
    expect(model.facts).toEqual([]);
  });
});
