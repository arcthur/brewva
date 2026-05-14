import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import {
  buildInspectReport,
  formatInspectText,
} from "../../../packages/brewva-cli/src/operator/inspect.js";

describe("cli inspect lineage reporting", () => {
  test("prints lineage topology and selected channels", () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-lineage-")),
    }).hosted;
    const sessionId = "inspect-lineage-session";
    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "lineage:main",
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
    });
    runtime.authority.session.lineage.createNode(sessionId, {
      lineageNodeId: "lineage:review",
      parentLineageNodeId: "lineage:main",
      kind: "review",
      forkPoint: { kind: "turn", turnId: "turn-review" },
      title: "Review branch",
    });
    runtime.authority.session.lineage.recordSelection(sessionId, {
      selectionId: "selection-cli",
      channelId: "cli",
      lineageNodeId: "lineage:review",
    });

    const report = buildInspectReport(runtime, sessionId);
    const text = formatInspectText(report);

    expect(text).toContain("Lineage: root=lineage:main current=lineage:review nodes=2 edges=1");
    expect(text).toContain("Lineage: selected=cli:lineage:review");
  });
});
