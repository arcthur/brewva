import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

setDefaultTimeout(60_000);

const repoRoot = resolve(import.meta.dir, "../../..");
const scriptPath = join(repoRoot, "skills/core/debugging/scripts/hypothesis_tracker.py");

function runTracker(payload: unknown): {
  readonly status: number | null;
  readonly stdout: Record<string, unknown>;
  readonly stderr: string;
} {
  const result = spawnSync("python3", [scriptPath], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
  return {
    status: result.status,
    stdout: JSON.parse(result.stdout) as Record<string, unknown>,
    stderr: result.stderr,
  };
}

describe("debugging hypothesis tracker authority ceiling", () => {
  test("reports neutral counts without enforcing active or falsified budgets", () => {
    const hypotheses = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        claim: `active-${index}`,
        status: "active",
        evidence: "",
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: index + 6,
        claim: `falsified-${index}`,
        status: "falsified",
        evidence: `observation-${index}`,
      })),
      {
        id: 10,
        claim: "confirmed",
        status: "confirmed",
        evidence: "causal probe",
      },
    ];

    const result = runTracker({ hypotheses });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      valid: true,
      active_count: 5,
      falsified_count: 4,
      confirmed_count: 1,
      reason: "ok",
    });
    expect(Object.keys(result.stdout)).toEqual([
      "valid",
      "active_count",
      "falsified_count",
      "confirmed_count",
      "reason",
    ]);
  });

  test("keeps malformed hypothesis shape fail-closed", () => {
    const result = runTracker({
      hypotheses: [
        { id: 1, claim: "first", status: "active", evidence: "" },
        { id: 1, claim: "", status: "confirmed", evidence: "" },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatchObject({
      valid: false,
      active_count: 1,
      falsified_count: 0,
      confirmed_count: 1,
    });
    expect(result.stdout.reason).toContain("duplicate id 1");
    expect(result.stdout.reason).toContain("claim must be non-empty string");
    expect(result.stdout.reason).toContain("confirmed hypothesis must have non-empty evidence");
  });

  test("rejects a non-object top-level payload without crashing", () => {
    const result = runTracker([]);

    expect(result.status).toBe(1);
    expect(result.stdout).toEqual({
      valid: false,
      active_count: 0,
      falsified_count: 0,
      confirmed_count: 0,
      reason: "input must be an object",
    });
  });
});
