import { describe, expect, test } from "bun:test";
import type { SessionWireFrame } from "@brewva/brewva-runtime";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { registerProviderRequestRecovery } from "../../../packages/brewva-gateway/src/runtime-plugins/provider-request-recovery.js";
import { collectSessionPromptOutput } from "../../../packages/brewva-gateway/src/session/collect-output.js";
import { COMPACTION_RECOVERY_TEST_ONLY } from "../../../packages/brewva-gateway/src/session/compaction-recovery.js";
import { createMockRuntimePluginApi, invokeHandler } from "../../helpers/runtime-plugin.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("output budget recovery chain", () => {
  test("retries the same prompt with output-budget escalation before bounded max-output follow-up recovery", async () => {
    const runtime = createRuntimeFixture();
    const { api, handlers } = createMockRuntimePluginApi();
    registerProviderRequestRecovery(api, runtime);

    const sessionId = "unit-output-budget-recovery";
    const promptedMessages: string[] = [];
    const streamedPayloads: Array<Record<string, unknown> | undefined> = [];
    const frames: SessionWireFrame[] = [];
    let listener: ((event: AgentSessionEvent) => void) | undefined;

    const session = {
      subscribe(next: (event: AgentSessionEvent) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      sessionManager: {
        getSessionId: () => sessionId,
      },
      model: {
        provider: "openai",
        id: "gpt-5.4",
        maxTokens: 16_384,
      },
      async prompt(content: string): Promise<void> {
        promptedMessages.push(content);

        if (promptedMessages.length === 1) {
          listener?.({
            type: "message_update",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "draft answer that will be superseded" }],
            },
            assistantMessageEvent: {
              type: "text_delta",
              delta: "draft answer that will be superseded",
            },
          } as AgentSessionEvent);
          throw new Error("max output tokens exceeded");
        }

        if (promptedMessages.length === 2) {
          streamedPayloads.push(
            invokeHandler<Record<string, unknown> | undefined>(
              handlers,
              "before_provider_request",
              {
                payload: {
                  model: "gpt-5.4",
                  max_tokens: 2_048,
                },
              },
              {
                sessionManager: {
                  getSessionId: () => sessionId,
                },
              },
            ),
          );
          listener?.({
            type: "message_update",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "second draft still too long" }],
            },
            assistantMessageEvent: {
              type: "text_delta",
              delta: "second draft still too long",
            },
          } as AgentSessionEvent);
          throw new Error("max output tokens exceeded");
        }

        if (content !== COMPACTION_RECOVERY_TEST_ONLY.MAX_OUTPUT_RECOVERY_PROMPT) {
          throw new Error(`unexpected_prompt:${content}`);
        }

        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final concise answer" }],
          },
        } as AgentSessionEvent);
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
      },
      dispose(): void {
        return;
      },
    };

    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "recover this answer",
      {
        runtime,
        sessionId,
        turnId: "turn-output-budget",
        onFrame: (frame) => {
          frames.push(frame);
        },
      },
    );

    expect(promptedMessages).toEqual([
      "recover this answer",
      "recover this answer",
      COMPACTION_RECOVERY_TEST_ONLY.MAX_OUTPUT_RECOVERY_PROMPT,
    ]);
    expect(streamedPayloads).toEqual([
      {
        model: "gpt-5.4",
        max_tokens: 16_384,
      },
    ]);
    expect(output.assistantText).toBe("final concise answer");
    expect(output.attemptId).toBe("attempt-3");
    expect(frames).toEqual(
      expect.arrayContaining([
        {
          schema: "brewva.session-wire.v2",
          sessionId,
          type: "attempt.started",
          turnId: "turn-output-budget",
          attemptId: "attempt-1",
          reason: "initial",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
        {
          schema: "brewva.session-wire.v2",
          sessionId,
          type: "attempt.superseded",
          turnId: "turn-output-budget",
          attemptId: "attempt-1",
          supersededByAttemptId: "attempt-2",
          reason: "output_budget_escalation",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
        {
          schema: "brewva.session-wire.v2",
          sessionId,
          type: "attempt.started",
          turnId: "turn-output-budget",
          attemptId: "attempt-2",
          reason: "output_budget_escalation",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
        {
          schema: "brewva.session-wire.v2",
          sessionId,
          type: "attempt.superseded",
          turnId: "turn-output-budget",
          attemptId: "attempt-2",
          supersededByAttemptId: "attempt-3",
          reason: "max_output_recovery",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
        {
          schema: "brewva.session-wire.v2",
          sessionId,
          type: "attempt.started",
          turnId: "turn-output-budget",
          attemptId: "attempt-3",
          reason: "max_output_recovery",
          source: "live",
          durability: "cache",
          frameId: expect.any(String),
          ts: expect.any(Number),
        },
      ]),
    );

    const transitions = runtime.inspect.events.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "output_budget_escalation",
          status: "entered",
        }),
        expect.objectContaining({
          reason: "output_budget_escalation",
          status: "completed",
          model: "openai/gpt-5.4",
        }),
        expect.objectContaining({
          reason: "max_output_recovery",
          status: "entered",
          attempt: 1,
        }),
        expect.objectContaining({
          reason: "max_output_recovery",
          status: "completed",
          attempt: 1,
        }),
      ]),
    );
  });
});
