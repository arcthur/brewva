import { describe, expect, test } from "bun:test";
import {
  collapseCodeContent,
  splitFoldableCodeBlocks,
} from "../../../packages/brewva-cli/runtime/shell/code-fold.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("collapseCodeContent", () => {
  test("content at or below the limit is not collapsible and renders in full", () => {
    const content = lines(12);
    const result = collapseCodeContent({ content, limit: 16, expanded: false });
    expect(result.collapsible).toBe(false);
    expect(result.visibleContent).toBe(content);
    expect(result.hiddenLineCount).toBe(0);
    expect(result.totalLineCount).toBe(12);
  });

  test("content exactly at the limit is not collapsible (boundary)", () => {
    const result = collapseCodeContent({ content: lines(16), limit: 16, expanded: false });
    expect(result.collapsible).toBe(false);
    expect(result.hiddenLineCount).toBe(0);
  });

  test("content one line over the limit collapses to the limit (boundary)", () => {
    const result = collapseCodeContent({ content: lines(17), limit: 16, expanded: false });
    expect(result.collapsible).toBe(true);
    expect(result.visibleContent).toBe(lines(16));
    expect(result.hiddenLineCount).toBe(1);
    expect(result.totalLineCount).toBe(17);
  });

  test("a long payload collapses to exactly `limit` visible lines", () => {
    const result = collapseCodeContent({ content: lines(100), limit: 16, expanded: false });
    expect(result.visibleContent.split("\n")).toHaveLength(16);
    expect(result.hiddenLineCount).toBe(84);
    expect(result.totalLineCount).toBe(100);
  });

  test("an expanded collapsible payload renders in full with no hidden lines", () => {
    const content = lines(100);
    const result = collapseCodeContent({ content, limit: 16, expanded: true });
    expect(result.collapsible).toBe(true);
    expect(result.visibleContent).toBe(content);
    expect(result.hiddenLineCount).toBe(0);
    expect(result.totalLineCount).toBe(100);
  });

  test("empty content is a single line and never collapsible", () => {
    const result = collapseCodeContent({ content: "", limit: 16, expanded: false });
    expect(result.collapsible).toBe(false);
    expect(result.totalLineCount).toBe(1);
    expect(result.visibleContent).toBe("");
  });

  test("CRLF line endings are counted and preserved in the visible slice", () => {
    const result = collapseCodeContent({ content: "a\r\nb\r\nc", limit: 2, expanded: false });
    expect(result.totalLineCount).toBe(3);
    expect(result.visibleContent).toBe("a\nb");
    expect(result.hiddenLineCount).toBe(1);
  });

  test("collapsed lines are width-capped when maxLineWidth is set", () => {
    const long = "x".repeat(50);
    const result = collapseCodeContent({
      content: `${long}\n${long}\n${long}`,
      limit: 2,
      expanded: false,
      maxLineWidth: 10,
    });
    expect(result.visibleContent.split("\n")).toEqual([`${"x".repeat(10)}…`, `${"x".repeat(10)}…`]);
    expect(result.hiddenLineCount).toBe(1);
  });

  test("a collapsed line at or under maxLineWidth is not truncated", () => {
    const result = collapseCodeContent({
      content: "short\nshort\nshort",
      limit: 2,
      expanded: false,
      maxLineWidth: 10,
    });
    expect(result.visibleContent).toBe("short\nshort");
  });

  test("maxLineWidth does not truncate an expanded (full) payload", () => {
    const long = "y".repeat(50);
    const content = `${long}\n${long}\n${long}`;
    const result = collapseCodeContent({ content, limit: 2, expanded: true, maxLineWidth: 10 });
    expect(result.visibleContent).toBe(content);
  });

  test("a single over-wide line is collapsible even under the line limit (P2)", () => {
    const giant = "x".repeat(500);
    const result = collapseCodeContent({
      content: giant,
      limit: 16,
      expanded: false,
      maxLineWidth: 100,
    });
    expect(result.collapsible).toBe(true);
    expect(result.totalLineCount).toBe(1);
    expect(result.visibleContent).toBe(`${"x".repeat(100)}…`);
    expect(result.hiddenLineCount).toBe(0);
  });

  test("expanding an over-wide single line restores the untruncated content", () => {
    const giant = "x".repeat(500);
    const result = collapseCodeContent({
      content: giant,
      limit: 16,
      expanded: true,
      maxLineWidth: 100,
    });
    expect(result.visibleContent).toBe(giant);
  });

  test("without maxLineWidth an over-wide line is not collapsible on width alone", () => {
    const result = collapseCodeContent({ content: "x".repeat(500), limit: 16, expanded: false });
    expect(result.collapsible).toBe(false);
  });
});

const F3 = "```";
const F4 = "````";
const codeLines = (n: number) => Array.from({ length: n }, (_, i) => `code ${i + 1}`).join("\n");

describe("splitFoldableCodeBlocks", () => {
  test("plain prose is a single markdown segment", () => {
    const segs = splitFoldableCodeBlocks("Just some prose.\n\nMore prose.", 8);
    expect(segs).toEqual([{ kind: "markdown", content: "Just some prose.\n\nMore prose." }]);
  });

  test("a long fenced block splits into markdown / code / markdown", () => {
    const content = `Before.\n\n${F3}ts\n${codeLines(10)}\n${F3}\n\nAfter.`;
    const segs = splitFoldableCodeBlocks(content, 8);
    expect(segs).toEqual([
      { kind: "markdown", content: "Before." },
      { kind: "code", content: codeLines(10), lang: "ts" },
      { kind: "markdown", content: "After." },
    ]);
  });

  test("a short fenced block stays in markdown (not folded)", () => {
    const content = `Before.\n\n${F3}ts\n${codeLines(3)}\n${F3}\n\nAfter.`;
    const segs = splitFoldableCodeBlocks(content, 8);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("markdown");
    expect(segs[0]!.content).toContain(`${F3}ts`);
  });

  test("an unclosed fence is never folded (kept as markdown)", () => {
    const content = `Before.\n\n${F3}ts\n${codeLines(20)}`;
    const segs = splitFoldableCodeBlocks(content, 8);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("markdown");
  });

  test("supports ~~~ fences", () => {
    const content = `~~~python\n${codeLines(10)}\n~~~`;
    const segs = splitFoldableCodeBlocks(content, 8);
    expect(segs).toEqual([{ kind: "code", content: codeLines(10), lang: "python" }]);
  });

  test("a fence with no language yields undefined lang", () => {
    const content = `${F3}\n${codeLines(10)}\n${F3}`;
    const segs = splitFoldableCodeBlocks(content, 8);
    expect(segs).toEqual([{ kind: "code", content: codeLines(10), lang: undefined }]);
  });

  test("boundary: body exactly at minFoldLines folds", () => {
    const segs = splitFoldableCodeBlocks(`${F3}ts\n${codeLines(8)}\n${F3}`, 8);
    expect(segs[0]!.kind).toBe("code");
  });

  test("boundary: body one under minFoldLines stays markdown", () => {
    const segs = splitFoldableCodeBlocks(`${F3}ts\n${codeLines(7)}\n${F3}`, 8);
    expect(segs[0]!.kind).toBe("markdown");
  });

  test("two long fenced blocks each fold, prose between stays markdown", () => {
    const content = `${F3}ts\n${codeLines(10)}\n${F3}\n\nmiddle\n\n${F3}js\n${codeLines(10)}\n${F3}`;
    const segs = splitFoldableCodeBlocks(content, 8);
    expect(segs.map((s) => s.kind)).toEqual(["code", "markdown", "code"]);
    expect(segs[1]!.content).toBe("middle");
  });

  test("a shorter inner fence does not close a longer opener", () => {
    const content = `${F4}ts\n${F3}\ninner\n${F3}\n${codeLines(6)}\n${F4}`;
    const segs = splitFoldableCodeBlocks(content, 3);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("code");
    expect(segs[0]!.content).toContain(F3);
  });

  test("an indented fence (inside a list item) is NOT lifted — stays markdown (P3)", () => {
    // A 2-space-indented open fence must not be torn out of its list; the whole
    // thing stays one markdown segment so the list renders intact.
    const content = `1. intro\n\n  ${F3}ts\n${codeLines(10)}\n  ${F3}\n\n2. next`;
    const segs = splitFoldableCodeBlocks(content, 8);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("markdown");
  });

  test("a top-level fence is still lifted (P3 does not over-restrict)", () => {
    const content = `intro\n\n${F3}ts\n${codeLines(10)}\n${F3}\n\nnext`;
    const segs = splitFoldableCodeBlocks(content, 8);
    expect(segs.map((s) => s.kind)).toEqual(["markdown", "code", "markdown"]);
  });
});
