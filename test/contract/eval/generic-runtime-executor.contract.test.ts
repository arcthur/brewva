import { describe, expect, test } from "bun:test";
import { executeGenericRuntimeScenario } from "../../eval/generic-runtime.js";
import type { EvalScenario } from "../../eval/types.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import {
  GATEWAY_BACKED_CLI_CONTRACT_TIMEOUT_MS,
  startGatewayDaemonHarness,
} from "../../helpers/gateway.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

// Hermetic end-to-end proof of the generic runtime eval executor: a real
// `brewva --print` process against the fake-assistant gateway harness, so the
// pipeline (prompt assembly -> CLI spawn -> stdout collection -> named-fence
// parsing) is exercised without a live model. Real-model measurement stays a
// manual `bun run eval` invocation by design (it spends provider tokens).

const scenario: EvalScenario = {
  id: "executor-smoke",
  skill: "harness-fluency",
  description: "executor smoke",
  context: {
    task_description: "State your continuation decision for the active goal.",
    available_artifacts: { goal_state: "authorized" },
  },
  rubric_path: "unused",
  output_contracts: {
    continuation_decision: { kind: "json", min_keys: 2 },
    turn_plan: { kind: "text", min_words: 3 },
  },
};

const FAKE_RESPONSE = [
  "```continuation_decision",
  '{ "interpreted_scope": "whole_goal", "asks_permission": false }',
  "```",
  "```turn_plan",
  "Finish the remaining modules and run the suite.",
  "```",
].join("\n");

describe("eval contract: generic runtime executor", () => {
  test(
    "runs a real print turn and parses named fenced outputs",
    async () => {
      const workspace = createTestWorkspace("eval-generic-runtime");
      writeMinimalConfig(workspace);
      const harness = await startGatewayDaemonHarness({
        workspace,
        fakeAssistantText: FAKE_RESPONSE,
      });

      try {
        const result = await executeGenericRuntimeScenario({
          scenario,
          model: "default",
          variantText: null,
          variantName: "baseline",
          cli: {
            backend: "gateway",
            extraArgs: ["--cwd", workspace, "--config", ".brewva/brewva.json"],
            env: harness.env,
          },
        });

        expect(result.outputs.continuation_decision).toEqual({
          interpreted_scope: "whole_goal",
          asks_permission: false,
        });
        expect(result.outputs.turn_plan).toBe("Finish the remaining modules and run the suite.");
        expect(result.telemetry).toMatchObject({
          kind: "generic",
          metrics: { variant: "baseline" },
        });
      } finally {
        await harness.dispose();
        cleanupTestWorkspace(workspace);
      }
    },
    GATEWAY_BACKED_CLI_CONTRACT_TIMEOUT_MS,
  );
});
