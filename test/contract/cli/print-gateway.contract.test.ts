import { describe, expect, test } from "bun:test";
import { assertCliSuccess, runCli } from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import { countEventType, parseEventFile, requireLatestEventFile } from "../../helpers/events.js";
import { startGatewayDaemonHarness } from "../../helpers/gateway.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("cli contract: gateway-backed print mode", () => {
  test("gateway-backed print emits assistant text and persists core events", async () => {
    const workspace = createTestWorkspace("contract-print-gateway");
    writeMinimalConfig(workspace);
    const harness = await startGatewayDaemonHarness({
      workspace,
      fakeAssistantText: "SYSTEM_PRINT_OK",
    });

    try {
      const result = await runCli(
        workspace,
        [
          "--cwd",
          workspace,
          "--config",
          ".brewva/brewva.json",
          "--backend",
          "gateway",
          "--print",
          "Return the latest status summary.",
        ],
        {
          env: harness.env,
        },
      );
      assertCliSuccess(result, "system-print");
      expect(result.stdout).toContain("SYSTEM_PRINT_OK");

      const eventFile = requireLatestEventFile(workspace, "gateway-backed print mode");
      const events = parseEventFile(eventFile, { strict: true });
      expect(countEventType(events, "session_start")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "turn_start")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "turn_end")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "agent_end")).toBeGreaterThanOrEqual(1);
    } finally {
      await harness.dispose();
      cleanupTestWorkspace(workspace);
    }
  });
});
