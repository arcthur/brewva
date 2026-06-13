import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceReferenceCompletionSource } from "../../../packages/brewva-cli/src/shell/domain/completion-provider.js";
import {
  createCliShellState,
  reduceCliShellState,
} from "../../../packages/brewva-cli/src/shell/domain/state.js";

describe("keystroke path invariants", () => {
  test("workspace completion resolve is synchronous and never blocks on the filesystem", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-keystroke-fs-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "main.ts"), "export {};\n");

    let updates = 0;
    const source = createWorkspaceReferenceCompletionSource({
      cwd,
      onEntriesUpdated: () => {
        updates += 1;
      },
    });
    const range = { trigger: "@" as const, query: "", start: 0, end: 1 };

    // Cold cache: resolve returns immediately with nothing — the fill runs
    // in the background, never on the keystroke path.
    expect(source.resolve(range)).toEqual([]);
    await source.settleFills();
    await Promise.resolve();

    expect(updates).toBeGreaterThan(0);
    const warm = source.resolve(range);
    expect(warm.map((candidate) => candidate.value)).toContain("src/");
  });

  test("editor-sourced composer commits keep the revision unchanged", () => {
    const initial = createCliShellState();
    const afterTyping = reduceCliShellState(initial, {
      type: "composer.setPromptState",
      text: "hello",
      cursor: 5,
      parts: [],
      source: "editor",
    });
    expect(afterTyping.composer.revision).toBe(initial.composer.revision);
    expect(afterTyping.composer.text).toBe("hello");
  });

  test("external composer changes bump the revision", () => {
    const initial = createCliShellState();
    const afterPrefill = reduceCliShellState(initial, {
      type: "composer.setText",
      text: "/help",
      cursor: 5,
    });
    expect(afterPrefill.composer.revision).toBe(initial.composer.revision + 1);

    const afterAccept = reduceCliShellState(afterPrefill, {
      type: "composer.setPromptState",
      text: "/help topic",
      cursor: 11,
      parts: [],
    });
    expect(afterAccept.composer.revision).toBe(afterPrefill.composer.revision + 1);
  });
});
