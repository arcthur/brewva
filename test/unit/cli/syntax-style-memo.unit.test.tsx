/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test";
import { Show, createEffect, createSignal } from "solid-js";
import {
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import type { SyntaxStyle } from "../../../packages/brewva-cli/runtime/opentui/index.js";
import { createSyntaxStyleMemo } from "../../../packages/brewva-cli/runtime/shell/syntax-style.js";

interface TrackedStyle {
  readonly theme: number;
  destroyCount: number;
}

function makeFactory(): {
  factory: (theme: number) => SyntaxStyle;
  created: TrackedStyle[];
} {
  const created: TrackedStyle[] = [];
  const factory = (theme: number): SyntaxStyle => {
    const tracked: TrackedStyle = { theme, destroyCount: 0 };
    created.push(tracked);
    // Only `destroy()` is exercised by createSyntaxStyleMemo; the rest of the
    // SyntaxStyle surface is irrelevant to its lifecycle, so a stub suffices.
    return {
      destroy() {
        tracked.destroyCount += 1;
      },
    } as unknown as SyntaxStyle;
  };
  return { factory, created };
}

interface Controls {
  setTheme?: (theme: number) => void;
  setMounted?: (mounted: boolean) => void;
}

function Probe(props: { theme: number; factory: (theme: number) => SyntaxStyle }) {
  const syntax = createSyntaxStyleMemo(() => props.factory(props.theme));
  // Subscribe so the memo recomputes eagerly when `theme` changes (mirrors a
  // `<markdown syntaxStyle={syntax()}>` binding).
  createEffect(() => void syntax());
  return <box />;
}

function Harness(props: { factory: (theme: number) => SyntaxStyle; controls: Controls }) {
  const [theme, setTheme] = createSignal(0);
  const [mounted, setMounted] = createSignal(true);
  props.controls.setTheme = setTheme;
  props.controls.setMounted = setMounted;
  return (
    <Show when={mounted()}>
      <Probe theme={theme()} factory={props.factory} />
    </Show>
  );
}

// createSyntaxStyleMemo defers destroy until renderer.idle(); flush both the
// idle promise and the trailing .finally() microtask before asserting.
type TestRenderSetup = Awaited<ReturnType<typeof openTuiSolidTestRender>>;

async function settle(setup: TestRenderSetup): Promise<void> {
  // The runtime renderer is a CliRenderer (has `idle()`); the test-render setup
  // types it as the narrower OpenTuiRenderer, so narrow back here.
  const renderer = setup.renderer as unknown as { idle(): Promise<void> };
  await renderer.idle();
  await renderer.idle();
  await Promise.resolve();
}

describe("createSyntaxStyleMemo lifecycle", () => {
  test("reuses one style across renders and destroys retired/unmounted styles after idle", async () => {
    const { factory, created } = makeFactory();
    const controls: Controls = {};
    const setup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(Harness, { factory, controls }),
      { width: 40, height: 10 },
    );
    try {
      await settle(setup);
      // Initial render: exactly one style, still live.
      expect(created.length).toBe(1);
      expect(created[0]?.destroyCount).toBe(0);

      // Theme change recomputes the factory: previous style destroyed once, new kept.
      await openTuiSolidAct(async () => {
        controls.setTheme?.(1);
      });
      await settle(setup);
      expect(created.length).toBe(2);
      expect(created[0]?.destroyCount).toBe(1);
      expect(created[1]?.destroyCount).toBe(0);

      // Unmount destroys the current style (native highlight buffers are freed).
      await openTuiSolidAct(async () => {
        controls.setMounted?.(false);
      });
      await settle(setup);
      expect(created[1]?.destroyCount).toBe(1);

      // No double-free: every style destroyed exactly once, none more than once.
      expect(created.map((style) => style.destroyCount)).toEqual([1, 1]);
    } finally {
      setup.renderer.destroy();
    }
  });
});
