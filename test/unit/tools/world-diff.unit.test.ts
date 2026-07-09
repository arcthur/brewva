import { describe, expect, test } from "bun:test";
import {
  projectWorldDiff,
  type WorldManifest,
} from "../../../packages/brewva-tools/src/world-store/index.js";

// projectWorldDiff is a pure content-addressed manifest comparison (rfc-worlds-operator-panel
// Phase 2): a differing blob (or exec-bit) is a modification, a one-sided path is an
// add/delete, an identical path is omitted. No I/O, deterministic, path-sorted.

function manifest(
  entries: ReadonlyArray<[string, string, ("normal" | "executable")?]>,
): WorldManifest {
  return {
    schema: "brewva.world.manifest.v1",
    files: entries.map(([path, blob, mode]) => ({ path, blob, mode: mode ?? "normal", size: 1 })),
  };
}

describe("projectWorldDiff", () => {
  test("classifies added / modified / deleted and omits identical, path-sorted", () => {
    const before = manifest([
      ["a.ts", "sha256:1"],
      ["b.ts", "sha256:2"],
      ["c.ts", "sha256:3"],
    ]);
    const after = manifest([
      ["a.ts", "sha256:1"],
      ["b.ts", "sha256:9"],
      ["d.ts", "sha256:4"],
    ]);
    const diff = projectWorldDiff(before, after);
    // a identical (omitted); b modified; c deleted; d added.
    expect(diff.files).toEqual([
      { path: "b.ts", change: "modified", beforeBlob: "sha256:2", afterBlob: "sha256:9" },
      { path: "c.ts", change: "deleted", beforeBlob: "sha256:3", afterBlob: null },
      { path: "d.ts", change: "added", beforeBlob: null, afterBlob: "sha256:4" },
    ]);
    expect({ added: diff.added, modified: diff.modified, deleted: diff.deleted }).toEqual({
      added: 1,
      modified: 1,
      deleted: 1,
    });
  });

  test("an exec-bit flip on identical content is a modification", () => {
    const before = manifest([["run.sh", "sha256:1", "normal"]]);
    const after = manifest([["run.sh", "sha256:1", "executable"]]);
    const diff = projectWorldDiff(before, after);
    expect(diff.files.map((file) => file.change)).toEqual(["modified"]);
    expect(diff.modified).toBe(1);
  });

  test("diff against an empty world is all-added, path-sorted", () => {
    const diff = projectWorldDiff(
      manifest([]),
      manifest([
        ["z.ts", "sha256:2"],
        ["a.ts", "sha256:1"],
      ]),
    );
    expect(diff.files.map((file) => file.path)).toEqual(["a.ts", "z.ts"]);
    expect(diff.added).toBe(2);
    expect(diff.modified).toBe(0);
    expect(diff.deleted).toBe(0);
  });

  test("two identical worlds diff to nothing", () => {
    const world = manifest([["a.ts", "sha256:1"]]);
    expect(projectWorldDiff(world, world).files).toEqual([]);
  });
});
