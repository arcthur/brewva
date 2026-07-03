import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import type { BrewvaToolUpdateHandler } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import { createCliInspectPort } from "../../../packages/brewva-cli/src/runtime/cli-runtime-ports.js";
import { createSessionViewPort } from "../../../packages/brewva-cli/src/shell/ports/session-adapter.js";
import { NOOP_UI } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/noop-ui.js";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../../../packages/brewva-provider-core/src/providers/faux/index.js";
import { createRuntimeProviderFaceFixture } from "../../helpers/runtime-provider-face.js";

// Resuming an approval MUST run the resumed turn through the same projection
// pipeline as the original prompt. The operator path used to re-enter the turn
// with no frame sink, so everything after the approval — the tool finish, the
// assistant text, the terminal idle phase — vanished: the composer stayed
// stashed on waiting_approval forever and the transcript froze.

const SESSION_ID = "session-approval-resume";

function buildBundle() {
  const runtime = createHostedRuntimeAdapter({
    cwd: mkdtempSync(join(tmpdir(), "brewva-approval-resume-")),
  });
  const fauxProvider = registerFauxProvider({
    provider: `faux-approval-resume-${Math.random().toString(36).slice(2)}`,
    api: "faux",
    tokenSize: { min: 1, max: 1 },
  });
  fauxProvider.setResponses([
    fauxAssistantMessage([
      { type: "text", text: "running the build" },
      fauxToolCall("exec_like", { command: "swift build" }, { id: "tool-exec-1" }),
    ]),
    fauxAssistantMessage([{ type: "text", text: "build done" }]),
  ]);
  const model = fauxProvider.getModel();
  const session = {
    model,
    isStreaming: false,
    subscribe: () => () => {},
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getLeafId: () => null,
    },
    getRegisteredTools: () => [
      {
        name: "exec_like",
        label: "Exec",
        description: "Runs a command (effectful, needs operator approval).",
        parameters: Type.Object({ command: Type.String() }),
        brewva: {
          surface: "base",
          actionClass: "local_exec_effectful",
        },
        async execute(
          _toolCallId: string,
          params: { command: string },
          _signal: AbortSignal | undefined,
          _onUpdate: BrewvaToolUpdateHandler<{ ok: boolean }> | undefined,
        ) {
          return {
            content: [{ type: "text" as const, text: `ran ${params.command}` }],
            outcome: { kind: "ok" as const, value: { ok: true } },
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
  return {
    bundle: {
      session,
      runtime,
      inspect: createCliInspectPort(runtime),
    },
    runtime,
  };
}

describe("session view port approval resume", () => {
  test("the resumed turn projects frames: terminal idle phase and tool finish", async () => {
    const { bundle, runtime } = buildBundle();
    const port = createSessionViewPort(bundle as never);
    const events: BrewvaPromptSessionEvent[] = [];
    port.subscribe((event) => events.push(event));

    // The prompt suspends on the effectful tool's approval.
    await port.prompt([{ type: "text", text: "build it" }], { source: "interactive" });
    const phases = () =>
      events
        .filter(
          (event): event is BrewvaPromptSessionEvent & { type: "session_phase_change" } =>
            event.type === "session_phase_change",
        )
        .map((event) => (event.phase as { kind: string }).kind);
    expect(phases().at(-1)).toBe("waiting_approval");

    // Operator accepts the pending approval.
    const pending = bundle.inspect.proposals.listPending(SESSION_ID);
    expect(pending).toHaveLength(1);
    const request = pending[0]!;
    runtime.ops.proposals.requests.decide(SESSION_ID, request.requestId, {
      decision: "accept",
      actor: "operator",
    });

    // Resume through the session port: the resumed turn's frames must project.
    const status = await port.resolveApproval({
      requestId: request.requestId,
      turnId: request.turnId ?? "turn-0",
    });
    expect(status).toBe("completed");

    // The phase reached idle (the composer un-stashes) …
    expect(phases().at(-1)).toBe("idle");
    // … and the resumed tool execution reached the projection.
    expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
  });
});
