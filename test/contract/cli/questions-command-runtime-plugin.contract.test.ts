import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createQuestionsCommandRuntimePlugin } from "@brewva/brewva-cli";
import type { RuntimePluginApi } from "@brewva/brewva-gateway/runtime-plugins";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { requireDefined, requireNonEmptyString } from "../../helpers/assertions.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

function createCommandApiMock(): {
  api: RuntimePluginApi;
  commands: Map<string, RegisteredCommand>;
  sentMessages: Array<{ content: string; options?: Record<string, unknown> }>;
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >;
} {
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: Array<{ content: string; options?: Record<string, unknown> }> = [];
  const handlers = new Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >();

  const api = {
    on(
      event: string,
      handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
    ) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, definition: RegisteredCommand) {
      commands.set(name, definition);
    },
    sendUserMessage(content: string, options?: Record<string, unknown>) {
      sentMessages.push({ content, options });
    },
  } as unknown as RuntimePluginApi;

  return { api, commands, sentMessages, handlers };
}

function requireCommand(commands: Map<string, RegisteredCommand>, name: string): RegisteredCommand {
  return requireDefined(commands.get(name), `Expected ${name} command to be registered.`);
}

describe("questions interactive command runtime plugin", () => {
  test("renders open questions into a widget without mutating event history", async () => {
    const workspace = createTestWorkspace("questions-command-runtime-plugin");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "questions-command-session-1";
    const questionEvent = requireDefined(
      runtime.events.record({
        sessionId,
        type: "skill_completed",
        payload: {
          skillName: "design",
          outputs: {
            open_questions: ["Which deployment target should the gateway use?"],
          },
        },
      }),
      "Expected question event to be recorded.",
    );
    const questionEventId = requireNonEmptyString(
      questionEvent.id,
      "Expected recorded question event id.",
    );

    const beforeEventCount = runtime.events.query(sessionId).length;
    const { api, commands } = createCommandApiMock();
    await createQuestionsCommandRuntimePlugin(runtime)(api);

    const questionsCommand = requireCommand(commands, "questions");

    const widgets: Array<{ id: string; lines?: string[]; options?: Record<string, unknown> }> = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(id: string, lines: string[] | undefined, options?: Record<string, unknown>) {
          widgets.push({ id, lines, options });
        },
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    await questionsCommand.handler("", ctx);

    expect(runtime.events.query(sessionId)).toHaveLength(beforeEventCount);
    expect(widgets.at(-1)?.id).toBe("brewva-questions");
    expect(widgets.at(-1)?.options?.placement).toBe("belowEditor");
    const rendered = (widgets.at(-1)?.lines ?? []).join("\n");
    expect(rendered).toContain("Open questions: 1");
    expect(rendered).toContain(questionEventId);
    expect(rendered).toContain("Which deployment target should the gateway use?");
    expect(notifications.at(-1)?.message).toContain("Questions updated (1 open).");
  });

  test("routes /answer back into the session and records a durable answer event", async () => {
    const workspace = createTestWorkspace("questions-command-answer");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "questions-answer-session-1";
    const questionEvent = requireDefined(
      runtime.events.record({
        sessionId,
        type: "skill_completed",
        payload: {
          skillName: "design",
          outputs: {
            open_questions: ["Which deployment target should the gateway use?"],
          },
        },
      }),
      "Expected answerable question event to be recorded.",
    );
    const questionId = `skill:${requireNonEmptyString(questionEvent.id, "Expected question event id.")}:1`;

    const { api, commands, sentMessages } = createCommandApiMock();
    await createQuestionsCommandRuntimePlugin(runtime)(api);

    const answerCommand = requireCommand(commands, "answer");

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      isIdle: () => false,
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    await answerCommand.handler(`${questionId} Use the gateway daemon path.`, ctx);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp" });
    expect(sentMessages[0]?.content).toContain(`Question ID: ${questionId}`);
    expect(sentMessages[0]?.content).toContain("Answer: Use the gateway daemon path.");
    const answerEvents = runtime.events
      .query(sessionId)
      .filter((event) => event.type === OPERATOR_QUESTION_ANSWERED_EVENT_TYPE);
    expect(answerEvents).toHaveLength(1);
    expect(notifications).toEqual([
      {
        message: `Queued answer for ${questionId} after the current run.`,
        level: "info",
      },
    ]);
  });
});
