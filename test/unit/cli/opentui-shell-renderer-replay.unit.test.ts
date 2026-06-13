import { afterEach, describe, expect, test } from "bun:test";
import {
  createOpenTuiSolidElement,
  openTuiSolidTestRender,
  settleOpenTuiTextRendering,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { BrewvaOpenTuiShell } from "../../../packages/brewva-cli/runtime/opentui-shell-renderer.js";
import { startShellRuntimeFixture, type ShellRuntimeFixture } from "../../helpers/shell-fixture.js";
import { streamAssistantText } from "../../helpers/shell-replay.js";

const REPLAY_TEXT = [
  "Here is the plan.",
  "",
  "## Steps",
  "",
  "1. Read the configuration file.",
  "2. Apply the migration in `src/db.ts`.",
  "3. Verify with the contract suite.",
  "",
  "All steps are reversible.",
].join("\n");

let fixture: ShellRuntimeFixture | undefined;
let testSetup: Awaited<ReturnType<typeof openTuiSolidTestRender>> | undefined;

const SETTLE_PASS_LIMIT = 20;

/**
 * Render until async text rendering (tree-sitter highlight, markdown blocks)
 * has settled and the needle is visible, or the pass limit is reached.
 * Returns the final frame either way so assertions report real content.
 */
async function settleReplayFrame(
  setup: Awaited<ReturnType<typeof openTuiSolidTestRender>>,
  needle: string,
): Promise<string> {
  let frame = "";
  for (let pass = 0; pass < SETTLE_PASS_LIMIT; pass += 1) {
    await settleOpenTuiTextRendering((setup.renderer as unknown as { root?: unknown }).root);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (frame.includes(needle)) {
      return frame;
    }
  }
  return frame;
}

afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
  testSetup?.renderer.destroy();
  testSetup = undefined;
});

describe("opentui solid shell: streaming replay", () => {
  // Bun crashes during native TUI renderer teardown on Linux CI (see
  // opentui-shell-renderer-layout.unit.test.ts); run locally via test:tui.
  if (process.env.CI === "true") {
    test("skipped in CI due to Bun native TUI teardown crash", () => {
      expect(true).toBe(true);
    });
    return;
  }

  test("a replayed stream settles into a stable transcript frame", async () => {
    fixture = await startShellRuntimeFixture();
    testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: fixture.runtime }),
      { width: 80, height: 30 },
    );
    await testSetup.renderOnce();

    streamAssistantText(fixture, { text: REPLAY_TEXT, chunkSize: 4, intervalMs: 10 });
    fixture.clock.runAll();
    const frame = await settleReplayFrame(testSetup, "All steps are reversible.");
    expect(frame).toContain("Here is the plan.");
    expect(frame).toContain("Steps");
    expect(frame).toContain("All steps are reversible.");
    // Behavior lock for the projection/render refactors: the full frame must
    // stay byte-identical while internals change underneath it.
    expect(frame).toMatchSnapshot();
  });

  test("content growth never drives continuous scroll-sync commits", async () => {
    fixture = await startShellRuntimeFixture();
    const runtime = fixture.runtime;
    const scrollSyncInputs: unknown[] = [];
    const originalHandleInput = runtime.handleInput.bind(runtime);
    runtime.handleInput = async (input: Parameters<typeof originalHandleInput>[0]) => {
      if ((input as { type?: string }).type === "surface.scrollSync") {
        scrollSyncInputs.push(input);
      }
      return await originalHandleInput(input);
    };

    testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime }),
      { width: 80, height: 24 },
    );
    await testSetup.renderOnce();

    // Force scrolled follow mode, then stream enough content to grow the
    // scroll height every flush. The drifting offset must stay
    // renderer-local: at most one transition commit (snap back to live),
    // never a commit per content-growth tick.
    await originalHandleInput({
      type: "surface.scrollSync",
      followMode: "scrolled",
      scrollOffset: 10,
    });
    scrollSyncInputs.length = 0;

    const longText = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
    streamAssistantText(fixture, { text: longText, chunkSize: 8, intervalMs: 8, end: false });
    fixture.clock.runAll();
    await testSetup.renderOnce();
    await testSetup.renderOnce();

    expect(scrollSyncInputs.length).toBeLessThanOrEqual(1);
  });

  test("mid-stream frames render the partial text without duplication", async () => {
    fixture = await startShellRuntimeFixture();
    testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: fixture.runtime }),
      { width: 80, height: 30 },
    );
    await testSetup.renderOnce();

    streamAssistantText(fixture, {
      text: "alpha beta gamma delta",
      chunkSize: 6,
      intervalMs: 10,
      end: false,
    });
    fixture.clock.runAll();
    const frame = await settleReplayFrame(testSetup, "alpha beta gamma delta");
    const occurrences = frame.split("alpha ").length - 1;
    expect(occurrences).toBe(1);
    expect(frame).toContain("alpha beta gamma delta");
  });
});
