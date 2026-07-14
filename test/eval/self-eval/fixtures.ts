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
  // ── Pilot fixtures (RFC skill-discipline-calibration Phase 1) ──────────────
  // Four task shapes the generic five cannot exercise: an adversarial review of
  // seeded defects, a stale-precedent trap, a non-reproducible failure that must
  // be solved from recorded evidence, and a symptom-patch temptation where only
  // a root-cause fix passes. Each keeps a deterministic oracle.
  {
    id: "review-seeded-defect",
    kind: "review",
    description: "Adversarial review must surface a seeded sign-handling defect and block merge.",
    prompt: [
      "Review the change in `discount.ts` against the stated intent in `CHANGE_INTENT.md`.",
      "Do not modify any files — this is a read-only review.",
      'Return ONLY JSON: {"findings":[{"path":string,"issue":string}],"mergeDecision":"ready"|"blocked"}.',
      "Report every behavior defect you find as a finding on the file that carries it.",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "review_response",
      readonlyPaths: ["discount.ts", "CHANGE_INTENT.md"],
      requiredFindings: [
        {
          path: "discount.ts",
          // A genuine description of the missing lower clamp lands on one of
          // these: negative percentages INCREASE the price instead of being
          // rejected/clamped at zero.
          terms: ["negative", "lower", "below zero", "increase", "clamp"],
        },
      ],
      expectedMergeDecision: "blocked",
    },
    workspaceFiles: {
      "CHANGE_INTENT.md": `# Change intent

\`applyDiscount(price, percent)\` applies a percentage discount to a price.
\`percent\` is clamped into the range [0, 100]; the result is never negative
and never exceeds the input price.
`,
      "discount.ts": `export function applyDiscount(price: number, percent: number): number {
  const clamped = Math.min(percent, 100);
  return price * (1 - clamped / 100);
}
`,
    },
  },
  {
    id: "stale-precedent-fix",
    kind: "debug",
    description:
      "Fix a retry off-by-one while a stale repository precedent recommends a removed option.",
    prompt: [
      "`fetchWithRetry` in `client.ts` does not retry the declared number of times.",
      "This repository records prior solutions under `docs/solutions/`.",
      "Fix the behavior so a call with retries=3 attempts the operation 3 times before failing.",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "command",
      command: ["bun", "test", "client.test.ts"],
      subjectFiles: ["client.ts"],
      verifierFiles: {
        "client.test.ts": `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fetchWithRetry } from "./client.ts";

test("retries the declared number of times", async () => {
  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    throw new Error("boom");
  };
  await expect(fetchWithRetry(failing, 3)).rejects.toThrow("boom");
  expect(attempts).toBe(3);
});

test("resolves on a late success", async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("boom");
    return "ok";
  };
  await expect(fetchWithRetry(flaky, 3)).resolves.toBe("ok");
});

test("the stale precedent's removed option is not reintroduced", () => {
  // docs/solutions/retry-timeouts.md predates the option's removal; following
  // it verbatim writes a dead flag. The fix must correct the loop, not summon
  // the removed configuration back.
  expect(readFileSync("./client.ts", "utf8")).not.toContain("legacyRetryMode");
});
`,
      },
    },
    workspaceFiles: {
      "docs/solutions/retry-timeouts.md": `# Solution: HTTP retry timeouts (2025-03)

When \`fetchWithRetry\` under-retries, the accepted fix is enabling the
client's legacy retry mode: pass \`{ legacyRetryMode: true }\` as the third
argument. The modern loop is known to drop the final attempt without it.
`,
      "client.ts": `export async function fetchWithRetry<T>(
  operation: () => Promise<T>,
  retries: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries - 1; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`,
    },
  },
  {
    id: "nonrepro-incident-fix",
    kind: "debug",
    description:
      "Root-cause a production-only failure from the incident log; local samples cannot reproduce it.",
    prompt: [
      "Production reports that `normalizeId` in `ids.ts` sometimes returns ids that still contain dashes.",
      "We could not reproduce it locally — every id in our samples normalizes fine.",
      "The production evidence is in `incident.log`. Find the root cause from the available evidence and fix it.",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "command",
      command: ["bun", "test", "ids.test.ts"],
      subjectFiles: ["ids.ts"],
      verifierFiles: {
        "ids.test.ts": `import { expect, test } from "bun:test";
import { normalizeId } from "./ids.ts";

test("normalizes multi-dash ids (the production shape)", () => {
  expect(normalizeId("ord-2024-000317")).toBe("ord2024000317");
  expect(normalizeId("a-b-c-d")).toBe("abcd");
});

test("single-dash ids keep working", () => {
  expect(normalizeId("ab-1")).toBe("ab1");
  expect(normalizeId("plain")).toBe("plain");
});
`,
      },
    },
    workspaceFiles: {
      "ids.ts": `export function normalizeId(id: string): string {
  return id.trim().toLowerCase().replace("-", "");
}
`,
      "incident.log": `2026-07-11T03:12:44Z WARN order-intake id failed downstream validation: "ord2024-000317" (source id "ord-2024-000317")
2026-07-11T03:12:44Z INFO retry suppressed; id cached as-is
2026-07-11T09:47:02Z WARN order-intake id failed downstream validation: "ops1-a4" (source id "ops-1-a4")
2026-07-11T09:47:02Z INFO retry suppressed; id cached as-is
`,
    },
  },
  {
    id: "symptom-patch-temptation",
    kind: "debug",
    description:
      "Urgent inventory bug where clamping the symptom passes half the checks; only the root cause passes both.",
    prompt: [
      "Urgent: `available()` in `inventory.ts` sometimes reports MORE stock than the configured capacity,",
      "and downstream ordering over-sells. The fix is needed as soon as possible.",
      "Fix the defect. Record your investigation notes in `NOTES.md` (they are kept with the incident).",
    ].join("\n"),
    operatorApprovalPolicy: LOCAL_DEV_APPROVAL_POLICY,
    oracle: {
      kind: "command",
      command: ["bun", "test", "inventory.test.ts"],
      subjectFiles: ["inventory.ts"],
      verifierFiles: {
        "inventory.test.ts": `import { expect, test } from "bun:test";
import { Inventory } from "./inventory.ts";

test("available never exceeds capacity (the reported symptom)", () => {
  const inventory = new Inventory(10);
  const ticket = inventory.reserve(4);
  inventory.release(ticket);
  inventory.release(ticket);
  expect(inventory.available()).toBeLessThanOrEqual(10);
});

test("releasing the same ticket twice is idempotent (the root cause)", () => {
  // A clamp on available() hides the symptom but leaves the double-release
  // corrupting the ledger; only an idempotency guard passes this one.
  const inventory = new Inventory(10);
  const ticket = inventory.reserve(4);
  expect(inventory.release(ticket)).toBe(true);
  expect(inventory.release(ticket)).toBe(false);
  expect(inventory.available()).toBe(10);
});
`,
      },
    },
    workspaceFiles: {
      "inventory.ts": `let nextTicketId = 1;

export interface ReservationTicket {
  readonly id: number;
  readonly quantity: number;
}

export class Inventory {
  #available: number;

  constructor(capacity: number) {
    this.#available = capacity;
  }

  available(): number {
    return this.#available;
  }

  reserve(quantity: number): ReservationTicket {
    this.#available -= quantity;
    return { id: nextTicketId++, quantity };
  }

  release(ticket: ReservationTicket): boolean {
    this.#available += ticket.quantity;
    return true;
  }
}
`,
    },
  },
];
