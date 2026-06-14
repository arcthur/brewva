import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const axiomsDoc = resolve(repoRoot, "docs/architecture/design-axioms.md");
const gatewaySrc = resolve(repoRoot, "packages/brewva-gateway/src");
const controlTape = resolve(gatewaySrc, "daemon/session-supervisor/control-tape.ts");

const CONSTITUTIONAL_LINE =
  "`Model owns attention. Kernel owns consequence. Tape owns truth. Runtime owns physics.`";

const OWNERSHIP_CLAUSES = [
  "Model owns attention",
  "Kernel owns consequence",
  "Tape owns truth",
  "Runtime owns physics",
] as const;

function walkTypeScript(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      files.push(...walkTypeScript(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

// The aesthetic gain of the control tape is only durable if the ownership
// grammar is machine-checked, not just documented. These guards fail CI the
// moment "Tape owns truth" regresses back into a mutable JSON registry.
describe("ownership grammar: the constitutional line stays singular and present", () => {
  test("design-axioms.md fixes the four-owner constitution verbatim", () => {
    const doc = readFileSync(axiomsDoc, "utf8");
    expect(doc).toContain(CONSTITUTIONAL_LINE);
    expect(OWNERSHIP_CLAUSES.filter((clause) => !doc.includes(clause))).toEqual([]);
  });
});

describe("ownership grammar: Tape owns truth (gateway durable control state)", () => {
  test("the retired mutable binding registry never reappears in gateway source", () => {
    const offenders = walkTypeScript(gatewaySrc).filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes("session-bindings.json") ||
        source.includes("brewva.gateway-session-bindings.v2")
      );
    });
    expect(offenders).toEqual([]);
  });

  test("the gateway durable control store is an append-only jsonl tape", () => {
    const source = readFileSync(controlTape, "utf8");
    expect(source).toMatch(/GATEWAY_CONTROL_TAPE_FILENAME\s*=\s*"[^"]+\.jsonl"/u);
    expect(source).toContain('"brewva.gateway-control.v3"');
    // Durable truth is appended, never rewritten in place.
    expect(source).toMatch(/openSync\([^)]*,\s*"a"\)/u);
  });
});
