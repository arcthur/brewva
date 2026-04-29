import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  classifyOpenQuestion,
  classifyQuestionRequest,
  collectOpenSessionQuestions,
  listOpenQuestionRequests,
  validateQuestionRequestAnswers,
  type SessionQuestionRequest,
} from "../../../packages/brewva-gateway/src/operator-questions.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(workspace);
  return workspace;
}

function writeOutcomeArtifact(
  workspaceRoot: string,
  name: string,
  payload: Record<string, unknown>,
): string {
  const artifactsDir = join(workspaceRoot, ".artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const path = join(artifactsDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}

describe("operator question collection", () => {
  test("rejects invalid structured answer bundles for non-custom single-choice requests", () => {
    const request: SessionQuestionRequest = {
      requestId: "request-1",
      sessionId: "session-1",
      createdAt: Date.now(),
      sourceKind: "skill",
      sourceEventId: "event-1",
      sourceLabel: "skill:plan",
      questions: [
        {
          questionId: "request-1:question:1",
          header: "Deploy",
          questionText: "Proceed with deployment?",
          options: [{ label: "Yes" }, { label: "No" }],
          custom: false,
        },
      ],
    };

    expect(
      validateQuestionRequestAnswers({
        request,
        answers: [["Maybe"]],
      }),
    ).toEqual({
      ok: false,
      error: "Question 1 does not allow custom answer 'Maybe'.",
    });
  });

  test("prefers delegated structured questionRequests over follow-up fallback text", async () => {
    const workspaceRoot = createTempWorkspace("brewva-operator-questions-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const sessionId = "session-structured-questions";
    const runId = "run-structured";

    const artifactPath = writeOutcomeArtifact(workspaceRoot, runId, {
      ok: true,
      runId,
      delegate: "review-boundaries",
      label: "review-boundaries",
      kind: "consult",
      consultKind: "review",
      status: "ok",
      summary: "Structured review questions are available.",
      data: {
        kind: "consult",
        consultKind: "review",
        conclusion: "The lane needs operator clarification before it can clear.",
        lane: "review-boundaries",
        disposition: "inconclusive",
        questionRequests: [
          {
            title: "Release evidence",
            questions: [
              {
                header: "Dist",
                question: "Should this lane wait for a dist smoke result before clearing?",
                options: [{ label: "Yes" }, { label: "No" }],
                custom: false,
              },
            ],
          },
        ],
        followUpQuestions: ["This fallback should stay hidden when structured requests exist."],
      },
      metrics: {
        durationMs: 1,
      },
      evidenceRefs: [],
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_completed",
      payload: {
        runId,
        delegate: "review-boundaries",
        artifactRefs: [
          {
            kind: "delegation_outcome",
            path: artifactPath,
          },
        ],
      },
    });

    const collection = await collectOpenSessionQuestions(runtime, sessionId);
    expect(collection.warnings).toEqual([]);
    expect(collection.questions).toHaveLength(1);
    expect(collection.questions[0]).toMatchObject({
      runId,
      header: "Dist",
      questionText: "Should this lane wait for a dist smoke result before clearing?",
      requestId: `delegation:${runId}:request:1`,
      questionId: `delegation:${runId}:request:1:question:1`,
      custom: false,
    });
  });

  test("falls back to delegated followUpQuestions when no structured request exists", async () => {
    const workspaceRoot = createTempWorkspace("brewva-operator-follow-up-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const sessionId = "session-follow-up-questions";
    const runId = "run-follow-up";

    const artifactPath = writeOutcomeArtifact(workspaceRoot, runId, {
      ok: true,
      runId,
      delegate: "review-performance",
      label: "review-performance",
      kind: "consult",
      consultKind: "review",
      status: "ok",
      summary: "Follow-up review question is available.",
      data: {
        kind: "consult",
        consultKind: "review",
        conclusion: "The lane has one non-blocking follow-up question.",
        lane: "review-performance",
        disposition: "clear",
        followUpQuestions: ["Should we inspect replay throughput after dist smoke passes?"],
      },
      metrics: {
        durationMs: 1,
      },
      evidenceRefs: [],
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_completed",
      payload: {
        runId,
        delegate: "review-performance",
        artifactRefs: [
          {
            kind: "delegation_outcome",
            path: artifactPath,
          },
        ],
      },
    });

    const collection = await collectOpenSessionQuestions(runtime, sessionId);
    expect(collection.warnings).toEqual([]);
    expect(collection.questions).toHaveLength(1);
    expect(collection.questions[0]).toMatchObject({
      runId,
      header: "Question",
      questionText: "Should we inspect replay throughput after dist smoke passes?",
      requestId: `delegation:${runId}:1`,
      questionId: `delegation:${runId}:1`,
      presentationKind: "follow_up",
      custom: true,
    });
  });

  test("falls back to legacy delegated openQuestions when canonical follow-up questions are absent", async () => {
    const workspaceRoot = createTempWorkspace("brewva-operator-legacy-open-questions-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const sessionId = "session-legacy-follow-up";
    const runId = "run-legacy-follow-up";

    const artifactPath = writeOutcomeArtifact(workspaceRoot, runId, {
      ok: true,
      runId,
      delegate: "review-runtime",
      label: "review-runtime",
      kind: "consult",
      consultKind: "review",
      status: "ok",
      summary: "Legacy follow-up question is available.",
      data: {
        kind: "consult",
        consultKind: "review",
        conclusion: "The lane has one legacy follow-up question.",
        openQuestions: ["Should we inspect runtime receipts after the replay pass?"],
      },
      metrics: {
        durationMs: 1,
      },
      evidenceRefs: [],
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_completed",
      payload: {
        runId,
        delegate: "review-runtime",
        artifactRefs: [
          {
            kind: "delegation_outcome",
            path: artifactPath,
          },
        ],
      },
    });

    const collection = await collectOpenSessionQuestions(runtime, sessionId);
    expect(collection.warnings).toEqual([]);
    expect(collection.questions).toHaveLength(1);
    expect(collection.questions[0]).toMatchObject({
      questionText: "Should we inspect runtime receipts after the replay pass?",
      presentationKind: "follow_up",
    });
    expect(classifyOpenQuestion(collection.questions[0]!)).toBe("follow_up");
  });

  test("keeps single custom structured requests classified as input requests", async () => {
    const workspaceRoot = createTempWorkspace("brewva-operator-structured-custom-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const sessionId = "session-structured-custom-request";
    const runId = "run-structured-custom-request";

    const artifactPath = writeOutcomeArtifact(workspaceRoot, runId, {
      ok: true,
      runId,
      delegate: "review-boundaries",
      label: "review-boundaries",
      kind: "consult",
      consultKind: "review",
      status: "ok",
      summary: "Structured custom request should stay in the input-request lane.",
      data: {
        kind: "consult",
        consultKind: "review",
        conclusion: "The lane needs a structured operator answer.",
        questionRequests: [
          {
            questions: [
              {
                header: "Question",
                question: "Which deployment target should the gateway use?",
                options: [],
                custom: true,
              },
            ],
          },
        ],
      },
      metrics: {
        durationMs: 1,
      },
      evidenceRefs: [],
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_completed",
      payload: {
        runId,
        delegate: "review-boundaries",
        artifactRefs: [
          {
            kind: "delegation_outcome",
            path: artifactPath,
          },
        ],
      },
    });

    const collection = await collectOpenSessionQuestions(runtime, sessionId);
    const requests = listOpenQuestionRequests(collection.questions);

    expect(collection.questions).toHaveLength(1);
    expect(collection.questions[0]?.presentationKind).toBe("input_request");
    expect(classifyOpenQuestion(collection.questions[0]!)).toBe("input_request");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.presentationKind).toBe("input_request");
    expect(classifyQuestionRequest(requests[0]!)).toBe("input_request");
  });

  test("drops structured requests that cannot be answered", async () => {
    const workspaceRoot = createTempWorkspace("brewva-operator-invalid-request-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const sessionId = "session-invalid-request";
    const runId = "run-invalid-request";

    const artifactPath = writeOutcomeArtifact(workspaceRoot, runId, {
      ok: true,
      runId,
      delegate: "review-boundaries",
      label: "review-boundaries",
      kind: "consult",
      consultKind: "review",
      status: "ok",
      summary: "Invalid structured request should be ignored.",
      data: {
        kind: "consult",
        consultKind: "review",
        conclusion: "The lane emitted an impossible question definition.",
        lane: "review-boundaries",
        disposition: "inconclusive",
        questionRequests: [
          {
            title: "Broken request",
            questions: [
              {
                header: "Broken",
                question: "This question has no valid answer path.",
                options: [],
                custom: false,
              },
            ],
          },
        ],
      },
      metrics: {
        durationMs: 1,
      },
      evidenceRefs: [],
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_completed",
      payload: {
        runId,
        delegate: "review-boundaries",
        artifactRefs: [
          {
            kind: "delegation_outcome",
            path: artifactPath,
          },
        ],
      },
    });

    const collection = await collectOpenSessionQuestions(runtime, sessionId);
    expect(collection.warnings).toEqual([]);
    expect(collection.questions).toEqual([]);
  });
});
