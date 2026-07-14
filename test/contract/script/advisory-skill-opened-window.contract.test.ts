import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCRIPT = join(REPO_ROOT, "script/analyze-advisory-receipts.ts");

function selection(timestamp: number, filePath: string) {
  return {
    type: "custom",
    timestamp,
    payload: {
      kind: "skill.selection.recorded",
      payload: { renderedSkillReasons: [{ filePath, reasons: ["query_match"] }] },
    },
  };
}

function read(timestamp: number, path: string) {
  return {
    type: "tool.committed",
    timestamp,
    payload: { call: { toolName: "read", args: { path } } },
  };
}

describe("advisory skill-opened temporal join contract", () => {
  test("credits reads only until the next selection receipt", () => {
    const workspace = mkdtempSync(join(tmpdir(), "advisory-open-window-"));
    const tape = join(workspace, "tape");
    mkdirSync(tape, { recursive: true });
    writeFileSync(
      join(tape, "session.jsonl"),
      [
        selection(100, "skills/core/debugging/SKILL.md"),
        selection(100, "skills/core/review/SKILL.md"),
        read(100, "skills/core/debugging/SKILL.md"),
        read(100, "skills/core/review/SKILL.md"),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      "utf8",
    );

    const result = Bun.spawnSync(["bun", SCRIPT, "--tape", tape], {
      cwd: workspace,
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("opened (SKILL.md read after offer): 1 (50.0%)");
  });

  test("does not credit a same-millisecond read before selection or a basename-only read", () => {
    const workspace = mkdtempSync(join(tmpdir(), "advisory-open-order-"));
    const tape = join(workspace, "tape");
    mkdirSync(tape, { recursive: true });
    writeFileSync(
      join(tape, "session.jsonl"),
      [
        read(100, "skills/core/review/SKILL.md"),
        selection(100, "skills/core/review/SKILL.md"),
        read(100, "SKILL.md"),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      "utf8",
    );

    const result = Bun.spawnSync(["bun", SCRIPT, "--tape", tape], {
      cwd: workspace,
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("opened (SKILL.md read after offer): 0 (0.0%)");
  });
});
