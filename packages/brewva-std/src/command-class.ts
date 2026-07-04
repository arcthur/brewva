/**
 * Deterministic shell-command classification.
 *
 * `verification` marks commands whose purpose is to check work rather than
 * perform it: builds, test runs, type checks, linters. Runtime physics keys on
 * this class — verification commands get a long foreground wait so a typical
 * build or test run completes in one tool call instead of a poll loop — and
 * read-side projections use it to recognize verification evidence on the tape.
 *
 * Classification is a static pattern table, never inference. Unknown commands
 * classify as `general`; the cost of a miss is one extra poll round trip, so
 * the table stays conservative.
 */

export type CommandClass = "verification" | "general";

interface CommandPattern {
  /** First token of the command. */
  readonly head: string;
  /** When present, one of these must appear among the following tokens. */
  readonly anySubcommand?: readonly string[];
}

const VERIFICATION_PATTERNS: readonly CommandPattern[] = [
  { head: "make" },
  { head: "ninja" },
  { head: "cmake", anySubcommand: ["--build"] },
  { head: "tsc" },
  { head: "eslint" },
  { head: "oxlint" },
  { head: "vitest" },
  { head: "jest" },
  { head: "pytest" },
  { head: "mypy" },
  { head: "ruff" },
  { head: "tox" },
  { head: "bun", anySubcommand: ["test", "build", "check", "typecheck", "lint"] },
  { head: "npm", anySubcommand: ["test", "build", "check", "typecheck", "lint"] },
  { head: "pnpm", anySubcommand: ["test", "build", "check", "typecheck", "lint"] },
  { head: "yarn", anySubcommand: ["test", "build", "check", "typecheck", "lint"] },
  { head: "npx", anySubcommand: ["tsc", "jest", "vitest", "eslint", "playwright"] },
  { head: "cargo", anySubcommand: ["build", "test", "check", "clippy"] },
  { head: "go", anySubcommand: ["build", "test", "vet"] },
  { head: "swift", anySubcommand: ["build", "test"] },
  { head: "xcodebuild" },
  { head: "mvn", anySubcommand: ["test", "verify", "package", "compile"] },
  { head: "gradle", anySubcommand: ["build", "test", "check"] },
  { head: "./gradlew", anySubcommand: ["build", "test", "check"] },
  { head: "dotnet", anySubcommand: ["build", "test"] },
  { head: "codesign", anySubcommand: ["--verify"] },
  { head: "python", anySubcommand: ["-m"] },
];

/** `python -m` counts only for check-shaped modules. */
const PYTHON_MODULE_CHECKS = new Set(["pytest", "mypy", "ruff", "unittest", "tox"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/u).filter(Boolean);
}

function stripWrappers(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] ?? "")) {
    index += 1;
  }
  // `cd somewhere` never carries the intent of a compound command by itself.
  if (tokens[index] === "cd") {
    return [];
  }
  return tokens.slice(index);
}

function matchesPattern(tokens: readonly string[], pattern: CommandPattern): boolean {
  if (tokens[0] !== pattern.head) {
    return false;
  }
  if (!pattern.anySubcommand) {
    return true;
  }
  const rest = tokens.slice(1);
  if (pattern.head === "python") {
    const moduleIndex = rest.indexOf("-m");
    const moduleName = moduleIndex >= 0 ? rest[moduleIndex + 1] : undefined;
    return moduleName !== undefined && PYTHON_MODULE_CHECKS.has(moduleName);
  }
  return rest.some((token) => pattern.anySubcommand?.includes(token) === true);
}

/**
 * Classifies a shell command line. Compound commands (`&&`, `;`, `||`, `|`)
 * classify as `verification` when any segment does.
 */
export function classifyCommandClass(command: string): CommandClass {
  const segments = command.split(/&&|\|\||[;|]/u);
  for (const segment of segments) {
    const tokens = stripWrappers(tokenize(segment));
    if (tokens.length === 0) {
      continue;
    }
    if (VERIFICATION_PATTERNS.some((pattern) => matchesPattern(tokens, pattern))) {
      return "verification";
    }
  }
  return "general";
}
