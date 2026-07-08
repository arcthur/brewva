import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePatchSetFromIsolatedWorkspace,
  createIsolatedWorkspace,
} from "@brewva/brewva-gateway";
import { requireDefined } from "../../helpers/assertions.js";

// Real-filesystem fork + seal coverage; the fork's basis capture walks the
// whole copied tree, so the bare 5s default is too tight on cold machines.
setDefaultTimeout(60_000);

function makeParentWorkspace(): string {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-subagent-workspace-"));
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src", "keep.ts"), "export const keep = 1;\n", "utf8");
  writeFileSync(join(workspaceRoot, "src", "delete.ts"), "export const remove = true;\n", "utf8");
  return workspaceRoot;
}

async function fork(workspaceRoot: string) {
  return await createIsolatedWorkspace(workspaceRoot);
}

describe("subagent isolated workspace helpers (basis-anchored)", () => {
  test("captures add/modify/delete against the fork basis and ignores runtime roots", async () => {
    const workspaceRoot = makeParentWorkspace();
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    mkdirSync(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".orchestrator"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(workspaceRoot, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(workspaceRoot, ".orchestrator", "state.json"), '{"ok":true}\n', "utf8");

    const isolated = await fork(workspaceRoot);
    expect(isolated.basisWorldId.startsWith("sha256:")).toBe(true);

    writeFileSync(join(isolated.root, "src", "keep.ts"), "export const keep = 2;\n", "utf8");
    rmSync(join(isolated.root, "src", "delete.ts"));
    writeFileSync(join(isolated.root, "src", "add.ts"), "export const added = true;\n", "utf8");
    mkdirSync(join(isolated.root, ".orchestrator"), { recursive: true });
    writeFileSync(join(isolated.root, ".orchestrator", "child.json"), '{"temp":true}\n', "utf8");

    const sealed = await capturePatchSetFromIsolatedWorkspace({
      sourceRoot: workspaceRoot,
      handle: isolated,
      summary: "captured",
    });
    if (!sealed.ok) throw new Error(`expected seal ok, got ${sealed.reason}`);
    const patchSet = requireDefined(sealed.patchSet, "Expected isolated workspace patch set.");

    expect(patchSet.changes).toEqual([
      expect.objectContaining({ path: "src/add.ts", action: "add" }),
      expect.objectContaining({ path: "src/delete.ts", action: "delete" }),
      expect.objectContaining({ path: "src/keep.ts", action: "modify" }),
    ]);
    expect(patchSet.changes.some((change) => change.path.startsWith(".orchestrator/"))).toBe(false);

    // Artifacts carry the sealed bytes for add/modify.
    const addChange = patchSet.changes.find((change) => change.action === "add");
    const artifactRef = requireDefined(addChange?.artifactRef, "Expected add artifact ref.");
    expect(readFileSync(join(workspaceRoot, artifactRef), "utf8")).toBe(
      "export const added = true;\n",
    );

    await isolated.dispose();
  });

  test("content addressing catches a same-size, mtime-preserved rewrite", async () => {
    const workspaceRoot = makeParentWorkspace();
    const isolated = await fork(workspaceRoot);

    const target = join(isolated.root, "src", "keep.ts");
    const originalMtime = new Date(Date.now() - 60_000);
    utimesSync(target, originalMtime, originalMtime);
    // Same byte length, same mtime — the old size+mtime baseline diff class
    // that silently lost worker edits.
    writeFileSync(target, "export const keep = 9;\n", "utf8");
    utimesSync(target, originalMtime, originalMtime);

    const sealed = await capturePatchSetFromIsolatedWorkspace({
      sourceRoot: workspaceRoot,
      handle: isolated,
      summary: "racy rewrite",
    });
    if (!sealed.ok) throw new Error(`expected seal ok, got ${sealed.reason}`);
    const patchSet = requireDefined(sealed.patchSet, "Expected racy rewrite to be captured.");
    expect(patchSet.changes).toEqual([
      expect.objectContaining({ path: "src/keep.ts", action: "modify" }),
    ]);

    await isolated.dispose();
  });

  test("beforeHash is the fork basis, not whatever the parent holds at seal time", async () => {
    const workspaceRoot = makeParentWorkspace();
    const isolated = await fork(workspaceRoot);

    // Worker edits the file; the PARENT concurrently moves the same file.
    writeFileSync(join(isolated.root, "src", "keep.ts"), "export const keep = 2;\n", "utf8");
    writeFileSync(
      join(workspaceRoot, "src", "keep.ts"),
      "export const keep = 777; // parent moved\n",
      "utf8",
    );

    const sealed = await capturePatchSetFromIsolatedWorkspace({
      sourceRoot: workspaceRoot,
      handle: isolated,
      summary: "parent diverged",
    });
    if (!sealed.ok) throw new Error(`expected seal ok, got ${sealed.reason}`);
    const change = requireDefined(
      sealed.patchSet?.changes.find((entry) => entry.path === "src/keep.ts"),
      "Expected the worker edit to be sealed.",
    );
    // Basis anchoring: beforeHash must hash the fork content ("keep = 1"),
    // NOT the parent's diverged content — adoption uses this to detect the
    // divergence instead of last-writer-wins overwriting it.
    const basisManifest = isolated.store.readManifest(isolated.basisWorldId);
    const basisBlob = requireDefined(
      basisManifest?.files.find((entry) => entry.path === "src/keep.ts")?.blob,
      "Expected the basis manifest to carry the forked file.",
    );
    expect(`sha256:${change.beforeHash}`).toBe(basisBlob);

    await isolated.dispose();
  });

  test("a linked-worktree parent forks git-less so worker git ops cannot reach shared metadata", async () => {
    // Simulate a linked worktree: `.git` is a pointer FILE into a primary
    // checkout's shared metadata. Copying it would let the worker mutate the
    // PARENT's index/HEAD through the fork.
    const workspaceRoot = makeParentWorkspace();
    writeFileSync(
      join(workspaceRoot, ".git"),
      "gitdir: /somewhere/primary/.git/worktrees/example\n",
      "utf8",
    );

    const isolated = await fork(workspaceRoot);
    expect(existsSync(join(isolated.root, ".git"))).toBe(false);
    // Scope was still narrowed by the copy itself; enumeration is stable walk.
    expect(isolated.basisSource).toBe("walk");

    writeFileSync(join(isolated.root, "src", "keep.ts"), "export const keep = 3;\n", "utf8");
    const sealed = await capturePatchSetFromIsolatedWorkspace({
      sourceRoot: workspaceRoot,
      handle: isolated,
      summary: "worktree fork",
    });
    if (!sealed.ok) throw new Error(`expected seal ok, got ${sealed.reason}`);
    expect(sealed.patchSet?.changes).toEqual([
      expect.objectContaining({ path: "src/keep.ts", action: "modify" }),
    ]);
    await isolated.dispose();
  });

  test("the fork store is fork-local and never touches the parent .brewva/worlds", async () => {
    const workspaceRoot = makeParentWorkspace();
    const isolated = await fork(workspaceRoot);

    // The store rooted the run's basis world under the fork tmpdir, not the
    // parent workspace — delegation captures cannot pollute (or share the stat
    // cache / GC lock of) the checkpoint lane's store, and need no worlds.enabled.
    expect(isolated.store.rootDir.startsWith(isolated.root.replace(/\/workspace$/u, ""))).toBe(
      true,
    );
    expect(isolated.store.rootDir.startsWith(workspaceRoot)).toBe(false);
    expect(existsSync(join(workspaceRoot, ".brewva", "worlds"))).toBe(false);

    // Disposal reclaims the whole store with the tmpdir — no lifecycle hook.
    const storeDir = isolated.store.rootDir;
    expect(existsSync(storeDir)).toBe(true);
    await isolated.dispose();
    expect(existsSync(storeDir)).toBe(false);
    expect(existsSync(join(workspaceRoot, ".brewva", "worlds"))).toBe(false);
  });

  test("a clean worker seals to no patch set", async () => {
    const workspaceRoot = makeParentWorkspace();
    const isolated = await fork(workspaceRoot);
    const sealed = await capturePatchSetFromIsolatedWorkspace({
      sourceRoot: workspaceRoot,
      handle: isolated,
      summary: "untouched",
    });
    if (!sealed.ok) throw new Error(`expected seal ok, got ${sealed.reason}`);
    expect(sealed.patchSet).toBe(undefined);
    await isolated.dispose();
  });
});
