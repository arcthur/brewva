import { describe, expect, test } from "bun:test";
import type { BoxExecSpec, BoxHandle, BoxPlane, BoxScope } from "@brewva/brewva-box";
import { createExecTool, createProcessTool } from "@brewva/brewva-tools";
import {
  createRuntimeForExecTests,
  extractTextContent,
  fakeContext,
} from "./tools-exec-process.helpers.js";

function eventTypes(events: Array<{ type?: string }>): string[] {
  return events.flatMap((event) => (typeof event.type === "string" ? [event.type] : []));
}

const REMOVED_LEGACY_BOX_ERROR_EVENT = ["exec", "sand", "box", "error"].join("_");

function createCapturingBoxPlane(calls: {
  scopes: BoxScope[];
  execs: BoxExecSpec[];
  snapshots: string[];
  releases?: Array<{ kind: string; id: string; reason: string }>;
  result?: { stdout: string; stderr: string; exitCode: number };
  waitDelayMs?: number;
}): BoxPlane {
  const acquiredBoxes: Array<{ id: string; scope: BoxScope; fingerprint: string }> = [];
  return {
    async acquire(scope) {
      calls.scopes.push(scope);
      acquiredBoxes.push({
        id: "box-captured",
        scope,
        fingerprint: "fingerprint-captured",
      });
      const handle: BoxHandle = {
        id: "box-captured",
        scope,
        fingerprint: "fingerprint-captured",
        acquisitionReason: "created",
        async exec(spec) {
          calls.execs.push(spec);
          return {
            id: "exec-captured",
            boxId: "box-captured",
            detached: spec.detach === true,
            async wait() {
              if (calls.waitDelayMs && calls.waitDelayMs > 0) {
                await new Promise((resolveNow) => setTimeout(resolveNow, calls.waitDelayMs));
              }
              return {
                id: "exec-captured",
                boxId: "box-captured",
                stdout: calls.result?.stdout ?? "captured\n",
                stderr: calls.result?.stderr ?? "",
                exitCode: calls.result?.exitCode ?? 0,
              };
            },
            async kill() {},
          };
        },
        async snapshot(name) {
          calls.snapshots.push(name);
          return {
            id: "snapshot-captured",
            name,
            boxId: "box-captured",
            createdAt: new Date(0).toISOString(),
          };
        },
        async restore() {},
        async fork() {
          return handle;
        },
        async release(reason) {
          calls.releases?.push({ kind: scope.kind, id: scope.id, reason });
        },
      };
      return handle;
    },
    async inspect() {
      return {
        boxes: acquiredBoxes.map((box) => ({
          id: box.id,
          scope: box.scope,
          fingerprint: box.fingerprint,
          createReason: "created" as const,
          createdAt: new Date(0).toISOString(),
          snapshots: [],
        })),
      };
    },
    async reattach() {
      return {
        id: "exec-captured",
        boxId: "box-captured",
        detached: true,
        async wait() {
          return {
            id: "exec-captured",
            boxId: "box-captured",
            stdout: "reattached\n",
            stderr: "",
            exitCode: 0,
          };
        },
        async kill() {},
      };
    },
    async observeExecution(_boxId, _executionId, options) {
      const stdout = calls.result?.stdout ?? "captured\n";
      const stderr = calls.result?.stderr ?? "";
      const stdoutOffset = Math.max(0, options?.stdoutOffset ?? 0);
      const stderrOffset = Math.max(0, options?.stderrOffset ?? 0);
      return {
        id: "exec-captured",
        boxId: "box-captured",
        status: "completed",
        stdout: stdout.slice(stdoutOffset),
        stderr: stderr.slice(stderrOffset),
        stdoutOffset: stdout.length,
        stderrOffset: stderr.length,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        exitCode: 0,
      };
    },
    async releaseScope(scope, reason) {
      calls.releases?.push({ kind: scope.kind, id: scope.id, reason });
    },
    async maintain() {
      return { stopped: [], removed: [], retained: [] };
    },
  };
}

describe("exec box routing", () => {
  test("box backend records acquired, started, and completed events without host fallback", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-routing",
      {
        command: "echo box-ok",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-routing"),
    );

    expect(extractTextContent(result)).toContain("(no output)");
    expect((result.details as { backend?: string }).backend).toBe("box");
    expect(eventTypes(events)).toContain("box.acquired");
    expect(eventTypes(events)).toContain("box.bootstrap.started");
    expect(eventTypes(events)).toContain("box.bootstrap.progress");
    expect(eventTypes(events)).toContain("box.bootstrap.completed");
    expect(eventTypes(events)).toContain("box.exec.started");
    expect(eventTypes(events)).toContain("box.exec.completed");
    expect(eventTypes(events)).not.toContain("box.released");
    expect(events.find((event) => event.type === "box.acquired")?.payload?.acquisitionReason).toBe(
      "created",
    );
    expect(eventTypes(events)).not.toContain(["exec", "fallback", "host"].join("_"));
    expect(eventTypes(events)).not.toContain(REMOVED_LEGACY_BOX_ERROR_EVENT);
  });

  test("host backend remains explicit and does not emit removed fallback events", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-host-routing",
      {
        command: "echo host-ok",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-host-routing"),
    );

    expect(extractTextContent(result)).toContain("host-ok");
    expect((result.details as { backend?: string }).backend).toBe("host");
    expect(eventTypes(events)).toContain("exec.started");
    expect(eventTypes(events)).not.toContain("box.exec.started");
    expect(eventTypes(events)).not.toContain(["exec", "fallback", "host"].join("_"));
    expect(eventTypes(events)).not.toContain(REMOVED_LEGACY_BOX_ERROR_EVENT);
  });

  test("box backend maps host workdir to guest workspace cwd and snapshots before writes", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
    };
    const workspaceRoot = "/tmp/brewva-box-routing";
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      cwd: workspaceRoot,
      targetRoots: [workspaceRoot],
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    const result = await execTool.execute(
      "tc-exec-box-cwd-snapshot",
      {
        command: "touch output.txt",
        workdir: "packages/app",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-cwd-snapshot"),
    );

    expect(extractTextContent(result)).toContain("captured");
    expect(calls.scopes[0]?.workspaceRoot).toBe(workspaceRoot);
    expect(calls.execs[0]?.cwd).toBe("/workspace/packages/app");
    expect(calls.snapshots).toHaveLength(1);
    expect(eventTypes(events)).toContain("box.snapshot.created");
    expect(
      events.find((event) => event.type === "box.exec.started")?.payload?.effectiveBoxCwd,
    ).toBe("/workspace/packages/app");
  });

  test("box backend records failed events for non-zero process exits", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      result: {
        stdout: "",
        stderr: "boom\n",
        exitCode: 42,
      },
    };
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    let thrown: unknown;
    try {
      await execTool.execute(
        "tc-exec-box-nonzero",
        {
          command: "false",
        },
        undefined,
        undefined,
        fakeContext("s13-exec-box-nonzero"),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Process exited with code 42");

    const failed = events.find((event) => event.type === "box.exec.failed");
    expect(failed?.payload?.boxId).toBe("box-captured");
    expect(failed?.payload?.exitCode).toBe(42);
    expect(failed?.payload?.reason).toBe("box_process_nonzero");
    expect(eventTypes(events)).not.toContain("box.exec.completed");
  });

  test("session-scoped boxes are released on session clear, not after each exec", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      releases: [] as Array<{ kind: string; id: string; reason: string }>,
    };
    const { runtime, clearSession } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });

    await execTool.execute(
      "tc-exec-box-session-release",
      {
        command: "echo release-on-clear",
      },
      undefined,
      undefined,
      fakeContext("s13-exec-box-session-release"),
    );

    expect(calls.releases).toEqual([]);

    clearSession("s13-exec-box-session-release");
    await new Promise((resolveNow) => setTimeout(resolveNow, 0));

    expect(calls.releases).toEqual([
      {
        kind: "session",
        id: "s13-exec-box-session-release",
        reason: "session_closed",
      },
    ]);
  });

  test("box background execution returns a process session backed by box execution identity", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool();
    const sessionId = "s13-exec-box-background";

    const started = await execTool.execute(
      "tc-exec-box-background",
      {
        command: "sleep 1 && echo done",
        background: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const details = started.details as {
      sessionId?: string;
      boxId?: string;
      executionId?: string;
      status?: string;
    };

    expect(details.status).toBe("running");
    expect(details.boxId).toBe("box-captured");
    expect(details.executionId).toBe("exec-captured");
    expect(calls.execs[0]?.detach).toBe(true);
    expect(typeof details.sessionId).toBe("string");

    const polled = await processTool.execute(
      "tc-process-box-background",
      {
        action: "poll",
        sessionId: details.sessionId,
        timeout: 1000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(polled)).toContain("captured");
    expect((polled.details as { backend?: string }).backend).toBe("box");
  });

  test("box background execution defers non-detach release until completion", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
      releases: [] as Array<{ kind: string; id: string; reason: string }>,
      waitDelayMs: 50,
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxDetach: false,
      boxPlane: createCapturingBoxPlane(calls),
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool();
    const sessionId = "s13-exec-box-background-release";

    const started = await execTool.execute(
      "tc-exec-box-background-release",
      {
        command: "sleep 1 && echo done",
        background: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const details = started.details as { sessionId?: string; status?: string };

    expect(details.status).toBe("running");
    expect(calls.releases).toEqual([]);

    await processTool.execute(
      "tc-process-box-background-release",
      {
        action: "poll",
        sessionId: details.sessionId,
        timeout: 1000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const releaseDeadline = Date.now() + 1000;
    while (calls.releases.length === 0 && Date.now() < releaseDeadline) {
      await new Promise((resolveNow) => setTimeout(resolveNow, 10));
    }

    expect(calls.releases).toEqual([
      {
        kind: "session",
        id: sessionId,
        reason: "task_completed",
      },
    ]);
  });

  test("process can observe a detached box execution by box identity without an in-memory session", async () => {
    const calls = {
      scopes: [] as BoxScope[],
      execs: [] as BoxExecSpec[],
      snapshots: [] as string[],
    };
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane: createCapturingBoxPlane(calls),
    });
    const processTool = createProcessTool({ runtime });

    const polled = await processTool.execute(
      "tc-process-box-reattach",
      {
        action: "poll",
        boxId: "box-captured",
        executionId: "exec-captured",
      },
      undefined,
      undefined,
      fakeContext("s13-process-box-reattach"),
    );

    expect(extractTextContent(polled)).toContain("captured");
    expect((polled.details as { backend?: string; reattached?: boolean }).backend).toBe("box");
    expect((polled.details as { backend?: string; reattached?: boolean }).reattached).toBe(true);
  });
});
