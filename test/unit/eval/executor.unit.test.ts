import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeExecutor } from "../../eval/executor.js";
import type { EvalScenario } from "../../eval/types.js";

describe("eval executor", () => {
  test("runtime executor benchmarks recall broker against the session-local baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-eval-executor-"));
    const scenariosDir = join(root, "scenarios");
    const datasetsDir = join(root, "datasets");
    mkdirSync(scenariosDir, { recursive: true });
    mkdirSync(datasetsDir, { recursive: true });

    const datasetPath = join(datasetsDir, "recall.yaml");
    writeFileSync(
      datasetPath,
      `schema: brewva.recall-eval.dataset.v1
workspace_files:
  - path: packages/gateway/bootstrap.ts
    content: |
      export const bootstrap = true;
sessions:
  - id: prior-session
    goal: Fix the gateway bootstrap flake
    target_files:
      - packages/gateway/bootstrap.ts
    events:
      - alias: prior-fix
        type: task_event
        payload:
          schema: brewva.task.ledger.v1
          kind: item_added
          item:
            id: prior-fix-item
            text: Fixed the gateway bootstrap flake by removing duplicate startup hooks
            status: done
  - id: current-session
    goal: Trace the latest hosted startup regression
    target_files:
      - packages/gateway/bootstrap.ts
query:
  session_id: current-session
  text: gateway bootstrap flake duplicate startup hooks
  scope: user_repository_root
  limit: 3
expectations:
  relevant_stable_ids:
    - tape:prior-session:prior-fix
  harmful_stable_ids: []
  contradictory_stable_ids: []
  expected_top_stable_id: tape:prior-session:prior-fix
`,
      "utf8",
    );

    const scenario = {
      id: "recall-cross-session",
      kind: "recall",
      skill: "recall",
      description: "Cross-session broker recall beats the session-local baseline.",
      context: {
        task_description: "Evaluate recall broker retrieval against the session-local baseline.",
      },
      dataset_path: datasetPath,
      rubric_path: join(scenariosDir, "unused-rubric.yaml"),
      output_contracts: {},
    } as EvalScenario;

    const executor = new RuntimeExecutor("test-model", root);
    const result = await executor.execute(scenario);

    expect(result.outputs.metrics).toEqual(
      expect.objectContaining({
        baseline_precision_at_k: 0,
        broker_useful_recall_rate: 1,
        broker_harmful_recall_rate: 0,
        broker_contradiction_rate: 0,
      }),
    );
    expect(
      (result.outputs.metrics as Record<string, number>).broker_precision_at_k,
    ).toBeGreaterThan(0);
    expect((result.outputs.metrics as Record<string, number>).precision_gain_at_k).toBeGreaterThan(
      0,
    );
    expect(result.outputs.broker_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stable_id: expect.stringContaining("tape:prior-session:"),
        }),
      ]),
    );
    expect(result.telemetry).toEqual(
      expect.objectContaining({
        kind: "recall",
        metrics: expect.objectContaining({
          broker_precision_at_k: expect.any(Number),
          added_token_cost: expect.any(Number),
        }),
      }),
    );
  });
});
