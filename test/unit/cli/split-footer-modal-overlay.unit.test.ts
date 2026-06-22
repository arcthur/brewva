import { describe, expect, test } from "bun:test";
import {
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { BrewvaOpenTuiShell } from "../../../packages/brewva-cli/runtime/shell/app.js";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/domain/operator-snapshot.js";
import { startShellRuntimeFixture } from "../../helpers/shell-fixture.js";

// ---------------------------------------------------------------------------
// Modal overlays (tool approval, confirm, select, …) must render INLINE in the
// split-footer footer — the footer is a tiny live region, so the alternate-
// screen `position="absolute"` float would be clipped. DialogLayoutProvider
// "inline" (wired in split-footer-app.tsx) makes DialogFrame render in flow so
// the footer-height router allocates rows for it, and the composer is hidden
// while a modal is active. This mounts the REAL BrewvaOpenTuiShell over a
// started CliShellRuntime, opens overlays, and asserts the modal content
// appears in the captured frame (and the composer placeholder does not).
//
// Like the interactive-shell interaction tests, this needs the native TUI
// renderer, which segfaults on Bun's teardown under Linux CI — so it is skipped
// there. The pure resolveFooterKeymapMode coverage (split-footer-keymap.unit
// .test.ts) runs in CI and locks the input-routing half of the contract.
// ---------------------------------------------------------------------------

function emptyOperatorSnapshot(): OperatorSurfaceSnapshot {
  return { approvals: [], questions: [], taskRuns: [], sessions: [] };
}

async function startRuntime() {
  const fixture = await startShellRuntimeFixture();
  return fixture;
}

describe("split-footer shell: inline modal overlays", () => {
  // Bun v1.3.12 segfaults during native TUI renderer teardown on Linux CI
  // (crash is in Bun's finalizer phase, not test code). Mirrors the guard in
  // opentui-shell-renderer-interaction-events.unit.test.ts.
  if (process.env.CI === "true") {
    test("skipped in CI due to Bun native TUI teardown crash", () => {
      expect(true).toBe(true);
    });
    return;
  }

  test("renders an approval modal inline and hides the composer", async () => {
    const fixture = await startRuntime();
    const { runtime } = fixture;

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime }),
      { width: 100, height: 30 },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      // Baseline: no overlay -> composer placeholder is visible.
      expect(testSetup.captureCharFrame()).toContain("think ");

      await openTuiSolidAct(async () => {
        runtime.openOverlay({
          kind: "approval",
          selectedIndex: 0,
          snapshot: emptyOperatorSnapshot(),
        });
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const frame = testSetup.captureCharFrame();
      // The approval modal surface (empty-ask state) renders in flow.
      expect(frame).toContain("Operator safety");
      expect(frame).toContain("No pending asks.");
      // The composer placeholder is gone while the modal owns the footer.
      expect(frame).not.toContain("think ");
    } finally {
      fixture.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders a confirm dialog inline, then restores the composer on Esc", async () => {
    const fixture = await startRuntime();
    const { runtime } = fixture;

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime }),
      { width: 100, height: 30 },
    );

    try {
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        runtime.openOverlay({
          kind: "confirm",
          message: "Delete the workspace checkpoint?",
        });
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("Confirm");
      expect(frame).toContain("Delete the workspace checkpoint?");
      expect(frame).not.toContain("think ");

      // Esc routes to the modal (overlay keymap layer) and closes it; the
      // composer footer comes back in flow. The observable proof is the frame:
      // the modal message is gone and the composer chrome ("think <level>") is
      // back — both only possible if the overlay store cleared and the inline
      // <Show> swapped the composer back in.
      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("\x1B");
        await Bun.sleep(50);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(runtime.getViewState().overlay.active?.payload?.kind ?? "none").toBe("none");
      frame = testSetup.captureCharFrame();
      expect(frame).toContain("think ");
      expect(frame).not.toContain("Delete the workspace checkpoint?");
    } finally {
      fixture.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders a select modal with its options inline", async () => {
    const fixture = await startRuntime();
    const { runtime } = fixture;

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime }),
      { width: 100, height: 30 },
    );

    try {
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        runtime.openOverlay({
          kind: "select",
          title: "Pick a branch",
          options: ["main", "feature/login", "feature/logout"],
          selectedIndex: 1,
        });
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Pick a branch");
      expect(frame).toContain("feature/login");
      expect(frame).toContain("feature/logout");
      expect(frame).not.toContain("think ");
    } finally {
      fixture.dispose();
      testSetup.renderer.destroy();
    }
  });
});
