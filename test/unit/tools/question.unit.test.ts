import { describe, expect, test } from "bun:test";
import type { BrewvaToolContext } from "@brewva/brewva-substrate/tools";
import { createQuestionTool } from "@brewva/brewva-tools/delegation";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

function createToolContext(overrides?: {
  custom?(
    kind: string,
    payload: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<readonly (readonly string[])[] | undefined>;
}): BrewvaToolContext {
  return {
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify() {},
      onTerminalInput() {
        return () => undefined;
      },
      setStatus() {},
      setWorkingMessage() {},
      setHiddenThinkingLabel() {},
      async custom<T>(kind: string, payload: unknown, options?: { signal?: AbortSignal }) {
        return (await overrides?.custom?.(kind, payload, options)) as T;
      },
      pasteToEditor() {},
      setEditorText() {},
      getEditorText() {
        return "";
      },
      editor: async () => undefined,
      setEditorComponent() {},
      theme: {},
      getAllThemes() {
        return [];
      },
      getTheme() {
        return undefined;
      },
      setTheme() {
        return { success: true } as const;
      },
      getToolsExpanded() {
        return false;
      },
      setToolsExpanded() {},
    },
    hasUI: true,
    cwd: "/workspace/project",
    sessionManager: {
      getSessionId() {
        return "session-1";
      },
      getLeafId() {
        return null;
      },
    },
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: "not configured" }),
    },
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    compact() {},
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
  };
}

describe("question tool", () => {
  test("forwards the execution abort signal into the UI custom request", async () => {
    const tool = createQuestionTool();
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const result = await tool.execute(
      "tool-call-1",
      {
        title: "Deployment",
        questions: [
          {
            header: "Deploy",
            question: "Proceed with deployment?",
            options: [{ label: "Yes" }, { label: "No" }],
            custom: false,
          },
        ],
      },
      abortController.signal,
      undefined,
      createToolContext({
        async custom(_kind, _payload, options) {
          receivedSignal = options?.signal;
          return [["Yes"]];
        },
      }),
    );

    expect(receivedSignal).toBe(abortController.signal);
    expect(toolOutcomePayload(result)).toMatchObject({
      ok: true,
      answers: [["Yes"]],
      questionCount: 1,
    });
  });

  test("rejects invalid or unanswerable question prompts", async () => {
    const tool = createQuestionTool();

    const result = await tool.execute(
      "tool-call-2",
      {
        questions: [
          {
            header: "Freeform disabled",
            question: "Provide the missing answer.",
            options: [],
            custom: false,
          },
        ],
      },
      undefined,
      undefined,
      createToolContext(),
    );

    expect(result.outcome).toMatchObject({
      kind: "err",
      error: { error: "invalid_question_request" },
    });
  });

  test("rejects answer bundles that do not match the question count", async () => {
    const tool = createQuestionTool();

    const result = await tool.execute(
      "tool-call-3",
      {
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
      undefined,
      undefined,
      createToolContext({
        async custom() {
          return [["Yes"]];
        },
      }),
    );

    expect(result.outcome).toMatchObject({
      kind: "err",
      error: { error: "invalid_question_answer" },
    });
  });
});
