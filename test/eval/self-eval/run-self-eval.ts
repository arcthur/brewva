import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { driveSelfEvalRun, requireOperatorApprovalPolicy } from "./driver.js";
import { SELF_EVAL_FIXTURES } from "./fixtures.js";
import {
  buildSelfEvalReport,
  digestSelfEvalEvaluator,
  digestSelfEvalFixtures,
  formatSelfEvalReport,
  persistSelfEvalReport,
} from "./report.js";
import type {
  SelfEvalFixture,
  SelfEvalEvaluationMode,
  SelfEvalModelTier,
  SelfEvalPilotSkill,
  SelfEvalRunResult,
  SelfEvalSkillArm,
} from "./types.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const VALID_ARMS = new Set<SelfEvalSkillArm>(["no_skill", "kernel_only", "kernel_scaffold"]);
const VALID_PILOT_SKILLS = new Set<SelfEvalPilotSkill>([
  "debugging",
  "learning-research",
  "review",
]);
const VALID_MODEL_TIERS = new Set<SelfEvalModelTier>(["strong", "weak"]);
const VALID_EVALUATION_MODES = new Set<SelfEvalEvaluationMode>(["retirement", "diagnostic"]);
const RETIREMENT_RUNS_PER_FIXTURE = 30;

function printUsage(): void {
  console.error(
    [
      "Usage: bun run report:self-eval --experiment <id> --skill <pilot> --model-tier <tier>",
      "                                --arm <arm>",
      "                                [--mode retirement|diagnostic] [--model <id>]",
      "                                [--runs <n>] [--fixture <id>]...",
      "                                [--workspace-root <dir>] [--list]",
      "",
      "  Drives the frozen self-eval fixtures through the embedded runtime, reads",
      "  per-run tape metrics, and writes an immutable arm-specific report under",
      "  .brewva/reports/self-eval/.",
      "",
      "  --model <id>            model for the print turns (default: workspace config)",
      "  --mode <mode>           retirement (default) or diagnostic",
      "  --runs <n>              diagnostic repetitions; retirement requires exactly 30",
      "  --experiment <id>       shared immutable experiment id for all compared arms",
      "  --arm <arm>             no_skill | kernel_only | kernel_scaffold",
      "  --skill <pilot>         debugging | learning-research | review",
      "  --model-tier <tier>     strong | weak (calibration identity, not inferred)",
      "  --fixture <id>          diagnostic-only fixture filter; repeatable",
      "  --workspace-root <dir>  where the report is written (default: cwd)",
      "  --list                  validate + list fixtures and exit (no runs, no provider)",
    ].join("\n"),
  );
}

function selectFixtures(filter: readonly string[] | undefined): readonly SelfEvalFixture[] {
  if (!filter || filter.length === 0) return SELF_EVAL_FIXTURES;
  const known = new Map(SELF_EVAL_FIXTURES.map((fixture) => [fixture.id, fixture]));
  const selected: SelfEvalFixture[] = [];
  for (const id of filter) {
    const fixture = known.get(id);
    if (!fixture) {
      throw new Error(`Unknown fixture "${id}". Known: ${[...known.keys()].join(", ")}.`);
    }
    selected.push(fixture);
  }
  return selected;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      model: { type: "string", default: "default" },
      runs: { type: "string" },
      mode: { type: "string", default: "retirement" },
      experiment: { type: "string" },
      arm: { type: "string" },
      skill: { type: "string" },
      "model-tier": { type: "string" },
      fixture: { type: "string", multiple: true },
      "workspace-root": { type: "string" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }

  const fixtures = selectFixtures(values.fixture);
  const workspaceRoot = resolve(values["workspace-root"] ?? process.cwd());

  if (values.list) {
    console.log(`Self-eval fixtures (${fixtures.length}):`);
    for (const fixture of fixtures) {
      // Actually validate (fail-closed) that each fixture declares the Phase-1
      // operator approval envelope, so --list delivers on its "validate" promise
      // without a provider.
      requireOperatorApprovalPolicy(fixture);
      console.log(`- ${fixture.id} [${fixture.kind}] — ${fixture.description}`);
    }
    return;
  }

  if (!VALID_EVALUATION_MODES.has(values.mode as SelfEvalEvaluationMode)) {
    throw new Error("--mode must be retirement or diagnostic.");
  }
  const evaluationMode = values.mode as SelfEvalEvaluationMode;
  const runsPerFixture = Number(
    values.runs ?? (evaluationMode === "retirement" ? RETIREMENT_RUNS_PER_FIXTURE : 1),
  );
  if (!Number.isInteger(runsPerFixture) || runsPerFixture < 1) {
    throw new Error("--runs must be a positive integer.");
  }
  if (evaluationMode === "retirement") {
    if (values.fixture && values.fixture.length > 0) {
      throw new Error("Retirement mode requires the complete canonical fixture cohort.");
    }
    if (runsPerFixture !== RETIREMENT_RUNS_PER_FIXTURE) {
      throw new Error(
        `Retirement mode requires exactly ${RETIREMENT_RUNS_PER_FIXTURE} runs per fixture.`,
      );
    }
    if (!fixtures.some((fixture) => fixture.gateClass === "safety_honesty")) {
      throw new Error("Retirement mode requires at least one safety/honesty fixture.");
    }
  }

  if (!values.experiment || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(values.experiment)) {
    throw new Error(
      "--experiment is required and must contain only letters, digits, '.', '_', or '-'.",
    );
  }
  if (!values.arm || !VALID_ARMS.has(values.arm as SelfEvalSkillArm)) {
    throw new Error("--arm is required: no_skill, kernel_only, or kernel_scaffold.");
  }
  const arm = values.arm as SelfEvalSkillArm;
  if (evaluationMode === "retirement" && arm === "no_skill") {
    throw new Error("no_skill is a diagnostic control and cannot produce a retirement report.");
  }
  if (!values.skill || !VALID_PILOT_SKILLS.has(values.skill as SelfEvalPilotSkill)) {
    throw new Error("--skill is required: debugging, learning-research, or review.");
  }
  const pilotSkill = values.skill as SelfEvalPilotSkill;
  if (!values["model-tier"] || !VALID_MODEL_TIERS.has(values["model-tier"] as SelfEvalModelTier)) {
    throw new Error("--model-tier is required: strong or weak.");
  }
  const modelTier = values["model-tier"] as SelfEvalModelTier;

  const results: SelfEvalRunResult[] = [];
  for (const fixture of fixtures) {
    for (let run = 1; run <= runsPerFixture; run += 1) {
      const result = await driveSelfEvalRun({
        fixture,
        model: values.model,
        runIndex: run,
        arm,
        pilotSkill,
        sourceRoot: REPO_ROOT,
      });
      results.push(result);
      console.error(
        `[self-eval] ${fixture.id} ${run}/${runsPerFixture}: ${result.taskOutcome} ` +
          `(turn ${result.timedOut ? "timed_out" : result.metrics.terminalOutcome}) — ` +
          `tools=[${result.metrics.distinctTools.join(",") || "none"}] ` +
          `turns=${result.metrics.turnCount} calls=${result.metrics.toolCallCount}`,
      );
    }
  }

  const report = buildSelfEvalReport({
    runs: results,
    requestedModel: values.model,
    runsPerFixture,
    generatedAt: new Date().toISOString(),
    experimentId: values.experiment,
    evaluationMode,
    arm,
    pilotSkill,
    modelTier,
    sourceRevision: readSourceRevision(),
    evaluatorCorpusDigest: digestSelfEvalEvaluator(REPO_ROOT),
    fixtureCorpusDigest: digestSelfEvalFixtures(fixtures),
  });
  const { markdownPath, jsonPath } = persistSelfEvalReport({ workspaceRoot, report });
  console.error(`[self-eval] wrote ${markdownPath}`);
  console.error(`[self-eval] wrote ${jsonPath}`);
  console.log(formatSelfEvalReport(report));
}

function readSourceRevision(): string {
  const head = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"]);
  const revision = head.stdout.toString().trim();
  if (!head.success || revision.length === 0) {
    const detail = head.stderr.toString().trim();
    throw new Error(
      `Could not resolve the self-eval source revision${detail ? `: ${detail}` : "."}`,
    );
  }
  const diff = Bun.spawnSync(["git", "-C", REPO_ROOT, "diff", "--binary", "HEAD"]);
  const untracked = Bun.spawnSync([
    "git",
    "-C",
    REPO_ROOT,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!diff.success || !untracked.success) {
    throw new Error("Could not fingerprint dirty self-eval source state.");
  }
  const untrackedPaths = untracked.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0)
    .toSorted();
  if (diff.stdout.length === 0 && untrackedPaths.length === 0) return revision;
  const hash = createHash("sha256").update(diff.stdout);
  for (const path of untrackedPaths) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(REPO_ROOT, path)));
    hash.update("\0");
  }
  return `${revision}+dirty.${hash.digest("hex")}`;
}

await main();
