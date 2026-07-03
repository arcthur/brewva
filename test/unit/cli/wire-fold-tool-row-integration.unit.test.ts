import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaToolUpdateHandler } from "@brewva/brewva-substrate/tools";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { Type } from "@sinclair/typebox";
import { createShellCockpitWireFoldStore } from "../../../packages/brewva-cli/src/shell/domain/cockpit/wire-fold.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";
import { NOOP_UI } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/noop-ui.js";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import { runHostedTurnEnvelope } from "../../../packages/brewva-gateway/src/hosted/internal/turn/turn-envelope.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../../../packages/brewva-provider-core/src/providers/faux/index.js";
import { createRuntimeProviderFaceFixture } from "../../helpers/runtime-provider-face.js";

// Full-chain fidelity: a REAL hosted turn (runtime executes a write-like tool)
// must fold — from the actual wire frames the gateway emits — into a transcript
// tool row that reaches its terminal state AND carries the tool call args.
// This is the chain behind "the UI showed `~ Record` forever while the files
// were written on disk": the row's title and completion both starved because
// the folded row never carried args / never left `pending`.

const SESSION_ID = "session-wire-fold-tool-row";

async function runRealTurnCollectingFrames(): Promise<readonly SessionWireFrame[]> {
  const runtime = createHostedRuntimeAdapter({
    cwd: mkdtempSync(join(tmpdir(), "brewva-wire-fold-tool-row-")),
  });
  const fauxProvider = registerFauxProvider({
    provider: `faux-wire-fold-${Math.random().toString(36).slice(2)}`,
    api: "faux",
    tokenSize: { min: 1, max: 1 },
  });
  const observedFrames: SessionWireFrame[] = [];
  fauxProvider.setResponses([
    fauxAssistantMessage([
      { type: "text", text: "writing the file" },
      fauxToolCall(
        "write",
        { path: "src/app/main.swift", content: "print(1)" },
        { id: "tool-write-1" },
      ),
    ]),
    fauxAssistantMessage([{ type: "text", text: "done" }]),
  ]);

  const model = fauxProvider.getModel();
  const session = {
    model,
    sessionManager: {
      getSessionId: () => SESSION_ID,
    },
    getRegisteredTools: () => [
      {
        name: "write",
        label: "Write",
        description: "Writes a file.",
        parameters: Type.Object({
          path: Type.String(),
          content: Type.String(),
        }),
        brewva: {
          surface: "base",
          actionClass: "workspace_write",
        },
        async execute(
          _toolCallId: string,
          params: { path: string; content: string },
          _signal: AbortSignal | undefined,
          _onUpdate: BrewvaToolUpdateHandler<{ path: string }> | undefined,
        ) {
          return {
            content: [{ type: "text" as const, text: `wrote ${params.path}` }],
            outcome: { kind: "ok" as const, value: { path: params.path } },
          };
        },
      },
    ],
    getRuntimeProviderFace: () =>
      createRuntimeProviderFaceFixture({
        model,
        getModelCatalog: () => ({
          async getApiKeyAndHeaders() {
            return { ok: true as const };
          },
        }),
      }),
    createRuntimeToolContext: () => ({
      ui: NOOP_UI,
      hasUI: false,
      cwd: runtime.identity.cwd,
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getLeafId: () => null,
      },
      modelRegistry: {
        getAll: () => [model],
      },
      model,
      isIdle: () => true,
      signal: undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      compact: () => undefined,
      getContextUsage: () => undefined,
      getSystemPrompt: () => "Test hosted system prompt.",
    }),
  };

  const result = await runHostedTurnEnvelope({
    session: session as unknown as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
    runtime,
    sessionId: SESSION_ID,
    prompt: "write the main file",
    source: "interactive",
    turnId: "turn-tool-row-1",
    onFrame: (frame) => observedFrames.push(frame),
  });
  expect(result.status).toBe("completed");
  return observedFrames;
}

function findToolRow(
  messages: readonly CliShellTranscriptMessage[],
): { toolName: string; status: string; args?: unknown } | undefined {
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "tool") {
        return { toolName: part.toolName, status: part.status, args: part.args };
      }
    }
  }
  return undefined;
}

describe("wire-fold tool row fidelity (full chain)", () => {
  test("a live turn folds the tool row to terminal state with its args", async () => {
    const frames = await runRealTurnCollectingFrames();
    expect(frames.map((frame) => frame.type)).toEqual(
      expect.arrayContaining(["tool.started", "tool.finished", "turn.committed"]),
    );

    const store = createShellCockpitWireFoldStore();
    for (const frame of frames) {
      store.remember(frame);
    }
    const snapshot = store.snapshot(SESSION_ID);

    // The folded activity view reaches the terminal state.
    const folded = snapshot.toolCalls.find((toolCall) => toolCall.toolCallId === "tool-write-1");
    expect(folded?.status).toBe("completed");

    // The transcript projection row is terminal AND knows WHAT it wrote.
    const row = findToolRow(snapshot.transcriptMessages);
    expect(row?.toolName).toBe("write");
    expect(row?.status).toBe("completed");
    expect(row?.args).toMatchObject({ path: "src/app/main.swift" });
  });
});
