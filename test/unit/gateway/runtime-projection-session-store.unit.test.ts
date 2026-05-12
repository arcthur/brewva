import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { readContextEntryRecordedEventPayload } from "@brewva/brewva-runtime/events";
import { sha256Hex } from "@brewva/brewva-std/hash";
import {
  readSessionBundleArtifact,
  replayImportedSessionEntries,
} from "@brewva/brewva-substrate/persistence";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.js";
import type { StoredSessionMessage } from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/runtime-session-transcript.js";
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
  type BranchSummaryMessage = StoredSessionMessage & {
    role: "branchSummary";
    summary: string;
    fromId: string;
    timestamp: number;
  };

  test("replays canonical transcript entries through lineage context-entry linkers", () => {
    const restoreDateNow = patchDateNow(() => 1_700_000_000_000);

    try {
      const workspace = createTestWorkspace("runtime-projection-session-store");
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const sessionId = "agent-session:projection";
      const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

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

      store.appendModelPresetSelection({
        presetName: "Claude Lead",
        previousPresetName: "Default",
        source: "tui",
        mainModel: "anthropic/claude-main:high",
        subagentModels: {
          advisor: "openai/gpt-5.5:medium",
        },
      });
      store.appendModelChange("openai", "gpt-5.4");
      store.appendThinkingLevelChange("high");
      store.appendMessage(userMessage);
      store.appendMessage(assistantMessage);
      const restoredLeafId = store.getLeafId();
      store.branchWithSummary(restoredLeafId, "checkpoint restored", { source: "unit-test" }, true);

      const restored = new HostedRuntimeTapeSessionStore(runtime, sessionId);
      const context = restored.buildSessionContext();
      const eventTypes = runtime.inspect.events.list(sessionId).map((event) => event.type);

      expect(restored.getLeafId()).toBe(store.getLeafId());
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "model_preset_select",
          "model_select",
          "thinking_level_select",
          "message_end",
          "branch_summary_recorded",
          SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
          CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
        ]),
      );
      expect(eventTypes[0]).toBe(SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE);
      expect(eventTypes.some((type) => type.startsWith("hosted_session_projection_"))).toBe(false);
      expect(context.activeModelPresetName).toBe("Claude Lead");
      expect(context.activeModelPreset).toEqual({
        name: "Claude Lead",
        mainModel: "anthropic/claude-main:high",
        subagentModels: {
          advisor: "openai/gpt-5.5:medium",
        },
      });
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

  test("branches from the target entry lineage rather than the current branch", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-target-lineage");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:target-lineage";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    const firstMainEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main checkpoint" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const secondMainEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main continues" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);

    store.branch(firstMainEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "experiment branch" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);
    store.branch(secondMainEntryId);
    const treeAfterFirstVisit = runtime.inspect.session.getLineageTree(sessionId);
    store.branch(firstMainEntryId);
    const treeAfterRepeatVisit = runtime.inspect.session.getLineageTree(sessionId);

    const targetBranch = treeAfterFirstVisit.nodes.find(
      (node) =>
        node.forkPoint.kind === "context_entry" && node.forkPoint.entryId === secondMainEntryId,
    );

    expect(targetBranch).toEqual(
      expect.objectContaining({
        parentLineageNodeId: "lineage:main",
        forkPoint: {
          kind: "context_entry",
          lineageNodeId: "lineage:main",
          entryId: secondMainEntryId,
        },
      }),
    );
    expect(treeAfterRepeatVisit.nodes).toHaveLength(treeAfterFirstVisit.nodes.length);
  });

  test("checks out an existing lineage node without creating a branch", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-checkout-lineage");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:checkout-lineage";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);
    const checkoutStore = store as HostedRuntimeTapeSessionStore & {
      checkoutLineageNode(lineageNodeId: string, leafEntryId?: string | null): void;
    };

    const mainEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main checkpoint" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);

    store.branch(mainEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "experiment branch" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);

    const treeBeforeCheckout = runtime.inspect.session.getLineageTree(sessionId);
    const experimentNode = treeBeforeCheckout.nodes.find((node) => node.kind === "branch");
    if (!experimentNode) {
      throw new Error("expected experiment branch lineage node");
    }

    checkoutStore.checkoutLineageNode("lineage:main", mainEntryId);

    expect(store.getLineageNodeId()).toBe("lineage:main");
    expect(store.getLeafId()).toBe(mainEntryId);
    expect(JSON.stringify(store.buildSessionContext().messages)).toContain("main checkpoint");
    expect(JSON.stringify(store.buildSessionContext().messages)).not.toContain("experiment branch");
    expect(runtime.inspect.session.getLineageTree(sessionId).nodes).toHaveLength(
      treeBeforeCheckout.nodes.length,
    );

    checkoutStore.checkoutLineageNode(experimentNode.lineageNodeId);

    expect(store.getLineageNodeId()).toBe(experimentNode.lineageNodeId);
    expect(JSON.stringify(store.buildSessionContext().messages)).toContain("experiment branch");
    expect(runtime.inspect.session.getLineageTree(sessionId).nodes).toHaveLength(
      treeBeforeCheckout.nodes.length,
    );
  });

  test("rejects checkout when the leaf belongs to a descendant lineage", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-checkout-mismatch");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:checkout-mismatch";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);
    const checkoutStore = store as HostedRuntimeTapeSessionStore & {
      checkoutLineageNode(lineageNodeId: string, leafEntryId?: string | null): void;
    };

    const mainEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main checkpoint" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);

    store.branch(mainEntryId);
    const experimentEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "experiment branch" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);
    const previousLineageNodeId = store.getLineageNodeId();
    const previousLeafId = store.getLeafId();

    expect(previousLineageNodeId).not.toBe("lineage:main");
    expect(() => checkoutStore.checkoutLineageNode("lineage:main", experimentEntryId)).toThrow(
      `session_context_entry_lineage_mismatch:${experimentEntryId}:lineage:main`,
    );
    expect(store.getLineageNodeId()).toBe(previousLineageNodeId);
    expect(store.getLeafId()).toBe(previousLeafId);
  });

  test("builds LLM context from admitted context entries while retaining UI branch state", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-admission");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:admission";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    const visibleUser = {
      role: "user",
      content: [{ type: "text", text: "visible prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage;
    const hiddenState = {
      role: "user",
      content: [{ type: "text", text: "state-only diagnostic" }],
      excludeFromContext: true,
      timestamp: Date.now() + 1,
    } as StoredSessionMessage;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 2,
    } as StoredSessionMessage;

    store.appendMessage(visibleUser);
    store.appendMessage(hiddenState);
    store.appendMessage(assistant);

    expect(
      store
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            JSON.stringify((entry.message as { content?: unknown }).content).includes(
              "state-only diagnostic",
            ),
        ),
    ).toBe(true);
    expect(store.buildSessionContext().messages).toMatchObject([visibleUser, assistant]);
  });

  test("fails closed when replaying a compact summary with a mismatched digest", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-compaction-digest");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:compaction-digest";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "before compact" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const leafEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready to compact" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_compact",
      payload: {
        compactId: "compact-bad-digest",
        sanitizedSummary: "[CompactSummary]\nTampered summary",
        summaryDigest: sha256Hex("[CompactSummary]\nOriginal summary"),
        sourceTurn: 1,
        leafEntryId,
        firstKeptEntryId: leafEntryId,
        referenceContextDigest: null,
        fromTokens: 1000,
        toTokens: 100,
        origin: "auto_compaction",
      },
    });

    const restored = new HostedRuntimeTapeSessionStore(runtime, sessionId);
    expect(restored.buildSessionContext().messages).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
    expect(
      restored
        .buildSessionContext()
        .messages.some((message) => message.role === "compactionSummary"),
    ).toBe(false);
  });

  test("replays stored sanitized compact summaries instead of regenerating them", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-compaction-replay");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:compaction-replay";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "before compact" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const leafEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready to compact" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    const sanitizedSummary = "[CompactSummary]\nStored summary from the original compact event.";

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_compact",
      payload: {
        compactId: "compact-stored-summary",
        sanitizedSummary,
        summaryDigest: sha256Hex(sanitizedSummary),
        sourceTurn: 1,
        leafEntryId,
        firstKeptEntryId: leafEntryId,
        referenceContextDigest: null,
        fromTokens: 1000,
        toTokens: 100,
        origin: "auto_compaction",
        summaryGeneration: {
          strategy: "llm_primary",
          model: {
            provider: "openai",
            id: "gpt-5.4",
            api: "openai-responses",
          },
        },
      },
    });

    const restored = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    expect(
      restored
        .buildSessionContext()
        .messages.find((message) => message.role === "compactionSummary"),
    ).toEqual(
      expect.objectContaining({
        role: "compactionSummary",
        summary: sanitizedSummary,
      }),
    );
  });

  test("appendCompaction records a canonical compact payload that produces a context entry", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-canonical-compaction");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:canonical-compaction";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "before compact" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const firstKeptEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "keep this message" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);

    store.appendCompaction("[CompactSummary]\nCanonical compact.", firstKeptEntryId, 1200);

    const contextEntry = runtime.inspect.events
      .list(sessionId)
      .filter((event) => event.type === CONTEXT_ENTRY_RECORDED_EVENT_TYPE)
      .map((event) => readContextEntryRecordedEventPayload(event))
      .find((payload) => payload?.sourceEventType === "session_compact");

    expect(contextEntry).toEqual(
      expect.objectContaining({
        entryKind: "compaction",
        sourceEventType: "session_compact",
      }),
    );
  });

  test("rejects legacy hosted projection tapes without a lineage root", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-legacy");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:legacy";

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "hosted_session_projection_model_change",
      payload: {
        provider: "openai",
        modelId: "gpt-5.4",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "hosted_session_projection_thinking_level_change",
      payload: {
        thinkingLevel: "high",
      },
    });
    runtime.extensions.hosted.events.record({
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
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "hosted_session_projection_custom_message",
      payload: {
        customType: "note",
        content: "legacy custom",
        display: true,
      },
    });

    expect(() => new HostedRuntimeTapeSessionStore(runtime, sessionId)).toThrow(
      "session_lineage_root_missing",
    );
  });

  test("projects clean conversation rewind without replaying the discarded branch summary", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-clean-rewind");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:clean-rewind";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const checkpointA = runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: store.getLeafId(),
      prompt: {
        text: "first prompt",
        parts: [],
      },
    });
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second prompt" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);
    runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: store.getLeafId(),
      prompt: {
        text: "second prompt",
        parts: [],
      },
    });

    const rewind = runtime.authority.session.rewind(sessionId, {
      checkpointId: checkpointA.checkpointId,
      mode: "conversation",
      summary: "none",
      returnLeafEntryId: store.getLeafId(),
    });
    if (!rewind.ok) {
      throw new Error(`expected clean rewind to succeed, got ${rewind.reason}`);
    }

    const restored = new HostedRuntimeTapeSessionStore(runtime, sessionId);
    const branchSummaryMessages = restored
      .buildSessionContext()
      .messages.filter(
        (message): message is BranchSummaryMessage =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          (message as { role?: string }).role === "branchSummary" &&
          typeof (message as { summary?: unknown }).summary === "string",
      );

    expect(branchSummaryMessages.map((message) => message.summary)).toEqual([
      expect.stringContaining("Workspace divergence:"),
    ]);
    expect(
      branchSummaryMessages.some((message) =>
        message.summary.includes("Treat the abandoned branch"),
      ),
    ).toBe(false);
    expect(runtime.inspect.session.getLineageTree(sessionId).nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "recovery",
          parentLineageNodeId: "lineage:main",
        }),
      ]),
    );
  });

  test("keeps undo-triggered conversation rewind inside the current lineage node", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-undo-intra-node");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:undo-intra-node";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    runtime.authority.session.recordRewindCheckpoint(sessionId, {
      leafEntryId: store.getLeafId(),
      prompt: {
        text: "first prompt",
        parts: [],
      },
    });
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);

    const rewind = runtime.authority.session.rewind(sessionId, {
      mode: "conversation",
      summary: "none",
      returnLeafEntryId: store.getLeafId(),
    });
    if (!rewind.ok) {
      throw new Error(`expected undo rewind to succeed, got ${rewind.reason}`);
    }

    const tree = runtime.inspect.session.getLineageTree(sessionId);
    expect(tree.nodes.some((node) => node.kind === "recovery")).toBe(false);
    expect(store.getLineageNodeId()).toBe("lineage:main");
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
          type: "model_preset_select",
          id: "p1",
          parentId: null,
          timestamp: "2026-04-10T00:00:00.500Z",
          presetName: "Claude Lead",
          previousPresetName: "Default",
          source: "import",
          mainModel: "anthropic/claude-main:high",
        }),
        JSON.stringify({
          type: "model_change",
          id: "m1",
          parentId: "p1",
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

    const store = new HostedRuntimeTapeSessionStore(runtime, artifact.sessionId);
    replayImportedSessionEntries(store, artifact.entries);

    expect(store.buildSessionContext()).toMatchObject({
      activeModelPresetName: "Claude Lead",
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
      expect.arrayContaining([
        "model_preset_select",
        "model_select",
        "message_end",
        "branch_summary_recorded",
      ]),
    );
  });

  test("preserves control-entry parent chains during imported replay", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-control-parent-chain");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:control-parent-chain";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    const idMap = replayImportedSessionEntries(store, [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: new Date("2026-04-10T00:00:00.000Z").toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "root user" }],
          timestamp: 1,
        } as StoredSessionMessage,
      },
      {
        type: "thinking_level_change",
        id: "t1",
        parentId: "u1",
        timestamp: new Date("2026-04-10T00:00:01.000Z").toISOString(),
        thinkingLevel: "high",
      },
      {
        type: "message",
        id: "a1",
        parentId: "t1",
        timestamp: new Date("2026-04-10T00:00:02.000Z").toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "child assistant" }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4",
          usage: createUsage(),
          stopReason: "stop",
          timestamp: 2,
        } as StoredSessionMessage,
      },
    ]);

    const importedThinkingId = idMap.get("t1");
    const importedUserId = idMap.get("u1");
    if (!importedThinkingId || !importedUserId) {
      throw new Error("expected imported ids");
    }

    store.branch(importedThinkingId);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "branched after thinking change" }],
      api: "openai-responses",
      provider: "openai",
      model: "openai/gpt-5.4",
      usage: createUsage(),
      stopReason: "stop",
      timestamp: 3,
    } as StoredSessionMessage);

    const latestContextEntry = runtime.inspect.events
      .list(sessionId)
      .filter((event) => event.type === CONTEXT_ENTRY_RECORDED_EVENT_TYPE)
      .map((event) => readContextEntryRecordedEventPayload(event))
      .at(-1);

    expect(latestContextEntry).toEqual(
      expect.objectContaining({
        parentEntryId: importedUserId,
      }),
    );
  });

  test("normalizes imported branch-summary parents to the nearest context entry", () => {
    const workspace = createTestWorkspace("runtime-projection-session-store-branch-summary-parent");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "agent-session:branch-summary-parent";
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);

    replayImportedSessionEntries(store, [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: new Date("2026-04-10T00:00:00.000Z").toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "root user" }],
          timestamp: 1,
        } as StoredSessionMessage,
      },
      {
        type: "thinking_level_change",
        id: "t1",
        parentId: "u1",
        timestamp: new Date("2026-04-10T00:00:01.000Z").toISOString(),
        thinkingLevel: "high",
      },
      {
        type: "branch_summary",
        id: "b1",
        parentId: "t1",
        timestamp: new Date("2026-04-10T00:00:02.000Z").toISOString(),
        fromId: "u1",
        summary: "imported summary",
      },
    ]);

    const userContextEntry = runtime.inspect.events
      .list(sessionId)
      .filter((event) => event.type === CONTEXT_ENTRY_RECORDED_EVENT_TYPE)
      .map((event) => readContextEntryRecordedEventPayload(event))
      .find((payload) => payload?.entryKind === "message");
    const branchSummaryContextEntry = runtime.inspect.events
      .list(sessionId)
      .filter((event) => event.type === CONTEXT_ENTRY_RECORDED_EVENT_TYPE)
      .map((event) => readContextEntryRecordedEventPayload(event))
      .find((payload) => payload?.entryKind === "branch_summary");

    if (!userContextEntry) {
      throw new Error("expected user context entry");
    }
    expect(branchSummaryContextEntry).toEqual(
      expect.objectContaining({
        parentEntryId: userContextEntry.entryId,
      }),
    );
    expect(store.buildSessionContext().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "branchSummary",
          summary: "imported summary",
        }),
      ]),
    );
  });
});
