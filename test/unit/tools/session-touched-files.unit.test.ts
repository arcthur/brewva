import { describe, expect, test } from "bun:test";
import { sessionFreshTouchedFilePaths } from "../../../packages/brewva-tools/src/runtime-port/session-touched-files.js";
import { committedToolEvent } from "../../helpers/tool-events.js";

// Finding P2 — absolute-path regression. `tool.committed` write args carry
// ABSOLUTE paths (the real hosted tape shape); the fresh-touched universe that
// feeds an atoms review's `file_digests` receipt must be WORKSPACE-RELATIVE so
// it matches the coverage universe assembleReviewDebtInput builds. Before the
// fix, `sessionFreshTouchedFilePaths` extracted the paths with cwd:null (no
// relativization), so on a real tape the receipt keyed files absolute and an
// independent atoms review of exactly those files could NEVER clear debt. Every
// prior test seeded RELATIVE paths, so cwd:null was a harmless no-op and the bug
// shipped green — this pins the ABSOLUTE shape production actually carries.
const WORKSPACE_ROOT = "/workspace/app";

function runtimeWithEvents(events: ReturnType<typeof committedToolEvent>[]) {
  return {
    capabilities: { events: { records: { query: () => events } } },
  } as never;
}

describe("sessionFreshTouchedFilePaths — bare-write paths relativized to the workspace root", () => {
  test("absolute committed write/edit paths become workspace-relative", () => {
    const touched = sessionFreshTouchedFilePaths(
      runtimeWithEvents([
        committedToolEvent({
          toolName: "write",
          args: { path: "/workspace/app/Sources/A.swift" },
          timestamp: 1,
        }),
        committedToolEvent({
          toolName: "edit",
          args: { path: "/workspace/app/Sources/B.swift" },
          timestamp: 2,
        }),
      ]),
      "session-1",
      WORKSPACE_ROOT,
    );
    expect(touched).toEqual(["Sources/A.swift", "Sources/B.swift"]);
  });

  test("a path OUTSIDE the workspace stays absolute (correctly never matches a workspace-relative universe)", () => {
    const touched = sessionFreshTouchedFilePaths(
      runtimeWithEvents([
        committedToolEvent({
          toolName: "write",
          args: { path: "/elsewhere/vendored/C.swift" },
          timestamp: 1,
        }),
      ]),
      "session-2",
      WORKSPACE_ROOT,
    );
    expect(touched).toEqual(["/elsewhere/vendored/C.swift"]);
  });

  test("an errored write did not mutate the tree, so it contributes no touched file", () => {
    const touched = sessionFreshTouchedFilePaths(
      runtimeWithEvents([
        committedToolEvent({
          toolName: "write",
          args: { path: "/workspace/app/Sources/Broken.swift" },
          timestamp: 1,
          outcome: "err",
        }),
      ]),
      "session-3",
      WORKSPACE_ROOT,
    );
    expect(touched).toEqual([]);
  });
});
