import type { SelfEvalFixture } from "./types.js";

// The operator-declared unattended envelope every fixture runs under: local
// development classes (read/write/exec) auto-approve so the task finishes
// unattended, while external classes stay uncovered and fail-closed suspend.
// The driver supplies this outside the model-writable workspace.
const LOCAL_DEV_APPROVAL_POLICY = {
  workspace_read: "allow",
  workspace_write: "allow",
  local_exec: "allow",
} as const satisfies Readonly<Record<string, "allow" | "deny">>;

/**
 * Frozen self-eval fixtures. The model receives only `workspaceFiles`; command
 * verifier files are materialized in a fresh directory after its process exits.
 * This makes task success independent of any workspace test the model creates or
 * rewrites during the run.
 */
export const SELF_EVAL_FIXTURES: readonly SelfEvalFixture[] = [
  {
    id: "fix-arithmetic-bug",
    kind: "build",
    description: "Fix an off-by-operator arithmetic bug so sum returns addition.",
    prompt: [
      "`sum` in `sum.ts` has an off-by-operator arithmetic bug.",
      "Fix it so `sum(a, b)` returns the arithmetic sum of its operands, then verify the result.",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "command",
      command: ["bun", "test", "sum.test.ts"],
      subjectFiles: ["sum.ts"],
      verifierFiles: {
        "sum.test.ts": `import { expect, test } from "bun:test";
import { sum } from "./sum.ts";

test("sum adds its operands", () => {
  expect(sum(2, 3)).toBe(5);
  expect(sum(10, 5)).toBe(15);
});
`,
      },
    },
    workspaceFiles: {
      "sum.ts": `export function sum(a: number, b: number): number {
  return a - b;
}
`,
    },
  },
  {
    id: "implement-missing-functions",
    kind: "build",
    description: "Implement factorial and gcd from their declared contracts.",
    prompt: [
      "`math.ts` has two unimplemented functions (`factorial`, `gcd`) that throw.",
      "Implement both: factorial(5) is 120, factorial(0) is 1, and gcd returns the greatest common divisor.",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "command",
      command: ["bun", "test", "math.test.ts"],
      subjectFiles: ["math.ts"],
      verifierFiles: {
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
    workspaceFiles: {
      "math.ts": `export function factorial(n: number): number {
  throw new Error("not implemented");
}

export function gcd(a: number, b: number): number {
  throw new Error("not implemented");
}
`,
    },
  },
  {
    id: "debug-regex",
    kind: "debug",
    description: "Diagnose and fix a subtle regex bug in a slug helper.",
    prompt: [
      "`slug.ts`'s `slugify` mishandles inputs with multiple spaces.",
      "Diagnose and fix the regex so whitespace runs collapse to one dash.",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "command",
      command: ["bun", "test", "slug.test.ts"],
      subjectFiles: ["slug.ts"],
      verifierFiles: {
        "slug.test.ts": `import { expect, test } from "bun:test";
import { slugify } from "./slug.ts";

test("slugify collapses whitespace runs into single dashes", () => {
  expect(slugify("Hello   World")).toBe("hello-world");
  expect(slugify("Foo Bar Baz")).toBe("foo-bar-baz");
});
`,
      },
    },
    workspaceFiles: {
      "slug.ts": `export function slugify(input: string): string {
  return input.toLowerCase().replace(/ /, "-");
}
`,
    },
  },
  {
    id: "summarize-architecture",
    kind: "comprehension",
    description: "Summarize a small multi-module package's structure and dependencies.",
    prompt: [
      "Summarize the architecture of the package under `src/`. Do not modify files.",
      'Return ONLY JSON: {"modules":[{"path":string,"responsibility":string,"dependsOn":string[]}]}',
      "List exactly src/types.ts, src/store.ts, src/format.ts, and src/index.ts with direct dependencies.",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "architecture_response",
      readonlyPaths: ["src/types.ts", "src/store.ts", "src/format.ts", "src/index.ts"],
      modules: [
        { path: "src/types.ts", dependsOn: [], responsibilityTerms: ["task", "interface"] },
        {
          path: "src/store.ts",
          dependsOn: ["src/types.ts"],
          responsibilityTerms: ["addtask", "listtask"],
        },
        {
          path: "src/format.ts",
          dependsOn: ["src/types.ts"],
          responsibilityTerms: ["formattask"],
        },
        {
          path: "src/index.ts",
          dependsOn: ["src/store.ts", "src/format.ts"],
          responsibilityTerms: ["render"],
        },
      ],
    },
    workspaceFiles: {
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
    id: "implement-chunk",
    kind: "build",
    description: "Add a chunk() utility that partitions a list into fixed-size groups.",
    prompt: [
      "Add a `chunk<T>(items: T[], size: number): T[][]` function to `utils.ts`.",
      "It must preserve order and retain a final partial chunk.",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "command",
      command: ["bun", "test", "utils.test.ts"],
      subjectFiles: ["utils.ts"],
      verifierFiles: {
        "utils.test.ts": `import { expect, test } from "bun:test";
import { chunk } from "./utils.ts";

test("chunk preserves order and retains the final partial group", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 3)).toEqual([]);
});
`,
      },
    },
    workspaceFiles: {
      "utils.ts": `export function range(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index);
}
`,
    },
  },
];
