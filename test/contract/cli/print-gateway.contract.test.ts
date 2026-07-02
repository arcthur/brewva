import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { assertCliSuccess, runCli } from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import { parseEventFile, requireLatestCanonicalTapeFile } from "../../helpers/events.js";
import {
  GATEWAY_BACKED_CLI_CONTRACT_TIMEOUT_MS,
  startGatewayDaemonHarness,
} from "../../helpers/gateway.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

// Cases here do real end-to-end work (subprocess spawns, source-tree scans, embedded
// runtimes) that can exceed bun's 5s default test timeout under machine load (bare
// `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

describe("cli contract: gateway-backed print mode", () => {
  test(
    "gateway-backed print emits assistant text and persists core events",
    async () => {
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

        const tapeFile = requireLatestCanonicalTapeFile(workspace, "gateway-backed print mode");
        const events = parseEventFile(tapeFile, { strict: true });
        expect(events.map((event) => event.type)).toEqual(
          expect.arrayContaining(["turn.started", "msg.committed", "turn.ended"]),
        );
        expect(events.find((event) => event.type === "msg.committed")?.payload).toEqual({
          text: "SYSTEM_PRINT_OK",
        });
      } finally {
        await harness.dispose();
        cleanupTestWorkspace(workspace);
      }
    },
    GATEWAY_BACKED_CLI_CONTRACT_TIMEOUT_MS,
  );
});
