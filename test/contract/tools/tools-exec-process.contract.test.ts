import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxExecSpec, BoxHandle, BoxPlane, BoxScope } from "@brewva/brewva-box";
import { createExecTool, createProcessTool } from "@brewva/brewva-tools";
import { requireDefined, requireNonEmptyString } from "../../helpers/assertions.js";
import {
  createRuntimeForExecTests,
  extractTextContent,
  fakeContext,
} from "./tools-exec-process.helpers.js";

function createOutputRaceBoxPlane(output: string, observedOffsets: number[]): BoxPlane {
  let releaseObservationGate: (() => void) | undefined;
  let firstObservationStarted: (() => void) | undefined;
  const firstObservation = new Promise<void>((resolveNow) => {
    firstObservationStarted = resolveNow;
  });
  const observationGate = new Promise<void>((resolveNow) => {
    releaseObservationGate = resolveNow;
  });
  let observationCount = 0;
  let gateTimer: ReturnType<typeof setTimeout> | undefined;
  const scopeRecords: BoxScope[] = [];

  const handleForScope = (scope: BoxScope): BoxHandle => ({
    id: "box-output-race",
    scope,
    fingerprint: "fingerprint-output-race",
    acquisitionReason: "created",
    async exec(spec: BoxExecSpec) {
      return {
        id: "exec-output-race",
        boxId: "box-output-race",
        detached: spec.detach === true,
        async wait() {
          await firstObservation;
          await new Promise((resolveNow) => setTimeout(resolveNow, 0));
          return {
            id: "exec-output-race",
            boxId: "box-output-race",
            stdout: output,
            stderr: "",
            exitCode: 0,
          };
        },
        async kill() {},
      };
    },
    async snapshot(name) {
      return {
        id: "snapshot-output-race",
        name,
        boxId: "box-output-race",
        createdAt: new Date(0).toISOString(),
      };
    },
    async restore() {},
    async fork() {
      return handleForScope(scope);
    },
    async release() {},
  });

  return {
    async acquire(scope) {
      scopeRecords.push(scope);
      return handleForScope(scope);
    },
    async reattach() {
      return undefined;
    },
    async observeExecution(_boxId, _executionId, options) {
      observationCount += 1;
      const offset = Math.max(0, options?.stdoutOffset ?? 0);
      observedOffsets.push(offset);
      if (observationCount === 1) {
        firstObservationStarted?.();
        gateTimer = setTimeout(() => releaseObservationGate?.(), 20);
        await observationGate;
      } else {
        if (gateTimer) clearTimeout(gateTimer);
        releaseObservationGate?.();
      }
      return {
        id: "exec-output-race",
        boxId: "box-output-race",
        status: "completed",
        stdout: output.slice(offset),
        stderr: "",
        stdoutOffset: output.length,
        stderrOffset: 0,
        stdoutBytes: output.length,
        stderrBytes: 0,
        exitCode: 0,
      };
    },
    async releaseScope() {},
    async inspect() {
      return {
        boxes: scopeRecords.map((scope) => ({
          id: "box-output-race",
          scope,
          fingerprint: "fingerprint-output-race",
          createReason: "created",
          createdAt: new Date(0).toISOString(),
          snapshots: [],
        })),
      };
    },
    async maintain() {
      return { stopped: [], removed: [], retained: [] };
    },
  };
}

function createChunkedDetachedBoxPlane(chunks: string[], observedOffsets: number[]): BoxPlane {
  const output = chunks.join("");
  const scopeRecords: BoxScope[] = [];

  const handleForScope = (scope: BoxScope): BoxHandle => ({
    id: "box-chunked-detached",
    scope,
    fingerprint: "fingerprint-chunked-detached",
    acquisitionReason: "created",
    async exec() {
      return {
        id: "exec-chunked-detached",
        boxId: "box-chunked-detached",
        detached: true,
        async wait() {
          return {
            id: "exec-chunked-detached",
            boxId: "box-chunked-detached",
            stdout: output,
            stderr: "",
            exitCode: 0,
          };
        },
        async kill() {},
      };
    },
    async snapshot(name) {
      return {
        id: "snapshot-chunked-detached",
        name,
        boxId: "box-chunked-detached",
        createdAt: new Date(0).toISOString(),
      };
    },
    async restore() {},
    async fork() {
      return handleForScope(scope);
    },
    async release() {},
  });

  return {
    async acquire(scope) {
      scopeRecords.push(scope);
      return handleForScope(scope);
    },
    async reattach() {
      return undefined;
    },
    async observeExecution(_boxId, _executionId, options) {
      const offset = Math.max(0, options?.stdoutOffset ?? 0);
      observedOffsets.push(offset);
      const chunk =
        offset === 0
          ? (chunks[0] ?? "")
          : output.slice(offset, offset + (chunks[1]?.length ?? output.length));
      const nextOffset = Math.min(output.length, offset + chunk.length);
      return {
        id: "exec-chunked-detached",
        boxId: "box-chunked-detached",
        status: nextOffset >= output.length ? "completed" : "running",
        stdout: chunk,
        stderr: "",
        stdoutOffset: nextOffset,
        stderrOffset: 0,
        stdoutBytes: output.length,
        stderrBytes: 0,
        stdoutTruncated: nextOffset < output.length,
        exitCode: nextOffset >= output.length ? 0 : undefined,
      };
    },
    async releaseScope() {},
    async inspect() {
      return {
        boxes: scopeRecords.map((scope) => ({
          id: "box-chunked-detached",
          scope,
          fingerprint: "fingerprint-chunked-detached",
          createReason: "created",
          createdAt: new Date(0).toISOString(),
          snapshots: [],
        })),
      };
    },
    async maintain() {
      return { stopped: [], removed: [], retained: [] };
    },
  };
}

describe("exec/process tool flow", () => {
  test("exec backgrounds and process poll waits for completion", async () => {
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool();
    const sessionId = "s13-exec-process";

    const started = await execTool.execute(
      "tc-exec-start",
      {
        command: "node -e \"setTimeout(() => { console.log('done') }, 150)\"",
        yieldMs: 10,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const startDetails = started.details as {
      status?: string;
      verdict?: string;
      sessionId?: string;
    };
    expect(startDetails.status).toBe("running");
    expect(startDetails.verdict).toBe("inconclusive");
    const sessionHandle = requireNonEmptyString(
      startDetails.sessionId,
      "Expected background exec sessionId.",
    );
    let observedDone = false;
    let finalStatus: string | undefined;
    let finalVerdict: string | undefined;

    for (const [index, pollCallId] of [
      "tc-exec-poll",
      "tc-exec-poll-finished",
      "tc-exec-poll-final",
    ].entries()) {
      const polled = await processTool.execute(
        pollCallId,
        {
          action: "poll",
          sessionId: sessionHandle,
          timeout: 2_000,
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      );
      const pollText = extractTextContent(polled);
      observedDone ||= pollText.includes("done");

      const pollDetails = polled.details as { status?: string; verdict?: string };
      finalStatus = pollDetails.status;
      finalVerdict = pollDetails.verdict;

      if (pollDetails.status === "completed") {
        break;
      }

      expect(pollDetails.status).toBe("running");
      expect(pollDetails.verdict).toBe("inconclusive");
      expect(index).toBeLessThan(2);
    }

    expect(observedDone).toBe(true);
    expect(finalStatus).toBe("completed");
    expect(finalVerdict).toBeUndefined();
  });

  test("box background output polling does not duplicate final observed chunks", async () => {
    const output = "box-race-output\n";
    const observedOffsets: number[] = [];
    const boxPlane = createOutputRaceBoxPlane(output, observedOffsets);
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane,
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool({ runtime });
    const sessionId = "s13-box-output-race";

    const started = await execTool.execute(
      "tc-box-output-race-start",
      {
        command: "echo box-race-output",
        background: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const sessionHandle = requireNonEmptyString(
      (started.details as { sessionId?: string }).sessionId,
      "Expected box process session handle.",
    );

    const polled = await processTool.execute(
      "tc-box-output-race-poll",
      {
        action: "poll",
        sessionId: sessionHandle,
        timeout: 2_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const pollText = extractTextContent(polled);
    const occurrences = pollText.split("box-race-output").length - 1;

    expect((polled.details as { status?: string }).status).toBe("completed");
    expect(occurrences).toBe(1);
    expect(observedOffsets).toContain(output.length);
  });

  test("direct detached box polling advances observe offsets", async () => {
    const observedOffsets: number[] = [];
    const firstChunk = "first-chunk\n";
    const chunks = [firstChunk, "second-chunk\n"];
    const boxPlane = createChunkedDetachedBoxPlane(chunks, observedOffsets);
    const { runtime } = createRuntimeForExecTests({
      mode: "standard",
      backend: "box",
      boxPlane,
    });
    const processTool = createProcessTool({ runtime });
    const sessionId = "s13-direct-box-offsets";

    const polled = await processTool.execute(
      "tc-direct-box-offsets-poll",
      {
        action: "poll",
        boxId: "box-chunked-detached",
        executionId: "exec-chunked-detached",
        timeout: 1_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const pollText = extractTextContent(polled);
    expect(pollText).toContain("first-chunk");
    expect(pollText).toContain("second-chunk");
    expect((polled.details as { status?: string }).status).toBe("completed");
    expect(observedOffsets).toEqual([0, firstChunk.length]);
  });

  test("process kill stops a background session", async () => {
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const processTool = createProcessTool();
    const sessionId = "s13-process-kill";

    const started = await execTool.execute(
      "tc-exec-start",
      {
        command: "node -e \"setInterval(() => process.stdout.write('tick\\\\n'), 40)\"",
        background: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const sessionHandle = requireNonEmptyString(
      (started.details as { sessionId?: string }).sessionId,
      "Expected process session handle.",
    );

    const killed = await processTool.execute(
      "tc-process-kill",
      {
        action: "kill",
        sessionId: sessionHandle,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect((killed.details as { status?: string; verdict?: string }).status).toBe("failed");
    expect((killed.details as { status?: string; verdict?: string }).verdict).toBe("fail");

    const polled = await processTool.execute(
      "tc-process-poll",
      {
        action: "poll",
        sessionId: sessionHandle,
        timeout: 1_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const pollStatus = requireDefined(
      (polled.details as { status?: string }).status,
      "expected polled process status",
    );
    expect(["completed", "failed"]).toContain(pollStatus);
  });

  test("exec rejects missing command with explicit fail verdict", async () => {
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-missing-command";

    const rejected = await execTool.execute(
      "tc-exec-missing-command",
      {
        command: "   ",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const details = rejected.details as { status?: string; verdict?: string };
    expect(details.status).toBe("failed");
    expect(details.verdict).toBe("fail");
  });

  test("exec throws on non-zero exit code", async () => {
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-fail";

    expect(
      execTool.execute(
        "tc-exec-fail",
        {
          command: 'node -e "process.exit(2)"',
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("Process exited");
  });

  test("exec interprets large timeout values as milliseconds", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-timeout-ms";

    const resultFromLargeTimeout = await execTool.execute(
      "tc-exec-timeout-ms-1",
      {
        command: "echo timeout-large",
        timeout: 120_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(resultFromLargeTimeout)).toContain("timeout-large");

    const routedEvents = events.filter((event) => event.type === "exec.started");
    expect(routedEvents[0]?.payload?.requestedTimeoutSec).toBe(120);
    expect(routedEvents).toHaveLength(1);
  });

  test("credential bindings override user-provided env for exec", async () => {
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
      boundEnv: {
        OPENAI_API_KEY: "sk-bound-credential",
      },
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-bound-env";

    const result = await execTool.execute(
      "tc-exec-bound-env",
      {
        command: 'node -e "process.stdout.write(process.env.OPENAI_API_KEY || \\"\\" )"',
        env: {
          OPENAI_API_KEY: "user-supplied-value",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result);
    expect(text).toContain("sk-bound-credential");
    expect(text).not.toContain("user-supplied-value");
  });

  test("exec rejects workdir values outside the task target roots", async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "brewva-exec-allowed-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "brewva-exec-outside-root-"));
    const { runtime } = createRuntimeForExecTests({
      mode: "permissive",
      backend: "host",
      cwd: allowedRoot,
      targetRoots: [allowedRoot],
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-workdir-outside-target";

    const result = await execTool.execute(
      "tc-exec-workdir-outside-target",
      {
        command: "pwd",
        workdir: outsideRoot,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const details = result.details as { status?: string; verdict?: string; reason?: string };
    expect(details.status).toBe("failed");
    expect(details.verdict).toBe("fail");
    expect(details.reason).toBe("workdir_outside_target");
    expect(extractTextContent(result)).toContain("Exec rejected (workdir_outside_target)");
  });
});
