import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureOracle } from "../../eval/self-eval/oracle.js";

describe("self-eval post-run oracle", () => {
  test("command oracle: exit 0 in the final workspace is task_passed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const outcome = await runFixtureOracle({
      oracle: { kind: "command", command: ["true"] },
      workspace,
      stagedFiles: {},
    });
    expect(outcome).toBe("task_passed");
  });

  test("command oracle: a non-zero exit is task_failed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const outcome = await runFixtureOracle({
      oracle: { kind: "command", command: ["false"] },
      workspace,
      stagedFiles: {},
    });
    expect(outcome).toBe("task_failed");
  });

  test("command oracle actually runs the fixture's test against the final workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    writeFileSync(
      join(workspace, "sum.ts"),
      "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf8",
    );
    writeFileSync(
      join(workspace, "sum.test.ts"),
      'import { expect, test } from "bun:test";\n' +
        'import { sum } from "./sum.ts";\n' +
        'test("sum", () => { expect(sum(2, 3)).toBe(5); });\n',
      "utf8",
    );
    const passed = await runFixtureOracle({
      oracle: { kind: "command", command: ["bun", "test", "sum.test.ts"] },
      workspace,
      stagedFiles: {},
    });
    expect(passed).toBe("task_passed");

    // A wrong implementation makes the very same oracle fail.
    writeFileSync(
      join(workspace, "sum.ts"),
      "export function sum(a: number, b: number): number {\n  return a - b;\n}\n",
      "utf8",
    );
    const failed = await runFixtureOracle({
      oracle: { kind: "command", command: ["bun", "test", "sum.test.ts"] },
      workspace,
      stagedFiles: {},
    });
    expect(failed).toBe("task_failed");
  });

  test("readonly_unchanged: byte-identical guarded files are task_passed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const staged = { "src/a.ts": "export const a = 1;\n" };
    // Stage the guarded file byte-identical to its baseline.
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.ts"), staged["src/a.ts"], "utf8");
    const outcome = await runFixtureOracle({
      oracle: { kind: "readonly_unchanged", paths: ["src/a.ts"] },
      workspace,
      stagedFiles: staged,
    });
    expect(outcome).toBe("task_passed");
  });

  test("readonly_unchanged: a modified guarded file is task_failed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const staged = { "a.ts": "export const a = 1;\n" };
    writeFileSync(join(workspace, "a.ts"), "export const a = 2;\n", "utf8");
    const outcome = await runFixtureOracle({
      oracle: { kind: "readonly_unchanged", paths: ["a.ts"] },
      workspace,
      stagedFiles: staged,
    });
    expect(outcome).toBe("task_failed");
  });

  test("readonly_unchanged: a deleted guarded file is task_failed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const outcome = await runFixtureOracle({
      oracle: { kind: "readonly_unchanged", paths: ["gone.ts"] },
      workspace,
      stagedFiles: { "gone.ts": "export const g = 1;\n" },
    });
    expect(outcome).toBe("task_failed");
  });
});
