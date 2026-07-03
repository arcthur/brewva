import { describe, expect, test } from "bun:test";
import {
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { BrewvaFullScreenShell } from "../../../packages/brewva-cli/runtime/opentui-shell-renderer.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import { createShellFixture } from "../../helpers/shell-fixture.js";

// Live-repro of the reported "TUI freeze": with any modal overlay open, the
// arrow keys / ctrl+n / escape do nothing — the dialog cannot be navigated or
// dismissed, which reads as a frozen UI. Drives the REAL renderer + keymap.

async function invokePaletteCommand(runtime: CliShellRuntime, commandId: string): Promise<boolean> {
  return await (
    runtime as unknown as {
      handleShellIntent(intent: {
        type: "command.invoke";
        commandId: string;
        args: string;
        source: "palette";
      }): Promise<boolean>;
    }
  ).handleShellIntent({ type: "command.invoke", commandId, args: "", source: "palette" });
}

describe("overlay keyboard navigation (real renderer)", () => {
  test("models dialog responds to down / ctrl+n / escape", async () => {
    const fixture = createShellFixture({
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5.5",
          name: "GPT-5.5",
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoning: true,
        },
        {
          provider: "openai-codex",
          id: "gpt-5.5-pro",
          name: "GPT-5.5 Pro",
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoning: true,
        },
      ],
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      operatorPollIntervalMs: 600_000,
    });

    await runtime.start();
    await invokePaletteCommand(runtime, "agent.model");
    expect(runtime.getViewState().overlay.active?.payload?.kind).toBe("modelPicker");

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaFullScreenShell, { runtime }),
      { width: 100, height: 30 },
    );

    const selectedIndex = () => {
      const payload = runtime.getViewState().overlay.active?.payload;
      return payload && "selectedIndex" in payload ? payload.selectedIndex : -1;
    };

    try {
      await testSetup.renderOnce();
      expect(selectedIndex()).toBe(0);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ARROW_DOWN");
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(1);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ARROW_UP");
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(0);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("n", { ctrl: true });
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(1);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ESCAPE");
        // A lone ESC byte sits in the ANSI parser until its escape-sequence
        // timeout confirms it is not a sequence prefix.
        await Bun.sleep(80);
      });
      expect(runtime.getViewState().overlay.active).toBe(undefined);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("models dialog responds to keys under the kitty keyboard protocol", async () => {
    // The interactive shell enables kitty keyboard (disambiguate) on capable
    // terminals, which re-encodes escape / ctrl+n / arrows as CSI-u sequences.
    // The classic-ANSI variant above passing while this fails means the key
    // PARSING layer, not the keymap, drops kitty-encoded keys.
    const fixture = createShellFixture({
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5.5",
          name: "GPT-5.5",
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoning: true,
        },
        {
          provider: "openai-codex",
          id: "gpt-5.5-pro",
          name: "GPT-5.5 Pro",
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoning: true,
        },
      ],
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      operatorPollIntervalMs: 600_000,
    });

    await runtime.start();
    await invokePaletteCommand(runtime, "agent.model");

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaFullScreenShell, { runtime }),
      { width: 100, height: 30, kittyKeyboard: true },
    );

    const selectedIndex = () => {
      const payload = runtime.getViewState().overlay.active?.payload;
      return payload && "selectedIndex" in payload ? payload.selectedIndex : -1;
    };

    try {
      await testSetup.renderOnce();
      expect(selectedIndex()).toBe(0);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ARROW_DOWN");
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(1);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("n", { ctrl: true });
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(0);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ESCAPE");
        await Bun.sleep(80);
      });
      expect(runtime.getViewState().overlay.active).toBe(undefined);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("a mouse text selection must not capture the keyboard away from an overlay", async () => {
    // Regression for the "overlay frozen after connecting a provider" report:
    // switching back from the browser OAuth approval, a stray mouse drag left a
    // renderer text selection. Selection mode then captured the keymap — every
    // overlay key (arrows, ctrl+n, escape) fell into the selection layer's two
    // bindings — and because the renderer selection lives outside the reactive
    // graph, even clearing it never recomputed the mode. Keyboard dead, "TUI
    // frozen".
    const fixture = createShellFixture({
      transcriptSeed: [
        { role: "assistant", content: "some transcript text to select with the mouse" },
      ],
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5.5",
          name: "GPT-5.5",
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoning: true,
        },
        {
          provider: "openai-codex",
          id: "gpt-5.5-pro",
          name: "GPT-5.5 Pro",
          contextWindow: 400_000,
          maxTokens: 128_000,
          reasoning: true,
        },
      ],
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      operatorPollIntervalMs: 600_000,
    });

    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaFullScreenShell, { runtime }),
      { width: 100, height: 30 },
    );

    const selectedIndex = () => {
      const payload = runtime.getViewState().overlay.active?.payload;
      return payload && "selectedIndex" in payload ? payload.selectedIndex : -1;
    };

    // The harness cannot produce a real mouse drag-selection (no selectable
    // text renderable), so inject the selection OBJECT while keeping the whole
    // fixed chain real: renderer `selection` event -> wiring signal -> keymap
    // mode memo -> layer activation, and the selection layer's escape ->
    // clearSelection -> mode recovery.
    const rendererWithSelection = testSetup.renderer as unknown as {
      getSelection(): object | null;
      clearSelection(): void;
      emit(event: string, payload: unknown): boolean;
    };
    let fakeSelection: { getSelectedText(): string } | null = null;
    rendererWithSelection.getSelection = () => fakeSelection;
    rendererWithSelection.clearSelection = () => {
      fakeSelection = null;
    };

    try {
      await testSetup.renderOnce();

      // The stray drag the operator makes when refocusing the terminal window —
      // a REAL drag, so the selection carries text.
      await openTuiSolidAct(async () => {
        fakeSelection = { getSelectedText: () => "some transcript text" };
        rendererWithSelection.emit("selection", fakeSelection);
        await Bun.sleep(0);
      });

      // The models dialog opened over that selection still owns the keyboard.
      await invokePaletteCommand(runtime, "agent.model");
      await testSetup.renderOnce();
      expect(runtime.getViewState().overlay.active?.payload?.kind).toBe("modelPicker");

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ARROW_DOWN");
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(1);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ESCAPE");
        await Bun.sleep(80);
      });
      expect(runtime.getViewState().overlay.active).toBe(undefined);

      // Without an overlay the selection layer owns escape: the FIRST escape
      // clears the selection AND the keymap must leave selection mode with it
      // (the reactivity half of the bug), so the next overlay navigates again.
      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ESCAPE");
        await Bun.sleep(80);
      });
      expect(fakeSelection).toBe(null);

      await invokePaletteCommand(runtime, "agent.model");
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ARROW_DOWN");
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(1);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("an empty click-selection must not disable the composer's editing keys", async () => {
    // A bare left-click on selectable content creates a Selection object with
    // NO text (anchor == focus) that lingers until cleared. Treating that
    // object as "selection mode" silently deactivates the composer textarea
    // binding layer: printable keys still insert (native path) but backspace /
    // arrows do nothing — "I can type but I can't delete", reported right
    // after a provider connect because approving OAuth in the browser means
    // clicking back into the terminal.
    const fixture = createShellFixture({});
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      operatorPollIntervalMs: 600_000,
    });

    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaFullScreenShell, { runtime }),
      { width: 100, height: 30 },
    );

    const rendererWithSelection = testSetup.renderer as unknown as {
      getSelection(): object | null;
      emit(event: string, payload: unknown): boolean;
    };
    // The empty selection a bare click leaves behind.
    const emptySelection = { getSelectedText: () => "" };
    rendererWithSelection.getSelection = () => emptySelection;

    try {
      await testSetup.renderOnce();

      await openTuiSolidAct(async () => {
        rendererWithSelection.emit("selection", emptySelection);
        await Bun.sleep(0);
      });
      // An unrelated state commit — the trigger that used to flip the mode.
      runtime.ui.notify("unrelated state change", "info");
      await testSetup.renderOnce();

      await openTuiSolidAct(async () => {
        await testSetup.mockInput.typeText("ab");
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("ab");

      // Backspace must still be wired to the composer textarea.
      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("BACKSPACE");
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).not.toContain("ab");
      expect(frame).toContain("a");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("inbox overlay responds to down / ctrl+n / ctrl+p / escape", async () => {
    const fixture = createShellFixture({});
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      operatorPollIntervalMs: 600_000,
    });

    await runtime.start();
    // Two notifications so the inbox has at least two selectable rows.
    runtime.ui.notify("first failure detail", "error");
    runtime.ui.notify("second failure detail", "warning");
    await invokePaletteCommand(runtime, "operator.inbox");
    expect(runtime.getViewState().overlay.active?.payload?.kind).toBe("inbox");

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaFullScreenShell, { runtime }),
      { width: 100, height: 30 },
    );

    const selectedIndex = () => {
      const payload = runtime.getViewState().overlay.active?.payload;
      return payload && "selectedIndex" in payload ? payload.selectedIndex : -1;
    };

    try {
      await testSetup.renderOnce();
      const initial = selectedIndex();
      expect(initial).toBeGreaterThanOrEqual(0);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ARROW_DOWN");
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(initial + 1);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("p", { ctrl: true });
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(initial);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("n", { ctrl: true });
        await Bun.sleep(0);
      });
      expect(selectedIndex()).toBe(initial + 1);

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("ESCAPE");
        await Bun.sleep(80);
      });
      expect(runtime.getViewState().overlay.active).toBe(undefined);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });
});
