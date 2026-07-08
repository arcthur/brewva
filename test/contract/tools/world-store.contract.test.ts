import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceWorldStore,
  type WorkspaceWorldStore,
  type WorldStoreOptions,
} from "@brewva/brewva-tools/world-store";

// Real-filesystem and real-git coverage; the bare `bun test` 5s default is too
// tight for the first cold capture on slower machines.
setDefaultTimeout(60_000);

const SESSION_ID = "world-store-session";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-world-store-"));
}

function initGitRepo(root: string): void {
  const result = spawnSync("git", ["-C", root, "init", "--quiet"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git init failed: ${result.stderr}`);
  }
}

function makeStore(
  root: string,
  overrides: Partial<Omit<WorldStoreOptions, "workspaceRoot">> = {},
): WorkspaceWorldStore {
  return createWorkspaceWorldStore({
    workspaceRoot: root,
    dir: ".brewva/worlds",
    retainPerSession: 64,
    ...overrides,
  });
}

function captureOk(store: WorkspaceWorldStore, turn = 1, sessionId = SESSION_ID) {
  const result = store.capture({ sessionId, turn });
  if (!result.ok) {
    throw new Error(`expected capture ok, got ${result.reason}: ${result.detail ?? ""}`);
  }
  return result;
}

function manifestPaths(store: WorkspaceWorldStore, worldId: string): string[] {
  const manifest = store.readManifest(worldId);
  if (!manifest) throw new Error(`manifest missing for ${worldId}`);
  return manifest.files.map((entry) => entry.path);
}

describe("workspace world store", () => {
  test("captures a content-addressed world; identical recaptures dedup and append no ref", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "alpha\n", "utf8");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");

    const store = makeStore(root);
    const first = captureOk(store, 1);
    expect(first.worldId.startsWith("sha256:")).toBe(true);
    expect(first.fileCount).toBe(2);
    expect(first.source).toBe("git");
    expect(first.newBlobCount).toBe(2);
    expect(first.deduplicated).toBe(false);

    const second = captureOk(store, 2);
    expect(second.worldId).toBe(first.worldId);
    expect(second.newBlobCount).toBe(0);
    expect(second.deduplicated).toBe(true);

    // Refs record world TRANSITIONS, not captures: a clean recapture appends
    // nothing, so retention bounds distinct worlds instead of turn count.
    const refs = store.listRefs(SESSION_ID);
    expect(refs.map((ref) => ref.worldId)).toEqual([first.worldId]);
    expect(refs.map((ref) => ref.turn)).toEqual([1]);
  });

  test("reflects edits with a new world id while retaining prior worlds", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");

    const store = makeStore(root);
    const first = captureOk(store, 1);
    writeFileSync(join(root, "a.txt"), "v2\n", "utf8");
    const second = captureOk(store, 2);

    expect(second.worldId).not.toBe(first.worldId);
    expect(store.verifyWorld(first.worldId).present).toBe(true);
    expect(store.verifyWorld(second.worldId).present).toBe(true);
    expect(store.listRefs(SESSION_ID).map((ref) => ref.worldId)).toEqual([
      first.worldId,
      second.worldId,
    ]);
  });

  test("git enumeration respects gitignore and excludes runtime data roots", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), "dist/\n", "utf8");
    writeFileSync(join(root, "kept.ts"), "export {};\n", "utf8");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "out.js"), "ignored", "utf8");
    mkdirSync(join(root, ".brewva"), { recursive: true });
    writeFileSync(join(root, ".brewva", "internal.json"), "{}", "utf8");
    mkdirSync(join(root, ".orchestrator"), { recursive: true });
    writeFileSync(join(root, ".orchestrator", "ledger.jsonl"), "{}", "utf8");

    const store = makeStore(root);
    const result = captureOk(store);
    const paths = manifestPaths(store, result.worldId);
    expect(paths).toContain("kept.ts");
    expect(paths).toContain(".gitignore");
    expect(paths.some((path) => path.startsWith("dist/"))).toBe(false);
    expect(paths.some((path) => path.startsWith(".brewva/"))).toBe(false);
    expect(paths.some((path) => path.startsWith(".orchestrator/"))).toBe(false);
  });

  test("falls back to a bounded walk without git and honors walk excludes", () => {
    const root = makeWorkspace();
    writeFileSync(join(root, "a.txt"), "alpha", "utf8");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x", "utf8");
    mkdirSync(join(root, ".orchestrator"), { recursive: true });
    writeFileSync(join(root, ".orchestrator", "state.json"), "{}", "utf8");

    const store = makeStore(root);
    const result = captureOk(store);
    expect(result.source).toBe("walk");
    expect(manifestPaths(store, result.worldId)).toEqual(["a.txt"]);
  });

  test("both backends fail closed on the size caps", () => {
    const walkRoot = makeWorkspace();
    writeFileSync(join(walkRoot, "a.txt"), "a", "utf8");
    writeFileSync(join(walkRoot, "b.txt"), "b", "utf8");
    writeFileSync(join(walkRoot, "c.txt"), "c", "utf8");
    const walkStore = makeStore(walkRoot, { maxFileCount: 2 });
    const walkResult = walkStore.capture({ sessionId: SESSION_ID });
    expect(walkResult.ok).toBe(false);
    if (!walkResult.ok) {
      expect(walkResult.reason).toBe("workspace_too_large");
    }

    const gitRoot = makeWorkspace();
    initGitRepo(gitRoot);
    writeFileSync(join(gitRoot, "a.txt"), "a", "utf8");
    writeFileSync(join(gitRoot, "b.txt"), "b", "utf8");
    writeFileSync(join(gitRoot, "c.txt"), "c", "utf8");
    const gitStore = makeStore(gitRoot, { maxFileCount: 2 });
    const gitResult = gitStore.capture({ sessionId: SESSION_ID });
    expect(gitResult.ok).toBe(false);
    if (!gitResult.ok) {
      expect(gitResult.reason).toBe("workspace_too_large");
    }
  });

  test("captures through a symlinked workspace root", () => {
    const real = makeWorkspace();
    writeFileSync(join(real, "a.txt"), "via link", "utf8");
    const linkParent = makeWorkspace();
    const linked = join(linkParent, "current");
    symlinkSync(real, linked);

    const store = makeStore(linked);
    const result = captureOk(store);
    expect(manifestPaths(store, result.worldId)).toEqual(["a.txt"]);
  });

  test("a non-default store dir never captures itself", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "stable", "utf8");

    const store = makeStore(root, { dir: "snapshots" });
    const first = captureOk(store, 1);
    const second = captureOk(store, 2);
    // Self-capture would make the store churn its own world id; stability
    // proves the configured dir is excluded from its own scope.
    expect(second.worldId).toBe(first.worldId);
    expect(manifestPaths(store, first.worldId).some((path) => path.startsWith("snapshots/"))).toBe(
      false,
    );
  });

  test("skips symlinks and records the executable bit", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\n", "utf8");
    chmodSync(join(root, "run.sh"), 0o755);
    writeFileSync(join(root, "plain.txt"), "text", "utf8");
    symlinkSync(join(root, "plain.txt"), join(root, "link.txt"));

    const store = makeStore(root);
    const result = captureOk(store);
    const manifest = store.readManifest(result.worldId);
    const byPath = new Map(manifest?.files.map((entry) => [entry.path, entry]));
    expect(byPath.has("link.txt")).toBe(false);
    expect(byPath.get("run.sh")?.mode).toBe("executable");
    expect(byPath.get("plain.txt")?.mode).toBe("normal");
  });

  test("retention trims refs and trim-triggered maintenance sweeps unreferenced worlds", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "v1", "utf8");

    const store = makeStore(root, { retainPerSession: 1, gcGraceMs: 0 });
    const first = captureOk(store, 1);
    writeFileSync(join(root, "a.txt"), "v2", "utf8");
    const second = captureOk(store, 2);

    expect(store.listRefs(SESSION_ID).map((ref) => ref.worldId)).toEqual([second.worldId]);
    expect(second.maintenance).toBe("swept");
    expect(store.verifyWorld(first.worldId)).toEqual({
      worldId: first.worldId,
      present: false,
      fileCount: 0,
      missingBlobCount: 0,
    });
    expect(store.verifyWorld(second.worldId).present).toBe(true);
    expect(manifestPaths(store, second.worldId)).toEqual(["a.txt"]);
  });

  test("sweep aborts fail-closed when anything in refs is unreadable", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "v1", "utf8");

    const store = makeStore(root, { gcGraceMs: 0 });
    const first = captureOk(store);
    writeFileSync(join(store.rootDir, "refs", "garbage.json"), "not json", "utf8");

    const sweep = store.sweep();
    expect(sweep.ok).toBe(false);
    if (!sweep.ok) {
      expect(sweep.skippedReason).toBe("refs_unreadable");
    }
    expect(manifestPaths(store, first.worldId)).toEqual(["a.txt"]);
  });

  test("a corrupt refs file is quarantined, never clobbered, and keeps blocking sweep", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "v1", "utf8");

    const store = makeStore(root, { gcGraceMs: 0 });
    const first = captureOk(store, 1);
    const refsFile = join(store.rootDir, "refs", `${encodeURIComponent(SESSION_ID)}.json`);
    writeFileSync(refsFile, "corrupted {{{", "utf8");

    const second = captureOk(store, 2);
    expect(second.worldId).toBe(first.worldId);
    // Fresh refs list restarted with the current world...
    expect(store.listRefs(SESSION_ID).map((ref) => ref.worldId)).toEqual([first.worldId]);
    // ...while the unreadable original is preserved aside as an unknown root.
    const refEntries = readdirSync(join(store.rootDir, "refs"));
    expect(refEntries.some((entry) => entry.includes(".corrupt-"))).toBe(true);
    const sweep = store.sweep();
    expect(sweep.ok).toBe(false);
    if (!sweep.ok) {
      expect(sweep.skippedReason).toBe("refs_unreadable");
    }
    expect(manifestPaths(store, first.worldId)).toEqual(["a.txt"]);
  });

  test("refs files past the expiry fall out of the promise and their worlds sweep", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "old session", "utf8");

    const store = makeStore(root, { gcGraceMs: 0 });
    const old = captureOk(store, 1, "dead-session");
    const refsFile = join(store.rootDir, "refs", `${encodeURIComponent("dead-session")}.json`);
    const staleRecordedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    writeFileSync(
      refsFile,
      `${JSON.stringify({
        version: 1,
        refs: [{ worldId: old.worldId, recordedAt: staleRecordedAt, turn: 1 }],
      })}\n`,
      "utf8",
    );

    const sweep = store.sweep();
    expect(sweep.ok).toBe(true);
    if (sweep.ok) {
      expect(sweep.removedRefFiles).toBe(1);
    }
    expect(existsSync(refsFile)).toBe(false);
    expect(store.hasWorld(old.worldId)).toBe(false);
  });

  test("verifyWorld reports missing blobs and capture heals them", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "healable", "utf8");

    const store = makeStore(root);
    const first = captureOk(store, 1);
    const manifest = store.readManifest(first.worldId);
    const blob = manifest?.files[0]?.blob ?? "";
    const blobHex = blob.replace("sha256:", "");
    const blobPath = join(store.rootDir, "objects", blobHex.slice(0, 2), blobHex);
    expect(existsSync(blobPath)).toBe(true);
    rmSync(blobPath);

    const broken = store.verifyWorld(first.worldId);
    expect(broken.present).toBe(false);
    expect(broken.missingBlobCount).toBe(1);

    const second = captureOk(store, 2);
    expect(second.worldId).toBe(first.worldId);
    expect(store.verifyWorld(first.worldId).present).toBe(true);
    expect(readFileSync(blobPath, "utf8")).toBe("healable");
  });

  test("self-heals a corrupted stat cache", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "v1", "utf8");

    const store = makeStore(root);
    captureOk(store, 1);
    writeFileSync(join(store.rootDir, "statcache.json"), "{{{corrupt", "utf8");
    writeFileSync(join(root, "a.txt"), "v2", "utf8");

    const second = captureOk(store, 2);
    const manifest = store.readManifest(second.worldId);
    const entry = manifest?.files.find((file) => file.path === "a.txt");
    expect(entry?.size).toBe(2);
    const blobHex = (entry?.blob ?? "").replace("sha256:", "");
    const blobContent = readFileSync(
      join(store.rootDir, "objects", blobHex.slice(0, 2), blobHex),
      "utf8",
    );
    expect(blobContent).toBe("v2");
  });

  test("capture fails closed when the workspace root is missing", () => {
    const store = makeStore(join(tmpdir(), "brewva-world-store-missing-root"));
    const result = store.capture({ sessionId: SESSION_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("workspace_missing");
    }
  });

  test("deleted files leave the next world and prior worlds intact", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "keep.txt"), "keep", "utf8");
    writeFileSync(join(root, "gone.txt"), "gone", "utf8");

    const store = makeStore(root);
    const first = captureOk(store, 1);
    rmSync(join(root, "gone.txt"));
    const second = captureOk(store, 2);

    expect(manifestPaths(store, first.worldId).toSorted()).toEqual(["gone.txt", "keep.txt"]);
    expect(manifestPaths(store, second.worldId)).toEqual(["keep.txt"]);
  });
});

describe("workspace world store: materialize", () => {
  test("restores edits, deletions, and creations back to the captured world", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "v1", "utf8");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "gone.txt"), "keep me", "utf8");

    const store = makeStore(root);
    const captured = captureOk(store, 1);

    // Post-checkpoint damage in exec style: direct fs writes the patch
    // lifecycle never saw.
    writeFileSync(join(root, "a.txt"), "v2 damaged", "utf8");
    rmSync(join(root, "sub", "gone.txt"));
    writeFileSync(join(root, "extra.txt"), "junk", "utf8");

    // Engine discipline: a pre-restore capture makes the damaged state (and
    // its stray files) store-known, so the restore may delete them.
    captureOk(store, 2);

    const restore = store.materialize(captured.worldId);
    if (!restore.ok) throw new Error(`expected restore ok, got ${restore.reason}`);
    expect(restore.wroteFileCount).toBe(2);
    expect(restore.deletedFileCount).toBe(1);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1");
    expect(readFileSync(join(root, "sub", "gone.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(root, "extra.txt"))).toBe(false);

    // Round-trip proof: recapturing the restored workspace is the same world.
    const recaptured = captureOk(store, 3);
    expect(recaptured.worldId).toBe(captured.worldId);
  });

  test("spares in-scope files whose content the store has never seen", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "captured", "utf8");

    const store = makeStore(root);
    const captured = captureOk(store, 1);
    // Scope drift: a file appears in scope whose bytes no world ever stored
    // (e.g. an ignore rule was narrowed post-checkpoint). Deleting it would
    // destroy data outside every restore promise.
    writeFileSync(join(root, "mystery.txt"), "never captured", "utf8");

    const restore = store.materialize(captured.worldId);
    if (!restore.ok) throw new Error(`expected restore ok, got ${restore.reason}`);
    expect(restore.deletedFileCount).toBe(0);
    expect(restore.sparedFileCount).toBe(1);
    expect(readFileSync(join(root, "mystery.txt"), "utf8")).toBe("never captured");
  });

  test("prunes directories the delete pass emptied", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "keep.txt"), "keep", "utf8");

    const store = makeStore(root);
    const captured = captureOk(store, 1);
    mkdirSync(join(root, "gen", "deep"), { recursive: true });
    writeFileSync(join(root, "gen", "deep", "out.txt"), "generated", "utf8");
    captureOk(store, 2);

    const restore = store.materialize(captured.worldId);
    if (!restore.ok) throw new Error(`expected restore ok, got ${restore.reason}`);
    expect(restore.deletedFileCount).toBe(1);
    expect(existsSync(join(root, "gen"))).toBe(false);
  });

  test("fails closed when a symlinked ancestor would redirect a restore write", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "inner.txt"), "safe", "utf8");

    const store = makeStore(root);
    const captured = captureOk(store, 1);
    // Post-checkpoint swap: the directory becomes a symlink pointing outside
    // the workspace. Restoring through it would mutate foreign paths.
    const outside = makeWorkspace();
    writeFileSync(join(outside, "inner.txt"), "foreign", "utf8");
    rmSync(join(root, "sub"), { recursive: true, force: true });
    symlinkSync(outside, join(root, "sub"));

    const restore = store.materialize(captured.worldId);
    expect(restore.ok).toBe(false);
    if (!restore.ok) {
      expect(restore.reason).toBe("occupant_conflict");
    }
    expect(readFileSync(join(outside, "inner.txt"), "utf8")).toBe("foreign");
  });

  test("preserves non-executable permission bits across a restore", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "secret.txt"), "v1", "utf8");
    chmodSync(join(root, "secret.txt"), 0o600);

    const store = makeStore(root);
    const captured = captureOk(store, 1);
    writeFileSync(join(root, "secret.txt"), "damaged", "utf8");
    chmodSync(join(root, "secret.txt"), 0o600);
    captureOk(store, 2);

    const restore = store.materialize(captured.worldId);
    if (!restore.ok) throw new Error(`expected restore ok, got ${restore.reason}`);
    expect(readFileSync(join(root, "secret.txt"), "utf8")).toBe("v1");
    expect(statSync(join(root, "secret.txt")).mode & 0o777).toBe(0o600);
  });

  test("reconciles the executable bit without rewriting unchanged content", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\n", "utf8");
    chmodSync(join(root, "run.sh"), 0o755);
    writeFileSync(join(root, "plain.txt"), "text", "utf8");

    const store = makeStore(root);
    const captured = captureOk(store, 1);
    chmodSync(join(root, "run.sh"), 0o644);

    const restore = store.materialize(captured.worldId);
    if (!restore.ok) throw new Error(`expected restore ok, got ${restore.reason}`);
    expect(restore.wroteFileCount).toBe(0);
    expect(restore.unchangedFileCount).toBe(2);
    const mode = statSync(join(root, "run.sh")).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  test("leaves out-of-scope (ignored) files untouched", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), "dist/\n", "utf8");
    writeFileSync(join(root, "a.txt"), "v1", "utf8");

    const store = makeStore(root);
    const captured = captureOk(store, 1);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "out.js"), "build artifact", "utf8");

    const restore = store.materialize(captured.worldId);
    if (!restore.ok) throw new Error(`expected restore ok, got ${restore.reason}`);
    expect(readFileSync(join(root, "dist", "out.js"), "utf8")).toBe("build artifact");
  });

  test("fails closed on missing artifacts before touching anything", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "a.txt"), "v1", "utf8");

    const store = makeStore(root);
    const captured = captureOk(store, 1);
    const manifest = store.readManifest(captured.worldId);
    const blobHex = (manifest?.files[0]?.blob ?? "").replace("sha256:", "");
    rmSync(join(store.rootDir, "objects", blobHex.slice(0, 2), blobHex));
    writeFileSync(join(root, "a.txt"), "v2 damaged", "utf8");

    const restore = store.materialize(captured.worldId);
    expect(restore.ok).toBe(false);
    if (!restore.ok) {
      expect(restore.reason).toBe("world_missing_artifacts");
    }
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v2 damaged");
  });

  test("fails closed when a manifest path is occupied by a non-file", () => {
    const root = makeWorkspace();
    initGitRepo(root);
    writeFileSync(join(root, "thing"), "file form", "utf8");

    const store = makeStore(root);
    const captured = captureOk(store, 1);
    rmSync(join(root, "thing"));
    mkdirSync(join(root, "thing"));
    writeFileSync(join(root, "thing", "inner.txt"), "occupant", "utf8");

    const restore = store.materialize(captured.worldId);
    expect(restore.ok).toBe(false);
    if (!restore.ok) {
      expect(restore.reason).toBe("occupant_conflict");
      expect(restore.detail).toBe("thing");
    }
    expect(readFileSync(join(root, "thing", "inner.txt"), "utf8")).toBe("occupant");
  });
});
