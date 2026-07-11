import { SCENARIO_CARRIED_CONFIG_KEY } from "../capability-premise.js";
import type { SelfEvalFixture } from "./types.js";

// The declared unattended envelope every fixture carries: local development
// classes (read/write/exec) auto-approve so the task finishes unattended, while
// the external classes stay uncovered and fail-closed suspend — the Phase-1
// chain, and the operator-declared envelope the RFC's provenance model requires.
// `local_exec` is the class the only approval-gated primitive (`exec`) projects.
const LOCAL_DEV_ENVELOPE = `${JSON.stringify(
  {
    security: {
      unattendedApproval: {
        workspace_read: "allow",
        workspace_write: "allow",
        local_exec: "allow",
      },
    },
  },
  null,
  2,
)}\n`;

/**
 * The frozen self-eval fixture set (D6 evaluator definitions), seeded from the
 * n=12 tool-surface recipe's five fresh build/comprehension tasks. Each is small
 * and self-contained (runs under `bun test` with zero external deps) so the
 * exercised tool-surface profile — not scaffolding — is what the metrics read.
 *
 * These are DATA the candidate materializer never touches (they are not on the
 * optimizable prompt/skill allowlist), so a harness candidate can never retune
 * the yardstick it is graded against.
 */
export const SELF_EVAL_FIXTURES: readonly SelfEvalFixture[] = [
  {
    id: "fix-arithmetic-bug",
    kind: "build",
    description: "Fix an off-by-operator arithmetic bug so its unit test passes.",
    prompt: [
      "The test in `sum.test.ts` fails because `sum` in `sum.ts` is wrong.",
      "Fix `sum.ts` so the test passes, then run `bun test sum.test.ts` to verify.",
    ].join("\n"),
    workspaceFiles: {
      [SCENARIO_CARRIED_CONFIG_KEY]: LOCAL_DEV_ENVELOPE,
      "sum.ts": `export function sum(a: number, b: number): number {
  return a - b;
}
`,
      "sum.test.ts": `import { expect, test } from "bun:test";
import { sum } from "./sum.ts";

test("sum adds its operands", () => {
  expect(sum(2, 3)).toBe(5);
  expect(sum(10, 5)).toBe(15);
});
`,
    },
  },
  {
    id: "implement-missing-functions",
    kind: "build",
    description: "Implement two stubbed functions so their tests pass.",
    prompt: [
      "`math.ts` has two unimplemented functions (`factorial`, `gcd`) that throw.",
      "Implement both so `math.test.ts` passes, then run `bun test math.test.ts`.",
    ].join("\n"),
    workspaceFiles: {
      [SCENARIO_CARRIED_CONFIG_KEY]: LOCAL_DEV_ENVELOPE,
      "math.ts": `export function factorial(n: number): number {
  throw new Error("not implemented");
}

export function gcd(a: number, b: number): number {
  throw new Error("not implemented");
}
`,
      "math.test.ts": `import { expect, test } from "bun:test";
import { factorial, gcd } from "./math.ts";

test("factorial", () => {
  expect(factorial(5)).toBe(120);
  expect(factorial(0)).toBe(1);
});

test("gcd", () => {
  expect(gcd(12, 8)).toBe(4);
  expect(gcd(17, 5)).toBe(1);
});
`,
    },
  },
  {
    id: "debug-regex",
    kind: "debug",
    description: "Diagnose and fix a subtle regex bug in a slug helper.",
    prompt: [
      "`slug.ts`'s `slugify` mishandles inputs with multiple spaces, so",
      "`slug.test.ts` fails. Diagnose and fix the regex, then run `bun test slug.test.ts`.",
    ].join("\n"),
    workspaceFiles: {
      [SCENARIO_CARRIED_CONFIG_KEY]: LOCAL_DEV_ENVELOPE,
      "slug.ts": `export function slugify(input: string): string {
  return input.toLowerCase().replace(/ /, "-");
}
`,
      "slug.test.ts": `import { expect, test } from "bun:test";
import { slugify } from "./slug.ts";

test("slugify collapses whitespace runs into single dashes", () => {
  expect(slugify("Hello   World")).toBe("hello-world");
  expect(slugify("Foo Bar Baz")).toBe("foo-bar-baz");
});
`,
    },
  },
  {
    id: "summarize-architecture",
    kind: "comprehension",
    description: "Summarize a small multi-module package's structure and dependencies.",
    prompt: [
      "Summarize the architecture of the package under `src/`: list each module,",
      "what it does, and how the modules depend on one another. Do not modify files.",
    ].join("\n"),
    workspaceFiles: {
      [SCENARIO_CARRIED_CONFIG_KEY]: LOCAL_DEV_ENVELOPE,
      "src/types.ts": `export interface Task {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}
`,
      "src/store.ts": `import type { Task } from "./types.ts";

const tasks: Task[] = [];

export function addTask(task: Task): void {
  tasks.push(task);
}

export function listTasks(): readonly Task[] {
  return tasks;
}
`,
      "src/format.ts": `import type { Task } from "./types.ts";

export function formatTask(task: Task): string {
  return \`[\${task.done ? "x" : " "}] \${task.title}\`;
}
`,
      "src/index.ts": `import { formatTask } from "./format.ts";
import { listTasks } from "./store.ts";

export function render(): string {
  return listTasks().map(formatTask).join("\\n");
}
`,
    },
  },
  {
    id: "add-util-and-test",
    kind: "build",
    description: "Add a chunk() utility and a passing test at package scale.",
    prompt: [
      "Add a `chunk<T>(items: T[], size: number): T[][]` function to `utils.ts`",
      "and a test in `utils.test.ts` covering it, then run `bun test utils.test.ts`.",
    ].join("\n"),
    workspaceFiles: {
      [SCENARIO_CARRIED_CONFIG_KEY]: LOCAL_DEV_ENVELOPE,
      "utils.ts": `export function range(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index);
}
`,
    },
  },
];
