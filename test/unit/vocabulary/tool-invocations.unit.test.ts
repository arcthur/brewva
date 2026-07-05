import { describe, expect, test } from "bun:test";
import {
  deriveLatestTreeMutationAt,
  extractWriteInvocationPaths,
  projectFreshCodeWritten,
  projectToolInvocations,
  TOOL_COMMITTED_EVENT_TYPE,
  WRITE_TOOL_NAMES,
  type ToolInvocation,
} from "@brewva/brewva-vocabulary/tool-invocations";
import {
  ROLLBACK_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";

// A tool run, in the exact `tool.committed` shape the hosted managed-session
// path emits: `payload.call.{toolName,args}` + `payload.result.outcome.kind`.
// These fixtures feed the SAME shape production carries, so a projection that
// reads the wrong event kind can no longer pass its unit tests (the blind spot
// that shipped the review-debt producer dead on every real tape).
function committed(input: {
  toolName: string;
  args?: Record<string, unknown>;
  timestamp?: number;
  outcome?: "ok" | "err" | "inconclusive";
}) {
  return {
    type: TOOL_COMMITTED_EVENT_TYPE,
    timestamp: input.timestamp ?? 0,
    payload: {
      call: {
        toolCallId: `c-${input.timestamp ?? 0}`,
        toolName: input.toolName,
        args: input.args ?? {},
      },
      result: { outcome: { kind: input.outcome ?? "ok" } },
    },
  };
}

const invocation = (input: {
  toolName: string;
  args?: Record<string, unknown>;
  timestamp?: number;
  outcome?: "ok" | "err" | "inconclusive";
}): ToolInvocation => ({
  toolCallId: null,
  toolName: input.toolName,
  args: input.args ?? {},
  timestamp: input.timestamp ?? 0,
  outcome: input.outcome ?? "ok",
});

describe("projectToolInvocations — the canonical read-model over the commitment boundary", () => {
  test("normalizes tool.committed into {toolName, args, outcome}, tape order preserved", () => {
    const result = projectToolInvocations([
      committed({ toolName: "write", args: { path: "a.ts" }, timestamp: 1 }),
      { type: "turn.started", timestamp: 2, payload: {} },
      committed({
        toolName: "exec",
        args: { command: "make build" },
        timestamp: 3,
        outcome: "err",
      }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ toolName: "write", outcome: "ok", args: { path: "a.ts" } });
    expect(result[1]).toMatchObject({ toolName: "exec", outcome: "err" });
  });

  test("ignores non-commitment events, including a blocked call that aborted", () => {
    const result = projectToolInvocations([
      { type: "tool.aborted", timestamp: 1, payload: { call: { toolName: "write", args: {} } } },
      { type: "tool.invocation.started", timestamp: 2, payload: { toolName: "edit", args: {} } },
    ]);
    expect(result).toEqual([]);
  });

  test("skips a commitment with no usable call.toolName rather than yielding a nameless run", () => {
    expect(
      projectToolInvocations([
        { type: TOOL_COMMITTED_EVENT_TYPE, timestamp: 1, payload: { call: { args: {} } } },
        { type: TOOL_COMMITTED_EVENT_TYPE, timestamp: 2, payload: {} },
      ]),
    ).toEqual([]);
  });
});

describe("WRITE_TOOL_NAMES", () => {
  test("contains exactly the write-class tool names", () => {
    expect(WRITE_TOOL_NAMES).toBeInstanceOf(Set);
    expect([...WRITE_TOOL_NAMES].toSorted()).toEqual(["edit", "source_patch_apply", "write"]);
  });
});

describe("projectFreshCodeWritten", () => {
  test("true when a write-class tool committed successfully", () => {
    expect(projectFreshCodeWritten([invocation({ toolName: "write" })])).toBe(true);
    expect(projectFreshCodeWritten([invocation({ toolName: "edit" })])).toBe(true);
    expect(projectFreshCodeWritten([invocation({ toolName: "source_patch_apply" })])).toBe(true);
  });
  test("false for a non-write tool, and for a write that errored", () => {
    expect(projectFreshCodeWritten([invocation({ toolName: "read" })])).toBe(false);
    expect(projectFreshCodeWritten([invocation({ toolName: "write", outcome: "err" })])).toBe(
      false,
    );
    expect(projectFreshCodeWritten([])).toBe(false);
  });
  test("reads end-to-end from committed events (the production shape)", () => {
    const invocations = projectToolInvocations([
      committed({ toolName: "write", args: { path: "x" } }),
    ]);
    expect(projectFreshCodeWritten(invocations)).toBe(true);
  });
});

describe("extractWriteInvocationPaths", () => {
  test("returns each bare-write's parsed path; source_patch_apply is excluded", () => {
    const paths = extractWriteInvocationPaths([
      invocation({ toolName: "write", args: { path: "a.ts" } }),
      invocation({ toolName: "edit", args: { file_path: "b.ts" } }),
      invocation({ toolName: "source_patch_apply", args: { path: "c.ts" } }),
      invocation({ toolName: "read", args: { path: "d.ts" } }),
    ]);
    expect(paths).toEqual([
      { path: "a.ts", cwd: null },
      { path: "b.ts", cwd: null },
    ]);
  });
  test("an unparseable write path yields { path: null } (universe not-fully-known)", () => {
    expect(extractWriteInvocationPaths([invocation({ toolName: "write", args: {} })])).toEqual([
      { path: null, cwd: null },
    ]);
  });
  test("the optional workspaceRoot is carried on cwd so the caller need not remap (single-homed)", () => {
    expect(
      extractWriteInvocationPaths(
        [
          invocation({ toolName: "write", args: { path: "/ws/app/a.ts" } }),
          invocation({ toolName: "edit", args: { file_path: "/ws/app/b.ts" } }),
        ],
        "/ws/app",
      ),
    ).toEqual([
      { path: "/ws/app/a.ts", cwd: "/ws/app" },
      { path: "/ws/app/b.ts", cwd: "/ws/app" },
    ]);
  });
});

describe("deriveLatestTreeMutationAt (Finding P1 — bare write/edit ages the tree)", () => {
  const patchApplied = (timestamp: number, ok = true) => ({
    type: SOURCE_PATCH_APPLIED_EVENT_TYPE,
    timestamp,
    payload: { ok, patchSetId: `ps-${timestamp}`, appliedPaths: ["a.ts"] },
  });
  const rollback = (timestamp: number, ok = true) => ({
    type: ROLLBACK_EVENT_TYPE,
    timestamp,
    payload: { ok },
  });
  const bareWrite = (timestamp: number, opts: { toolName?: string; outcome?: "ok" | "err" } = {}) =>
    invocation({
      toolName: opts.toolName ?? "edit",
      args: { file_path: "a.ts" },
      timestamp,
      outcome: opts.outcome,
    });

  test("returns null when neither channel has a mutation", () => {
    expect(
      deriveLatestTreeMutationAt({ patchRollbackEvents: [], writeInvocations: [] }),
    ).toBeNull();
  });
  test("a bare edit/write commitment advances the timestamp like a patch application", () => {
    expect(
      deriveLatestTreeMutationAt({ patchRollbackEvents: [], writeInvocations: [bareWrite(950)] }),
    ).toBe(950);
  });
  test("takes the max across patch, rollback, and bare-write channels", () => {
    expect(
      deriveLatestTreeMutationAt({
        patchRollbackEvents: [patchApplied(100), rollback(300)],
        writeInvocations: [bareWrite(200)],
      }),
    ).toBe(300);
    expect(
      deriveLatestTreeMutationAt({
        patchRollbackEvents: [patchApplied(100)],
        writeInvocations: [bareWrite(500)],
      }),
    ).toBe(500);
  });
  test("a failed patch/rollback (ok !== true) never advances the timestamp", () => {
    expect(
      deriveLatestTreeMutationAt({
        patchRollbackEvents: [patchApplied(900, false), rollback(950, false)],
        writeInvocations: [],
      }),
    ).toBeNull();
  });
  test("an errored bare write did not mutate the tree, so it does not count", () => {
    expect(
      deriveLatestTreeMutationAt({
        patchRollbackEvents: [],
        writeInvocations: [bareWrite(950, { outcome: "err" })],
      }),
    ).toBeNull();
  });
  test("a non-write tool does not count", () => {
    expect(
      deriveLatestTreeMutationAt({
        patchRollbackEvents: [],
        writeInvocations: [bareWrite(950, { toolName: "read" })],
      }),
    ).toBeNull();
  });
  test("source_patch_apply does NOT count on the write channel (its applied receipt is truth)", () => {
    expect(
      deriveLatestTreeMutationAt({
        patchRollbackEvents: [],
        writeInvocations: [bareWrite(950, { toolName: "source_patch_apply" })],
      }),
    ).toBeNull();
  });
});
