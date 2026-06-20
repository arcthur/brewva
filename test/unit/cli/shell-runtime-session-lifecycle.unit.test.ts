import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type {
  BrewvaQueuedPromptView,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import type { BrewvaReplaySession } from "@brewva/brewva-vocabulary/session";
import { DEFAULT_TUI_THEME } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type { ShellEffect } from "../../../packages/brewva-cli/src/shell/domain/effects.js";
import type { ProviderConnectionDescriptor } from "../../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.js";
import type { StoredSessionMessage } from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-session-transcript.js";
import {
  createHostedShellFixture,
  type HostedShellFixtureOptions,
} from "../../helpers/shell-fixture.js";

async function keymapEffect(runtime: CliShellRuntime, effect: ShellEffect): Promise<boolean> {
  return await runtime.handleInput({
    type: "keymap.effect",
    effect,
  });
}

async function keymapCommand(runtime: CliShellRuntime, commandId: string): Promise<boolean> {
  return await runtime.handleInput({
    type: "keymap.command",
    commandId,
    source: "keybinding",
  });
}

async function submitComposer(runtime: CliShellRuntime): Promise<boolean> {
  return await keymapEffect(runtime, { type: "composer.submit" });
}

function createFakeBundle(options: HostedShellFixtureOptions = {}) {
  return createHostedShellFixture({ fauxProvider: true, ...options });
}

describe("shell runtime: session lifecycle", () => {
  test("attaches the shell ui port to the managed session", () => {
    const { bundle, getAttachedUi } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    expect(getAttachedUi()).toBe(runtime.ui);
    runtime.dispose();
  });

  test("routes theme selection through shell state so the renderer can react to it", () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    const customTheme = {
      ...DEFAULT_TUI_THEME,
      name: "custom",
      accent: "#7dd3fc",
      borderActive: "#7dd3fc",
    };

    expect(runtime.getViewState().theme).toEqual(DEFAULT_TUI_THEME);
    expect(runtime.ui.getTheme("default")).toEqual(DEFAULT_TUI_THEME);
    expect(runtime.ui.getAllThemes()).toEqual([
      { name: "default" },
      { name: "graphite" },
      { name: "paper" },
    ]);
    expect(runtime.ui.setTheme(customTheme)).toEqual({ success: true });
    expect(runtime.getViewState().theme).toEqual(customTheme);
    expect(runtime.ui.theme).toEqual(customTheme);
    runtime.dispose();
  });

  test("handles theme shell commands for listing and switching built-in themes", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/theme list");
    await submitComposer(runtime);

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Available themes: default, graphite, paper",
    });

    runtime.ui.setEditorText("/theme paper");
    await submitComposer(runtime);

    expect(runtime.getViewState().theme.name).toBe("paper");

    runtime.ui.setEditorText("/theme missing");
    await submitComposer(runtime);

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Unknown theme selection.",
    });
    runtime.dispose();
  });

  test("lineage slash command opens the lineage overlay", async () => {
    const { bundle } = createFakeBundle({ sessionId: "lineage-overlay-session" });
    bundle.runtime.ops.session.lineage.createNode("lineage-overlay-session", {
      lineageNodeId: "lineage:main",
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
    });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/lineage");
    await submitComposer(runtime);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "lineage",
      selectedIndex: 0,
    });
    runtime.dispose();
  });

  test("tree slash command opens the context-entry tree overlay", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-overlay-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-overlay-session");
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tree root prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "tree",
      selectedIndex: 0,
    });
    expect(runtime.getViewState().overlay.active?.lines?.join("\n")).toContain("tree root prompt");
    runtime.dispose();
  });

  test("tree projection includes inactive sibling branches", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-sibling-branches-session" });
    const store = new HostedRuntimeTapeSessionStore(
      bundle.runtime,
      "tree-sibling-branches-session",
    );
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "root prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const answerEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "shared answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
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
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main path" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);
    store.branch(answerEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "branch path" }],
      timestamp: Date.now() + 3,
    } as StoredSessionMessage);
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);

    const text = runtime.getViewState().overlay.active?.lines?.join("\n") ?? "";
    expect(text).toContain("main path");
    expect(text).toContain("branch path");
    runtime.dispose();
  });

  test("tree and lineage overlays cross-focus each other", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-lineage-focus-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-lineage-focus-session");
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "focus prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await runtime.handleInput({
      key: "character",
      text: "l",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload?.kind).toBe("lineage");

    await runtime.handleInput({
      key: "character",
      text: "t",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "tree",
      selectedIndex: 0,
    });
    runtime.dispose();
  });

  test("lineage scoped tree focuses the selected branch leaf", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-lineage-leaf-focus-session" });
    const store = new HostedRuntimeTapeSessionStore(
      bundle.runtime,
      "tree-lineage-leaf-focus-session",
    );
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const answerEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
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
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    const mainLeafEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main continuation" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);
    store.branch(answerEntryId);
    const branchLeafEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "branch prompt" }],
      timestamp: Date.now() + 3,
    } as StoredSessionMessage);
    store.checkoutLineageNode("lineage:main", mainLeafEntryId);
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/lineage");
    await submitComposer(runtime);
    const lineagePayload = runtime.getViewState().overlay.active?.payload;
    expect(lineagePayload?.kind).toBe("lineage");
    if (lineagePayload?.kind !== "lineage") {
      throw new Error("Expected lineage overlay.");
    }
    const branchIndex = lineagePayload.nodes.findIndex(
      (node) => node.leafEntryId === branchLeafEntryId,
    );
    expect(branchIndex).toBeGreaterThanOrEqual(0);
    for (let step = lineagePayload.selectedIndex; step < branchIndex; step += 1) {
      await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    }
    await runtime.handleInput({
      key: "character",
      text: "t",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const treePayload = runtime.getViewState().overlay.active?.payload;
    expect(treePayload?.kind).toBe("tree");
    if (treePayload?.kind !== "tree") {
      throw new Error("Expected tree overlay.");
    }
    expect(treePayload.nodes[treePayload.selectedIndex]?.entryId).toBe(branchLeafEntryId);
    expect(treePayload.nodes.map((node) => node.entryId)).toContain(answerEntryId);

    await runtime.handleInput({
      key: "character",
      text: "F",
      ctrl: false,
      meta: false,
      shift: true,
    });
    const filteredTreePayload = runtime.getViewState().overlay.active?.payload;
    expect(filteredTreePayload?.kind).toBe("tree");
    if (filteredTreePayload?.kind !== "tree") {
      throw new Error("Expected tree overlay.");
    }
    const selectedLineageNodeId =
      treePayload.nodes[treePayload.selectedIndex]?.lineageNodeId ?? null;
    expect(filteredTreePayload.scopeLineageNodeId).toBe(selectedLineageNodeId);
    runtime.dispose();
  });

  test("tree search refinement uses full text and filter cycling hides tool entries", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-search-filter-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-search-filter-session");
    store.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: `${"long prompt prefix ".repeat(12)}deep-search-token`,
        },
      ],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    store.appendCustomMessageEntry("tool_result", "read_file tool output", true);
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await runtime.handleInput({
      key: "character",
      text: "/",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "paste",
      text: "deep-search-token",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "enter",
      text: "",
      ctrl: false,
      meta: false,
      shift: false,
    });
    const searchedPayload = runtime.getViewState().overlay.active?.payload;
    expect(searchedPayload?.kind).toBe("tree");
    if (searchedPayload?.kind !== "tree") {
      throw new Error("Expected tree overlay.");
    }
    expect(searchedPayload.query).toBe("deep-search-token");
    const matchedUserNode = searchedPayload.nodes.find((node) => node.role === "user");
    expect(matchedUserNode?.preview).not.toContain("deep-search-token");

    await keymapEffect(runtime, { type: "overlay.closeActive", cancelled: false });
    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await runtime.handleInput({
      key: "character",
      text: "F",
      ctrl: false,
      meta: false,
      shift: true,
    });
    const filteredPayload = runtime.getViewState().overlay.active?.payload;
    expect(filteredPayload?.kind).toBe("tree");
    if (filteredPayload?.kind !== "tree") {
      throw new Error("Expected tree overlay.");
    }
    expect(filteredPayload.filter).toBe("noTools");
    expect(filteredPayload.nodes.some((node) => node.entryKind.includes("tool"))).toBe(false);
    runtime.dispose();
  });

  test("tree checkout followed by append creates lineage topology", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-lineage-created-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-lineage-created-session");
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "root prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const answerEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "shared answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
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
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main continuation" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    const beforeCount = bundle.runtime.ops.session.lineage.getTree("tree-lineage-created-session")
      .nodes.length;
    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    const treePayload = runtime.getViewState().overlay.active?.payload;
    expect(treePayload?.kind).toBe("tree");
    if (treePayload?.kind !== "tree") {
      throw new Error("Expected tree overlay.");
    }
    const answerIndex = treePayload.nodes.findIndex((node) => node.entryId === answerEntryId);
    expect(answerIndex).toBeGreaterThanOrEqual(0);
    const moveDelta = answerIndex - treePayload.selectedIndex;
    for (let step = 0; step < Math.abs(moveDelta); step += 1) {
      await keymapEffect(runtime, {
        type: "overlay.moveSelection",
        delta: moveDelta > 0 ? 1 : -1,
      });
    }
    const checkout = keymapEffect(runtime, { type: "overlay.primary" });
    await Bun.sleep(0);
    await keymapEffect(runtime, { type: "overlay.primary" });
    await checkout;

    const branchLeafEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tree-created branch" }],
      timestamp: Date.now() + 3,
    } as StoredSessionMessage);

    await keymapEffect(runtime, { type: "overlay.closeActive", cancelled: false });
    runtime.ui.setEditorText("/lineage");
    await submitComposer(runtime);
    const lineagePayload = runtime.getViewState().overlay.active?.payload;
    expect(lineagePayload?.kind).toBe("lineage");
    if (lineagePayload?.kind !== "lineage") {
      throw new Error("Expected lineage overlay.");
    }
    expect(lineagePayload.nodes.length).toBeGreaterThan(beforeCount);
    expect(lineagePayload.nodes.some((node) => node.leafEntryId === branchLeafEntryId)).toBe(true);
    runtime.dispose();
  });

  test("tree express branch (b) checks out conversation-only without a carry dialog", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-express-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-express-session");
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "explore an idea" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    const replacedMessages: unknown[][] = [];
    session.sessionManager = store;
    session.replaceMessages = async (messages) => {
      replacedMessages.push(messages);
    };
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: -1 });
    await runtime.handleInput({
      key: "character",
      text: "b",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await Bun.sleep(0);

    // One keystroke: no carry dialog, checkout already applied.
    expect(runtime.getViewState().overlay.active?.payload?.kind).not.toBe("select");
    expect(runtime.getViewState().composer.text).toBe("explore an idea");
    expect(replacedMessages.at(-1) ?? []).toEqual([]);
    runtime.dispose();
  });

  test("tree checkout restores a selected user prompt into the composer", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-restore-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-restore-session");
    store.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "restore " },
        { type: "image", data: "base64-image", mimeType: "image/png" },
        { type: "text", text: "@README.md" },
      ],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
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
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    const replacedMessages: unknown[][] = [];
    session.sessionManager = store;
    session.replaceMessages = async (messages) => {
      replacedMessages.push(messages);
    };
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: -1 });
    const checkout = keymapEffect(runtime, { type: "overlay.primary" });
    await Bun.sleep(0);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "select",
      options: ["No summary", "Generated summary", "Generated summary with instructions"],
    });
    await keymapEffect(runtime, { type: "overlay.primary" });
    await checkout;

    expect(runtime.getViewState().composer.text).toBe("restore @README.md");
    expect(replacedMessages.at(-1) ?? []).toEqual([]);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: expect.stringContaining("non-text prompt parts were omitted"),
    });
    runtime.dispose();
  });

  test("tree checkout carry prompt records generated summary instructions", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-carry-instructions-session" });
    const store = new HostedRuntimeTapeSessionStore(
      bundle.runtime,
      "tree-carry-instructions-session",
    );
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const answerEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
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
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.branch(answerEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "abandoned branch" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);

    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: -1 });
    const checkout = keymapEffect(runtime, { type: "overlay.primary" });
    await Bun.sleep(0);
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    await keymapEffect(runtime, { type: "overlay.primary" });
    await Bun.sleep(0);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "input",
      title: "Branch carry instructions",
    });
    await runtime.handleInput({
      key: "paste",
      text: "Preserve the successful design decision.",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "enter",
      text: "",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await checkout;

    const summaryEvent = bundle.runtime.ops.events.records
      .query("tree-carry-instructions-session", { type: "branch_summary_recorded" })
      .at(-1);
    expect(summaryEvent?.payload).toMatchObject({
      summary: expect.stringContaining("abandoned branch"),
      details: {
        instructions: "Preserve the successful design decision.",
      },
    });
    runtime.dispose();
  });

  test("tree carry summary records textual continuity without copying abandoned entries as messages", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-carry-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-carry-session");
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const answerEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
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
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.branch(answerEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "abandoned branch raw read result" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);

    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    const replacedMessages: unknown[][] = [];
    session.sessionManager = store;
    session.replaceMessages = async (messages) => {
      replacedMessages.push(messages);
    };
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: -1 });
    await runtime.handleInput({
      key: "character",
      text: "c",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const lastMessages = (replacedMessages.at(-1) ?? []) as Array<{
      role?: string;
      content?: unknown;
      summary?: string;
    }>;
    expect(store.getBranch().some((entry) => entry.type === "branch_summary")).toBe(true);
    expect(
      lastMessages.some(
        (message) =>
          message.role === "branchSummary" &&
          message.summary?.includes("abandoned branch raw read result"),
      ),
    ).toBe(true);
    expect(
      lastMessages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("abandoned branch raw read result"),
      ),
    ).toBe(false);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: expect.stringContaining("branch carry summary"),
    });
    runtime.dispose();
  });

  test("tree rewind opens escalation choices and applies carried rewind for an exact checkpoint", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-rewind-exact-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-rewind-exact-session");
    const userEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "exact checkpoint prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const checkpoint = {
      checkpointId: "checkpoint-exact",
      sessionId: "tree-rewind-exact-session",
      turnId: "turn-1",
      reasoningCheckpointId: "reasoning-1",
      leafEntryId: userEntryId,
      prompt: { text: "exact checkpoint prompt", parts: [] },
      turn: 1,
      eventId: "event-checkpoint",
      timestamp: Date.now(),
      status: "active" as const,
      patchSetIds: [],
      returnLeafEntryId: null,
    };
    const rewinds: unknown[] = [];
    Object.assign(bundle.runtime.ops.session.rewind, {
      getState() {
        return {
          checkpoints: [checkpoint],
          rewindAvailable: true,
          redoAvailable: false,
          redoStack: [],
        };
      },
      listTargets() {
        return [
          {
            checkpointId: checkpoint.checkpointId,
            turn: checkpoint.turn,
            timestamp: checkpoint.timestamp,
            promptPreview: "exact checkpoint prompt",
            patchSetCountAfter: 2,
            fileSummary: { added: 0, modified: 0, deleted: 0 },
            lineage: { kind: "active" as const },
          },
        ];
      },
      rewind(_sessionId: string, input: unknown) {
        rewinds.push(input);
        const rewindInput = input as {
          mode?: "conversation" | "code" | "both";
          summary?: "none" | "carry";
        };
        return {
          ok: true as const,
          checkpoint,
          abandonedCheckpointIds: [],
          patchSetIds: [],
          rollbackResults: [],
          restoredPrompt: checkpoint.prompt,
          returnLeafEntryId: null,
          trigger: "rewind" as const,
          mode: rewindInput.mode ?? "both",
          summary: rewindInput.summary ?? "none",
        };
      },
    });
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    const treePayload = runtime.getViewState().overlay.active?.payload;
    expect(treePayload?.kind).toBe("tree");
    if (treePayload?.kind !== "tree") {
      throw new Error("Expected tree overlay.");
    }
    expect(treePayload.nodes[treePayload.selectedIndex]?.workspaceEffectPatchSetCount).toBe(2);
    expect(runtime.getViewState().overlay.active?.lines?.join("\n")).toContain("patchSetsAfter=2");
    await runtime.handleInput({
      key: "character",
      text: "r",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "select",
      title: "Tree rewind",
      message: expect.stringContaining("Workspace effects after this entry: 2 patch set(s)"),
      options: [
        "Conversation only",
        "Code only",
        "Conversation and code",
        "Conversation and code with carried summary",
      ],
    });
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    await keymapEffect(runtime, { type: "overlay.primary" });

    expect(rewinds).toEqual([
      {
        checkpointId: "checkpoint-exact",
        mode: "both",
        summary: "carry",
        returnLeafEntryId: expect.any(String),
      },
    ]);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: expect.stringContaining("both/carry"),
    });
    runtime.dispose();
  });

  test("tree rewind floors to the nearest prior checkpoint and applies rewind", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-rewind-floor-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-rewind-floor-session");
    const userEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "checkpoint prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer after checkpoint" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
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
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    const checkpoint = {
      checkpointId: "checkpoint-floor",
      sessionId: "tree-rewind-floor-session",
      turnId: "turn-1",
      reasoningCheckpointId: "reasoning-1",
      leafEntryId: userEntryId,
      prompt: { text: "checkpoint prompt", parts: [] },
      turn: 1,
      eventId: "event-checkpoint",
      timestamp: Date.now(),
      status: "active" as const,
      patchSetIds: [],
      returnLeafEntryId: null,
    };
    const rewinds: unknown[] = [];
    Object.assign(bundle.runtime.ops.session.rewind, {
      getState() {
        return {
          checkpoints: [checkpoint],
          rewindAvailable: true,
          redoAvailable: false,
          redoStack: [],
        };
      },
      listTargets() {
        return [
          {
            checkpointId: checkpoint.checkpointId,
            turn: checkpoint.turn,
            timestamp: checkpoint.timestamp,
            promptPreview: "checkpoint prompt",
            patchSetCountAfter: 0,
            fileSummary: { added: 0, modified: 0, deleted: 0 },
            lineage: { kind: "active" as const },
          },
        ];
      },
      rewind(_sessionId: string, input: unknown) {
        rewinds.push(input);
        return {
          ok: true as const,
          checkpoint,
          abandonedCheckpointIds: [],
          patchSetIds: [],
          rollbackResults: [],
          restoredPrompt: checkpoint.prompt,
          returnLeafEntryId: null,
          trigger: "rewind" as const,
          mode: "both" as const,
          summary: "none" as const,
        };
      },
    });
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    const replacedMessages: unknown[][] = [];
    session.sessionManager = store;
    session.replaceMessages = async (messages) => {
      replacedMessages.push(messages);
    };
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await runtime.handleInput({
      key: "character",
      text: "r",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    await keymapEffect(runtime, { type: "overlay.primary" });

    expect(rewinds).toEqual([
      {
        checkpointId: "checkpoint-floor",
        mode: "both",
        summary: "none",
        returnLeafEntryId: expect.any(String),
      },
    ]);
    expect(replacedMessages.length).toBeGreaterThan(0);
    expect(runtime.getViewState().composer.text).toBe("checkpoint prompt");
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: expect.stringContaining("floored to checkpoint checkpoint-floor"),
    });
    runtime.dispose();
  });

  test("tree rewind without a checkpoint stays conversation-only", async () => {
    const { bundle } = createFakeBundle({ sessionId: "tree-rewind-none-session" });
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "tree-rewind-none-session");
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "prompt without checkpoint" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const rewinds: unknown[] = [];
    Object.assign(bundle.runtime.ops.session.rewind, {
      rewind(_sessionId: string, input: unknown) {
        rewinds.push(input);
        return {
          ok: false as const,
          reason: "no_checkpoint" as const,
          trigger: "rewind" as const,
          mode: "both" as const,
          summary: "none" as const,
        };
      },
    });
    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    session.sessionManager = store;
    session.replaceMessages = async () => {};
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/tree");
    await submitComposer(runtime);
    await runtime.handleInput({
      key: "character",
      text: "r",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(rewinds).toEqual([]);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: expect.stringContaining("conversation-only checkout"),
    });
    runtime.dispose();
  });

  test("lineage overlay checkout updates the hosted branch and visible transcript", async () => {
    const { bundle } = createFakeBundle({ sessionId: "lineage-checkout-session" });
    const workspace = mkdtempSync(join(tmpdir(), "brewva-shell-lineage-checkout-"));
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "lineage-checkout-session");
    const mainEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main checkpoint" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const mainAnswerEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
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
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.branch(mainEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "experiment branch" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);

    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    const replacedMessages: unknown[][] = [];
    session.sessionManager = store;
    session.replaceMessages = async (messages) => {
      replacedMessages.push(messages);
    };

    const runtime = new CliShellRuntime(bundle, {
      cwd: workspace,
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/lineage");
    await submitComposer(runtime);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "lineage",
      selectedIndex: 1,
    });
    expect(
      (
        runtime.getViewState().overlay.active?.payload as
          | { kind: "lineage"; nodes: Array<{ lineageNodeId: string; leafEntryId: string | null }> }
          | undefined
      )?.nodes.find((node) => node.lineageNodeId === "lineage:main")?.leafEntryId,
    ).toBe(mainAnswerEntryId);

    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: -1 });
    await keymapEffect(runtime, { type: "overlay.primary" });

    expect(store.getLineageNodeId()).toBe("lineage:main");
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "lineage",
      selectedIndex: 0,
    });
    expect(
      bundle.runtime.ops.session.lineage.getTree("lineage-checkout-session").selectedByChannel.cli,
    ).toBe("lineage:main");
    expect(JSON.stringify(replacedMessages.at(-1))).toContain("main checkpoint");
    expect(JSON.stringify(replacedMessages.at(-1))).not.toContain("experiment branch");

    runtime.dispose();
  });

  test("/help opens the help hub overlay", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/help");
    await submitComposer(runtime);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "helpHub",
      title: "Help",
    });
    expect(runtime.getViewState().overlay.active?.lines?.join("\n") ?? "").toContain("Ctrl+P");

    runtime.dispose();
  });

  test("shift-tab cycles model presets and updates session status", async () => {
    const fixture = createFakeBundle({
      modelPresetState: {
        activeName: "Default",
        defaultName: "Default",
        presets: [
          { name: "Default", roles: {}, synthetic: true },
          { name: "Claude Lead", roles: { default: "anthropic/claude-main:high" } },
        ],
      },
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
    });

    await keymapCommand(runtime, "agent.preset.next");

    expect(fixture.getModelPresetState().activeName).toBe("Claude Lead");
    expect(runtime.getViewState().status.entries.preset).toBe("Claude Lead");
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Model preset: Claude Lead",
    });

    runtime.dispose();
  });

  test("shift-tab queues model preset changes while a turn is streaming", async () => {
    const prompts: string[] = [];
    const fixture = createFakeBundle({
      isStreaming: true,
      promptHandler: async (text) => {
        prompts.push(text);
      },
      modelPresetState: {
        activeName: "Default",
        defaultName: "Default",
        presets: [
          { name: "Default", roles: {}, synthetic: true },
          { name: "Claude Lead", roles: { default: "anthropic/claude-main:high" } },
        ],
      },
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
    });

    await keymapCommand(runtime, "agent.preset.next");

    expect(fixture.getModelPresetState()).toMatchObject({
      activeName: "Default",
      pendingName: "Claude Lead",
    });
    expect(runtime.getViewState().status.entries.preset).toBe("Default -> Claude Lead");

    fixture.setStreaming(false);
    runtime.ui.setEditorText("next turn");
    await submitComposer(runtime);

    expect(prompts).toEqual(["next turn"]);
    expect(fixture.getModelPresetState()).toMatchObject({
      activeName: "Claude Lead",
      pendingName: undefined,
    });

    runtime.dispose();
  });

  test("model picker selects models and persists recent/favorite preferences outside prompt turns", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
      {
        provider: "anthropic",
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        contextWindow: 200_000,
        maxTokens: 32_000,
        reasoning: true,
      },
    ];
    const fixture = createFakeBundle({ models });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model ");
    await submitComposer(runtime);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
    });

    await runtime.handleInput({
      key: "character",
      text: "f",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(fixture.getModelPreferences().favorite).toEqual([
      { provider: "anthropic", id: "claude-opus-4-6" },
    ]);

    await keymapEffect(runtime, { type: "overlay.primary" });

    expect(fixture.getCurrentModel()).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
    expect(runtime.getViewState().status.entries.model).toBe("anthropic/claude-opus-4-6");
    expect(fixture.getModelPreferences().recent[0]).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "thinkingPicker",
    });

    runtime.dispose();
  });

  test("model picker supports arrow and ctrl-n/ctrl-p navigation before selecting", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "gpt-5.4-alpha",
        name: "Alpha",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: false,
      },
      {
        provider: "openai",
        id: "gpt-5.4-beta",
        name: "Beta",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: false,
      },
    ];
    const fixture = createFakeBundle({ models });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model ");
    await submitComposer(runtime);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      selectedIndex: 0,
    });

    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      selectedIndex: 1,
    });

    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: -1 });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      selectedIndex: 0,
    });

    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      selectedIndex: 1,
    });

    await keymapEffect(runtime, { type: "overlay.primary" });

    expect(fixture.getCurrentModel()).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-beta",
    });
    expect(runtime.getViewState().overlay.active).toBe(undefined);

    runtime.dispose();
  });

  test("model picker exposes disconnected providers when model search matches their catalog", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
    ];
    const providers: ProviderConnectionDescriptor[] = [
      {
        id: "openai",
        name: "OpenAI",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://openai/apiKey",
      },
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://openai-codex/apiKey",
      },
    ];
    const fixture = createFakeBundle({ models, availableModelKeys: [], providers });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model gpt");
    await submitComposer(runtime);

    const payload = runtime.getViewState().overlay.active?.payload;
    expect(payload).toMatchObject({
      kind: "modelPicker",
      query: "gpt",
    });
    if (payload?.kind !== "modelPicker") {
      throw new Error("Expected model picker payload.");
    }

    expect(payload.items.map((item) => item.label)).toEqual(["OpenAI", "OpenAI Codex"]);
    expect(payload.items.every((item) => item.kind === "connect_provider")).toBe(true);

    runtime.dispose();
  });

  test("model picker rows keep long provider model ids out of inline details", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "google",
        id: "gemini-2.5-flash-lite-preview-06-17",
        name: "Gemini 2.5 Flash Lite Preview 06-17",
        contextWindow: 1_000_000,
        maxTokens: 16_384,
        reasoning: true,
      },
    ];
    const { bundle } = createFakeBundle({ models });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model gemini");
    await submitComposer(runtime);

    const payload = runtime.getViewState().overlay.active?.payload;
    if (payload?.kind !== "modelPicker") {
      throw new Error("Expected model picker payload.");
    }

    expect(payload.items[0]).toMatchObject({
      kind: "model",
      section: "Google",
      label: "Gemini 2.5 Flash Lite Preview 06-17",
      detail: undefined,
      footer: undefined,
    });

    runtime.dispose();
  });

  test("model picker routes disconnected OpenAI Codex models through the consolidated OpenAI connect flow", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
    ];
    const providers: ProviderConnectionDescriptor[] = [
      {
        id: "openai",
        name: "OpenAI",
        description: "ChatGPT Plus/Pro or API key",
        group: "popular",
        connected: true,
        connectionSource: "vault",
        modelProviders: ["openai", "openai-codex"],
        modelCount: 2,
        availableModelCount: 1,
        credentialRef: "vault://openai/apiKey",
      },
    ];
    const fixture = createFakeBundle({
      models,
      availableModelKeys: ["openai/gpt-5.4"],
      providers,
      authMethods: {
        openai: [
          {
            id: "chatgpt_browser",
            kind: "oauth",
            type: "oauth",
            label: "ChatGPT Pro/Plus (browser)",
            credentialProvider: "openai-codex",
            modelProviderFilter: "openai-codex",
          },
          {
            id: "chatgpt_headless",
            kind: "oauth",
            type: "oauth",
            label: "ChatGPT Pro/Plus (headless)",
            credentialProvider: "openai-codex",
            modelProviderFilter: "openai-codex",
          },
          {
            id: "api_key",
            kind: "api_key",
            type: "api",
            label: "Manually enter API Key",
            credentialRef: "vault://openai/apiKey",
          },
        ],
      },
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model codex");
    await submitComposer(runtime);
    await keymapEffect(runtime, { type: "overlay.primary" });
    await Bun.sleep(0);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "authMethodPicker",
      items: [
        { id: "chatgpt_browser", label: "ChatGPT Pro/Plus (browser)", detail: "OAuth" },
        { id: "chatgpt_headless", label: "ChatGPT Pro/Plus (headless)", detail: "OAuth" },
        { id: "api_key", label: "Manually enter API Key", detail: "API key" },
      ],
    });

    runtime.dispose();
  });

  test("model picker fuzzy search matches non-contiguous model names", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "google",
        id: "gemini-2.5-flash-lite-preview-06-17",
        name: "Gemini 2.5 Flash Lite Preview 06-17",
        contextWindow: 1_000_000,
        maxTokens: 16_384,
        reasoning: true,
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        maxTokens: 16_384,
        reasoning: true,
      },
    ];
    const { bundle } = createFakeBundle({ models });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model gmni");
    await submitComposer(runtime);

    const payload = runtime.getViewState().overlay.active?.payload;
    if (payload?.kind !== "modelPicker") {
      throw new Error("Expected model picker payload.");
    }

    expect(payload.items.map((item) => item.label)).toEqual([
      "Gemini 2.5 Flash Lite Preview 06-17",
    ]);

    runtime.dispose();
  });

  test("model picker c shortcut opens the provider connection picker", async () => {
    const providers: ProviderConnectionDescriptor[] = [
      {
        id: "openai",
        name: "OpenAI",
        description: "ChatGPT Plus/Pro or API key",
        group: "popular",
        connected: true,
        connectionSource: "oauth",
        modelProviders: ["openai", "openai-codex"],
        modelCount: 2,
        availableModelCount: 1,
        credentialRef: "vault://openai/apiKey",
      },
    ];
    const fixture = createFakeBundle({ providers });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model ");
    await submitComposer(runtime);
    await runtime.handleInput({
      key: "character",
      text: "codex",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "character",
      text: " ",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "character",
      text: "c",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "providerPicker",
      query: "codex ",
    });

    runtime.dispose();
  });

  test("session switching preserves drafts per session and restores them when returning", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("session-1"),
        eventCount: 14,
        lastEventAt: 1_710_000_000_000,
        title: "Session One",
      },
      {
        sessionId: asBrewvaSessionId("session-2"),
        eventCount: 9,
        lastEventAt: 1_710_000_100_000,
        title: "Session Two",
      },
    ] satisfies BrewvaReplaySession[];

    const first = createFakeBundle({
      sessionId: "session-1",
      replaySessions,
    });
    const second = createFakeBundle({
      sessionId: "session-2",
      replaySessions,
    });

    const bundles = new Map([
      ["session-1", first.bundle],
      ["session-2", second.bundle],
    ]);

    const runtime = new CliShellRuntime(first.bundle, {
      cwd: process.cwd(),
      openSession: async (sessionId) => bundles.get(sessionId) ?? first.bundle,
      createSession: async () => second.bundle,
    });

    runtime.ui.setEditorText("draft one");
    runtime.openOverlay({
      kind: "sessions",
      selectedIndex: 1,
      query: "",
      sessions: replaySessions,
      currentSessionId: "session-1",
      draftStateBySessionId: {
        "session-1": {
          characters: 9,
          lines: 1,
          preview: "draft one",
        },
      },
    });

    await keymapEffect(runtime, { type: "overlay.primary" });

    expect(runtime.getSessionBundle().session.sessionManager.getSessionId()).toBe("session-2");
    expect(runtime.ui.getEditorText()).toBe("");

    runtime.ui.setEditorText("draft two");
    runtime.openOverlay({
      kind: "sessions",
      selectedIndex: 0,
      query: "",
      sessions: replaySessions,
      currentSessionId: "session-2",
      draftStateBySessionId: {
        "session-1": {
          characters: 9,
          lines: 1,
          preview: "draft one",
        },
        "session-2": {
          characters: 9,
          lines: 1,
          preview: "draft two",
        },
      },
    });

    await keymapEffect(runtime, { type: "overlay.primary" });

    expect(runtime.getSessionBundle().session.sessionManager.getSessionId()).toBe("session-1");
    expect(runtime.ui.getEditorText()).toBe("draft one");
    runtime.dispose();
  });

  test("session switching seeds queued prompts from the target session immediately", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("session-1"),
        eventCount: 14,
        lastEventAt: 1_710_000_000_000,
        title: "Session One",
      },
      {
        sessionId: asBrewvaSessionId("session-2"),
        eventCount: 9,
        lastEventAt: 1_710_000_100_000,
        title: "Session Two",
      },
    ] satisfies BrewvaReplaySession[];

    const first = createFakeBundle({
      sessionId: "session-1",
      replaySessions,
    });
    const secondQueuedPrompts: BrewvaQueuedPromptView[] = [
      {
        promptId: "queued-1",
        text: "Queued prompt from session two",
        submittedAt: 2,
        behavior: "queue",
      },
    ];
    const second = createFakeBundle({
      sessionId: "session-2",
      replaySessions,
      queuedPrompts: secondQueuedPrompts,
    });

    const bundles = new Map([
      ["session-1", first.bundle],
      ["session-2", second.bundle],
    ]);

    const runtime = new CliShellRuntime(first.bundle, {
      cwd: process.cwd(),
      openSession: async (sessionId) => bundles.get(sessionId) ?? first.bundle,
      createSession: async () => second.bundle,
    });

    runtime.openOverlay({
      kind: "sessions",
      selectedIndex: 1,
      query: "",
      sessions: replaySessions,
      currentSessionId: "session-1",
      draftStateBySessionId: {},
    });

    await keymapEffect(runtime, { type: "overlay.primary" });

    expect(runtime.getSessionBundle().session.sessionManager.getSessionId()).toBe("session-2");
    expect(runtime.getViewState().queue).toEqual(secondQueuedPrompts);
    runtime.dispose();
  });

  test("sessions overlay text input filters sessions by title", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("session-1"),
        eventCount: 14,
        lastEventAt: 1_710_000_000_000,
        title: "Command Palette Polish",
      },
      {
        sessionId: asBrewvaSessionId("session-2"),
        eventCount: 9,
        lastEventAt: 1_710_000_100_000,
        title: "Runtime Projection Cleanup",
      },
    ] satisfies BrewvaReplaySession[];

    const { bundle } = createFakeBundle({
      sessionId: "session-1",
      replaySessions,
    });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();
    await keymapCommand(runtime, "session.list");
    await runtime.handleInput({
      key: "character",
      text: "runtime",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const payload = runtime.getViewState().overlay.active?.payload;
    expect(payload).toMatchObject({
      kind: "sessions",
      query: "runtime",
      selectedIndex: 0,
    });
    expect(
      payload?.kind === "sessions" ? payload.sessions.map((session) => session.title) : [],
    ).toEqual(["Runtime Projection Cleanup"]);
    runtime.dispose();
  });

  test("queue overlay closes after deleting the last queued prompt", async () => {
    const queuedPrompts: BrewvaQueuedPromptView[] = [
      {
        promptId: "queued-1",
        text: "Queued prompt",
        submittedAt: 1,
        behavior: "queue",
      },
    ];
    const { bundle } = createFakeBundle({ queuedPrompts });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();
    runtime.ui.setEditorText("draft");
    await keymapCommand(runtime, "session.queue");

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "queue",
      selectedIndex: 0,
    });
    expect(runtime.ui.getEditorText()).toBe("draft");

    await runtime.handleInput({
      key: "character",
      text: "d",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().queue).toEqual([]);
    expect(runtime.getViewState().overlay.active).toBe(undefined);
    runtime.dispose();
  });

  test("queue overlay notifies when the selected queued prompt leaves the queue", async () => {
    const firstQueuedPrompt: BrewvaQueuedPromptView = {
      promptId: "queued-1",
      text: "First queued prompt",
      submittedAt: 1,
      behavior: "queue",
    };
    const secondQueuedPrompt: BrewvaQueuedPromptView = {
      promptId: "queued-2",
      text: "Second queued prompt",
      submittedAt: 2,
      behavior: "queue",
    };
    const fixture = createFakeBundle({
      queuedPrompts: [firstQueuedPrompt, secondQueuedPrompt],
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();
    await keymapCommand(runtime, "session.queue");

    fixture.emitSessionEvent({
      type: "queue.changed",
      items: [secondQueuedPrompt],
    });

    expect(
      runtime.getViewState().notifications.map((notification) => notification.message),
    ).toContain("Selected queued prompt left the queue.");
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "queue",
      selectedIndex: 0,
      items: [secondQueuedPrompt],
    });
    runtime.dispose();
  });

  test("session browser still surfaces the current session before any replay events exist", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("archived-session"),
        eventCount: 12,
        lastEventAt: 1_710_000_000_000,
        title: "Archived session",
      },
    ] satisfies BrewvaReplaySession[];

    const { bundle } = createFakeBundle({
      sessionId: "fresh-session",
      replaySessions,
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();
    runtime.ui.setEditorText("draft before first turn");
    await keymapCommand(runtime, "session.list");

    const payload = runtime.getViewState().overlay.active?.payload;
    expect(payload).toMatchObject({
      kind: "sessions",
      currentSessionId: "fresh-session",
    });
    expect(
      payload?.kind === "sessions" ? payload.sessions.map((session) => session.sessionId) : [],
    ).toEqual([asBrewvaSessionId("fresh-session"), asBrewvaSessionId("archived-session")]);
    expect(
      payload?.kind === "sessions" ? payload.draftStateBySessionId["fresh-session"] : undefined,
    ).toMatchObject({
      lines: 1,
      preview: "draft before first turn",
    });
    runtime.dispose();
  });
});
