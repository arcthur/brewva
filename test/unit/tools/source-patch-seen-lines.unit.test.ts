import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSourcePatchTools,
  createSourceReadTool,
  type SourceReadToolDetails,
} from "@brewva/brewva-tools/navigation";
import { extractTextContent } from "../../contract/tools/tools-flow.helpers.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

type ToolResult = { content: Array<{ type: string; text?: string }> };

function context(workspace: string, sessionId: string) {
  return {
    cwd: workspace,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  } as never;
}

async function readSpanLineOne(
  workspace: string,
  sessionId: string,
): Promise<SourceReadToolDetails> {
  const sourceRead = createSourceReadTool();
  const result = await sourceRead.execute(
    "seen-read",
    { uri: "example.ts", mode: "spans", spans: [{ start_line: 1, end_line: 1 }] },
    undefined,
    undefined,
    context(workspace, sessionId),
  );
  return toolOutcomePayload(result) as SourceReadToolDetails;
}

function replaceLineEdit(details: SourceReadToolDetails, line: number, replacement: string) {
  return {
    edits: [
      {
        kind: "replace_lines",
        uri: details.resourceUri,
        snapshot_id: details.snapshot.id,
        start_line: line,
        replacement,
      },
    ],
  };
}

describe("source_patch seen-lines enforcement", () => {
  test("an unseen line is rejected with a reveal, and a complete reveal lets a straight retry land", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-seen-lines-reveal-"));
    const filePath = join(workspace, "example.ts");
    const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    writeFileSync(filePath, original, "utf8");
    const [prepare] = createSourcePatchTools();
    const sessionId = "seen-lines-reveal";

    // Read only line 1 — lines 2 and 3 are never shown to the model.
    const details = await readSpanLineOne(workspace, sessionId);
    expect(details.snapshot.seenLines).toEqual([1]);

    // Editing line 3 (unseen) is rejected and reveals line 3's content.
    const edit = replaceLineEdit(details, 3, "const c = 99;");
    const first = await prepare.execute(
      "seen-prepare-1",
      edit,
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    const firstText = extractTextContent(first as ToolResult);
    expect(firstText).toContain("unseen_lines");
    expect(firstText).toContain("3:const c = 3;");
    // Prepare never mutates the file.
    expect(readFileSync(filePath, "utf8")).toBe(original);

    // The reveal was complete (one line, full width), so it merged line 3 into the
    // in-session seen set: the identical retry now prepares without a re-read.
    const second = await prepare.execute(
      "seen-prepare-2",
      edit,
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    expect(extractTextContent(second as ToolResult)).toContain("status: prepared");
  });

  test("a column-truncated reveal merges nothing, so the retry stays rejected", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-seen-lines-column-"));
    const filePath = join(workspace, "example.ts");
    const longLine = `const x = "${"y".repeat(600)}";`;
    writeFileSync(filePath, `const a = 1;\n${longLine}\n`, "utf8");
    const [prepare] = createSourcePatchTools();
    const sessionId = "seen-lines-column";

    const details = await readSpanLineOne(workspace, sessionId);
    expect(details.snapshot.seenLines).toEqual([1]);

    const edit = replaceLineEdit(details, 2, "const short = 1;");
    const first = await prepare.execute(
      "seen-column-1",
      edit,
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    const firstText = extractTextContent(first as ToolResult);
    expect(firstText).toContain("unseen_lines");
    expect(firstText).toContain("reveal_truncated");

    // A clipped reveal must not merge the line — the retry is rejected again.
    const second = await prepare.execute(
      "seen-column-2",
      edit,
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    expect(extractTextContent(second as ToolResult)).toContain("unseen_lines");
  });

  test("a reveal past the line cap merges nothing, blocking piecewise circumvention of a wide unseen range", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-seen-lines-cap-"));
    const filePath = join(workspace, "example.ts");
    // 60 lines; reading only line 1 leaves a 59-line unseen span beyond the 40 cap.
    const lines = Array.from({ length: 60 }, (_, index) => `const line_${index} = ${index};`);
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    const [prepare] = createSourcePatchTools();
    const sessionId = "seen-lines-cap";

    const details = await readSpanLineOne(workspace, sessionId);
    expect(details.snapshot.seenLines).toEqual([1]);

    const edit = {
      edits: [
        {
          kind: "replace_lines",
          uri: details.resourceUri,
          snapshot_id: details.snapshot.id,
          start_line: 2,
          end_line: 60,
          replacement: "const collapsed = true;",
        },
      ],
    };
    const first = await prepare.execute(
      "seen-cap-1",
      edit,
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    const firstText = extractTextContent(first as ToolResult);
    expect(firstText).toContain("unseen_lines");
    expect(firstText).toContain("reveal_truncated");

    const second = await prepare.execute(
      "seen-cap-2",
      edit,
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    expect(extractTextContent(second as ToolResult)).toContain("unseen_lines");
  });

  test("out-of-range line citations fail closed with a clear reason", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-seen-lines-range-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "const a = 1;\n", "utf8");
    const [prepare] = createSourcePatchTools();
    const sessionId = "seen-lines-range";

    const details = await readSpanLineOne(workspace, sessionId);
    const edit = replaceLineEdit(details, 9999, "const oob = 1;");
    const result = await prepare.execute(
      "seen-range-1",
      edit,
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    expect(extractTextContent(result as ToolResult)).toContain("line_out_of_range");
  });

  test("the reveal-merge budget blocks piecewise circumvention across separate prepares", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-seen-lines-budget-"));
    const filePath = join(workspace, "example.ts");
    // 100 lines; only line 1 is ever read, leaving a 99-line blind region.
    const lines = Array.from({ length: 100 }, (_, index) => `const line_${index} = ${index};`);
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    const [prepare] = createSourcePatchTools();
    const sessionId = "seen-lines-budget";

    const details = await readSpanLineOne(workspace, sessionId);
    expect(details.snapshot.seenLines).toEqual([1]);

    const prepareEdit = (id: string, startLine: number, endLine: number) =>
      prepare.execute(
        id,
        {
          edits: [
            {
              kind: "replace_lines",
              uri: details.resourceUri,
              snapshot_id: details.snapshot.id,
              start_line: startLine,
              end_line: endLine,
              replacement: "const collapsed = true;",
            },
          ],
        },
        undefined,
        undefined,
        context(workspace, sessionId),
      );

    // First slice: 40 unseen lines (2..41) — a complete reveal that exactly spends
    // the 40-line reveal-merge budget, so it merges and a straight retry lands.
    expect(extractTextContent((await prepareEdit("budget-1a", 2, 41)) as ToolResult)).toContain(
      "unseen_lines",
    );
    expect(extractTextContent((await prepareEdit("budget-1b", 2, 41)) as ToolResult)).toContain(
      "status: prepared",
    );

    // Second slice: 4 more unseen lines (42..45). Each is a complete single reveal,
    // but the snapshot's reveal-merge budget is already spent, so nothing merges.
    const overBudget = extractTextContent((await prepareEdit("budget-2a", 42, 45)) as ToolResult);
    expect(overBudget).toContain("unseen_lines");
    expect(overBudget).toContain("reveal_budget_exhausted");

    // The retry stays rejected — the model cannot walk the blind region in <=cap
    // slices; it must source_read the range. This is the anti-piecewise guarantee.
    expect(extractTextContent((await prepareEdit("budget-2b", 42, 45)) as ToolResult)).toContain(
      "unseen_lines",
    );
  });

  test("drift that splits a multi-line range's endpoints fails closed instead of clobbering", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-seen-lines-relocate-"));
    const filePath = join(workspace, "example.ts");
    writeFileSync(filePath, "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n", "utf8");
    const sourceRead = createSourceReadTool();
    const [prepare] = createSourcePatchTools();
    const sessionId = "seen-lines-relocate";

    // Read all three lines so the seen-gate passes; the edit targets lines 1-3.
    const readResult = await sourceRead.execute(
      "relocate-read",
      { uri: "example.ts", mode: "spans", spans: [{ start_line: 1, end_line: 3 }] },
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    const details = toolOutcomePayload(readResult) as SourceReadToolDetails;
    expect(details.snapshot.seenLines).toEqual([1, 2, 3]);

    // Reorder so line 1's text ("alpha") moves to the bottom and line 3's text
    // ("gamma") moves to the top: each endpoint relocates uniquely, but to swapped
    // positions, so the recovered span no longer matches the seen 1-3 range.
    const reordered = "const gamma = 3;\nconst middle = 0;\nconst alpha = 1;\n";
    writeFileSync(filePath, reordered, "utf8");

    const result = await prepare.execute(
      "relocate-prepare",
      {
        edits: [
          {
            kind: "replace_lines",
            uri: details.resourceUri,
            snapshot_id: details.snapshot.id,
            start_line: 1,
            end_line: 3,
            replacement: "const collapsed = true;",
          },
        ],
      },
      undefined,
      undefined,
      context(workspace, sessionId),
    );
    const text = extractTextContent(result as ToolResult);
    // Fail closed: the endpoints no longer bound a contiguous range, so the plan
    // conflicts rather than splicing away the lines between the swapped endpoints.
    expect(text).toContain("range_relocation_conflict");
    expect(text).not.toContain("status: prepared");
    // Prepare never mutates regardless.
    expect(readFileSync(filePath, "utf8")).toBe(reordered);
  });
});
