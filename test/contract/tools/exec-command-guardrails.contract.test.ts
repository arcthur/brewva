import { describe, expect, test } from "bun:test";
import { createExecTool } from "@brewva/brewva-tools";
import { requireDefined, requireNonEmptyString } from "../../helpers/assertions.js";
import { createRuntimeForExecTests, fakeContext } from "./tools-exec-process.helpers.js";

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
      events.find((event) => event.type === "exec_blocked_isolation"),
      "Expected exec_blocked_isolation event.",
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

    expect(
      execTool.execute(
        "tc-exec-tool-misroute",
        {
          command: "session_compact",
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("exec_blocked_isolation");

    const blockedEvent = events.find((event) => event.type === "exec_blocked_isolation");
    expect(blockedEvent?.payload?.blockedAsToolNameMisroute).toBe(true);
    expect(blockedEvent?.payload?.suggestedTool).toBe("session_compact");
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
      events.find((event) => event.type === "exec_blocked_isolation"),
      "Expected blocked shell-wrapper event.",
    );
  });
});
