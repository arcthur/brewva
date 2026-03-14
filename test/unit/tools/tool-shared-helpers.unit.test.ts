import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenizeSearchTerms } from "../../../packages/brewva-tools/src/shared/query.js";
import { walkWorkspaceFiles } from "../../../packages/brewva-tools/src/shared/workspace-walk.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("tool shared helpers", () => {
  test("tokenizeSearchTerms applies consistent normalization and minimum lengths", () => {
    expect(tokenizeSearchTerms(" Brewva, brewva! TOC-search  ", { minLength: 3 })).toEqual([
      "brewva",
      "toc-search",
    ]);
  });

  test("walkWorkspaceFiles dedupes symlink loops while preserving .config", () => {
    const workspace = createTestWorkspace("tool-walk");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, ".config"), { recursive: true });
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(join(workspace, "node_modules"), { recursive: true });

    writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(workspace, ".config", "config.ts"), "export const config = 1;\n", "utf8");
    writeFileSync(join(workspace, ".git", "ignored.ts"), "export const ignored = 1;\n", "utf8");
    writeFileSync(
      join(workspace, "node_modules", "ignored.ts"),
      "export const ignored = 1;\n",
      "utf8",
    );
    symlinkSync(
      join(workspace, "src"),
      join(workspace, "src-loop"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const walked = walkWorkspaceFiles({
      roots: [workspace],
      maxFiles: 100,
      isMatch: (filePath) => filePath.endsWith(".ts"),
    });
    const canonicalWorkspace = realpathSync(workspace);

    expect(walked.overflow).toBe(false);
    expect(walked.files.toSorted()).toEqual([
      join(canonicalWorkspace, ".config", "config.ts"),
      join(canonicalWorkspace, "src", "a.ts"),
    ]);
  });

  test("walkWorkspaceFiles can reject file roots when callers want directory-only scanning", () => {
    const workspace = createTestWorkspace("tool-walk-file-root");
    mkdirSync(join(workspace, "src"), { recursive: true });
    const filePath = join(workspace, "src", "a.ts");
    writeFileSync(filePath, "export const a = 1;\n", "utf8");

    const walked = walkWorkspaceFiles({
      roots: [filePath],
      maxFiles: 100,
      isMatch: (candidate) => candidate.endsWith(".ts"),
      includeRootFiles: false,
    });

    expect(walked.overflow).toBe(false);
    expect(walked.files).toEqual([]);
  });
});
