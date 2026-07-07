import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import { CLEARED_TOOL_RESULT_PLACEHOLDER } from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction-walker.js";
import { registerProviderRequestReduction } from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.js";
import { createRuntimeConfig, createRuntimeInstanceFixture } from "../../helpers/runtime.js";

type BeforeProviderRequestHandler = (
  event: {
    type: "before_provider_request";
    payload: unknown;
    provider: string;
    api: string;
    modelId: string;
  },
  ctx: { sessionManager: { getSessionId(): string } },
) => unknown;

function captureBeforeProviderRequestHandler(
  runtime: ReturnType<typeof createRuntimeInstanceFixture>,
): BeforeProviderRequestHandler {
  const handlers: BeforeProviderRequestHandler[] = [];
  const api = {
    on(event: string, handler: BeforeProviderRequestHandler) {
      if (event === "before_provider_request") {
        handlers.push(handler);
      }
    },
  } as unknown as InternalHostPluginApi;

  registerProviderRequestReduction(api, runtime);
  const handler = handlers[0];
  if (!handler) {
    throw new Error("before_provider_request handler not registered");
  }
  return handler;
}

describe("registerProviderRequestReduction", () => {
  test("uses the current provider payload size instead of stale runtime usage", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-provider-request-reduction-")),
      config: createRuntimeConfig(),
    });
    const sessionId = "payload-size-session";
    runtime.ops.context.usage.observe(sessionId, {
      tokens: 10_000,
      contextWindow: 100_000,
      percent: 10,
    });
    const handler = captureBeforeProviderRequestHandler(runtime);
    const payload = {
      input: [
        { type: "function_call", call_id: "call-1", name: "grep" },
        { type: "function_call_output", call_id: "call-1", output: "x".repeat(88_000) },
      ],
    };

    const reduced = handler(
      {
        type: "before_provider_request",
        payload,
        provider: "openai-codex",
        api: "openai-codex-responses",
        modelId: "gpt-5.5",
      },
      { sessionManager: { getSessionId: () => sessionId } },
    ) as typeof payload | undefined;

    expect(reduced).toEqual({
      input: [
        { type: "function_call", call_id: "call-1", name: "grep" },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: CLEARED_TOOL_RESULT_PLACEHOLDER,
        },
      ],
    });
    expect(payload.input[1]?.output).not.toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
  });
});
