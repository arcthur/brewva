import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { OPERATOR_QUESTION_ANSWERED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
  type BrewvaQueuedPromptView,
  type BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate";
import {
  createOperatorSurfacePort,
  createSessionViewPort,
} from "../../../packages/brewva-cli/src/shell/adapters/ports.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/types.js";
import {
  buildOperatorQuestionAnsweredPayload,
  flattenQuestionRequest,
  resolveOpenSessionQuestionRequest,
} from "../../../packages/brewva-gateway/src/operator-questions.js";
import { recordHostedSkillCompleted } from "../../helpers/events.js";

describe("cli shell session port", () => {
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
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-shell-port-question-request-")),
    });
    const sessionId = "shell-port-question-session";
    const skillCompleted = recordHostedSkillCompleted({
      runtime,
      sessionId,
      skillName: "plan",
      outputs: {
        question_requests: [
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
    });
    if (!skillCompleted) {
      throw new Error("expected skill_completed event");
    }
    const requestId = `skill:${skillCompleted.id}:request:1`;
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
            source: "runtime_plugin",
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
