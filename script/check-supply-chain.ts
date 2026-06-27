import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

export interface SupplyChainViolation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

// A high-signal supply-chain diff scanner (a sibling to check-security-patterns): it
// flags the narrow set of true attack indicators a compromised dependency or commit
// introduces, and nothing else. The discipline is the rule COUNT — any rule that fires
// on a normal change is removed, not tuned, so reviewers never learn to ignore it. The
// repo is currently clean of every indicator below (the two intentional lifecycle
// scripts are allowlisted), so any new occurrence is a reviewable signal.

// --- Rule 1: package.json lifecycle scripts -------------------------------------------
// A `postinstall`/`preinstall`/`prepare`/`install` script runs arbitrary code at install
// time — the canonical npm-worm vector. `package.json` is strict JSON and cannot carry an
// inline allow-comment, so the escape hatch is an explicit allowlist: adding an entry is a
// deliberate, reviewed edit, and that review IS the gate.

const LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall", "prepare"] as const;

// Keyed `file::scriptName` -> the EXACT reviewed command. Allowlisting the command (not
// just the key) means swapping a reviewed script's body for a malicious one — e.g. changing
// `prepare` to `curl ... | bash` — still trips the gate; the key alone is never a free pass.
const ALLOWED_LIFECYCLE_SCRIPTS = new Map<string, string>([
  ["package.json::prepare", "./script/install-git-hooks.sh"], // installs the repo's git hooks
  ["distribution/brewva/package.json::postinstall", "node postinstall.mjs"], // npm self-installer
]);

function lineOf(content: string, needle: string): number {
  const lines = content.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(needle));
  return index >= 0 ? index + 1 : 1;
}

export function scanPackageJsonLifecycle(file: string, content: string): SupplyChainViolation[] {
  let parsed: { scripts?: Record<string, unknown> };
  try {
    parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
  } catch {
    return []; // a malformed manifest is format:check's concern, not this scanner's
  }
  const scripts = parsed.scripts;
  if (!scripts) return [];
  const violations: SupplyChainViolation[] = [];
  for (const key of LIFECYCLE_SCRIPT_KEYS) {
    if (!(key in scripts)) continue;
    // Allowlisted only when BOTH the key and its exact command match the reviewed entry; a
    // swapped command (or a non-string value) falls through to a violation.
    const expected = ALLOWED_LIFECYCLE_SCRIPTS.get(`${file}::${key}`);
    if (expected !== undefined && scripts[key] === expected) continue;
    violations.push({
      file,
      line: lineOf(content, `"${key}"`),
      rule: "package-json-lifecycle-script",
      message: `unreviewed "${key}" lifecycle script (key or command) — add the exact command to ALLOWED_LIFECYCLE_SCRIPTS after review`,
    });
  }
  return violations;
}

// --- Rules 2 & 3: content rules (the check-security-patterns allow-comment idiom) ------

interface ContentRule {
  id: string;
  message: string;
  anchors(line: string): boolean;
  matches(window: string): boolean;
}

const BASE64_DECODE = /\batob\s*\(|\bBuffer\.from\s*\([^)]*["']base64["']|\bfromBase64\b/u;
const DYNAMIC_EVAL = /\beval\s*\(|\bnew\s+Function\s*\(/u;

// Rule 2: a base64 decode whose result feeds eval/Function within a short window — the
// classic obfuscated-payload-execution signature. base64 alone is fine (credentials,
// transport); eval alone is fine; the COMBO in proximity is the indicator.
const SOURCE_RULES: ContentRule[] = [
  {
    id: "base64-decode-into-eval",
    message: "base64-decoded data feeding eval/new Function is a payload-execution signature",
    anchors(line) {
      return DYNAMIC_EVAL.test(line) || BASE64_DECODE.test(line);
    },
    matches(window) {
      return BASE64_DECODE.test(window) && DYNAMIC_EVAL.test(window);
    },
  },
];

// Rule 3: an install hook that fetches and pipes remote code into a shell, or decodes
// base64 into one. Install hooks run on every clone/install; they must never reach out.
const HOOK_RULES: ContentRule[] = [
  {
    id: "install-hook-remote-exec",
    message: "install hook pipes fetched remote code into a shell (curl/wget | sh)",
    anchors(line) {
      return /\b(?:curl|wget)\b/u.test(line);
    },
    matches(window) {
      return /\b(?:curl|wget)\b[\s\S]*?\|\s*(?:sh|bash|zsh|eval)\b/u.test(window);
    },
  },
  {
    id: "install-hook-base64-exec",
    message: "install hook decodes base64 into a shell — obfuscated payload execution",
    anchors(line) {
      return /\bbase64\b/u.test(line);
    },
    matches(window) {
      return /\bbase64\b[\s\S]*?\|\s*(?:sh|bash|zsh|eval)\b/u.test(window);
    },
  },
];

function hasAllowComment(lines: readonly string[], lineIndex: number, ruleId: string): boolean {
  const start = Math.max(0, lineIndex - 2);
  const context = lines.slice(start, lineIndex + 1).join("\n");
  if (!context.includes("supply-chain-allow")) return false;
  return context.includes(ruleId) || /supply-chain-allow\s*:/u.test(context);
}

function scanContentForRules(
  file: string,
  content: string,
  rules: readonly ContentRule[],
): SupplyChainViolation[] {
  const lines = content.split(/\r?\n/u);
  const violations: SupplyChainViolation[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const window = lines.slice(lineIndex, Math.min(lines.length, lineIndex + 10)).join("\n");
    for (const rule of rules) {
      if (!rule.anchors(lines[lineIndex] ?? "")) continue;
      if (!rule.matches(window)) continue;
      if (hasAllowComment(lines, lineIndex, rule.id)) continue;
      violations.push({ file, line: lineIndex + 1, rule: rule.id, message: rule.message });
    }
  }
  return violations;
}

/** Scan first-party source content for the base64-decode-into-eval signature. */
export function scanSourceContent(file: string, content: string): SupplyChainViolation[] {
  return scanContentForRules(file, content, SOURCE_RULES);
}

/** Scan install-hook content for remote-exec / base64-into-shell. */
export function scanHookContent(file: string, content: string): SupplyChainViolation[] {
  return scanContentForRules(file, content, HOOK_RULES);
}

// --- CLI: enumerate the scanned surfaces and report ------------------------------------

function scanSync(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync(ROOT)].toSorted();
}

function packageJsonFiles(): string[] {
  return [
    "package.json",
    ...scanSync("packages/*/package.json"),
    ...scanSync("distribution/*/package.json"),
  ];
}

// First-party TypeScript only: `src` trees plus the script dir. This excludes
// `runtime-assets/**` vendored bundles (e.g. mermaid.min.js) and `test/**` (whose
// fixtures intentionally contain the very patterns above), keeping the scanner false-
// positive free.
function firstPartySourceFiles(): string[] {
  return [...scanSync("packages/*/src/**/*.ts"), ...scanSync("script/**/*.ts")];
}

// Install-time code runs on every clone/install — the highest-value surface, and the very
// target the allowlisted lifecycle scripts hand off to. The shell git-hook installers plus
// the npm-distribution postinstall(s); each is scanned with BOTH the source rule (a JS
// base64->eval payload) and the hook rules (fetch-and-exec / base64 piped into a shell),
// since this code can be JavaScript or shell.
function installTimeCodeFiles(): string[] {
  return [
    ".githooks/pre-commit",
    "script/install-git-hooks.sh",
    ...scanSync("distribution/*/postinstall.mjs"),
  ];
}

export function scanSupplyChain(): SupplyChainViolation[] {
  const violations: SupplyChainViolation[] = [];
  for (const file of packageJsonFiles()) {
    const absolute = join(ROOT, file);
    if (!existsSync(absolute)) continue;
    violations.push(...scanPackageJsonLifecycle(file, readFileSync(absolute, "utf8")));
  }
  for (const file of firstPartySourceFiles()) {
    const content = readFileSync(join(ROOT, file), "utf8");
    // Strong early-out: the only source rule needs a base64 decode AND an eval/Function in
    // the same file, so skip the line scan unless both appear at all.
    if (!(BASE64_DECODE.test(content) && DYNAMIC_EVAL.test(content))) continue;
    violations.push(...scanSourceContent(file, content));
  }
  for (const file of installTimeCodeFiles()) {
    const absolute = join(ROOT, file);
    if (!existsSync(absolute)) continue;
    const content = readFileSync(absolute, "utf8");
    violations.push(...scanSourceContent(file, content), ...scanHookContent(file, content));
  }
  return violations;
}

if (import.meta.main) {
  const violations = scanSupplyChain();
  if (violations.length > 0) {
    console.error("Supply-chain pattern violations detected:");
    for (const violation of violations) {
      console.error(
        `- ${relative(ROOT, join(ROOT, violation.file))}:${violation.line} ${violation.rule}: ${violation.message}`,
      );
    }
    process.exit(1);
  }
}
