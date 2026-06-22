import { describe, expect, test } from "bun:test";
import {
  commitSolidToScrollback,
  createHeadlessSplitFooterRenderer,
  createOpenTuiElement,
  shutdownSplitFooterRenderer,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";

describe("commitSolidToScrollback integration", () => {
  test("commits a Solid node to the split-footer scrollback without throwing", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 24 });

    // Track whether the external_output event fires — this is the direct
    // observable signal that writeToScrollback enqueued a commit.
    let externalOutputEventCount = 0;
    (renderer as unknown as { on(event: string, listener: () => void): void }).on(
      "external_output",
      () => {
        externalOutputEventCount += 1;
      },
    );

    const knownContent = "hello-scrollback-7291";

    // Build a plain box > text node without JSX, using brewva's helper.
    const node = createOpenTuiElement(
      "box",
      null,
      createOpenTuiElement("text", { content: knownContent }),
    );

    try {
      // Calling directly — any throw surfaces as a test failure.
      commitSolidToScrollback(renderer, node, { width: 80 });

      // Observable signal: writeToScrollback synchronously fires "external_output"
      // when it enqueues the commit into the split-footer pipeline.
      expect(externalOutputEventCount).toBeGreaterThanOrEqual(1);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  test("renderer is still healthy (not destroyed) immediately after commit", async () => {
    const renderer = await createHeadlessSplitFooterRenderer();

    const node = createOpenTuiElement("text", { content: "hello-scrollback-health" });

    try {
      commitSolidToScrollback(renderer, node, { width: 80 });

      const asCli = renderer as unknown as { isDestroyed: boolean };
      expect(asCli.isDestroyed).toBe(false);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  test("shutdownSplitFooterRenderer destroys renderer after commit", async () => {
    const renderer = await createHeadlessSplitFooterRenderer();

    const node = createOpenTuiElement("text", { content: "hello-scrollback-shutdown" });
    commitSolidToScrollback(renderer, node, { width: 80 });

    shutdownSplitFooterRenderer(renderer);

    const asCli = renderer as unknown as { isDestroyed: boolean };
    expect(asCli.isDestroyed).toBe(true);
  });
});
