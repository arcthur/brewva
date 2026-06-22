import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  type DelegationRunRecord,
} from "@brewva/brewva-vocabulary/delegation";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import {
  createOpenTuiSolidElement,
  openTuiSolidTestRender,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { BrewvaOpenTuiShell } from "../../../packages/brewva-cli/runtime/shell/app.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import { createShellFixture } from "../../helpers/shell-fixture.js";

// ---------------------------------------------------------------------------
// The last three deferred surfaces — completion popup, cockpit status dock, and
// the subagent footer — must render INLINE in the split-footer footer (in flow,
// so the footer-height router allocates rows for them) at parity with the full
// alternate-screen shell. CompletionOverlay is normally `position="absolute"`
// anchored to the composer; the footer passes layout="inline" so it renders in
// flow ABOVE the composer instead of floating over the tiny footer region. The
// cockpit dock and subagent footer are already in-flow boxes, gated by their
// own visibility (an active cockpit projection / non-empty task runs).
//
// Like the other native-renderer tests (modal overlays, interaction events),
// this mounts the real TUI renderer, which segfaults during Bun's teardown on
// Linux CI — so it is skipped there. The pure resolveFooterKeymapMode coverage
// (split-footer-keymap.unit.test.ts) locks the input-routing half (including
// the subagentFooter focus branch) and runs in CI.
// ---------------------------------------------------------------------------

function wireFrame(
  input: Omit<SessionWireFrame, "schema" | "sessionId" | "source" | "durability">,
): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: "session-1",
    source: "live",
    durability: "durable",
    ...input,
  } as SessionWireFrame;
}

function runningTaskRun(index: number): DelegationRunRecord {
  const primary = index === 0;
  const name = primary ? "review-operator-state" : `background-${index}`;
  const now = Date.now();
  return {
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    runId: `run-worker-${index + 1}`,
    agent: "worker",
    targetName: primary ? "patch-worker" : "worker",
    delegate: primary ? "patch-worker" : "worker",
    taskName: name,
    taskPath: `/${name}`,
    nickname: primary ? "Review operator state" : `Background ${index}`,
    depth: 1,
    forkTurns: "none",
    gateReason: "implement_isolated",
    modelCategory: "isolated-execution",
    executionPrimitive: "named",
    visibility: "public",
    isolationStrategy: "worktree",
    adoption: {
      contractId: "cli-subagent-activity-test",
      decision: "require_human",
      reason: "Fixture record has not reached parent adoption.",
    },
    parentSessionId: asBrewvaSessionId("session-1"),
    status: "running",
    createdAt: now - 500 - index,
    updatedAt: primary ? now + 1_000 : now - index,
    label: primary ? "Review operator state" : `Background ${index}`,
    summary: primary ? "Inspecting OpenTUI status lane" : `Running background ${index}`,
    workerSessionId: asBrewvaSessionId(`worker-session-${index + 1}`),
  };
}

function startRuntime(bundle: ConstructorParameters<typeof CliShellRuntime>[0]): CliShellRuntime {
  return new CliShellRuntime(bundle, {
    cwd: process.cwd(),
    openSession: async () => bundle,
    createSession: async () => bundle,
    operatorPollIntervalMs: 60_000,
  });
}

describe("split-footer shell: inline footer surfaces", () => {
  // Mirrors the CI guard in opentui-shell-renderer-interaction-events.unit.test.ts
  // (Bun v1.3.12 segfaults during native TUI renderer teardown on Linux CI).
  if (process.env.CI === "true") {
    test("skipped in CI due to Bun native TUI teardown crash", () => {
      expect(true).toBe(true);
    });
    return;
  }

  test("renders the slash completion popup inline above the composer", async () => {
    const { bundle } = createShellFixture({
      transcriptSeed: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Transcript anchor row." }],
          timestamp: 200,
        },
      ],
    });
    const runtime = startRuntime(bundle);
    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime }),
      { width: 100, height: 30 },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      // Open the slash completion the same way a keystroke would: set the
      // editor text and let the completion-refresh debounce flush.
      runtime.ui.setEditorText("/in");
      await Bun.sleep(CliShellRuntime.COMPLETION_REFRESH_DEBOUNCE_MS + 30);
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const completion = runtime.getViewState().composer.completion;
      expect(completion?.items.length ?? 0).toBeGreaterThan(0);

      const frame = testSetup.captureCharFrame();
      // The completion list renders a real command item (e.g. /init) inline.
      const firstValue = completion?.items[0]?.value ?? "";
      expect(firstValue.length).toBeGreaterThan(0);
      expect(frame).toContain(`/${firstValue}`);
      // The composer chrome is still present (completion sits above it, not a
      // modal that replaces it).
      expect(frame).toContain("think ");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("docks the active cockpit effect surface in the footer", async () => {
    const { bundle } = createShellFixture({
      transcriptSeed: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Transcript anchor row." }],
          timestamp: 200,
        },
      ],
      sessionWireBySessionId: {
        "session-1": [
          wireFrame({
            type: "tool.finished",
            frameId: "frame:effect-write",
            ts: Date.now() - 1_000,
            turnId: "turn:1",
            attemptId: "attempt:1",
            toolCallId: "tool-call-write",
            toolName: "exec",
            verdict: "ok",
            isError: false,
            text: "patched files",
          }),
        ],
      },
    });
    const runtime = startRuntime(bundle);
    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime }),
      { width: 100, height: 30 },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      // The cockpit projection is live (an effect was folded from the wire),
      // and the dock surface renders its "Effects" lane inline in the footer.
      expect(runtime.getViewState().cockpit.projection?.schema).toBe(
        "brewva.shell-cockpit.projection.v1",
      );
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Effects");
      // The composer is still active below the dock.
      expect(frame).toContain("think ");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the subagent footer inline and blocks the composer when focused", async () => {
    const { bundle } = createShellFixture({
      taskRuns: Array.from({ length: 3 }, (_, index) => runningTaskRun(index)),
    });
    const runtime = startRuntime(bundle);
    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime }),
      { width: 120, height: 30 },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      // Task runs are present, so the subagent footer panel is visible inline.
      expect(runtime.getViewState().operator.taskRuns).toHaveLength(3);
      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("subagents");

      // Focusing the subagent footer routes input to it (resolveFooterKeymapMode
      // -> "subagentFooter") and blocks the composer, mirroring the full shell.
      // subagentFooter.toggle opens the footer and takes focus (reducer sets
      // focus.active = "subagentFooter").
      await runtime.handleInput({
        type: "keymap.effect",
        effect: { type: "subagentFooter.toggle" },
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(runtime.getViewState().focus.active).toBe("subagentFooter");
      frame = testSetup.captureCharFrame();
      expect(frame).toContain("subagents");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });
});
