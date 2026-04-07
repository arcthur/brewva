import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function runJsonScript<T>(input: {
  scriptPath: string;
  payload: Record<string, unknown>;
  cwd: string;
}): { status: number | null; stdout: T; stderr: string } {
  const result = spawnSync("python3", [input.scriptPath], {
    cwd: input.cwd,
    env: process.env,
    encoding: "utf8",
    input: JSON.stringify(input.payload),
  });

  return {
    status: result.status,
    stdout: JSON.parse(result.stdout) as T,
    stderr: result.stderr,
  };
}

describe("skill script protocol contracts", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const qaScript = join(repoRoot, "skills/core/qa/scripts/classify_qa_verdict.py");
  const validateLaneScript = join(repoRoot, "skills/core/review/scripts/validate_lane_outcome.py");
  const synthesizeLanesScript = join(
    repoRoot,
    "skills/core/review/scripts/synthesize_lane_dispositions.py",
  );

  test("QA verdict stays inconclusive when required evidence is missing", () => {
    const result = runJsonScript<{ verdict: string; reason: string }>({
      scriptPath: qaScript,
      cwd: repoRoot,
      payload: {
        checks_executed: 3,
        failed_checks: 0,
        adversarial_attempted: true,
        required_evidence_covered: false,
        environment_reachable: true,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      verdict: "inconclusive",
      reason: "1 required evidence item missing",
    });
  });

  test("QA verdict fails when executed checks fail", () => {
    const result = runJsonScript<{ verdict: string; reason: string }>({
      scriptPath: qaScript,
      cwd: repoRoot,
      payload: {
        checks_executed: 2,
        failed_checks: 1,
        adversarial_attempted: true,
        required_evidence_covered: true,
        environment_reachable: true,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toEqual({
      verdict: "fail",
      reason: "1 check failed",
    });
  });

  test("review lane validator accepts snake_case compatibility aliases", () => {
    const result = runJsonScript<{ valid: boolean; errors: string[] }>({
      scriptPath: validateLaneScript,
      cwd: repoRoot,
      payload: {
        lane: "review-boundaries",
        disposition: "clear",
        primaryClaim: "The boundary remains stable.",
        missing_evidence: ["No export-map diff was attached."],
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toEqual({ valid: true, errors: [] });
  });

  test("lane synthesis treats canonical missingEvidence as unresolved evidence", () => {
    const result = runJsonScript<{
      merge_decision: string;
      rationale: string;
      blocking_lanes: string[];
      concern_lanes: string[];
      missing_lanes: string[];
    }>({
      scriptPath: synthesizeLanesScript,
      cwd: repoRoot,
      payload: {
        activated_lanes: ["review-boundaries"],
        lane_outcomes: [
          {
            lane: "review-boundaries",
            disposition: "clear",
            primaryClaim: "The boundary remains stable.",
            missingEvidence: ["No export-map diff was attached."],
          },
        ],
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.merge_decision).toBe("blocked");
    expect(result.stdout.blocking_lanes).toEqual(["review-boundaries"]);
    expect(result.stdout.missing_lanes).toEqual([]);
  });
});
