import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecTool } from "@brewva/brewva-tools/execution";
import { requireDefined, requireNonEmptyString, requireRecord } from "../../helpers/assertions.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
import {
  createRuntimeForExecTests,
  extractTextContent,
  fakeContext,
} from "./tools-exec-process.helpers.js";

// Cases here run real subprocesses, which can exceed bun's 5s default test timeout
// under machine load (bare `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

describe("exec command guardrails", () => {
  test("command deny list blocks before execution", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "host",
      commandDenyList: ["node"],
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-deny-list";

    expect(
      execTool.execute(
        "tc-exec-deny-list",
        {
          command: "node -e \"console.log('should-not-run')\"",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    const blocked = requireDefined(
      events.find((event) => event.type === "exec.failed"),
      "Expected exec.failed event.",
    );
    const denyListPolicy = requireNonEmptyString(
      blocked.payload?.denyListPolicy,
      "Expected denyListPolicy.",
    );
    expect(denyListPolicy).toContain("best-effort");
  });

  test("exec rejects brewva tool-name command misroutes", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "host",
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-tool-misroute";

    const result = await execTool.execute(
      "tc-exec-tool-misroute",
      {
        command: "workbench_compact",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result)).toContain("Exec rejected");
    expect(toolOutcomePayload(result)).toMatchObject({
      status: "failed",
      reason: "shell_as_tool",
      executionPreflight: {
        decision: "block",
        findings: [
          expect.objectContaining({
            code: "shell_as_tool",
            severity: "block",
            suggestedTool: "workbench_compact",
          }),
        ],
      },
    });

    const blockedEvent = requireDefined(
      events.find((event) => event.type === "exec.failed"),
      "Expected exec.failed event.",
    );
    const executionPreflight = requireRecord(
      blockedEvent.payload?.executionPreflight,
      "Expected executionPreflight payload.",
    );
    expect(executionPreflight).toMatchObject({ decision: "block" });
  });

  test("exec rejects explicit runtime tape reads before shell execution", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-exec-runtime-tape-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    writeFileSync(join(workspace, ".brewva", "tape", "session.jsonl"), "needle\n", "utf8");
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "host",
      cwd: workspace,
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-runtime-tape";

    const result = await execTool.execute(
      "tc-exec-runtime-tape",
      {
        command: "grep needle .brewva/tape/session.jsonl",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result)).toContain("runtime artifact");
    expect(toolOutcomePayload(result)).toMatchObject({
      status: "failed",
      reason: "runtime_artifact_read_denied",
    });
    requireDefined(
      events.find((event) => event.type === "exec.failed"),
      "Expected exec.failed event.",
    );
  });

  test("exec rejects runtime tape workdirs before shell execution", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-exec-runtime-tape-workdir-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "tape", "session.jsonl"),
      `${JSON.stringify({
        id: "evt-exec-tape-workdir",
        sessionId: "s13-exec-runtime-tape-workdir",
        type: "turn.started",
        timestamp: 1,
        payload: {
          prompt: "needle",
          content: [{ type: "text", text: "needle" }],
        },
      })}\n`,
      "utf8",
    );
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "host",
      cwd: workspace,
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-runtime-tape-workdir";

    const result = await execTool.execute(
      "tc-exec-runtime-tape-workdir",
      {
        command: "ls",
        workdir: ".brewva/tape",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    expect(extractTextContent(result)).toContain("runtime artifact");
    expect(toolOutcomePayload(result)).toMatchObject({
      status: "failed",
      reason: "runtime_artifact_read_denied",
    });
    requireDefined(
      events.find((event) => event.type === "exec.failed"),
      "Expected exec.failed event.",
    );
  });

  test("command deny list blocks shell wrapper inline scripts", async () => {
    const { runtime, events } = createRuntimeForExecTests({
      mode: "standard",
      backend: "host",
      commandDenyList: ["node"],
    });
    const execTool = createExecTool({ runtime });
    const sessionId = "s13-exec-deny-shell-wrapper";

    expect(
      execTool.execute(
        "tc-exec-deny-shell-wrapper",
        {
          command: 'sh -lc "node -e \\"console.log(123)\\""',
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    requireDefined(
      events.find((event) => event.type === "exec.failed"),
      "Expected blocked shell-wrapper event.",
    );
  });
});
