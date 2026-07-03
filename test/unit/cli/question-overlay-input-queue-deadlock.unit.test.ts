import { describe, expect, test } from "bun:test";
import type {
  BrewvaInteractiveQuestionRequest,
  BrewvaToolUiPort,
} from "@brewva/brewva-substrate/host-api";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import { parseKeypress } from "@opentui/core";
import {
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
  type OpenTuiRenderer,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { BrewvaFullScreenShell } from "../../../packages/brewva-cli/runtime/opentui-shell-renderer.js";
import {
  createCliInspectPort,
  createCliOperatorPort,
} from "../../../packages/brewva-cli/src/runtime/cli-runtime-ports.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/ports/session-port.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/api.js";

interface BuildBundleOptions {
  onPrompt?: (ui: BrewvaToolUiPort) => Promise<void>;
  streamingFromStart?: boolean;
}

function buildBundle(options: BuildBundleOptions = {}) {
  let attachedUi: BrewvaToolUiPort | undefined;
  let sessionListener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
  let streaming = options.streamingFromStart === true;
  let turnActive = false;
  const idleWaiters: Array<() => void> = [];
  const resolveIdleWaiters = (): void => {
    while (idleWaiters.length > 0) {
      idleWaiters.shift()?.();
    }
  };
  const sessionId = "session-repro";
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
    modelRegistry: {
      getAll: () => [model],
      getAvailable: () => [model],
    },
    get isStreaming() {
      return streaming;
    },
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
    async prompt() {
      if (!options.onPrompt) {
        return;
      }
      turnActive = true;
      try {
        await options.onPrompt(attachedUi!);
      } finally {
        streaming = false;
        turnActive = false;
        resolveIdleWaiters();
      }
    },
    getQueuedPrompts: () => [],
    removeQueuedPrompt() {},
    getAvailableThinkingLevels: () => ["off", "low", "high"],
    setThinkingLevel() {},
    // Models managed-agent session.abort(): it signals the abort but then
    // `await waitForIdle()`. The interactive `question` tool blocks interrupt,
    // so the turn stays active until it is ANSWERED — waitForIdle resolves only
    // when `prompt()` returns.
    abort(): Promise<void> {
      return session.waitForIdle();
    },
    waitForIdle(): Promise<void> {
      if (!turnActive) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
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

function dispatchKey(renderer: OpenTuiRenderer, sequence: string): void {
  const parsed = parseKeypress(sequence, { useKittyKeyboard: true });
  if (!parsed) {
    throw new Error(`failed to parse key sequence ${JSON.stringify(sequence)}`);
  }
  (
    renderer as unknown as {
      keyInput: { processParsedKey(key: typeof parsed): boolean };
    }
  ).keyInput.processParsedKey(parsed);
}

const QUESTION_REQUEST: BrewvaInteractiveQuestionRequest = {
  toolCallId: "call_repro_1",
  title: "实现方式确认",
  questions: [
    {
      header: "范围",
      question: "你要我直接在现有仓库里新增，还是只做独立骨架？",
      options: [
        { label: "直接集成到当前仓库", description: "在当前仓库中新建/修改" },
        { label: "只做独立骨架", description: "只输出应用骨架" },
      ],
      custom: true,
    },
  ],
};

describe("question overlay: the input queue is not wedged while a question is open", () => {
  // The full-screen shell drives a native OpenTUI renderer; Bun v1.3.12 crashes
  // during native teardown on Linux CI (segfault outside test code). Run locally
  // with `bun run test:tui`; skip in CI.
  if (process.env.CI === "true") {
    test("skipped in CI (native TUI)", () => {
      expect(true).toBe(true);
    });
    return;
  }

  test("baseline: pressing digit 1 selects the first option and settles the request", async () => {
    const { bundle, getAttachedUi } = buildBundle();
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

    let settledValue: unknown = "PENDING";
    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const ui = getAttachedUi();
      expect(typeof ui?.custom).toBe("function");
      void ui!
        .custom<readonly (readonly string[])[] | undefined>("question", QUESTION_REQUEST)
        .then((value) => {
          settledValue = value;
        });
      await openTuiSolidAct(async () => {
        await Bun.sleep(20);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("范围");

      await openTuiSolidAct(async () => {
        dispatchKey(testSetup.renderer, "1");
        await Bun.sleep(20);
      });
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        await Bun.sleep(20);
      });
      expect(settledValue).toEqual([["直接集成到当前仓库"]]);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  // Faithful production path: the user types a task and presses Enter. Enter
  // routes through the keymap `composer.submit` short-circuit to the runtime's
  // fire-and-forget `submitComposer()`, the turn opens an interactive `question`
  // overlay, and the user answers it with a digit. Every keystroke must reach
  // the overlay — the submit must never hold the serialized `#semanticInputQueue`
  // across the turn.
  test("typed task submitted with Enter, then the question answers with a digit", async () => {
    let questionSettled: unknown = "PENDING";
    // streamingFromStart routes the fake session port to `bundle.session.prompt`
    // (our onPrompt) instead of the hosted-turn engine the fake does not model;
    // the submit itself is still the real fire-and-forget path under test.
    const { bundle } = buildBundle({
      streamingFromStart: true,
      onPrompt: async (ui) => {
        // The turn's tool executor opens the interactive question and blocks the
        // turn until it is answered — exactly what the `question` tool does.
        const answer = await ui.custom<readonly (readonly string[])[] | undefined>(
          "question",
          QUESTION_REQUEST,
        );
        questionSettled = answer;
      },
    });

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
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      // Type a task and press Enter through the real key pipeline.
      runtime.ui.setEditorText("build the macOS menubar app");
      await openTuiSolidAct(async () => {
        await Bun.sleep(10);
      });
      await openTuiSolidAct(async () => {
        dispatchKey(testSetup.renderer, "\r");
        await Bun.sleep(40);
      });

      // Let the turn start and the question overlay mount.
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("范围");

      // Answer the question with digit "1" through the real key pipeline.
      await openTuiSolidAct(async () => {
        dispatchKey(testSetup.renderer, "1");
        await Bun.sleep(40);
      });
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        await Bun.sleep(40);
      });

      expect(questionSettled).toEqual([["直接集成到当前仓库"]]);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  // The reported freeze: the user presses Esc on a slow-looking streaming turn.
  // `Esc` while streaming with no overlay routes to `session.abort`, which runs
  // inside the serialized `#semanticInputQueue` and awaits `waitForIdle()`. The
  // turn then opens an interactive `question` (interrupt behavior "block"), so it
  // never goes idle until answered — and answering needs the same queue the abort
  // is holding. Every later keystroke queues forever; the TUI freezes until killed.
  test("Esc-abort while streaming does not wedge the question keystrokes", async () => {
    let questionSettled: unknown = "PENDING";
    const { bundle } = buildBundle({
      streamingFromStart: true,
      onPrompt: async (ui) => {
        // Let the Esc-abort get queued before the question overlay opens (Esc
        // must route to session.abort, not to the overlay).
        await Bun.sleep(60);
        const answer = await ui.custom<readonly (readonly string[])[] | undefined>(
          "question",
          QUESTION_REQUEST,
        );
        questionSettled = answer;
      },
    });

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
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      // Type a task and press Enter (fire-and-forget submit starts the turn).
      runtime.ui.setEditorText("build the macOS menubar app");
      await openTuiSolidAct(async () => {
        await Bun.sleep(10);
      });
      await openTuiSolidAct(async () => {
        dispatchKey(testSetup.renderer, "\r");
        await Bun.sleep(10);
      });

      // Press Esc while the turn is streaming and no overlay is open yet — this
      // routes to session.abort.
      await openTuiSolidAct(async () => {
        dispatchKey(testSetup.renderer, "\x1b");
        await Bun.sleep(10);
      });

      // The question overlay opens after the abort is already queued.
      await openTuiSolidAct(async () => {
        await Bun.sleep(80);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("范围");

      // Answer the question with digit "1".
      await openTuiSolidAct(async () => {
        dispatchKey(testSetup.renderer, "1");
        await Bun.sleep(40);
      });
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        await Bun.sleep(40);
      });

      // In the buggy build the abort holds the queue and this stays PENDING; in
      // the fixed build the keystroke reaches the overlay and settles it.
      expect(questionSettled).toEqual([["直接集成到当前仓库"]]);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });
});
