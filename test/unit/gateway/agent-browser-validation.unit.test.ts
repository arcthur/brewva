import { describe, expect, test } from "bun:test";
import { distillToolOutput } from "@brewva/brewva-gateway/runtime-plugins";

describe("agent-browser validation evidence", () => {
  test("distills large browser snapshots while preserving artifact-oriented evidence", () => {
    const output = [
      "[Browser Snapshot]",
      "session: browser-session-validation",
      "artifact: .orchestrator/browser-artifacts/browser-session-validation/snapshot.txt",
      "interactive: true",
      "snapshot:",
      ...Array.from(
        { length: 160 },
        (_value, index) => `[@e${index}]<button>Action ${index}</button>`,
      ),
    ].join("\n");

    const distillation = distillToolOutput({
      toolName: "browser_snapshot",
      isError: false,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("browser_snapshot_heuristic");
    expect(distillation.summaryText).toContain("[BrowserSnapshotDistilled]");
    expect(distillation.summaryText).toContain(
      "artifact: .orchestrator/browser-artifacts/browser-session-validation/snapshot.txt",
    );
    expect(distillation.summaryText).toContain("interactive_refs: 160");
  });
});
