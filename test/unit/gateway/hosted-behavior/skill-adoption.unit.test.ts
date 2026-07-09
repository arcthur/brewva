import { describe, expect, test } from "bun:test";
import {
  formatSkillAdoptionLine,
  projectLatestSkillAdoption,
  projectRecentToolTargetPaths,
  queryRecentSkillProjectionInputs,
  readTargetMatchesSkillFile,
  type SkillProjectionEvent,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/skills/skill-adoption.js";

function selectionEvent(input: {
  timestamp: number;
  selectionId: string;
  rendered: ReadonlyArray<{ name: string; filePath: string }>;
}): SkillProjectionEvent {
  return {
    type: "skill.selection.recorded",
    timestamp: input.timestamp,
    payload: {
      selectionId: input.selectionId,
      renderedSkillReasons: input.rendered.map((entry) => ({
        name: entry.name,
        filePath: entry.filePath,
        reasons: ["name_match"],
        reasonCount: 1,
        score: 200,
        category: "core",
      })),
    },
  };
}

function invocationEvent(input: {
  timestamp: number;
  toolName: string;
  args?: object;
  allowed?: boolean;
}): SkillProjectionEvent {
  // The projections read the kernel COMMITMENT boundary. A blocked call never
  // commits (it aborts), so `allowed: false` is modeled as `tool.aborted`,
  // which the commitment-typed projections skip — the same "did not count"
  // outcome the old `allowed: false` flag produced, now via the real shape.
  const committed = input.allowed !== false;
  return {
    type: committed ? "tool.committed" : "tool.aborted",
    timestamp: input.timestamp,
    payload: {
      call: { toolName: input.toolName, ...(input.args ? { args: input.args } : {}) },
      result: { outcome: { kind: "ok" } },
    },
  };
}

describe("readTargetMatchesSkillFile", () => {
  test("matches equal, relative-vs-absolute, uri-wrapped, and normalized separators", () => {
    expect(readTargetMatchesSkillFile("/abs/skills/a/SKILL.md", "/abs/skills/a/SKILL.md")).toBe(
      true,
    );
    expect(readTargetMatchesSkillFile("skills/a/SKILL.md", "/abs/skills/a/SKILL.md")).toBe(true);
    expect(readTargetMatchesSkillFile("/abs/skills/a/SKILL.md", "skills/a/SKILL.md")).toBe(true);
    expect(readTargetMatchesSkillFile("skills\\a\\SKILL.md", "/abs/skills/a/SKILL.md")).toBe(true);
    expect(readTargetMatchesSkillFile("./skills/a/SKILL.md", "/abs/skills/a/SKILL.md")).toBe(true);
    expect(
      readTargetMatchesSkillFile("file:///abs/skills/a/SKILL.md", "/abs/skills/a/SKILL.md"),
    ).toBe(true);
    expect(
      readTargetMatchesSkillFile(
        "brewva-resource:///file/skills/a/SKILL.md",
        "/abs/skills/a/SKILL.md",
      ),
    ).toBe(true);
  });

  test("never matches partial path segments or different files", () => {
    expect(readTargetMatchesSkillFile("ills/a/SKILL.md", "/abs/skills/a/SKILL.md")).toBe(false);
    expect(readTargetMatchesSkillFile("skills/a/README.md", "/abs/skills/a/SKILL.md")).toBe(false);
    expect(readTargetMatchesSkillFile("", "/abs/skills/a/SKILL.md")).toBe(false);
  });
});

describe("projectLatestSkillAdoption", () => {
  const skillA = { name: "alpha", filePath: "/repo/skills/alpha/SKILL.md" };
  const skillB = { name: "beta", filePath: "/repo/skills/beta/SKILL.md" };

  test("returns null when no visible selection exists", () => {
    expect(projectLatestSkillAdoption([])).toBeNull();
    expect(
      projectLatestSkillAdoption([
        selectionEvent({ timestamp: 1, selectionId: "s0", rendered: [] }),
      ]),
    ).toBeNull();
  });

  test("attributes reads after the latest visible selection only", () => {
    const sample = projectLatestSkillAdoption([
      selectionEvent({ timestamp: 10, selectionId: "s1", rendered: [skillA, skillB] }),
      // Read BEFORE the latest selection must not count for it.
      invocationEvent({
        timestamp: 15,
        toolName: "source_read",
        args: { uri: "skills/beta/SKILL.md" },
      }),
      selectionEvent({ timestamp: 20, selectionId: "s2", rendered: [skillA, skillB] }),
      invocationEvent({
        timestamp: 25,
        toolName: "source_read",
        args: { uri: "skills/alpha/SKILL.md" },
      }),
      // Patch preparation is not a read-class adoption signal; beta stays unadopted.
      invocationEvent({
        timestamp: 26,
        toolName: "source_patch_prepare",
        args: { edits: [{ kind: "replace_anchor", uri: "skills/beta/SKILL.md" }] },
      }),
      invocationEvent({
        timestamp: 27,
        toolName: "source_read",
        args: { uri: "src/unrelated.ts" },
      }),
    ]);
    expect(sample).toMatchObject({
      selectionId: "s2",
      offeredSkillNames: ["alpha", "beta"],
      adoptedSkillNames: ["alpha"],
    });
  });

  test("builtin read counts as adoption; blocked invocations never do", () => {
    const sample = projectLatestSkillAdoption([
      selectionEvent({ timestamp: 10, selectionId: "s1", rendered: [skillA, skillB] }),
      invocationEvent({
        timestamp: 11,
        toolName: "read",
        args: { path: "/repo/skills/alpha/SKILL.md" },
      }),
      // A gate/policy-blocked read never executed: the model saw nothing.
      invocationEvent({
        timestamp: 12,
        toolName: "read",
        args: { path: "/repo/skills/beta/SKILL.md" },
        allowed: false,
      }),
    ]);
    expect(sample?.adoptedSkillNames).toEqual(["alpha"]);
  });

  test("resource_read and look_at count as adoption and missing args are ignored", () => {
    const sample = projectLatestSkillAdoption([
      selectionEvent({ timestamp: 10, selectionId: "s1", rendered: [skillA, skillB] }),
      invocationEvent({
        timestamp: 11,
        toolName: "resource_read",
        args: { uri: "brewva-resource:///file/repo/skills/alpha/SKILL.md" },
      }),
      invocationEvent({
        timestamp: 12,
        toolName: "look_at",
        args: { file_path: "/repo/skills/beta/SKILL.md", goal: "adopt" },
      }),
      invocationEvent({ timestamp: 13, toolName: "source_read" }),
    ]);
    expect(sample?.adoptedSkillNames).toEqual(["alpha", "beta"]);
  });

  test("formatSkillAdoptionLine renders counts and names", () => {
    expect(formatSkillAdoptionLine(null)).toBe("Previous Selection Adoption: none recorded");
    expect(
      formatSkillAdoptionLine({
        selectionId: "s1",
        offeredSkillNames: ["alpha", "beta"],
        adoptedSkillNames: ["alpha"],
      }),
    ).toBe("Previous Selection Adoption: 1/2 rendered SkillCards read (alpha)");
    expect(
      formatSkillAdoptionLine({
        selectionId: "s1",
        offeredSkillNames: ["alpha"],
        adoptedSkillNames: [],
      }),
    ).toBe("Previous Selection Adoption: 0/1 rendered SkillCards read");
  });
});

describe("queryRecentSkillProjectionInputs", () => {
  const skillA = { name: "alpha", filePath: "/repo/skills/alpha/SKILL.md" };

  test("degrades to empty inputs without a query surface", () => {
    expect(queryRecentSkillProjectionInputs(undefined, "s")).toEqual({
      recentInvocations: [],
      adoptionEvents: [],
    });
    expect(
      queryRecentSkillProjectionInputs(
        {
          query: () => {
            throw new Error("projection surface down");
          },
        },
        "s",
      ),
    ).toEqual({
      recentInvocations: [],
      adoptionEvents: [],
    });
  });

  test("fetches adoption reads since the visible selection, past any tail window", () => {
    const tape: SkillProjectionEvent[] = [
      selectionEvent({ timestamp: 100, selectionId: "s1", rendered: [skillA] }),
      invocationEvent({
        timestamp: 110,
        toolName: "read",
        args: { path: "/repo/skills/alpha/SKILL.md" },
      }),
      // 80 filler invocations push the read far beyond a last-60 tail.
      ...Array.from({ length: 80 }, (_, index) =>
        invocationEvent({
          timestamp: 200 + index,
          toolName: "grep",
          args: { query: "x", paths: [`dir/f${index}`] },
        }),
      ),
    ];
    const inputs = queryRecentSkillProjectionInputs(
      {
        query: (_sessionId, query) => {
          let matching = tape.filter(
            (event) =>
              (!query?.type || event.type === query.type) &&
              (query?.after === undefined || event.timestamp > query.after),
          );
          if (typeof query?.last === "number") {
            matching = matching.slice(-query.last);
          }
          if (typeof query?.limit === "number") {
            matching = matching.slice(0, query.limit);
          }
          return matching;
        },
      },
      "s",
    );
    expect(inputs.recentInvocations).toHaveLength(60);
    const adoption = projectLatestSkillAdoption(inputs.adoptionEvents);
    expect(adoption?.adoptedSkillNames).toEqual(["alpha"]);
  });
});

describe("projectRecentToolTargetPaths", () => {
  test("newest-first, deduplicated, limited, and scoped to path-bearing tools", () => {
    const paths = projectRecentToolTargetPaths(
      [
        invocationEvent({ timestamp: 1, toolName: "source_read", args: { uri: "a.ts" } }),
        invocationEvent({
          timestamp: 2,
          toolName: "source_patch_prepare",
          args: { edits: [{ kind: "replace_anchor", uri: "b.ts" }] },
        }),
        invocationEvent({ timestamp: 3, toolName: "grep", args: { query: "x", paths: ["dir/c"] } }),
        invocationEvent({ timestamp: 4, toolName: "source_read", args: { uri: "a.ts" } }),
        invocationEvent({
          timestamp: 5,
          toolName: "agent_send",
          args: { uri: "not-a-file-tool.ts" },
        }),
        { type: "workbench.note.recorded", timestamp: 6, payload: { toolName: "source_read" } },
      ],
      2,
    );
    // The repeated a.ts read collapses to one entry; grep scope path follows.
    expect(paths).toEqual(["a.ts", "dir/c"]);
  });

  test("absolute targets are relativized to the session workspace root for glob matching", () => {
    const paths = projectRecentToolTargetPaths(
      [
        invocationEvent({
          timestamp: 1,
          toolName: "read",
          args: { path: "/repo/src/payment/checkout.ts" },
        }),
        invocationEvent({
          timestamp: 2,
          toolName: "edit",
          args: { path: "/elsewhere/outside.ts" },
        }),
        invocationEvent({
          timestamp: 3,
          toolName: "write",
          args: { path: "docs/notes.md" },
        }),
      ],
      8,
      "/repo",
    );
    // Under-workspace absolute path relativizes; an outside-workspace absolute
    // path stays absolute (and correctly never matches a workspace glob); an
    // already-relative path passes through.
    expect(paths).toEqual(["docs/notes.md", "/elsewhere/outside.ts", "src/payment/checkout.ts"]);
  });

  test("blocked invocations contribute no recent paths", () => {
    const paths = projectRecentToolTargetPaths(
      [
        invocationEvent({
          timestamp: 1,
          toolName: "read",
          args: { path: "denied/area.ts" },
          allowed: false,
        }),
      ],
      8,
    );
    expect(paths).toEqual([]);
  });

  test("glob paths, look_at file_path, and file:// uris contribute targets", () => {
    const paths = projectRecentToolTargetPaths(
      [
        invocationEvent({
          timestamp: 1,
          toolName: "look_at",
          args: { file_path: "src/x.ts", goal: "inspect" },
        }),
        invocationEvent({
          timestamp: 2,
          toolName: "glob",
          args: { pattern: "**/*.ts", paths: ["packages/core", "packages/cli"] },
        }),
        invocationEvent({
          timestamp: 3,
          toolName: "source_read",
          args: { uri: "file:///abs/y.ts" },
        }),
      ],
      8,
    );
    expect(paths).toEqual(["/abs/y.ts", "packages/core", "packages/cli", "src/x.ts"]);
  });
});
