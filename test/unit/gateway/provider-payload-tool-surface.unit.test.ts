import { describe, expect, test } from "bun:test";
import { createToolSchemaSnapshot } from "../../../packages/brewva-gateway/src/hosted/internal/provider/cache/tool-schema-snapshot.js";
import { createProviderPayloadPipeline } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/provider-payload-pipeline.js";
import { EMPTY_WORKBENCH_CONTEXT_FINGERPRINT } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/provider-payload-summary.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

function createToolMutatingPipeline(transform: (payload: unknown) => unknown) {
  return createProviderPayloadPipeline({
    runner: {
      async emitBeforeProviderRequest(event: { payload: unknown }) {
        return {
          payload: transform(event.payload),
          mutatingHookIds: ["before_provider_request:tool-mutator"],
        };
      },
    },
    settings: {
      getCachePolicy() {
        return {
          retention: "short",
          writeMode: "readWrite",
          scope: "session",
          reason: "default",
        };
      },
      getTransport() {
        return undefined;
      },
      getThinkingBudgets() {
        return undefined;
      },
    },
    runtime: createRuntimeInstanceFixture(),
    sessionId: "session",
    isSessionReady: () => true,
    agentState: () => ({ systemPrompt: "", thinkingLevel: "off" }) as never,
    createHostContext: () => ({}) as never,
    resolveChannelContext: () => "",
    resolveToolSchemaSnapshot: () =>
      createToolSchemaSnapshot([
        { name: "read", description: "Read a file.", parameters: { type: "object" } },
      ]),
    observeStickyLatches: () => undefined,
    readWorkbenchContextFingerprint: () => EMPTY_WORKBENCH_CONTEXT_FINGERPRINT,
  } as never);
}

describe("provider payload tool surface", () => {
  test("rejects a before_provider_request hook that mutates the transmitted tools", async () => {
    const pipeline = createToolMutatingPipeline((payload) => ({
      ...(payload as object),
      tools: [],
    }));

    expect(
      pipeline.preparePayload({
        payload: {
          messages: [],
          tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
        },
        model: { provider: "test", api: "test", id: "model" } as never,
        turn: { sessionId: "session" },
        providerContext: {
          systemPromptHash: "system",
          messageHashes: [],
          activeToolNames: ["read"],
          toolSurfaceHash: "surface",
          perToolIdentity: [{ name: "read", identityHash: "identity" }],
        },
      }),
    ).rejects.toThrow("hosted_provider_payload_tool_surface_mutation");
  });

  test("rejects a hook that mutates the nested Google tool surface", async () => {
    const pipeline = createToolMutatingPipeline((payload) => ({
      ...(payload as object),
      config: { tools: [] },
    }));

    expect(
      pipeline.preparePayload({
        payload: {
          contents: [],
          config: {
            tools: [{ functionDeclarations: [{ name: "read", parameters: {} }] }],
          },
        },
        model: { provider: "google", api: "google-genai", id: "model" } as never,
        turn: { sessionId: "session" },
        providerContext: {
          systemPromptHash: "system",
          messageHashes: [],
          activeToolNames: ["read"],
          toolSurfaceHash: "surface",
          perToolIdentity: [{ name: "read", identityHash: "identity" }],
        },
      }),
    ).rejects.toThrow("hosted_provider_payload_tool_surface_mutation");
  });

  test("detects mutations beneath secret-named schema properties", async () => {
    const pipeline = createToolMutatingPipeline((payload) => ({
      ...(payload as object),
      tools: [
        {
          type: "function",
          name: "read",
          parameters: {
            type: "object",
            properties: { password: { type: "number" } },
          },
        },
      ],
    }));

    expect(
      pipeline.preparePayload({
        payload: {
          messages: [],
          tools: [
            {
              type: "function",
              name: "read",
              parameters: {
                type: "object",
                properties: { password: { type: "string" } },
              },
            },
          ],
        },
        model: { provider: "test", api: "test", id: "model" } as never,
        turn: { sessionId: "session" },
        providerContext: {
          systemPromptHash: "system",
          messageHashes: [],
          activeToolNames: ["read"],
          toolSurfaceHash: "surface",
          perToolIdentity: [{ name: "read", identityHash: "identity" }],
        },
      }),
    ).rejects.toThrow("hosted_provider_payload_tool_surface_mutation");
  });
});
