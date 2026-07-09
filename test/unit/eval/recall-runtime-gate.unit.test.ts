import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadScenarios, runEval, RuntimeExecutor } from "../../eval/executor.js";

// Runtime gate for the recall eval. `bun run eval:recall:fixtures` (fixture mode)
// validates the graders against the curated golden fixtures and NEVER runs the
// broker, so a broker regression that stops a scenario from surfacing its expected
// evidence sails straight past it — exactly the drift that let two recall scenarios
// silently fail in runtime while fixture mode stayed green. This gate runs every
// recall scenario through the REAL broker (RuntimeExecutor -> executeRecallRuntimeScenario)
// and fails loudly if shape or rubric regress, keeping the golden fixtures honest.
describe("recall runtime eval gate", () => {
  const scenariosDir = join(import.meta.dir, "../../eval/scenarios");
  const recallScenarios = loadScenarios(scenariosDir).filter(
    (scenario) => scenario.skill === "recall",
  );

  test("recall scenarios are wired for the runtime gate", () => {
    expect(recallScenarios.length).toBeGreaterThanOrEqual(5);
    for (const scenario of recallScenarios) {
      expect(scenario.kind).toBe("recall");
      expect(scenario.dataset_path).toMatch(/\/datasets\/recall-[a-z0-9-]+\.yaml$/);
      expect(Object.keys(scenario.output_contracts)).toContain("metrics");
    }
  });

  for (const scenario of recallScenarios) {
    test(`${scenario.id}: real broker satisfies shape + rubric`, async () => {
      const executor = new RuntimeExecutor("recall-runtime-gate", process.cwd());
      const result = await runEval(
        executor,
        scenario,
        scenario.output_contracts,
        "recall-runtime-gate",
        0,
      );

      // An execution error empties `outputs`, so the shape grade fails; a grader
      // that threw leaves `rubric_grade` undefined, so `undefined !== true` fails.
      // Both collapse into these two specific expectations — the gate proves the
      // REAL broker clears both the output shape and the ranking rubric.
      expect(result.shape_grade.pass).toBe(true);
      expect(result.rubric_grade?.pass).toBe(true);
    });
  }
});
