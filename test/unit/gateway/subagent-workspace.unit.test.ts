import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  capturePatchSetFromIsolatedWorkspace,
  createIsolatedWorkspace,
} from "@brewva/brewva-gateway";

describe("subagent isolated workspace helpers", () => {
  test("captures add/modify/delete changes while ignoring runtime-owned helper artifacts", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-subagent-workspace-"));

    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".brewva"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    mkdirSync(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".orchestrator"), { recursive: true });
    writeFileSync(join(workspaceRoot, "src", "keep.ts"), "export const keep = 1;\n", "utf8");
    writeFileSync(join(workspaceRoot, "src", "delete.ts"), "export const remove = true;\n", "utf8");
    writeFileSync(
      join(workspaceRoot, ".brewva", "skills_index.json"),
      '{"generatedAt":"before","skills":[]}\n',
      "utf8",
    );
    writeFileSync(join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(workspaceRoot, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(workspaceRoot, ".orchestrator", "state.json"), '{"ok":true}\n', "utf8");

    const isolated = await createIsolatedWorkspace(workspaceRoot);
    writeFileSync(join(isolated.root, "src", "keep.ts"), "export const keep = 2;\n", "utf8");
    rmSync(join(isolated.root, "src", "delete.ts"));
    writeFileSync(join(isolated.root, "src", "add.ts"), "export const added = true;\n", "utf8");
    mkdirSync(join(isolated.root, ".brewva"), { recursive: true });
    writeFileSync(
      join(isolated.root, ".brewva", "skills_index.json"),
      '{"generatedAt":"after","skills":[{"name":"noop"}]}\n',
      "utf8",
    );
    mkdirSync(join(isolated.root, ".orchestrator"), { recursive: true });
    writeFileSync(join(isolated.root, ".orchestrator", "child.json"), '{"temp":true}\n', "utf8");

    const patchSet = await capturePatchSetFromIsolatedWorkspace({
      sourceRoot: workspaceRoot,
      isolatedRoot: isolated.root,
      summary: "captured",
    });

    expect(patchSet).toBeDefined();
    expect(patchSet?.changes).toEqual([
      expect.objectContaining({ path: "src/add.ts", action: "add" }),
      expect.objectContaining({ path: "src/delete.ts", action: "delete" }),
      expect.objectContaining({ path: "src/keep.ts", action: "modify" }),
    ]);
    expect(patchSet?.changes.some((change) => change.path.startsWith(".git/"))).toBe(false);
    expect(patchSet?.changes.some((change) => change.path.startsWith("node_modules/"))).toBe(false);
    expect(patchSet?.changes.some((change) => change.path.startsWith(".orchestrator/"))).toBe(
      false,
    );
    expect(patchSet?.changes.some((change) => change.path === ".brewva/skills_index.json")).toBe(
      false,
    );
    const addChange = patchSet?.changes.find((change) => change.path === "src/add.ts");
    const modifyChange = patchSet?.changes.find((change) => change.path === "src/keep.ts");
    const deleteChange = patchSet?.changes.find((change) => change.path === "src/delete.ts");

    expect(addChange?.artifactRef).toBeTruthy();
    expect(modifyChange?.artifactRef).toBeTruthy();
    expect(deleteChange?.artifactRef).toBeUndefined();
    expect(existsSync(resolve(workspaceRoot, addChange?.artifactRef ?? ""))).toBe(true);
    expect(existsSync(resolve(workspaceRoot, modifyChange?.artifactRef ?? ""))).toBe(true);

    const isolatedBeforeDispose = isolated.root;
    await isolated.dispose();
    expect(existsSync(isolatedBeforeDispose)).toBe(false);

    await rm(workspaceRoot, { recursive: true, force: true });
  });
});
