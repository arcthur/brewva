import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TEST_ROOT = join(ROOT, "test");
const FORBIDDEN_LAYERS = ["contract", "system", "live"] as const;
const FORBIDDEN_PATTERNS = [
  {
    reason: "white-box import from packages/*/src/**",
    pattern: /(?:\.\.\/)+packages\/[^"'\n]+\/src\//u,
  },
  {
    reason: "direct Bun execution of packages/*/src/** entrypoint",
    pattern: /\[\s*["'`]run["'`]\s*,\s*["'`](?:\.\/)?packages\/[^"'`\n]+\/src\/[^"'`\n]+["'`]/u,
  },
  {
    reason: "shell command executes packages/*/src/** entrypoint",
    pattern: /\bbun\s+run\s+(?:\.\/)?packages\/[^"'`\n]+\/src\//u,
  },
  {
    reason: "path builder references packages/*/src/**",
    pattern:
      /\b(?:join|resolve)\s*\([^)\n]*["'`](?:\.\/)?packages\/[^"'`\n]+\/src\/[^"'`\n]+["'`]/u,
  },
] as const;

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function collectViolations(layer: (typeof FORBIDDEN_LAYERS)[number]): string[] {
  const root = join(TEST_ROOT, layer);
  try {
    const stat = statSync(root);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const violations: string[] = [];
  for (const file of walk(root)) {
    const content = readFileSync(file, "utf8");
    for (const violation of FORBIDDEN_PATTERNS) {
      if (!violation.pattern.test(content)) continue;
      violations.push(`${relative(ROOT, file)} (${violation.reason})`);
    }
  }
  return violations;
}

const errors = FORBIDDEN_LAYERS.flatMap((layer) => collectViolations(layer));
if (errors.length > 0) {
  console.error("Forbidden source-boundary violations detected outside test/unit:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}
