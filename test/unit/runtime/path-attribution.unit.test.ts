import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectPathCandidates,
  collectPersistedPatchPaths,
  listPersistedPatchSets,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from "../../../packages/brewva-runtime/src/index.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("shared path attribution helpers", () => {
  test("share patch history parsing and workspace path normalization across runtime and inspect analysis", () => {
    const workspace = createTestWorkspace("path-attribution-unit");
    const patchHistoryPath = join(
      workspace,
      ".orchestrator",
      "snapshots",
      "shared-session",
      "patchsets.json",
    );
    mkdirSync(join(workspace, ".orchestrator", "snapshots", "shared-session"), {
      recursive: true,
    });
    writeFileSync(
      patchHistoryPath,
      JSON.stringify(
        {
          version: 1,
          sessionId: "shared-session",
          updatedAt: 100,
          patchSets: [
            {
              id: "patch-1",
              createdAt: 10,
              toolName: "edit",
              appliedAt: 11,
              changes: [
                { path: "src/app.ts", action: "modify" },
                { path: ".orchestrator/tmp.json", action: "modify" },
              ],
            },
            {
              id: "patch-2",
              createdAt: 20,
              toolName: "write",
              appliedAt: 21,
              changes: [{ path: "src/extra.ts", action: "add" }],
            },
            {
              id: "invalid-patch",
              toolName: "write",
              appliedAt: 30,
              changes: [{ path: "src/bad.ts", action: "invalid" }],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const patchSets = listPersistedPatchSets({
      path: patchHistoryPath,
      sessionId: "shared-session",
      cutoffTimestamp: 20,
    });
    expect(patchSets.map((patchSet) => patchSet.id)).toEqual(["patch-1"]);

    const writePaths = collectPersistedPatchPaths(patchSets, {
      ignoredPrefixes: [".orchestrator/"],
    });
    expect([...writePaths]).toEqual(["src/app.ts"]);

    const candidates = collectPathCandidates(
      {
        path: "src/app.ts",
        files: ["src/extra.ts"],
        cwd: "src",
        command: "echo hi",
      },
      { allowUnkeyedString: true },
    );
    expect(candidates).toEqual(["src/app.ts", "src/extra.ts", "src"]);

    const relative = toWorkspaceRelativePath(workspace, join(workspace, "src", "app.ts"));
    expect(relative).toBe("src/app.ts");

    const resolved = resolveWorkspacePath({
      candidate: "./src/app.ts",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    expect(resolved).toEqual({
      absolutePath: join(workspace, "src", "app.ts"),
      relativePath: "src/app.ts",
    });
  });
});
