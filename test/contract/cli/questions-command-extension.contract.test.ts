import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createQuestionsCommandExtension } from "@brewva/brewva-cli/extensions";
import type { HostedExtensionApi } from "@brewva/brewva-gateway/extensions";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { OPERATOR_QUESTION_ANSWERED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import { requireDefined } from "../../helpers/assertions.js";
import { recordHostedDelegationOutcome } from "../../helpers/events.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
}

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

function createCommandApiMock(): {
  api: HostedExtensionApi;
  commands: Map<string, RegisteredCommand>;
  sentMessages: Array<{ content: BrewvaPromptContentPart[]; options?: Record<string, unknown> }>;
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >;
} {
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: Array<{
    content: BrewvaPromptContentPart[];
    options?: Record<string, unknown>;
  }> = [];
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
    sendUserMessage(content: BrewvaPromptContentPart[], options?: Record<string, unknown>) {
      sentMessages.push({ content, options });
    },
  } as unknown as HostedExtensionApi;

  return { api, commands, sentMessages, handlers };
}

function requireCommand(commands: Map<string, RegisteredCommand>, name: string): RegisteredCommand {
  return requireDefined(commands.get(name), `Expected ${name} command to be registered.`);
}

describe("questions interactive command extension", () => {
  test("publishes open questions into a notification without mutating event history", async () => {
    const workspace = createTestWorkspace("questions-command-extension");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const runtime = createHostedTestRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "questions-command-session-1";
    const runId = "questions-command-run-1";
    recordHostedDelegationOutcome({
      runtime,
      sessionId,
      runId,
      payload: {
        delegate: "advisor",
        kind: "consult",
        consultKind: "review",
      },
      outcome: {
        ok: true,
        runId,
        delegate: "advisor",
        label: "advisor",
        kind: "consult",
        consultKind: "review",
        status: "ok",
        summary: "Open question available.",
        data: {
          kind: "consult",
          consultKind: "review",
          conclusion: "The run needs operator input.",
          followUpQuestions: ["Which deployment target should the gateway use?"],
        },
        metrics: { durationMs: 1 },
        evidenceRefs: [],
      },
    });
    const questionId = `delegation:${runId}:1`;

    const beforeEventCount = runtime.inspect.events.records.query(sessionId).length;
    const { api, commands } = createCommandApiMock();
    await createQuestionsCommandExtension(runtime).register(api);

    const questionsCommand = requireCommand(commands, "questions");

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    await questionsCommand.handler("", ctx);

    expect(runtime.inspect.events.records.query(sessionId)).toHaveLength(beforeEventCount);
    const rendered = notifications.at(-1)?.message ?? "";
    expect(rendered).toContain("Operator inbox updated (1 pending).");
    expect(rendered).toContain("Operator inbox: 1");
    expect(rendered).toContain("Input requests: 0 · Follow-up questions: 1");
    expect(rendered).toContain("Follow-up questions:");
    expect(rendered).toContain(questionId);
    expect(rendered).toContain("Which deployment target should the gateway use?");
    expect(notifications.at(-1)?.level).toBe("info");
  });

  test("routes /answer back into the session and records a durable answer event", async () => {
    const workspace = createTestWorkspace("questions-command-answer");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const runtime = createHostedTestRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "questions-answer-session-1";
    const runId = "questions-answer-run-1";
    recordHostedDelegationOutcome({
      runtime,
      sessionId,
      runId,
      payload: {
        delegate: "advisor",
        kind: "consult",
        consultKind: "review",
      },
      outcome: {
        ok: true,
        runId,
        delegate: "advisor",
        label: "advisor",
        kind: "consult",
        consultKind: "review",
        status: "ok",
        summary: "Answerable question available.",
        data: {
          kind: "consult",
          consultKind: "review",
          conclusion: "The run needs operator input.",
          followUpQuestions: ["Which deployment target should the gateway use?"],
        },
        metrics: { durationMs: 1 },
        evidenceRefs: [],
      },
    });
    const questionId = `delegation:${runId}:1`;

    const { api, commands, sentMessages } = createCommandApiMock();
    await createQuestionsCommandExtension(runtime).register(api);

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
    expect(buildBrewvaPromptText(sentMessages[0]?.content ?? [])).toContain(
      `Question ID: ${questionId}`,
    );
    expect(buildBrewvaPromptText(sentMessages[0]?.content ?? [])).toContain(
      "Answer: Use the gateway daemon path.",
    );
    const answerEvents = runtime.inspect.events.records
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
