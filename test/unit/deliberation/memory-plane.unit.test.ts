import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  buildDeliberationMemoryState,
  createDeliberationMemoryContextProvider,
  getOrCreateDeliberationMemoryPlane,
  retrieveDeliberationMemoryArtifacts,
  resolveDeliberationMemoryRetentionSnapshot,
  resolveDeliberationMemoryStatePath,
  type GuardResultRecord,
  type MetricObservationRecord,
  type SessionMemoryInput,
  type SkillCompletionRecord,
  type TaskSpecObservation,
  type VerificationOutcomeRecord,
} from "@brewva/brewva-deliberation";
import {
  BrewvaRuntime,
  CONTEXT_SOURCES,
  type TruthState,
  type WorkflowArtifact,
} from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createWorkflowArtifact(input: {
  artifactId: string;
  sessionId: string;
  kind: WorkflowArtifact["kind"];
  summary: string;
  producedAt: number;
  freshness?: WorkflowArtifact["freshness"];
  state?: WorkflowArtifact["state"];
}): WorkflowArtifact {
  return {
    artifactId: input.artifactId,
    sessionId: input.sessionId,
    kind: input.kind,
    summary: input.summary,
    sourceEventIds: [`event:${input.artifactId}`],
    sourceSkillNames: [],
    outputKeys: [],
    producedAt: input.producedAt,
    freshness: input.freshness ?? "fresh",
    state: input.state ?? "ready",
  };
}

function createTaskSpecObservation(input: {
  sessionId: string;
  eventId: string;
  timestamp: number;
  goal: string;
  verificationLevel?: "quick" | "standard" | "strict";
  verificationCommands?: string[];
  constraints?: string[];
  files?: string[];
}): TaskSpecObservation {
  return {
    sessionId: input.sessionId,
    eventId: input.eventId,
    timestamp: input.timestamp,
    spec: {
      schema: "brewva.task.v1",
      goal: input.goal,
      verification:
        input.verificationLevel || input.verificationCommands
          ? {
              level: input.verificationLevel,
              commands: input.verificationCommands,
            }
          : undefined,
      constraints: input.constraints,
      targets: input.files
        ? {
            files: input.files,
          }
        : undefined,
    },
  };
}

function createMetric(input: {
  sessionId: string;
  eventId: string;
  timestamp: number;
  value: number;
}): MetricObservationRecord {
  return {
    sessionId: input.sessionId,
    eventId: input.eventId,
    timestamp: input.timestamp,
    metricKey: "coverage_pct",
    value: input.value,
    source: "goal-loop:coverage-raise",
    iterationKey: `coverage-raise/run-${input.value}/baseline`,
    evidenceRefs: [],
    summary: `Coverage now ${input.value}`,
  };
}

function createGuard(input: {
  sessionId: string;
  eventId: string;
  timestamp: number;
  status: "pass" | "fail" | "inconclusive" | "skipped";
}): GuardResultRecord {
  return {
    sessionId: input.sessionId,
    eventId: input.eventId,
    timestamp: input.timestamp,
    guardKey: "unit-tests",
    status: input.status,
    source: "goal-loop:coverage-raise",
    iterationKey: "coverage-raise/run-2/iter-1",
    evidenceRefs: [],
    summary: `Unit tests ${input.status}`,
  };
}

function createSkillCompletion(input: {
  sessionId: string;
  eventId: string;
  timestamp: number;
  skillName: string;
}): SkillCompletionRecord {
  return {
    sessionId: input.sessionId,
    eventId: input.eventId,
    timestamp: input.timestamp,
    skillName: input.skillName,
    outputs: {
      improvement_hypothesis: "Verification discipline is a stable leverage point.",
    },
  };
}

function createVerificationOutcome(input: {
  sessionId: string;
  eventId: string;
  timestamp: number;
  outcome: "pass" | "fail" | "skipped";
  failedChecks?: string[];
}): VerificationOutcomeRecord {
  return {
    sessionId: input.sessionId,
    eventId: input.eventId,
    timestamp: input.timestamp,
    outcome: input.outcome,
    level: "strict",
    failedChecks: input.failedChecks ?? [],
    activeSkill: input.outcome === "pass" ? "self-improve" : "goal-loop",
    rootCause: input.outcome === "fail" ? "failed checks: bun-test" : "verification checks passed",
  };
}

function createSessionInput(input: {
  sessionId: string;
  targetRoots?: string[];
  taskSpecs?: TaskSpecObservation[];
  workflowArtifacts?: WorkflowArtifact[];
  metricRecords?: MetricObservationRecord[];
  guardRecords?: GuardResultRecord[];
  skillCompletions?: SkillCompletionRecord[];
  verificationOutcomes?: VerificationOutcomeRecord[];
}): SessionMemoryInput {
  const truthState: TruthState = {
    facts: [],
    updatedAt: null,
  };
  return {
    sessionId: input.sessionId,
    targetRoots: input.targetRoots ?? ["/repo/workspace"],
    events: [],
    workflowArtifacts: input.workflowArtifacts ?? [],
    taskSpecs: input.taskSpecs ?? [],
    truthState,
    metricRecords: input.metricRecords ?? [],
    guardRecords: input.guardRecords ?? [],
    skillCompletions: input.skillCompletions ?? [],
    verificationOutcomes: input.verificationOutcomes ?? [],
  };
}

describe("deliberation memory plane", () => {
  test("refreshes provider collection live and serves artifacts without a prior manual sync", () => {
    const workspace = createTestWorkspace("deliberation-memory-provider");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "deliberation-provider-session";
    const statePath = resolveDeliberationMemoryStatePath(workspace);

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Keep deliberation memory aligned with repository verification discipline.",
      verification: {
        level: "strict",
        commands: ["bun run check", "bun test"],
      },
      constraints: ["no backward compatibility"],
      targets: {
        files: ["packages/brewva-runtime/src/runtime.ts"],
      },
    });

    const provider = createDeliberationMemoryContextProvider({
      runtime,
      maxArtifacts: 3,
      minRefreshIntervalMs: 1,
    });
    const beforeSyncEntries: Array<{ id: string; content: string }> = [];
    provider.collect({
      sessionId,
      promptText: "remember the repository strategy and verification contract",
      register: (entry) => {
        beforeSyncEntries.push(entry);
      },
    });

    expect(provider.source).toBe(CONTEXT_SOURCES.deliberationMemory);
    expect(beforeSyncEntries.length).toBeGreaterThan(0);
    expect(existsSync(statePath)).toBe(true);

    const plane = getOrCreateDeliberationMemoryPlane(runtime, {
      minRefreshIntervalMs: 1,
    });
    plane.sync();

    const afterSyncEntries: Array<{ id: string; content: string }> = [];
    provider.collect({
      sessionId,
      promptText: "remember the repository strategy and verification contract",
      register: (entry) => {
        afterSyncEntries.push(entry);
      },
    });

    expect(existsSync(statePath)).toBe(true);
    expect(afterSyncEntries.length).toBeGreaterThan(0);
    expect(afterSyncEntries[0]?.content).toContain(
      "[DeliberationMemory:repository_strategy_memory:",
    );
    expect(afterSyncEntries[0]?.content).toContain("Repository Working Contract");
  });

  test("prunes cold loop memories and annotates retained artifacts with retention metadata", () => {
    const now = 1_710_200_000_000;
    const sessions = Array.from({ length: 10 }, (_, index) =>
      createSessionInput({
        sessionId: `retention-session-${index}`,
        metricRecords: [
          {
            sessionId: `retention-session-${index}`,
            eventId: `metric-${index}`,
            timestamp: now - index * 45 * 24 * 60 * 60 * 1000,
            metricKey: "failed_checks",
            value: 10 - index,
            source: `goal-loop:retention-loop-${index}`,
            iterationKey: `retention-loop-${index}/run-1/baseline`,
            evidenceRefs: [],
            summary: `Failed checks now ${10 - index}`,
          },
        ],
      }),
    );
    const state = buildDeliberationMemoryState({
      updatedAt: now,
      now,
      sessionDigests: sessions.map((session) => ({
        sessionId: session.sessionId,
        eventCount: session.metricRecords.length,
        lastEventAt: session.metricRecords[0]?.timestamp ?? now,
      })),
      sessions,
    });

    const loopArtifacts = state.artifacts.filter((artifact) => artifact.kind === "loop_memory");
    expect(loopArtifacts.length).toBeLessThanOrEqual(8);
    expect(loopArtifacts.some((artifact) => artifact.id === "loop:retention-loop-0")).toBe(true);
    expect(loopArtifacts.some((artifact) => artifact.id === "loop:retention-loop-9")).toBe(false);
    for (const artifact of loopArtifacts) {
      expect(artifact.metadata?.retention).toBeDefined();
      expect((artifact.metadata?.retention?.retentionScore ?? 0) > 0).toBe(true);
    }
  });

  test("retains loop memories more gently across longer optimization gaps", () => {
    const now = 1_710_200_000_000;
    const retention = resolveDeliberationMemoryRetentionSnapshot({
      now,
      artifact: {
        id: "loop:slow-burn",
        kind: "loop_memory",
        title: "Slow burn optimization memory",
        summary: "A bounded optimization result that should survive moderate idle gaps.",
        content: "Coverage rose after three bounded runs with the same guard.",
        confidenceScore: 0.52,
        firstCapturedAt: now - 200 * 24 * 60 * 60 * 1000,
        lastValidatedAt: now - 150 * 24 * 60 * 60 * 1000,
        applicabilityScope: "loop",
        evidence: [
          {
            sessionId: "slow-burn-session",
            eventId: "metric:1",
            eventType: "iteration_metric_observed",
            timestamp: now - 150 * 24 * 60 * 60 * 1000,
          },
        ],
        sessionIds: ["slow-burn-session"],
        tags: ["coverage", "bounded-optimization"],
      },
    });

    expect(retention.retentionScore).toBeGreaterThan(0.3);
    expect(retention.decayFactor).toBeGreaterThanOrEqual(0.22);
  });

  test("builds repository, user, agent, and loop artifacts from folded session signals", () => {
    const sessions: SessionMemoryInput[] = [
      createSessionInput({
        sessionId: "s1",
        taskSpecs: [
          createTaskSpecObservation({
            sessionId: "s1",
            eventId: "task:1",
            timestamp: 1_000,
            goal: "Implement deliberation home",
            verificationLevel: "strict",
            verificationCommands: ["bun run check", "bun test"],
            constraints: ["no backward compatibility"],
            files: ["packages/brewva-runtime/src/runtime.ts"],
          }),
        ],
        workflowArtifacts: [
          createWorkflowArtifact({
            artifactId: "wf:design:1",
            sessionId: "s1",
            kind: "design",
            summary: "Split deliberation memory into persisted artifacts and retrieval scoring.",
            producedAt: 1_100,
          }),
          createWorkflowArtifact({
            artifactId: "wf:review:1",
            sessionId: "s1",
            kind: "review",
            summary: "Review called out missing decay and home-selection criteria.",
            producedAt: 1_200,
          }),
        ],
        metricRecords: [
          createMetric({
            sessionId: "s1",
            eventId: "metric:1",
            timestamp: 1_300,
            value: 62,
          }),
        ],
        guardRecords: [
          createGuard({
            sessionId: "s1",
            eventId: "guard:1",
            timestamp: 1_350,
            status: "pass",
          }),
        ],
        skillCompletions: [
          createSkillCompletion({
            sessionId: "s1",
            eventId: "skill:1",
            timestamp: 1_400,
            skillName: "self-improve",
          }),
        ],
        verificationOutcomes: [
          createVerificationOutcome({
            sessionId: "s1",
            eventId: "verify:1",
            timestamp: 1_500,
            outcome: "pass",
          }),
        ],
      }),
      createSessionInput({
        sessionId: "s2",
        taskSpecs: [
          createTaskSpecObservation({
            sessionId: "s2",
            eventId: "task:2",
            timestamp: 2_000,
            goal: "Wire deliberation memory into gateway",
            verificationLevel: "strict",
            verificationCommands: ["bun run check", "bun test"],
            constraints: ["no backward compatibility"],
            files: ["packages/brewva-gateway/src/host/create-hosted-session.ts"],
          }),
        ],
        metricRecords: [
          createMetric({
            sessionId: "s2",
            eventId: "metric:2",
            timestamp: 2_100,
            value: 71,
          }),
        ],
        guardRecords: [
          createGuard({
            sessionId: "s2",
            eventId: "guard:2",
            timestamp: 2_150,
            status: "pass",
          }),
        ],
        skillCompletions: [
          createSkillCompletion({
            sessionId: "s2",
            eventId: "skill:2",
            timestamp: 2_200,
            skillName: "goal-loop",
          }),
        ],
        verificationOutcomes: [
          createVerificationOutcome({
            sessionId: "s2",
            eventId: "verify:2",
            timestamp: 2_300,
            outcome: "fail",
            failedChecks: ["bun-test"],
          }),
        ],
      }),
    ];

    const state = buildDeliberationMemoryState({
      updatedAt: 3_000,
      sessionDigests: [
        { sessionId: "s1", eventCount: 10, lastEventAt: 1_500 },
        { sessionId: "s2", eventCount: 12, lastEventAt: 2_300 },
      ],
      sessions,
    });

    expect(state.schema).toBe("brewva.deliberation.memory.v2");
    expect(state.artifacts.some((artifact) => artifact.kind === "repository_strategy_memory")).toBe(
      true,
    );
    expect(state.artifacts.some((artifact) => artifact.kind === "user_collaboration_profile")).toBe(
      true,
    );
    expect(state.artifacts.some((artifact) => artifact.kind === "agent_capability_profile")).toBe(
      true,
    );
    expect(state.artifacts.some((artifact) => artifact.kind === "loop_memory")).toBe(true);

    const repositoryContract = state.artifacts.find(
      (artifact) =>
        artifact.kind === "repository_strategy_memory" &&
        artifact.title === "Repository Working Contract",
    );
    expect(repositoryContract?.content).toContain("bun run check");
    expect(repositoryContract?.content).toContain("no backward compatibility");

    const loopMemory = state.artifacts.find((artifact) => artifact.id === "loop:coverage-raise");
    expect(loopMemory?.summary).toContain("62 -> 71");
    expect(loopMemory?.summary).toContain("unit-tests=pass");
  });

  test("retrieval boosts loop memory when the prompt is loop-specific", () => {
    const state = buildDeliberationMemoryState({
      updatedAt: 4_000,
      sessionDigests: [{ sessionId: "s1", eventCount: 4, lastEventAt: 3_000 }],
      sessions: [
        createSessionInput({
          sessionId: "s1",
          taskSpecs: [
            createTaskSpecObservation({
              sessionId: "s1",
              eventId: "task:1",
              timestamp: 1_000,
              goal: "Keep verification strict",
              verificationLevel: "strict",
              verificationCommands: ["bun run check"],
            }),
          ],
          metricRecords: [
            createMetric({
              sessionId: "s1",
              eventId: "metric:1",
              timestamp: 2_000,
              value: 68,
            }),
            createMetric({
              sessionId: "s1",
              eventId: "metric:2",
              timestamp: 3_000,
              value: 74,
            }),
          ],
          guardRecords: [
            createGuard({
              sessionId: "s1",
              eventId: "guard:1",
              timestamp: 3_100,
              status: "pass",
            }),
          ],
        }),
      ],
    });

    const retrievals = retrieveDeliberationMemoryArtifacts({
      state,
      promptText: "continue the coverage-raise loop and inspect metric guard behavior",
      now: 4_100,
      limit: 3,
    });

    expect(retrievals[0]?.artifact.kind).toBe("loop_memory");
    expect(retrievals[0]?.artifact.id).toBe("loop:coverage-raise");
  });
});
