import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  isAllowedGateCommand,
  listActiveNotePromotionReadiness,
} from "../../../script/promotion-gates.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const activeDir = resolve(repoRoot, "docs/research/active");

// A promotion gate is a promise that a MACHINE can check a criterion; a gate
// that cannot run is exactly the unchecked promise axiom 19 forbids. Every
// declared gate must use a repo-runnable entrypoint, and `bun test` gates must
// point at test files that exist.
describe("promotion gate lines stay runnable", () => {
  const notes = listActiveNotePromotionReadiness(activeDir);

  test("every declared gate uses an allowlisted runner", () => {
    const offenders = notes.flatMap((note) =>
      note.gates
        .filter((gate) => !isAllowedGateCommand(gate.command))
        .map((gate) => `${note.file}:${gate.line} ${gate.command}`),
    );
    expect(offenders).toEqual([]);
  });

  test("bun test gates reference test paths that exist", () => {
    const offenders = notes.flatMap((note) =>
      note.gates
        .filter((gate) => gate.command.startsWith("bun test "))
        .map((gate) => ({
          ref: `${note.file}:${gate.line}`,
          path: gate.command.slice("bun test ".length).trim().split(/\s+/)[0] ?? "",
        }))
        .filter((entry) => !existsSync(resolve(repoRoot, entry.path)))
        .map((entry) => `${entry.ref} missing ${entry.path}`),
    );
    expect(offenders).toEqual([]);
  });
});
