import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  listActiveNotePromotionReadiness,
  parseGateCommand,
} from "../../../script/promotion-gates.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const activeDir = resolve(repoRoot, "docs/research/active");

// A promotion gate is a promise that a MACHINE can check a criterion; a gate
// that cannot run is exactly the unchecked promise axiom 19 forbids. Every
// declared gate must parse to a shell-free argv, and `bun test` gates must
// point at test files that exist.
describe("promotion gate lines stay runnable", () => {
  const notes = listActiveNotePromotionReadiness(activeDir);

  test("every declared gate parses to a shell-free argv", () => {
    const offenders = notes.flatMap((note) =>
      note.gates
        .filter((gate) => gate.argv === null)
        .map((gate) => `${note.file}:${gate.line} ${gate.command}`),
    );
    expect(offenders).toEqual([]);
  });

  test("bun test gates reference test paths that exist", () => {
    const offenders = notes.flatMap((note) =>
      note.gates
        .filter((gate) => gate.argv?.[1] === "test")
        .map((gate) => ({
          ref: `${note.file}:${gate.line}`,
          // argv is [bun, test, <path>, …]; the first operand is the test path.
          path: gate.argv?.[2] ?? "",
        }))
        .filter((entry) => !existsSync(resolve(repoRoot, entry.path)))
        .map((entry) => `${entry.ref} missing ${entry.path}`),
    );
    expect(offenders).toEqual([]);
  });
});

// RFC markdown is DATA. A gate string must never reach a shell: a single shell
// metacharacter, a program other than `bun test`/`bun run`, or a substitution
// fails the whole parse to null so the readiness runner cannot execute it.
describe("gate parsing rejects shell injection", () => {
  const rejected = [
    "bun test safe.test.ts; rm -rf /tmp/x",
    "bun test a.ts && curl http://evil",
    "bun run foo | tee /etc/passwd",
    "bun test $(whoami).ts",
    "bun test `id`.ts",
    "bun test a.ts > /etc/passwd",
    "bun test a.ts\nrm -rf .",
    "echo pwned",
    "npx foo",
    "bun exec 'rm -rf /'",
  ];
  for (const command of rejected) {
    test(`rejects ${JSON.stringify(command)}`, () => {
      expect(parseGateCommand(command)).toBeNull();
    });
  }

  const accepted = [
    "bun test test/fitness/tool-surface-ceiling.fitness.test.ts",
    "bun run rdp:distill",
    "bun test test/unit/a.test.ts --run",
  ];
  for (const command of accepted) {
    test(`accepts ${JSON.stringify(command)}`, () => {
      const argv = parseGateCommand(command);
      expect(argv).not.toBeNull();
      expect(argv?.[0]).toBe("bun");
    });
  }
});
