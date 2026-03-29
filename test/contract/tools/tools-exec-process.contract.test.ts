import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecTool, createProcessTool } from "@brewva/brewva-tools";
import { requireDefined, requireNonEmptyString } from "../../helpers/assertions.js";
import {
  createRuntimeForExecTests,
  extractTextContent,
  fakeContext,
} from "./tools-exec-process.helpers.js";

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

    const routedEvents = events.filter((event) => event.type === "exec_routed");
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
