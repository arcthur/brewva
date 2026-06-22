import { describe, expect, test } from "bun:test";
import {
  createOpenTuiSplitFooterRenderer,
  runOpenTuiSplitFooterSmoke,
  shutdownSplitFooterRenderer,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";

describe("split-footer renderer lifecycle", () => {
  test("runOpenTuiSplitFooterSmoke resolves without throwing and returns expected shape", async () => {
    const result = await runOpenTuiSplitFooterSmoke({ label: "split-footer smoke" });

    expect(result.backend).toBe("opentui-split-footer");
    expect(result.committedRows).toBeGreaterThanOrEqual(0);
  });

  test("createOpenTuiSplitFooterRenderer returns a renderer in split-footer screenMode", async () => {
    const renderer = await createOpenTuiSplitFooterRenderer({ footerHeight: 3 });

    try {
      // Cast to access the CliRenderer-level property (the OpenTuiRenderer interface
      // does not expose screenMode; CliRenderer does).
      const asCli = renderer as unknown as { screenMode: string };
      expect(asCli.screenMode).toBe("split-footer");
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  test("shutdownSplitFooterRenderer destroys the renderer without throwing", async () => {
    const renderer = await createOpenTuiSplitFooterRenderer();

    // Should not throw.
    shutdownSplitFooterRenderer(renderer);

    const asCli = renderer as unknown as { isDestroyed: boolean };
    expect(asCli.isDestroyed).toBe(true);
  });
});
