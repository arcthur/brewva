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
