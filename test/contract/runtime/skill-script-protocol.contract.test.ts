import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

// Cases here run real subprocesses, which can exceed bun's 5s default test timeout
// under machine load (bare `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

function runJsonScript<T>(
  input: {
    scriptPath: string;
    payload: Record<string, unknown>;
    cwd: string;
  },
  coerce: (value: unknown) => T = (value) => value as T,
): { status: number | null; stdout: T; stderr: string } {
  const result = spawnSync("python3", [input.scriptPath], {
    cwd: input.cwd,
    env: process.env,
    encoding: "utf8",
    input: JSON.stringify(input.payload),
  });

  return {
    status: result.status,
    stdout: coerce(JSON.parse(result.stdout)),
    stderr: result.stderr,
  };
}

describe("skill script protocol contracts", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const verifierScript = join(
    repoRoot,
    "skills/core/verifier/scripts/classify_verifier_verdict.py",
  );

  test("Verifier verdict stays inconclusive when required evidence is missing", () => {
    const result = runJsonScript<{ verdict: string; reason: string }>({
      scriptPath: verifierScript,
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

  test("Verifier verdict fails when executed checks fail", () => {
    const result = runJsonScript<{ verdict: string; reason: string }>({
      scriptPath: verifierScript,
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
});
