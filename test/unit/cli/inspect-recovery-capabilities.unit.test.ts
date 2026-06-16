import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInspectReport,
  formatInspectDiagnosticText,
} from "../../../packages/brewva-cli/src/operator/inspect.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

describe("cli inspect recovery capabilities (RFC WS2)", () => {
  test("surfaces evidence-derived capabilities in the report and the diagnostic text", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-caps-")),
    });
    const sessionId = "inspect-caps-session";
    runtime.ops.session.lineage.createNode(sessionId, {
      lineageNodeId: "lineage:main",
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
    });

    const report = buildInspectReport(runtime, sessionId);
    const byName = (name: string) =>
      report.recoveryCapabilities.capabilities.find((capability) => capability.name === name);

    // The full capability set is projected, not one health bit.
    expect(byName("inspectable")?.available).toBe(true);
    expect(report.recoveryCapabilities.capabilities).toHaveLength(7);

    // With no undone checkpoint to redo in this session, redo is denied with an
    // explicit reason, never silently "available".
    const redoable = byName("redoable");
    expect(redoable?.available).toBe(false);
    expect(redoable?.reasons.length).toBeGreaterThan(0);

    const text = formatInspectDiagnosticText(report);
    expect(text).toContain("Recovery capabilities:");
    expect(text).toContain("inspectable=yes");
    expect(text).toContain("redoable=no");
    expect(text).toContain("Recovery denied: redoable");
  });
});
