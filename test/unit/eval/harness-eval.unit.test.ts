import { describe, expect, test } from "bun:test";
import { RuntimeExecutor } from "../../eval/executor.js";

describe("harness eval runtime executor", () => {
  test("supports harness scenarios without falling back to fixtures", async () => {
    const executor = new RuntimeExecutor("faux-model", process.cwd());

    const result = await executor.execute({
      id: "harness-manifest-comparison",
      skill: "harness",
      kind: "harness",
      description: "Compare manifest-only Harness variants.",
      context: {
        task_description: "Compare Harness manifests.",
        available_artifacts: {
          // The delta-hash id is minted where the manifests exist; an
          // id-only scenario carries it explicitly.
          candidateId: "harness_candidate:eval-manifest-comparison",
          sourceSessionId: "source-session",
          targetSessionId: "candidate-session",
          divergeAt: "event-diverge",
          baseManifestId: "manifest-base",
          candidateManifestId: "manifest-candidate",
          changedFields: ["prompt.systemPromptHash"],
        },
      },
      rubric_path: "unused.md",
      output_contracts: {
        report: { kind: "json", required_fields: ["schema", "mode", "sideEffectPolicy"] },
      },
    });

    expect(result.telemetry).toMatchObject({
      kind: "harness",
      report: {
        schema: "brewva.harness.eval_report.v1",
        mode: "manifest",
        candidateId: "harness_candidate:eval-manifest-comparison",
        sideEffectPolicy: "no_provider_or_tool_execution",
      },
    });
  });
});
