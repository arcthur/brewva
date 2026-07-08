import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Standing fitness (coupled world rewind RFC, Phase 4): effect recoverability is
// a DESCRIPTIVE tier, never an authority input. It is derived pre-execution,
// projected onto the model capability view and the operator approval card, and
// read by nothing that decides allow/ask/deny/blocked. Phase 4 surfaced it onto
// the approval card precisely because it is safe to show — so the "it never
// gates" invariant, previously documented negative space, gets an enforced
// contract (axiom 18: descriptive metadata derives views, never authority;
// axiom 19: a load-bearing invariant needs a check, not a promise).

const repoRoot = resolve(import.meta.dirname, "../..");

const KERNEL_POLICY_DIR = "packages/brewva-runtime/src/runtime/kernel/policy";

// The full kernel admission surface: `impl.ts` (the admission entrypoint) plus
// EVERY module in the policy directory — enumerated dynamically so a new
// decision/admission module (or a re-export surface like `public-contract.ts`)
// cannot escape the scan by not being on a hardcoded list. `effect-posture.ts`
// is the legitimate PRODUCER of the tier (its derivation IS where the literals
// belong), so it is excluded; anything else reading a tier literal is a
// consumer that would be making an authority decision on it.
const PRODUCER_MODULE = "effect-posture.ts";

function admissionModules(): string[] {
  const policyModules = readdirSync(resolve(repoRoot, KERNEL_POLICY_DIR))
    .filter((entry) => entry.endsWith(".ts") && entry !== PRODUCER_MODULE)
    .map((entry) => `${KERNEL_POLICY_DIR}/${entry}`);
  return ["packages/brewva-runtime/src/runtime/kernel/impl.ts", ...policyModules].toSorted();
}

// The recoverability values; a comparison against any of these inside an
// admission module would mean a specific tier changes an authority decision.
const RECOVERABILITY_VALUES = [
  "observe_only",
  "reversible",
  "compensatable",
  "manual_recovery",
  "irreversible",
] as const;

function readModule(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("effect recoverability is descriptive, never an authority input", () => {
  test("no admission module compares against a recoverability value or reads the posture field", () => {
    const offenders: string[] = [];
    for (const modulePath of admissionModules()) {
      const source = readModule(modulePath);
      for (const value of RECOVERABILITY_VALUES) {
        // A quoted recoverability literal inside an admission module (the
        // producer excluded) would be a decision branching on the tier.
        if (source.includes(`"${value}"`) || source.includes(`'${value}'`)) {
          offenders.push(`${modulePath} references recoverability value "${value}"`);
        }
      }
      // Also catch a variable/imported-constant comparison: any read of a
      // `.recoverability` field in the admission path is suspect (the producer,
      // which WRITES it, is excluded above).
      if (source.includes(".recoverability")) {
        offenders.push(`${modulePath} reads a .recoverability field`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the approval-required decision is computed without reading recoverability", () => {
    const admissionPolicy = readModule(
      "packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts",
    );
    // The approval predicate exists and is admission-driven...
    expect(admissionPolicy.includes("toolActionPolicyRequiresApproval")).toBe(true);
    // ...and the module never reads a `.recoverability` field for a decision.
    expect(admissionPolicy.includes(".recoverability")).toBe(false);
  });

  test("the derivation stays the single producer; the kernel decision path never reads the posture field", () => {
    // `deriveEffectCommitmentPosture` is the one producer of the tier.
    const posture = readModule(
      "packages/brewva-runtime/src/runtime/kernel/policy/effect-posture.ts",
    );
    expect(posture.includes("deriveEffectCommitmentPosture")).toBe(true);
    // The kernel admission entrypoint never reads `.recoverability`.
    const kernel = readModule("packages/brewva-runtime/src/runtime/kernel/impl.ts");
    expect(kernel.includes(".recoverability")).toBe(false);
  });
});
