import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { OPERATOR_QUESTION_ANSWERED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaQueuedPromptView,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate/session";
import {
  createOperatorSurfacePort,
  createSessionViewPort,
} from "../../../packages/brewva-cli/src/shell/adapters/ports.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/types.js";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.js";
import type { StoredSessionMessage } from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/runtime-session-transcript.js";
import {
  buildOperatorQuestionAnsweredPayload,
  flattenQuestionRequest,
  resolveOpenSessionQuestionRequest,
} from "../../../packages/brewva-gateway/src/ingress/internal/operator-questions.js";

function writeDelegationOutcomeArtifact(
  workspaceRoot: string,
  runId: string,
  payload: Record<string, unknown>,
): string {
  const artifactsDir = join(workspaceRoot, ".artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const path = join(artifactsDir, `${runId}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}

describe("cli shell session port", () => {
  test("exposes the current session lineage status", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-shell-port-lineage-")),
    });
    const sessionId = "shell-port-lineage-session";
    runtime.authority.session.createLineageNode(sessionId, {
      lineageNodeId: "lineage:main",
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
    });
    runtime.authority.session.createLineageNode(sessionId, {
      lineageNodeId: "lineage:review",
      parentLineageNodeId: "lineage:main",
      kind: "review",
      forkPoint: { kind: "turn", turnId: "turn-review" },
      title: "Review branch",
    });

    const session = {
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
      },
      thinkingLevel: "high",
      isStreaming: false,
      sessionManager: {
        getSessionId() {
          return sessionId;
        },
        getLineageNodeId() {
          return "lineage:review";
        },
        buildSessionContext() {
          return { messages: [] };
        },
      },
      subscribe() {
        return () => undefined;
      },
      async prompt() {},
      async waitForIdle() {},
      async abort() {},
      dispose() {},
      getQueuedPrompts() {
        return [];
      },
      removeQueuedPrompt() {
        return false;
      },
      getRegisteredTools() {
        return [];
      },
    };

    const port = createSessionViewPort({
      session,
      runtime,
      toolDefinitions: new Map(),
    } as unknown as CliShellSessionBundle);

    expect(port.getLineageStatus()).toEqual({
      lineageNodeId: "lineage:review",
      kind: "review",
      title: "Review branch",
      childCount: 0,
      nodeCount: 2,
      unsupportedReason: null,
    });
  });

  test("checks out lineage through the session port and records channel selection", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-shell-port-lineage-checkout-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "shell-port-lineage-checkout-session";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);
    const mainEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main checkpoint" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.branch(mainEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "experiment branch" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);

    const replacedMessages: unknown[][] = [];
    const session = {
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
      },
      thinkingLevel: "high",
      isStreaming: false,
      sessionManager: store,
      async replaceMessages(messages: unknown[]) {
        replacedMessages.push(messages);
      },
      subscribe() {
        return () => undefined;
      },
      async prompt() {},
      async waitForIdle() {},
      async abort() {},
      dispose() {},
      getQueuedPrompts() {
        return [];
      },
      removeQueuedPrompt() {
        return false;
      },
      getRegisteredTools() {
        return [];
      },
    };

    const port = createSessionViewPort({
      session,
      runtime,
      toolDefinitions: new Map(),
    } as unknown as CliShellSessionBundle);

    expect(port.getLineageTree().nodes.map((node) => node.lineageNodeId)).toContain("lineage:main");

    await port.checkoutLineageNode({
      lineageNodeId: "lineage:main",
      leafEntryId: mainEntryId,
      channelId: "cli",
    });

    expect(store.getLineageNodeId()).toBe("lineage:main");
    expect(runtime.inspect.session.getLineageTree(sessionId).selectedByChannel.cli).toBe(
      "lineage:main",
    );
    expect(JSON.stringify(replacedMessages.at(-1))).toContain("main checkpoint");
    expect(JSON.stringify(replacedMessages.at(-1))).not.toContain("experiment branch");
  });

  test("records lineage selection only after transcript replacement succeeds", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-shell-port-lineage-checkout-failure-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "shell-port-lineage-checkout-failure-session";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);
    const mainEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main checkpoint" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.branch(mainEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "experiment branch" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);
    const previousLineageNodeId = store.getLineageNodeId();
    const previousLeafEntryId = store.getLeafId();

    const session = {
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
      },
      thinkingLevel: "high",
      isStreaming: false,
      sessionManager: store,
      async replaceMessages() {
        throw new Error("replace failed");
      },
      subscribe() {
        return () => undefined;
      },
      async prompt() {},
      async waitForIdle() {},
      async abort() {},
      dispose() {},
      getQueuedPrompts() {
        return [];
      },
      removeQueuedPrompt() {
        return false;
      },
      getRegisteredTools() {
        return [];
      },
    };

    const port = createSessionViewPort({
      session,
      runtime,
      toolDefinitions: new Map(),
    } as unknown as CliShellSessionBundle);

    let caughtError: unknown;
    try {
      await port.checkoutLineageNode({
        lineageNodeId: "lineage:main",
        leafEntryId: mainEntryId,
        channelId: "cli",
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toEqual(expect.objectContaining({ message: "replace failed" }));
    expect(runtime.inspect.session.getLineageTree(sessionId).selectedByChannel.cli).toBeUndefined();
    expect(store.getLineageNodeId()).toBe(previousLineageNodeId);
    expect(store.getLeafId()).toBe(previousLeafEntryId);
  });

  test("routes non-streaming interactive prompts through the hosted thread loop", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-shell-port-")),
    });
    const sentMessages: string[] = [];
    const queuedPrompts: BrewvaQueuedPromptView[] = [
      {
        promptId: "queued-1",
        text: "queued hello",
        submittedAt: 10,
        behavior: "queue",
      },
    ];
    let listener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
    const session = {
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
      },
      thinkingLevel: "high",
      isStreaming: false,
      sessionManager: {
        getSessionId() {
          return "shell-port-session";
        },
        buildSessionContext() {
          return { messages: [] };
        },
      },
      subscribe(next: (event: BrewvaPromptSessionEvent) => void) {
        listener = next;
        return () => {
          if (listener === next) {
            listener = undefined;
          }
        };
      },
      async prompt(parts: readonly BrewvaPromptContentPart[]) {
        const prompt = buildBrewvaPromptText(parts);
        sentMessages.push(prompt);
        if (sentMessages.length === 1) {
          runtime.extensions.hosted.events.record({
            sessionId: "shell-port-session",
            type: "session_compact",
            payload: {
              entryId: "compact-shell-port",
            },
          });
          return;
        }
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "shell resumed answer" }],
          },
        } as BrewvaPromptSessionEvent);
      },
      async waitForIdle() {},
      async abort() {},
      dispose() {},
      getQueuedPrompts() {
        return queuedPrompts;
      },
      removeQueuedPrompt(promptId: string) {
        const index = queuedPrompts.findIndex((item) => item.promptId === promptId);
        if (index < 0) {
          return false;
        }
        queuedPrompts.splice(index, 1);
        return true;
      },
      getRegisteredTools() {
        return [];
      },
    };

    const port = createSessionViewPort({
      session,
      runtime,
      toolDefinitions: new Map(),
    } as unknown as CliShellSessionBundle);

    expect(port.getShellViewPreferences()).toEqual({
      showThinking: true,
      toolDetails: true,
    });
    expect(() =>
      port.setShellViewPreferences({
        showThinking: false,
        toolDetails: false,
      }),
    ).not.toThrow();
    expect(port.getQueuedPrompts()).toEqual(queuedPrompts);
    expect(port.removeQueuedPrompt("queued-1")).toBe(true);
    expect(port.getQueuedPrompts()).toEqual([]);

    await port.prompt([{ type: "text", text: "hello shell" }], { source: "interactive" });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toBe("hello shell");
    expect(sentMessages[1]).toContain("Context compaction completed");
  });

  test("operator question request answers record receipts from the resolved request without recollecting", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-shell-port-question-request-"));
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const sessionId = "shell-port-question-session";
    const runId = "question-request-run";
    const artifactPath = writeDelegationOutcomeArtifact(workspaceRoot, runId, {
      ok: true,
      runId,
      delegate: "advisor",
      label: "advisor",
      kind: "consult",
      consultKind: "review",
      status: "ok",
      summary: "Operator questions are ready.",
      data: {
        kind: "consult",
        consultKind: "review",
        conclusion: "The run needs operator answers before proceeding.",
        questionRequests: [
          {
            title: "Deployment",
            questions: [
              {
                header: "Deploy",
                question: "Proceed with deployment?",
                options: [{ label: "Yes" }, { label: "No" }],
                custom: false,
              },
              {
                header: "Smoke",
                question: "Wait for dist smoke?",
                options: [{ label: "Yes" }, { label: "No" }],
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
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "subagent_completed",
      payload: {
        runId,
        delegate: "advisor",
        artifactRefs: [
          {
            kind: "delegation_outcome",
            path: artifactPath,
          },
        ],
      },
    });
    const requestId = `delegation:${runId}:request:1`;
    const request = await resolveOpenSessionQuestionRequest(runtime, sessionId, requestId);
    if (!request) {
      throw new Error("expected open question request");
    }
    const flatQuestions = flattenQuestionRequest(request);
    const sentMessages: string[] = [];

    const session = {
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
      },
      thinkingLevel: "high",
      isStreaming: true,
      sessionManager: {
        getSessionId() {
          return sessionId;
        },
        buildSessionContext() {
          return { messages: [] };
        },
      },
      subscribe() {
        return () => undefined;
      },
      async prompt(parts: readonly BrewvaPromptContentPart[]) {
        sentMessages.push(buildBrewvaPromptText(parts));
        const firstQuestion = flatQuestions[0];
        if (!firstQuestion) {
          return;
        }
        runtime.extensions.hosted.events.record({
          sessionId,
          type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
          payload: buildOperatorQuestionAnsweredPayload({
            question: firstQuestion,
            answerText: "Yes",
            source: "hosted",
          }),
        });
      },
      async waitForIdle() {},
      async abort() {},
      dispose() {},
      getRegisteredTools() {
        return [];
      },
    };

    const bundle = {
      session,
      runtime,
      toolDefinitions: new Map(),
    } as unknown as CliShellSessionBundle;
    const port = createOperatorSurfacePort({
      getSessionBundle: () => bundle,
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await port.answerQuestionRequest(requestId, [["Yes"], ["No"]]);

    expect(sentMessages).toHaveLength(1);
    const answeredEvents = runtime.inspect.events
      .query(sessionId)
      .filter((event) => event.type === OPERATOR_QUESTION_ANSWERED_EVENT_TYPE);
    expect(answeredEvents).toHaveLength(3);
    expect(
      answeredEvents.map((event) => (event.payload as { questionId?: string }).questionId),
    ).toEqual([
      flatQuestions[0]?.questionId,
      flatQuestions[0]?.questionId,
      flatQuestions[1]?.questionId,
    ]);
  });
});
