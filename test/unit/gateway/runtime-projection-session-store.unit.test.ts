import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { readSessionBundleArtifact, replayImportedSessionEntries } from "@brewva/brewva-substrate";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/host/runtime-projection-session-store.js";
import { patchDateNow } from "../../helpers/global-state.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createUsage() {
  return {
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
  };
}

describe("hosted runtime tape session store", () => {
  test("replays canonical transcript entries from runtime events without private projection events", () => {
    const restoreDateNow = patchDateNow(() => 1_700_000_000_000);

    try {
      const workspace = createTestWorkspace("runtime-projection-session-store");
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const sessionId = "agent-session:projection";
      const store = new HostedRuntimeTapeSessionStore(runtime, workspace, sessionId);

      const userMessage = {
        role: "user",
        content: [{ type: "text", text: "hello from runtime truth" }],
        timestamp: Date.now(),
      };
      const assistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "projection acknowledged" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: createUsage(),
        stopReason: "stop" as const,
        timestamp: Date.now() + 1,
      };

      store.appendModelChange("openai", "gpt-5.4");
      store.appendThinkingLevelChange("high");
      store.appendMessage(userMessage);
      store.appendMessage(assistantMessage);
      const restoredLeafId = store.getLeafId();
      store.branchWithSummary(restoredLeafId, "checkpoint restored", { source: "unit-test" }, true);

      const restored = new HostedRuntimeTapeSessionStore(runtime, workspace, sessionId);
      const context = restored.buildSessionContext();
      const eventTypes = runtime.inspect.events.list(sessionId).map((event) => event.type);

      expect(restored.getLeafId()).toBe(store.getLeafId());
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "model_select",
          "thinking_level_select",
          "message_end",
          "branch_summary_recorded",
        ]),
      );
      expect(eventTypes.some((type) => type.startsWith("hosted_session_projection_"))).toBe(false);
      expect(context.thinkingLevel).toBe("high");
      expect(context.model).toEqual({ provider: "openai", modelId: "gpt-5.4" });
      expect(context.messages).toMatchObject([
        userMessage,
        assistantMessage,
        {
          role: "branchSummary",
          summary: "checkpoint restored",
          fromId: restoredLeafId,
        },
      ]);
    } finally {
      restoreDateNow();
    }
  });

  test("migrates legacy hosted projection events into canonical runtime transcript events", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-legacy");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:legacy";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "hosted_session_projection_model_change",
      payload: {
        provider: "openai",
        modelId: "gpt-5.4",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "hosted_session_projection_thinking_level_change",
      payload: {
        thinkingLevel: "high",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "hosted_session_projection_message",
      payload: {
        message: {
          role: "user",
          content: [{ type: "text", text: "legacy hello" }],
          timestamp: 100,
        },
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "hosted_session_projection_custom_message",
      payload: {
        customType: "note",
        content: "legacy custom",
        display: true,
      },
    });

    const restored = new HostedRuntimeTapeSessionStore(runtime, workspace, sessionId);
    const eventTypes = runtime.inspect.events.list(sessionId).map((event) => event.type);
    const context = restored.buildSessionContext();

    expect(eventTypes).toEqual(
      expect.arrayContaining(["model_select", "thinking_level_select", "message_end"]),
    );
    expect(context.model).toEqual({ provider: "openai", modelId: "gpt-5.4" });
    expect(context.thinkingLevel).toBe("high");
    expect(context.messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "legacy hello" }],
      },
      {
        role: "custom",
        customType: "note",
        content: "legacy custom",
        display: true,
      },
    ]);
  });

  test("replays imported legacy Pi entries through the hosted runtime tape store", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-pi-import");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionPath = join(workspace, "legacy-session.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-import-session",
          timestamp: "2026-04-10T00:00:00.000Z",
          cwd: workspace,
        }),
        JSON.stringify({
          type: "model_change",
          id: "m1",
          parentId: null,
          timestamp: "2026-04-10T00:00:01.000Z",
          provider: "openai",
          modelId: "gpt-5.4",
        }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: "m1",
          timestamp: "2026-04-10T00:00:02.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "legacy user" }],
            timestamp: 1,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-04-10T00:00:03.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "legacy assistant" }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.4",
            usage: createUsage(),
            stopReason: "stop",
            timestamp: 2,
          },
        }),
        JSON.stringify({
          type: "branch_summary",
          id: "b1",
          parentId: "u1",
          timestamp: "2026-04-10T00:00:04.000Z",
          fromId: "a1",
          summary: "legacy branch summary",
        }),
      ].join("\n"),
      "utf8",
    );

    const artifact = readSessionBundleArtifact(sessionPath);
    if (artifact.kind !== "legacy_pi_jsonl") {
      throw new Error("expected legacy Pi import artifact");
    }

    const store = new HostedRuntimeTapeSessionStore(runtime, workspace, artifact.sessionId);
    replayImportedSessionEntries(store, artifact.entries);

    expect(store.buildSessionContext()).toMatchObject({
      model: { provider: "openai", modelId: "gpt-5.4" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "legacy user" }],
        },
        {
          role: "branchSummary",
          summary: "legacy branch summary",
        },
      ],
    });
    expect(runtime.inspect.events.list(artifact.sessionId).map((event) => event.type)).toEqual(
      expect.arrayContaining(["model_select", "message_end", "branch_summary_recorded"]),
    );
  });
});
