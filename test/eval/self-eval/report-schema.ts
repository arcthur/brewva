import type {
  SelfEvalReport,
  SelfEvalGateClass,
  SelfEvalEvaluationMode,
  SelfEvalModelTier,
  SelfEvalPilotSkill,
  SelfEvalSkillArm,
  SelfEvalTaskKind,
  SelfEvalTaskOutcome,
} from "./types.js";

const ARMS = new Set<SelfEvalSkillArm>(["no_skill", "kernel_only", "kernel_scaffold"]);
const KINDS = new Set<SelfEvalTaskKind>(["build", "debug", "comprehension", "review"]);
const TASK_OUTCOMES = new Set<SelfEvalTaskOutcome>([
  "task_passed",
  "task_failed",
  "terminal_incomplete",
]);
const PILOT_SKILLS = new Set<SelfEvalPilotSkill>(["debugging", "learning-research", "review"]);
const MODEL_TIERS = new Set<SelfEvalModelTier>(["strong", "weak"]);
const GATE_CLASSES = new Set<SelfEvalGateClass>(["utility", "safety_honesty"]);
const EVALUATION_MODES = new Set<SelfEvalEvaluationMode>(["retirement", "diagnostic"]);
const TERMINAL_OUTCOMES = new Set(["completed", "suspended_for_approval", "incomplete", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(source: string, path: string, expected: string): never {
  throw new Error(`${source}: ${path} must be ${expected}.`);
}

function requireString(value: unknown, source: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(source, path, "a non-empty string");
  return value;
}

function requireNumber(value: unknown, source: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(source, path, "a finite number");
  return value;
}

function requireInteger(value: unknown, source: string, path: string, minimum = 0): number {
  const parsed = requireNumber(value, source, path);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    fail(source, path, `an integer >= ${minimum}`);
  }
  return parsed;
}

function requireStringArray(value: unknown, source: string, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(source, path, "an array of strings");
  }
  return value as readonly string[];
}

function requireCountRecord(value: unknown, source: string, path: string): void {
  if (!isRecord(value)) fail(source, path, "an object");
  for (const [key, count] of Object.entries(value)) {
    requireInteger(count, source, `${path}.${key}`);
  }
}

export function parseSelfEvalReportJson(
  value: unknown,
  source = "self-eval report",
): SelfEvalReport {
  if (!isRecord(value)) fail(source, "$", "an object");
  if (value.schema !== "brewva.self-eval.report.v4") {
    fail(source, "schema", "brewva.self-eval.report.v4");
  }
  requireString(value.generatedAt, source, "generatedAt");
  requireString(value.requestedModel, source, "requestedModel");
  requireStringArray(value.observedModelRoutes, source, "observedModelRoutes");
  requireInteger(value.runsPerFixture, source, "runsPerFixture", 1);

  if (!isRecord(value.experiment)) fail(source, "experiment", "an object");
  requireString(value.experiment.id, source, "experiment.id");
  if (!EVALUATION_MODES.has(value.experiment.evaluationMode as SelfEvalEvaluationMode)) {
    fail(source, "experiment.evaluationMode", "retirement or diagnostic");
  }
  if (!ARMS.has(value.experiment.arm as SelfEvalSkillArm)) {
    fail(source, "experiment.arm", "a recognized skill arm");
  }
  if (!PILOT_SKILLS.has(value.experiment.pilotSkill as SelfEvalPilotSkill)) {
    fail(source, "experiment.pilotSkill", "a recognized pilot skill");
  }
  if (!MODEL_TIERS.has(value.experiment.modelTier as SelfEvalModelTier)) {
    fail(source, "experiment.modelTier", "strong or weak");
  }
  requireString(value.experiment.sourceRevision, source, "experiment.sourceRevision");
  requireString(value.experiment.evaluatorCorpusDigest, source, "experiment.evaluatorCorpusDigest");
  requireString(value.experiment.fixtureCorpusDigest, source, "experiment.fixtureCorpusDigest");
  requireString(value.experiment.skillCorpusDigest, source, "experiment.skillCorpusDigest");
  if (!Array.isArray(value.experiment.loadedSkills)) {
    fail(source, "experiment.loadedSkills", "an array");
  }
  for (const [index, skill] of value.experiment.loadedSkills.entries()) {
    if (!isRecord(skill)) fail(source, `experiment.loadedSkills[${index}]`, "an object");
    requireString(skill.name, source, `experiment.loadedSkills[${index}].name`);
    requireString(skill.contentDigest, source, `experiment.loadedSkills[${index}].contentDigest`);
  }

  if (!Array.isArray(value.runs)) fail(source, "runs", "an array");
  for (const [index, run] of value.runs.entries()) {
    const path = `runs[${index}]`;
    if (!isRecord(run)) fail(source, path, "an object");
    requireString(run.fixtureId, source, `${path}.fixtureId`);
    requireInteger(run.runIndex, source, `${path}.runIndex`, 1);
    if (!KINDS.has(run.kind as SelfEvalTaskKind)) fail(source, `${path}.kind`, "a task kind");
    if (!GATE_CLASSES.has(run.gateClass as SelfEvalGateClass)) {
      fail(source, `${path}.gateClass`, "a recognized gate class");
    }
    requireStringArray(run.observedModelRoutes, source, `${path}.observedModelRoutes`);
    if (!isRecord(run.treatmentExposure)) {
      fail(source, `${path}.treatmentExposure`, "an object");
    }
    for (const field of [
      "targetRelevant",
      "targetSkillOffered",
      "targetSkillOpened",
      "strictScaffoldOpened",
    ] as const) {
      if (typeof run.treatmentExposure[field] !== "boolean") {
        fail(source, `${path}.treatmentExposure.${field}`, "a boolean");
      }
    }
    if (!isRecord(run.skillContext)) fail(source, `${path}.skillContext`, "an object");
    if (!ARMS.has(run.skillContext.arm as SelfEvalSkillArm)) {
      fail(source, `${path}.skillContext.arm`, "a recognized skill arm");
    }
    requireString(
      run.skillContext.skillCorpusDigest,
      source,
      `${path}.skillContext.skillCorpusDigest`,
    );
    if (!Array.isArray(run.skillContext.loadedSkills)) {
      fail(source, `${path}.skillContext.loadedSkills`, "an array");
    }
    for (const [skillIndex, skill] of run.skillContext.loadedSkills.entries()) {
      if (!isRecord(skill)) {
        fail(source, `${path}.skillContext.loadedSkills[${skillIndex}]`, "an object");
      }
      requireString(skill.name, source, `${path}.skillContext.loadedSkills[${skillIndex}].name`);
      requireString(
        skill.contentDigest,
        source,
        `${path}.skillContext.loadedSkills[${skillIndex}].contentDigest`,
      );
    }
    if (
      run.skillContext.arm !== value.experiment.arm ||
      run.skillContext.skillCorpusDigest !== value.experiment.skillCorpusDigest ||
      JSON.stringify(run.skillContext.loadedSkills) !==
        JSON.stringify(value.experiment.loadedSkills)
    ) {
      fail(source, `${path}.skillContext`, "identical to the experiment skill identity");
    }
    if (!isRecord(run.metrics)) fail(source, `${path}.metrics`, "an object");
    requireStringArray(run.metrics.distinctTools, source, `${path}.metrics.distinctTools`);
    for (const field of ["distinctToolCount", "toolCallCount", "turnCount"] as const) {
      requireInteger(run.metrics[field], source, `${path}.metrics.${field}`);
    }
    requireCountRecord(run.metrics.perFamilyCounts, source, `${path}.metrics.perFamilyCounts`);
    const terminalOutcome = requireString(
      run.metrics.terminalOutcome,
      source,
      `${path}.metrics.terminalOutcome`,
    );
    if (!TERMINAL_OUTCOMES.has(terminalOutcome)) {
      fail(source, `${path}.metrics.terminalOutcome`, "a terminal outcome");
    }
    if (!TASK_OUTCOMES.has(run.taskOutcome as SelfEvalTaskOutcome)) {
      fail(source, `${path}.taskOutcome`, "a task outcome");
    }
    if (run.exitCode !== null) requireInteger(run.exitCode, source, `${path}.exitCode`);
    if (typeof run.timedOut !== "boolean") fail(source, `${path}.timedOut`, "a boolean");
    if (typeof run.tapePresent !== "boolean") fail(source, `${path}.tapePresent`, "a boolean");
    requireString(run.workspace, source, `${path}.workspace`);
    const isComplete = terminalOutcome === "completed" && !run.timedOut;
    if ((run.taskOutcome === "terminal_incomplete") === isComplete) {
      fail(source, `${path}.taskOutcome`, "consistent with turn liveness");
    }
  }

  if (!isRecord(value.aggregate)) fail(source, "aggregate", "an object");
  for (const field of [
    "fixtureCount",
    "runCount",
    "taskPassedRuns",
    "taskFailedRuns",
    "terminalIncompleteRuns",
    "completedRuns",
    "suspendedRuns",
    "incompleteRuns",
    "timedOutRuns",
    "unknownRuns",
  ] as const) {
    requireInteger(value.aggregate[field], source, `aggregate.${field}`);
  }
  requireStringArray(value.aggregate.distinctToolsUnion, source, "aggregate.distinctToolsUnion");
  requireCountRecord(value.aggregate.perFamilyCounts, source, "aggregate.perFamilyCounts");

  const report = value as unknown as SelfEvalReport;
  const expectedRoutes = [
    ...new Set(report.runs.flatMap((run) => run.observedModelRoutes)),
  ].toSorted();
  if (JSON.stringify(report.observedModelRoutes) !== JSON.stringify(expectedRoutes)) {
    fail(source, "observedModelRoutes", "the exact sorted union of per-run routes");
  }
  const expectedTaskCounts = {
    taskPassedRuns: report.runs.filter((run) => run.taskOutcome === "task_passed").length,
    taskFailedRuns: report.runs.filter((run) => run.taskOutcome === "task_failed").length,
    terminalIncompleteRuns: report.runs.filter((run) => run.taskOutcome === "terminal_incomplete")
      .length,
  };
  for (const [field, expected] of Object.entries(expectedTaskCounts)) {
    if (report.aggregate[field as keyof typeof expectedTaskCounts] !== expected) {
      fail(source, `aggregate.${field}`, "derived from runs");
    }
  }
  if (report.aggregate.runCount !== report.runs.length) {
    fail(source, "aggregate.runCount", "the number of runs");
  }
  if (report.aggregate.fixtureCount !== new Set(report.runs.map((run) => run.fixtureId)).size) {
    fail(source, "aggregate.fixtureCount", "the number of distinct fixtures");
  }
  // Re-derive the turn-liveness tallies (not merely type-check them), mirroring
  // the producer's precedence — a timed-out run counts as timed_out over its
  // partial tape signal — so a report whose liveness aggregate disagrees with
  // its per-run data cannot validate clean.
  const expectedLiveness = {
    completedRuns: 0,
    suspendedRuns: 0,
    incompleteRuns: 0,
    timedOutRuns: 0,
    unknownRuns: 0,
  };
  for (const run of report.runs) {
    if (run.timedOut) {
      expectedLiveness.timedOutRuns += 1;
      continue;
    }
    switch (run.metrics.terminalOutcome) {
      case "completed":
        expectedLiveness.completedRuns += 1;
        break;
      case "suspended_for_approval":
        expectedLiveness.suspendedRuns += 1;
        break;
      case "incomplete":
        expectedLiveness.incompleteRuns += 1;
        break;
      default:
        expectedLiveness.unknownRuns += 1;
    }
  }
  for (const [field, expected] of Object.entries(expectedLiveness)) {
    if (report.aggregate[field as keyof typeof expectedLiveness] !== expected) {
      fail(source, `aggregate.${field}`, "derived from run liveness");
    }
  }
  const indexesByFixture = new Map<string, number[]>();
  for (const run of report.runs) {
    const indexes = indexesByFixture.get(run.fixtureId) ?? [];
    indexes.push(run.runIndex);
    indexesByFixture.set(run.fixtureId, indexes);
  }
  const expectedIndexes = Array.from({ length: report.runsPerFixture }, (_, index) => index + 1);
  for (const [fixtureId, indexes] of indexesByFixture) {
    if (
      JSON.stringify(indexes.toSorted((left, right) => left - right)) !==
      JSON.stringify(expectedIndexes)
    ) {
      fail(source, `runs(${fixtureId})`, `the exact runIndex cohort 1..${report.runsPerFixture}`);
    }
  }
  return report;
}
