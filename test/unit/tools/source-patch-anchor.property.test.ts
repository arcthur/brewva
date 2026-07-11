import { expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSourcePatchTools,
  createSourceReadTool,
  type SourceReadToolDetails,
} from "@brewva/brewva-tools/navigation";
import fc from "fast-check";
import { extractTextContent } from "../../contract/tools/tools-flow.helpers.js";
import { propertyTest } from "../../helpers/property.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

function context(workspace: string) {
  return {
    cwd: workspace,
    sessionManager: {
      getSessionId() {
        return "property-source-patch";
      },
    },
  } as never;
}

function safeWord(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h"), {
      minLength: 1,
      maxLength: 8,
    })
    .map((letters) => letters.join(""));
}

propertyTest("anchors recover across unrelated leading line insertions and apply remains gated", {
  propertyId: "tools.source-patch.anchor-stale-recovery",
  layer: "unit",
  arbitraries: [
    fc.array(safeWord(), { minLength: 1, maxLength: 5 }),
    fc.integer({ min: 0, max: 4 }),
  ],
  examples: [[["alpha", "beta"], 1]],
  async predicate(words, rawIndex) {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-source-patch-property-"));
    const filePath = join(workspace, "example.ts");
    const lines = words.map((word, index) => `export const value_${index}_${word} = ${index};`);
    const targetIndex = rawIndex % lines.length;
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

    const sourceRead = createSourceReadTool();
    const [prepare, apply] = createSourcePatchTools();
    const readResult = await sourceRead.execute(
      "property-source-read",
      {
        uri: "example.ts",
        mode: "spans",
        spans: [{ start_line: targetIndex + 1, end_line: targetIndex + 1 }],
      },
      undefined,
      undefined,
      context(workspace),
    );
    const details = toolOutcomePayload(readResult) as SourceReadToolDetails;
    if (!details) {
      throw new Error("Missing source_read details.");
    }
    const anchor = details.snapshot.anchors.find((candidate) => candidate.line === targetIndex + 1);
    if (!anchor) {
      throw new Error("Missing target anchor.");
    }

    writeFileSync(filePath, `export const inserted = true;\n${lines.join("\n")}\n`, "utf8");
    const beforePrepare = readFileSync(filePath, "utf8");
    const replacement = `export const value_${targetIndex}_changed = 999;`;
    const prepareResult = await prepare.execute(
      "property-source-prepare",
      {
        edits: [
          {
            kind: "replace_lines",
            uri: details.resourceUri,
            snapshot_id: details.snapshot.id,
            start_line: anchor.line,
            replacement,
          },
        ],
      },
      undefined,
      undefined,
      context(workspace),
    );

    expect(
      extractTextContent(prepareResult as { content: Array<{ type: string; text?: string }> }),
    ).toContain("status: prepared");
    expect(readFileSync(filePath, "utf8")).toBe(beforePrepare);
    const planId = (toolOutcomePayload(prepareResult) as { planId?: string }).planId;
    expect(planId).toMatch(/^plan_/u);

    await apply.execute(
      "property-source-apply",
      { plan_id: planId },
      undefined,
      undefined,
      context(workspace),
    );
    const afterApply = readFileSync(filePath, "utf8");
    expect(afterApply).toContain("export const inserted = true;");
    expect(afterApply).toContain(replacement);
  },
});
