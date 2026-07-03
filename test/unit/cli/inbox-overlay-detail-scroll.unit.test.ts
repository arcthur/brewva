import { describe, expect, test } from "bun:test";
import type { BrewvaToolUiPort } from "@brewva/brewva-substrate/host-api";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import {
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { BrewvaFullScreenShell } from "../../../packages/brewva-cli/runtime/opentui-shell-renderer.js";
import {
  createCliInspectPort,
  createCliOperatorPort,
} from "../../../packages/brewva-cli/src/runtime/cli-runtime-ports.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/ports/session-port.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/api.js";

function buildBundle() {
  let attachedUi: BrewvaToolUiPort | undefined;
  let sessionListener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
  const sessionId = "session-inbox";
  const model = {
    provider: "openai",
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: true,
  };
  const session = {
    get model() {
      return model;
    },
    get thinkingLevel() {
      return "high";
    },
    modelRegistry: { getAll: () => [model], getAvailable: () => [model] },
    isStreaming: false,
    sessionManager: {
      getSessionId: () => sessionId,
      buildSessionContext: () => ({ messages: [] }),
    },
    settingsManager: {
      getQuietStartup: () => false,
      getModelPreferences: () => ({ recent: [], favorite: [] }),
      setModelPreferences() {},
      getDiffPreferences: () => ({ style: "auto" as const, wrapMode: "word" as const }),
      setDiffPreferences() {},
      getShellViewPreferences: () => ({ showThinking: true, toolDetails: true }),
      setShellViewPreferences() {},
    },
    subscribe(listener: (event: BrewvaPromptSessionEvent) => void) {
      sessionListener = listener;
      return () => {
        if (sessionListener === listener) {
          sessionListener = undefined;
        }
      };
    },
    async prompt() {},
    getQueuedPrompts: () => [],
    removeQueuedPrompt() {},
    getAvailableThinkingLevels: () => ["off", "low", "high"],
    setThinkingLevel() {},
    dispose() {},
    setUiPort(ui: BrewvaToolUiPort) {
      attachedUi = ui;
    },
  };

  const runtime = {
    identity: { cwd: process.cwd(), workspaceRoot: process.cwd(), agentId: "test-agent" },
    ops: {
      session: {
        rewind: {
          recordCheckpoint() {},
          rewind: () => ({ ok: false, reason: "no_checkpoint" }),
          redo: () => ({ ok: false, reason: "no_redo" }),
          getState: () => ({
            checkpoints: [],
            rewindAvailable: false,
            redoAvailable: false,
            redoStack: [],
          }),
          listTargets: () => [],
        },
        lineage: { getContextEntryPath: () => [] },
      },
      skills: {
        catalog: {
          getLoadReport: () => ({
            roots: [],
            loadedSkills: [],
            selectableSkills: [],
            overlaySkills: [],
            categories: {},
          }),
          list: () => [],
        },
      },
      proposals: {
        requests: {
          decide: (_s: string, requestId: string) => ({
            requestId,
            decision: "accept",
            applied: true,
          }),
          listPending: () => [],
          list: () => [],
        },
      },
      events: {
        records: { list: () => [], query: () => [] },
        replay: {
          listSessions: () => [
            { sessionId, eventCount: 1, lastEventAt: Date.now(), title: "New session" },
          ],
        },
      },
      sessionWire: { query: () => [] },
    },
  } as unknown as HostedRuntimeAdapterPort;

  const bundle = {
    session,
    toolDefinitions: new Map(),
    runtime,
    inspect: createCliInspectPort(runtime),
    operator: createCliOperatorPort(runtime),
  } as unknown as CliShellSessionBundle;

  return { bundle, getAttachedUi: () => attachedUi };
}

// 40 uniquely-tagged lines so the detail cannot possibly fit the overlay.
const LONG_MESSAGE = Array.from(
  { length: 40 },
  (_, index) => `LINE_${String(index).padStart(2, "0")}`,
).join("\n");

describe("inbox overlay: long notification detail stays inside the overlay and scrolls", () => {
  if (process.env.CI === "true") {
    test("skipped in CI (native TUI)", () => {
      expect(true).toBe(true);
    });
    return;
  }

  test("clips overflowing detail, keeps the footer visible, and scrolls with PgDn", async () => {
    const { bundle } = buildBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    await runtime.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaFullScreenShell, { runtime }),
      { width: 100, height: 24 },
    );

    try {
      runtime.ui.notify(LONG_MESSAGE, "error");
      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          type: "keymap.command",
          commandId: "operator.inbox",
          source: "keybinding",
        });
        await Bun.sleep(20);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const initial = testSetup.captureCharFrame();
      // Overlay chrome intact: the footer is not pushed off-screen by the detail.
      expect(initial).toContain("Inbox");
      expect(initial).toContain("Esc close");
      // Content is clipped, so the scroll affordance is shown and the top of the
      // detail is visible while the tail is not.
      expect(initial).toContain("PgUp/PgDn");
      expect(initial).toContain("LINE_00");
      expect(initial).not.toContain("LINE_39");

      // Page down enough to reach the tail of the notification.
      for (let page = 0; page < 12; page += 1) {
        await openTuiSolidAct(async () => {
          await runtime.handleInput({
            type: "keymap.effect",
            effect: { type: "overlay.scrollPage", direction: 1 },
          });
        });
      }
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const scrolled = testSetup.captureCharFrame();
      expect(scrolled).toContain("LINE_39");
      // Footer still present after scrolling — detail never escaped the overlay.
      expect(scrolled).toContain("Esc close");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("changing the selected item resets the detail scroll to the top", async () => {
    const { bundle } = buildBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    await runtime.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaFullScreenShell, { runtime }),
      { width: 100, height: 24 },
    );

    try {
      // Two notifications; newest is selected first (list is reversed).
      runtime.ui.notify("SHORT_OTHER notification body", "info");
      runtime.ui.notify(LONG_MESSAGE, "error");
      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          type: "keymap.command",
          commandId: "operator.inbox",
          source: "keybinding",
        });
        await Bun.sleep(20);
      });
      await testSetup.renderOnce();

      // Scroll the long (selected) notification down.
      for (let page = 0; page < 12; page += 1) {
        await openTuiSolidAct(async () => {
          await runtime.handleInput({
            type: "keymap.effect",
            effect: { type: "overlay.scrollPage", direction: 1 },
          });
        });
      }
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("LINE_39");

      // Move selection to the other item, then back: the long detail must be at
      // the top again (LINE_00 visible, tail hidden), not still scrolled.
      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          type: "keymap.effect",
          effect: { type: "overlay.moveSelection", delta: 1 },
        });
        await runtime.handleInput({
          type: "keymap.effect",
          effect: { type: "overlay.moveSelection", delta: -1 },
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const reselected = testSetup.captureCharFrame();
      expect(reselected).toContain("LINE_00");
      expect(reselected).not.toContain("LINE_39");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });
});
