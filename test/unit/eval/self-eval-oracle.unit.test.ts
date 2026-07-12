import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureOracle } from "../../eval/self-eval/oracle.js";
import { patchProcessEnv } from "../../helpers/global-state.js";

describe("self-eval post-run oracle", () => {
  test("command oracle: exit 0 in the final workspace is task_passed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const outcome = await runFixtureOracle({
      oracle: { kind: "command", command: ["true"], subjectFiles: [], verifierFiles: {} },
      workspace,
      stagedFiles: {},
    });
    expect(outcome).toBe("task_passed");
  });

  test("command oracle: a non-zero exit is task_failed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const outcome = await runFixtureOracle({
      oracle: { kind: "command", command: ["false"], subjectFiles: [], verifierFiles: {} },
      workspace,
      stagedFiles: {},
    });
    expect(outcome).toBe("task_failed");
  });

  test("command oracle fails closed when its verifier directory cannot be created", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const restoreEnv = patchProcessEnv({
      TMPDIR: join(workspace, "missing-temp-parent"),
    });
    try {
      const outcome = await runFixtureOracle({
        oracle: { kind: "command", command: ["true"], subjectFiles: [], verifierFiles: {} },
        workspace,
        stagedFiles: {},
      });
      expect(outcome).toBe("task_failed");
    } finally {
      restoreEnv();
    }
  });

  test("command oracle runs its frozen verifier even when the workspace test is absent", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    writeFileSync(
      join(workspace, "sum.ts"),
      "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf8",
    );
    const passed = await runFixtureOracle({
      oracle: {
        kind: "command",
        command: ["bun", "test", "sum.test.ts"],
        subjectFiles: ["sum.ts"],
        verifierFiles: {
          "sum.test.ts":
            'import { expect, test } from "bun:test";\n' +
            'import { sum } from "./sum.ts";\n' +
            'test("sum", () => { expect(sum(2, 3)).toBe(5); });\n',
        },
      },
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
      oracle: {
        kind: "command",
        command: ["bun", "test", "sum.test.ts"],
        subjectFiles: ["sum.ts"],
        verifierFiles: {
          "sum.test.ts":
            'import { expect, test } from "bun:test";\n' +
            'import { sum } from "./sum.ts";\n' +
            'test("sum", () => { expect(sum(2, 3)).toBe(5); });\n',
        },
      },
      workspace,
      stagedFiles: {},
    });
    expect(failed).toBe("task_failed");
  });

  test("command oracle rejects a wrong subject even when the model rewrites its workspace test", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    writeFileSync(
      join(workspace, "sum.ts"),
      "export function sum(a: number, b: number): number {\n  return a - b;\n}\n",
      "utf8",
    );
    // This represents a model-written test that blesses the still-wrong implementation.
    writeFileSync(
      join(workspace, "sum.test.ts"),
      'import { expect, test } from "bun:test";\n' +
        'import { sum } from "./sum.ts";\n' +
        'test("sum", () => { expect(sum(2, 3)).toBe(-1); });\n',
      "utf8",
    );

    const outcome = await runFixtureOracle({
      oracle: {
        kind: "command",
        command: ["bun", "test", "sum.test.ts"],
        subjectFiles: ["sum.ts"],
        verifierFiles: {
          "sum.test.ts":
            'import { expect, test } from "bun:test";\n' +
            'import { sum } from "./sum.ts";\n' +
            'test("sum", () => { expect(sum(2, 3)).toBe(5); });\n',
        },
      },
      workspace,
      stagedFiles: {},
    });

    expect(outcome).toBe("task_failed");
  });

  test("command oracle rejects a fixture that overlaps a subject with its frozen verifier", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    writeFileSync(join(workspace, "sum.test.ts"), "throw new Error('model controlled');\n", "utf8");

    const outcome = await runFixtureOracle({
      oracle: {
        kind: "command",
        command: ["true"],
        subjectFiles: ["sum.test.ts"],
        verifierFiles: { "sum.test.ts": "throw new Error('frozen');\n" },
      },
      workspace,
      stagedFiles: {},
    });

    expect(outcome).toBe("task_failed");
  });

  test("command oracle rejects a vacuous model-created test for an unimplemented subject", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    writeFileSync(
      join(workspace, "utils.ts"),
      "export function range(n: number): number[] {\n  return Array.from({ length: n }, (_, index) => index);\n}\n",
      "utf8",
    );
    writeFileSync(
      join(workspace, "utils.test.ts"),
      'import { test } from "bun:test";\ntest("empty", () => {});\n',
      "utf8",
    );

    const outcome = await runFixtureOracle({
      oracle: {
        kind: "command",
        command: ["bun", "test", "utils.test.ts"],
        subjectFiles: ["utils.ts"],
        verifierFiles: {
          "utils.test.ts":
            'import { expect, test } from "bun:test";\n' +
            'import { chunk } from "./utils.ts";\n' +
            'test("chunk", () => { expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]); });\n',
        },
      },
      workspace,
      stagedFiles: {},
    });

    expect(outcome).toBe("task_failed");
  });

  test("command oracle rejects a symlinked subject instead of reading outside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const outside = mkdtempSync(join(tmpdir(), "self-eval-oracle-outside-"));
    const outsideSource = join(outside, "sum.ts");
    writeFileSync(
      outsideSource,
      "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf8",
    );
    symlinkSync(outsideSource, join(workspace, "sum.ts"));

    const outcome = await runFixtureOracle({
      oracle: {
        kind: "command",
        command: ["bun", "test", "sum.test.ts"],
        subjectFiles: ["sum.ts"],
        verifierFiles: {
          "sum.test.ts":
            'import { expect, test } from "bun:test";\n' +
            'import { sum } from "./sum.ts";\n' +
            'test("sum", () => { expect(sum(2, 3)).toBe(5); });\n',
        },
      },
      workspace,
      stagedFiles: {},
    });

    expect(outcome).toBe("task_failed");
  });

  test("command oracle rejects a subject beneath a symlinked workspace directory", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const outside = mkdtempSync(join(tmpdir(), "self-eval-oracle-outside-"));
    const outsideSourceDir = join(outside, "src");
    mkdirSync(outsideSourceDir);
    writeFileSync(
      join(outsideSourceDir, "sum.ts"),
      "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf8",
    );
    symlinkSync(outsideSourceDir, join(workspace, "src"));

    const outcome = await runFixtureOracle({
      oracle: {
        kind: "command",
        command: ["bun", "test", "sum.test.ts"],
        subjectFiles: ["src/sum.ts"],
        verifierFiles: {
          "sum.test.ts":
            'import { expect, test } from "bun:test";\n' +
            'import { sum } from "./src/sum.ts";\n' +
            'test("sum", () => { expect(sum(2, 3)).toBe(5); });\n',
        },
      },
      workspace,
      stagedFiles: {},
    });

    expect(outcome).toBe("task_failed");
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

  test("readonly_unchanged: a same-content symlinked source directory is task_failed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const outside = mkdtempSync(join(tmpdir(), "self-eval-oracle-outside-"));
    const staged = { "src/a.ts": "export const a = 1;\n" };
    const outsideSourceDir = join(outside, "src");
    mkdirSync(outsideSourceDir);
    const outsideSource = join(outsideSourceDir, "a.ts");
    writeFileSync(outsideSource, staged["src/a.ts"], "utf8");
    symlinkSync(outsideSourceDir, join(workspace, "src"));

    const outcome = await runFixtureOracle({
      oracle: { kind: "readonly_unchanged", paths: ["src/a.ts"] },
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

  test("architecture response oracle rejects an unchanged workspace with no answer", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "self-eval-oracle-"));
    const staged = { "src/types.ts": "export interface Task {}\n" };
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "types.ts"), staged["src/types.ts"], "utf8");

    const outcome = await runFixtureOracle({
      oracle: {
        kind: "architecture_response",
        readonlyPaths: ["src/types.ts"],
        modules: [
          {
            path: "src/types.ts",
            dependsOn: [],
            responsibilityTerms: ["task"],
          },
        ],
      },
      workspace,
      stagedFiles: staged,
      assistantText: "",
    });
    expect(outcome).toBe("task_failed");
  });
});
