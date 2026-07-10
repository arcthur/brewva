#!/usr/bin/env bun
// Promotion-readiness report over the active research notes (auto-research
// assembly, step 3). Default mode LISTS each note's declared gates and prose
// criteria; `--run` additionally executes the gates and reports pass/fail.
// This derives a report for the humans who own promotion — it never promotes,
// archives, or edits anything (promotion stays a reviewed, atomic human act).
//
// Usage: bun run analyze:promotion-readiness [-- --run]
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isAllowedGateCommand, listActiveNotePromotionReadiness } from "./promotion-gates.js";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    run: { type: "boolean" },
  },
});

const repoRoot = resolve(import.meta.dir, "..");
const activeDir = resolve(repoRoot, "docs/research/active");
const notes = listActiveNotePromotionReadiness(activeDir);

console.log("# Promotion readiness (active research notes)");
console.log("note: gates are the machine-decidable half of each note's promotion criteria;");
console.log(
  "prose criteria remain human judgment. This table is a report — promotion stays a reviewed human act.",
);

let gateTotal = 0;
let gateFailures = 0;

for (const note of notes) {
  const header = `\n## ${note.file}${note.hasPromotionSection ? "" : "  (no promotion section)"}`;
  console.log(header);
  console.log(`  prose criteria: ${note.proseCriteria}  declared gates: ${note.gates.length}`);
  for (const gate of note.gates) {
    gateTotal += 1;
    if (!isAllowedGateCommand(gate.command)) {
      gateFailures += 1;
      console.log(`    ✗ (malformed prefix) ${gate.command}`);
      continue;
    }
    if (!args.run) {
      console.log(`    · ${gate.command}`);
      continue;
    }
    const result = Bun.spawnSync(["bash", "-c", gate.command], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      console.log(`    ✓ ${gate.command}`);
    } else {
      gateFailures += 1;
      const stderrText = result.stderr.toString().trim().split("\n").slice(-3).join(" | ");
      console.log(`    ✗ ${gate.command}${stderrText ? `  — ${stderrText}` : ""}`);
    }
  }
}

console.log(
  `\ntotals: notes=${notes.length} gates=${gateTotal}${args.run ? ` failed=${gateFailures}` : " (list mode — pass --run to execute)"}`,
);
