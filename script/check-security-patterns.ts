import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DEFAULT_SCAN_PATHS = [
  "packages/brewva-runtime/src/security/boundary-policy.ts",
  "packages/brewva-runtime/src/security/command-policy.ts",
  "packages/brewva-runtime/src/domain/tools/tool-gate.ts",
  "packages/brewva-tools/src/exec.ts",
] as const;

export interface SecurityPatternViolation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

interface SecurityRule {
  id: string;
  message: string;
  anchors(line: string): boolean;
  matches(window: string): boolean;
}

const RULES: SecurityRule[] = [
  {
    id: "raw-error-event-payload",
    message: "event/audit payload must not store raw error.message or unsanitized message",
    anchors(line) {
      return /payload\s*:/u.test(line);
    },
    matches(window) {
      return (
        /payload\s*:\s*\{/u.test(window) &&
        /\berror\s*:\s*(?:error\.message|message)\b/u.test(window)
      );
    },
  },
  {
    id: "raw-command-env-event-payload",
    message: "event/audit payload must store redacted command/env metadata, not raw values",
    anchors(line) {
      return /payload\s*:/u.test(line);
    },
    matches(window) {
      return (
        /payload\s*:\s*\{/u.test(window) &&
        /\b(?:command|env)\s*:\s*(?:input\.command|input\.env|command|env)\b/u.test(window)
      );
    },
  },
  {
    id: "unsafe-dynamic-key-object",
    message: "event/audit payload dynamic keys need an allow comment and reason",
    anchors(line) {
      return /payload\s*:/u.test(line);
    },
    matches(window) {
      return /payload\s*:\s*\{[\s\S]*\[[^\]\n]+\]\s*:/u.test(window);
    },
  },
  {
    id: "direct-shell-command-concat",
    message: "direct shell command concatenation needs an allow comment and reason",
    anchors(line) {
      return /\bshellCommand\s*=/u.test(line);
    },
    matches(window) {
      return (
        /\bshellCommand\s*=/u.test(window) &&
        (/\$\{[^}]*command[^}]*\}/u.test(window) || /\binput\.command\b/u.test(window))
      );
    },
  },
];

function hasAllowComment(lines: readonly string[], lineIndex: number, ruleId: string): boolean {
  const start = Math.max(0, lineIndex - 2);
  const context = lines.slice(start, lineIndex + 1).join("\n");
  if (!context.includes("security-pattern-allow")) return false;
  return context.includes(ruleId) || /security-pattern-allow\s*:/u.test(context);
}

export function scanSecurityPatternContent(
  file: string,
  content: string,
): SecurityPatternViolation[] {
  const lines = content.split(/\r?\n/u);
  const violations: SecurityPatternViolation[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const window = lines.slice(lineIndex, Math.min(lines.length, lineIndex + 10)).join("\n");
    for (const rule of RULES) {
      if (!rule.anchors(lines[lineIndex] ?? "")) continue;
      if (!rule.matches(window)) continue;
      if (hasAllowComment(lines, lineIndex, rule.id)) continue;
      violations.push({
        file,
        line: lineIndex + 1,
        rule: rule.id,
        message: rule.message,
      });
    }
  }

  return violations;
}

export function scanSecurityPatterns(
  paths: readonly string[] = DEFAULT_SCAN_PATHS,
): SecurityPatternViolation[] {
  const violations: SecurityPatternViolation[] = [];
  for (const path of paths) {
    const absolutePath = join(ROOT, path);
    if (!existsSync(absolutePath)) {
      continue;
    }
    violations.push(...scanSecurityPatternContent(path, readFileSync(absolutePath, "utf8")));
  }
  return violations;
}

if (import.meta.main) {
  const violations = scanSecurityPatterns();
  if (violations.length > 0) {
    console.error("Security pattern violations detected:");
    for (const violation of violations) {
      console.error(
        `- ${relative(ROOT, join(ROOT, violation.file))}:${violation.line} ${violation.rule}: ${violation.message}`,
      );
    }
    process.exit(1);
  }
}
