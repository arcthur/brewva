import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { compareHarnessCandidate } from "@brewva/brewva-gateway/harness";
import { parse } from "yaml";
import { executeGenericRuntimeScenario } from "./generic-runtime.js";
import { gradeRubric } from "./graders/rubric-grader.js";
import { gradeShape } from "./graders/shape-grader.js";
import { executeRecallRuntimeScenario } from "./recall-runtime.js";
import type {
  EvalResult,
  EvalScenario,
  EvalTelemetry,
  OutputContract,
  ShapeGrade,
  RubricGrade,
} from "./types.js";

/**
 * SkillExecutor is the abstraction boundary between execution and grading.
 *
 * The executor produces outputs. It NEVER sees rubrics, expected results, or
 * grading criteria. The graders operate independently on the outputs.
 *
 * Implementations:
 * - FixtureExecutor: validates graders against curated fixture outputs
 * - RuntimeExecutor: real execution — recall datasets, harness comparisons, and
 *   generic scenarios (one real `brewva --print` turn each, see generic-runtime.ts)
 */
export interface SkillExecutor {
  execute(scenario: EvalScenario): Promise<SkillExecutionResult>;
}

export interface SkillExecutionResult {
  outputs: Record<string, unknown>;
  telemetry?: EvalTelemetry;
}

function loadYamlFile<T>(
  filePath: string,
  coerce: (value: unknown) => T = (value) => value as T,
): T {
  const raw = readFileSync(filePath, "utf8");
  return coerce(parse(raw));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FixtureExecutor implements SkillExecutor {
  async execute(scenario: EvalScenario): Promise<SkillExecutionResult> {
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

    if (isRecord(fixture.outputs)) {
      return {
        outputs: fixture.outputs,
        telemetry: fixture.telemetry as EvalTelemetry | undefined,
      };
    }

    return {
      outputs: fixture,
    };
  }
}

/**
 * RuntimeExecutor never touches fixtures (historical note: a prior
 * implementation silently fell back to curated fixture outputs in runtime
 * mode, which invalidated executor/grader separation). Generic scenarios run
 * one real `brewva --print` turn per execution; outputs are parsed from the
 * model's named fenced blocks only.
 */
export interface RuntimeExecutorOptions {
  /** Prompt-variant text for generic scenarios (temp-workspace AGENTS.md); null = baseline. */
  readonly variantText?: string | null;
  readonly variantName?: string;
}

export class RuntimeExecutor implements SkillExecutor {
  constructor(
    private readonly model: string,
    private readonly workspaceRoot: string,
    private readonly options: RuntimeExecutorOptions = {},
  ) {}

  async execute(scenario: EvalScenario): Promise<SkillExecutionResult> {
    if (scenario.kind === "recall" && scenario.dataset_path) {
      return executeRecallRuntimeScenario({
        datasetPath: scenario.dataset_path,
        workspaceRoot: this.workspaceRoot,
      });
    }
    if (scenario.kind === "harness") {
      const artifacts = isRecord(scenario.context.available_artifacts)
        ? scenario.context.available_artifacts
        : {};
      const report = compareHarnessCandidate({
        mode: "manifest",
        // The candidate id is the normalized-delta hash minted where the
        // manifests exist (compare CLI / buildHarnessCandidatePatch); an
        // id-only scenario must carry it, because a pair-of-ids fallback
        // would split one edit into per-session candidates.
        candidateId: readRequiredArtifactString(artifacts, "candidateId", scenario.id),
        sourceSessionId: readRequiredArtifactString(artifacts, "sourceSessionId", scenario.id),
        targetSessionId: readOptionalArtifactString(artifacts, "targetSessionId"),
        divergeAt: readRequiredArtifactString(artifacts, "divergeAt", scenario.id),
        baseManifestId: readRequiredArtifactString(artifacts, "baseManifestId", scenario.id),
        candidateManifestId: readRequiredArtifactString(
          artifacts,
          "candidateManifestId",
          scenario.id,
        ),
        changedFields: readStringListArtifact(artifacts.changedFields),
      });
      return {
        outputs: {
          report,
        },
        telemetry: {
          kind: "harness",
          report,
        },
      };
    }
    // Generic scenarios run one real `brewva --print` turn per execution in a
    // hermetic temp workspace; outputs are parsed from named fenced blocks and
    // never sourced from fixtures (which stay grader-side only).
    return executeGenericRuntimeScenario({
      scenario,
      model: this.model,
      variantText: this.options.variantText ?? null,
      variantName: this.options.variantName ?? "baseline",
    });
  }
}

function readRequiredArtifactString(
  artifacts: Record<string, unknown>,
  key: string,
  scenarioId: string,
): string {
  const value = artifacts[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Scenario ${scenarioId}: harness runtime artifact ${key} is required`);
  }
  return value;
}

function readOptionalArtifactString(
  artifacts: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = artifacts[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringListArtifact(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
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

    if (scenario.dataset_path) {
      scenario.dataset_path = isAbsolute(scenario.dataset_path)
        ? scenario.dataset_path
        : resolve(scenarioDir, scenario.dataset_path);
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
  let telemetry: EvalTelemetry | undefined;

  try {
    const execution = await executor.execute(scenario);
    outputs = execution.outputs;
    telemetry = execution.telemetry;
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
    telemetry,
  };
}
