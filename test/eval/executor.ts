import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { gradeRubric } from "./graders/rubric-grader.js";
import { gradeShape } from "./graders/shape-grader.js";
import type { EvalResult, EvalScenario, OutputContract, ShapeGrade, RubricGrade } from "./types.js";

/**
 * SkillExecutor is the abstraction boundary between execution and grading.
 *
 * The executor produces outputs. It NEVER sees rubrics, expected results, or
 * grading criteria. The graders operate independently on the outputs.
 *
 * Implementations:
 * - FixtureExecutor: validates graders against curated fixture outputs
 * - RuntimeExecutor: reserved for real skill execution and fails closed until wired
 */
export interface SkillExecutor {
  execute(scenario: EvalScenario): Promise<Record<string, unknown>>;
}

function loadYamlFile<T>(filePath: string): T {
  const raw = readFileSync(filePath, "utf8");
  return parse(raw) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FixtureExecutor implements SkillExecutor {
  async execute(scenario: EvalScenario): Promise<Record<string, unknown>> {
    if (!scenario.fixture_path) {
      throw new Error(
        `Scenario ${scenario.id}: fixture mode requires fixture_path; fixture outputs are intentionally kept out of scenario definitions`,
      );
    }

    const fixture = loadYamlFile<unknown>(scenario.fixture_path);
    if (!isRecord(fixture)) {
      throw new Error(
        `Scenario ${scenario.id}: fixture file must contain a top-level object of outputs`,
      );
    }

    return fixture;
  }
}

/**
 * RuntimeExecutor is intentionally fail-closed until real runtime execution is wired.
 *
 * Historical note: the prior implementation silently fell back to curated fixture
 * outputs even in runtime mode, which invalidated executor/grader separation.
 * This executor now throws until a real runtime session can be created and the
 * skill outputs can be collected without exposing expected answers.
 */
export class RuntimeExecutor implements SkillExecutor {
  constructor(
    private readonly model: string,
    private readonly _workspaceRoot: string,
  ) {}

  async execute(scenario: EvalScenario): Promise<Record<string, unknown>> {
    throw new Error(
      `Runtime evaluation is not wired for scenario ${scenario.id} (model=${this.model}). ` +
        `Refusing to fall back to fixture outputs because that would contaminate grading. ` +
        `Use --mode fixture only for grader or contract development.`,
    );
  }
}

export function loadScenarios(scenariosDir: string): EvalScenario[] {
  const files = readdirSync(scenariosDir).filter((f) => f.endsWith(".yaml"));
  return files.map((f) => {
    const scenarioPath = join(scenariosDir, f);
    const scenario = loadYamlFile<EvalScenario>(scenarioPath);
    const scenarioDir = dirname(scenarioPath);

    scenario.rubric_path = isAbsolute(scenario.rubric_path)
      ? scenario.rubric_path
      : resolve(scenarioDir, scenario.rubric_path);

    if (scenario.fixture_path) {
      scenario.fixture_path = isAbsolute(scenario.fixture_path)
        ? scenario.fixture_path
        : resolve(scenarioDir, scenario.fixture_path);
    }

    return scenario;
  });
}

/**
 * Grade outputs independently of execution. The grader never sees the
 * executor's internal state — only the outputs and the contracts/rubrics.
 */
export function gradeOutputs(
  scenario: EvalScenario,
  outputs: Record<string, unknown>,
  outputContracts: Record<string, OutputContract>,
): { shapeGrade: ShapeGrade; rubricGrade?: RubricGrade } {
  const shapeGrade = gradeShape(outputs, outputContracts);

  let rubricGrade: RubricGrade | undefined;
  try {
    rubricGrade = gradeRubric(outputs, scenario.rubric_path);
  } catch {
    // rubric grading is optional during fixture development
  }

  return { shapeGrade, rubricGrade };
}

/**
 * Run a single eval: execute via the executor, then grade independently.
 */
export async function runEval(
  executor: SkillExecutor,
  scenario: EvalScenario,
  outputContracts: Record<string, OutputContract>,
  model: string,
  runIndex: number,
): Promise<EvalResult> {
  const start = Date.now();
  let outputs: Record<string, unknown>;
  let error: string | undefined;

  try {
    outputs = await executor.execute(scenario);
  } catch (e) {
    outputs = {};
    error = e instanceof Error ? e.message : String(e);
  }

  const { shapeGrade, rubricGrade } = gradeOutputs(scenario, outputs, outputContracts);

  return {
    scenario_id: scenario.id,
    skill: scenario.skill,
    model,
    run_index: runIndex,
    outputs,
    shape_grade: shapeGrade,
    rubric_grade: rubricGrade,
    duration_ms: Date.now() - start,
    error,
  };
}
