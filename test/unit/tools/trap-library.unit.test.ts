import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TRAP_ENTRIES } from "../../../packages/brewva-tools/src/shared/trap-library/entries.js";
import {
  matchFileAgainstWriteVerifyTraps,
  matchTraps,
} from "../../../packages/brewva-tools/src/shared/trap-library/index.js";
import type {
  TrapEntry,
  TrapTrigger,
} from "../../../packages/brewva-tools/src/shared/trap-library/index.js";

const FIXTURES_DIR = resolve(import.meta.dir, "../../fixtures/intent-realization");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

describe("trap library schema and engine", () => {
  test("phase gating: an entry only matches when the query phase equals the entry phase", () => {
    const entries: TrapEntry[] = [
      {
        id: "phase-gate-orient",
        phase: "orient",
        input: "prompt",
        trigger: { kind: "substring_any", needles: ["event tap"] },
        provenance: "test-fixture",
        retirement: "never (unit test entry)",
      },
    ];

    const orientMatches = matchTraps(
      { phase: "orient", kind: "prompt", text: "please add an event tap" },
      entries,
    );
    expect(orientMatches).toHaveLength(1);
    expect(orientMatches[0]?.entry.id).toBe("phase-gate-orient");

    const writeMatches = matchTraps(
      { phase: "write", kind: "prompt", text: "please add an event tap" },
      entries,
    );
    expect(writeMatches).toHaveLength(0);
  });

  test("input gating: an entry only matches when the query kind equals the entry input", () => {
    const entries: TrapEntry[] = [
      {
        id: "input-gate-diff",
        phase: "write",
        input: "diff",
        trigger: { kind: "substring_any", needles: ["CGEvent.tapCreate"] },
        lens: "test lens",
        provenance: "test-fixture",
        retirement: "never (unit test entry)",
      },
    ];

    const diffMatches = matchTraps(
      { phase: "write", kind: "diff", text: "+ CGEvent.tapCreate(...)" },
      entries,
    );
    expect(diffMatches).toHaveLength(1);

    const fileMatches = matchTraps(
      { phase: "write", kind: "file", text: "CGEvent.tapCreate(...)" },
      entries,
    );
    expect(fileMatches).toHaveLength(0);
  });

  test("substring_any trigger: matches when any needle is a substring of text, case-insensitively", () => {
    const trigger: TrapTrigger = { kind: "substring_any", needles: ["CGEvent", "global hotkey"] };
    const entries: TrapEntry[] = [
      {
        id: "substring-entry",
        phase: "orient",
        input: "prompt",
        trigger,
        provenance: "test-fixture",
        retirement: "never (unit test entry)",
      },
    ];

    expect(
      matchTraps({ phase: "orient", kind: "prompt", text: "I want a GLOBAL HOTKEY" }, entries),
    ).toHaveLength(1);
    expect(
      matchTraps({ phase: "orient", kind: "prompt", text: "install a cgevent tap" }, entries),
    ).toHaveLength(1);
    expect(
      matchTraps({ phase: "orient", kind: "prompt", text: "add a button to the toolbar" }, entries),
    ).toHaveLength(0);
  });

  test("pattern trigger: pattern is a RegExp source string compiled case-insensitively by the engine", () => {
    const trigger: TrapTrigger = { kind: "pattern", pattern: "cgevent\\.tapcreate" };
    const entries: TrapEntry[] = [
      {
        id: "pattern-entry",
        phase: "write",
        input: "file",
        trigger,
        lens: "test lens",
        provenance: "test-fixture",
        retirement: "never (unit test entry)",
      },
    ];

    expect(
      matchTraps(
        { phase: "write", kind: "file", text: "let tap = CGEvent.tapCreate(...)" },
        entries,
      ),
    ).toHaveLength(1);
    expect(
      matchTraps({ phase: "write", kind: "file", text: "no event handling here" }, entries),
    ).toHaveLength(0);
  });

  test("deterministic ordering: matches are returned in entry order, not sorted or shuffled", () => {
    const entries: TrapEntry[] = [
      {
        id: "second",
        phase: "orient",
        input: "prompt",
        trigger: { kind: "substring_any", needles: ["alpha"] },
        provenance: "test-fixture",
        retirement: "never (unit test entry)",
      },
      {
        id: "first",
        phase: "orient",
        input: "prompt",
        trigger: { kind: "substring_any", needles: ["alpha"] },
        provenance: "test-fixture",
        retirement: "never (unit test entry)",
      },
    ];

    const matches = matchTraps({ phase: "orient", kind: "prompt", text: "alpha" }, entries);
    expect(matches.map((match) => match.entry.id)).toEqual(["second", "first"]);
  });

  test("CJK needle match: the seeded orient/prompt entry fires on Chinese key-monitoring language", () => {
    const matches = matchTraps(
      { phase: "orient", kind: "prompt", text: "帮我实现全局快捷键监听" },
      TRAP_ENTRIES,
    );
    expect(matches.some((match) => match.entry.atomCore !== undefined)).toBe(true);
    expect(
      matches.find((match) => match.entry.atomCore !== undefined)?.entry.atomCore?.statement,
    ).toBe("Fn suppression must be keycode-scoped, not all .flagsChanged");
  });

  test("CJK needle match: 键盘监听 also fires the seeded orient/task_taxonomy entry", () => {
    const matches = matchTraps(
      { phase: "orient", kind: "task_taxonomy", text: "task category: 键盘监听 utility" },
      TRAP_ENTRIES,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.entry.atomCore?.modality).toBe("must");
  });

  test("orient seed entry injects the exact atomCore statement and modality from the RFC", () => {
    const matches = matchTraps(
      { phase: "orient", kind: "prompt", text: "please add a global hotkey for Fn" },
      TRAP_ENTRIES,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.entry.atomCore).toEqual({
      statement: "Fn suppression must be keycode-scoped, not all .flagsChanged",
      modality: "must",
    });
  });

  test("the tap trap fires on ALL THREE tap fixtures (lens != verdict: it surfaces attention, not a defect claim)", () => {
    const overbroad = readFixture("overbroad-tap.swift");
    const leak = readFixture("pass-retained-leak.swift");
    const correct = readFixture("correct-tap.swift");

    for (const [name, text] of [
      ["overbroad-tap.swift", overbroad],
      ["pass-retained-leak.swift", leak],
      ["correct-tap.swift", correct],
    ] as const) {
      const writeMatches = matchTraps({ phase: "write", kind: "diff", text }, TRAP_ENTRIES);
      const verifyMatches = matchTraps({ phase: "verify", kind: "file", text }, TRAP_ENTRIES);

      const writeHasTapLens = writeMatches.some(
        (match) =>
          match.entry.lens ===
          "verify suppression is keycode-scoped and callback ownership uses passUnretained",
      );
      const verifyHasTapLens = verifyMatches.some(
        (match) =>
          match.entry.lens ===
          "verify suppression is keycode-scoped and callback ownership uses passUnretained",
      );

      expect(writeHasTapLens, `expected write/diff tap lens to fire on ${name}`).toBe(true);
      expect(verifyHasTapLens, `expected verify/file tap lens to fire on ${name}`).toBe(true);
    }
  });

  test("the tap trap never fires on a non-tap file", () => {
    const nonTapFile = `
      import Foundation

      struct Greeter {
        func greet(name: String) -> String {
          return "Hello, \\(name)!"
        }
      }
    `;

    const writeMatches = matchTraps(
      { phase: "write", kind: "diff", text: nonTapFile },
      TRAP_ENTRIES,
    );
    const verifyMatches = matchTraps(
      { phase: "verify", kind: "file", text: nonTapFile },
      TRAP_ENTRIES,
    );

    expect(writeMatches).toHaveLength(0);
    expect(verifyMatches).toHaveLength(0);
  });

  test("the passRetained-specific trap fires only on the leak fixture, not on the correct or overbroad fixtures", () => {
    const overbroad = readFixture("overbroad-tap.swift");
    const leak = readFixture("pass-retained-leak.swift");
    const correct = readFixture("correct-tap.swift");

    const passRetainedLensMatches = (text: string) =>
      matchTraps({ phase: "verify", kind: "file", text }, TRAP_ENTRIES).filter((match) =>
        match.entry.id.includes("pass-retained"),
      );

    expect(passRetainedLensMatches(leak).length).toBeGreaterThan(0);
    expect(passRetainedLensMatches(overbroad)).toHaveLength(0);
    expect(passRetainedLensMatches(correct)).toHaveLength(0);
  });

  test("every seed entry carries provenance naming the Run C trace and a retirement condition", () => {
    for (const entry of TRAP_ENTRIES) {
      expect(entry.provenance.length).toBeGreaterThan(0);
      expect(entry.provenance).toContain("95bbdb0d");
      expect(entry.retirement.length).toBeGreaterThan(0);
    }
  });

  test("no accidental duplicate entry ids", () => {
    const ids = TRAP_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("orient pair auditability: prompt and task_taxonomy are separate entries (not merged, not duplicated)", () => {
    const orientPromptEntries = TRAP_ENTRIES.filter(
      (entry) => entry.phase === "orient" && entry.input === "prompt",
    );
    const orientTaxonomyEntries = TRAP_ENTRIES.filter(
      (entry) => entry.phase === "orient" && entry.input === "task_taxonomy",
    );
    expect(orientPromptEntries).toHaveLength(1);
    expect(orientTaxonomyEntries).toHaveLength(1);
    // Same trigger vocabulary and atomCore on both sides of the pair — this is
    // one requirement expressed twice for the two orient-time input shapes,
    // not two unrelated requirements.
    expect(orientPromptEntries[0]?.atomCore).toEqual(orientTaxonomyEntries[0]?.atomCore);
  });

  test("seed entries cover the RFC's two coordinated rows plus the passRetained row", () => {
    const hasWriteDiff = TRAP_ENTRIES.some(
      (entry) => entry.phase === "write" && entry.input === "diff",
    );
    const hasVerifyFile = TRAP_ENTRIES.some(
      (entry) => entry.phase === "verify" && entry.input === "file",
    );
    const hasPassRetainedRow = TRAP_ENTRIES.some((entry) => entry.id.includes("pass-retained"));

    expect(hasWriteDiff).toBe(true);
    expect(hasVerifyFile).toBe(true);
    expect(hasPassRetainedRow).toBe(true);
  });
});

describe("matchFileAgainstWriteVerifyTraps — shared file-lens fold (Task 9)", () => {
  test("the overbroad tap fixture yields exactly the tap lens, deduped across its write/diff and verify/file entries", () => {
    const text = readFixture("overbroad-tap.swift");
    const matches = matchFileAgainstWriteVerifyTraps(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.lens).toBe(
      "verify suppression is keycode-scoped and callback ownership uses passUnretained",
    );
  });

  test("the correct tap fixture ALSO yields the tap lens (lens != verdict: firing is not a defect claim)", () => {
    const text = readFixture("correct-tap.swift");
    const matches = matchFileAgainstWriteVerifyTraps(text);
    expect(matches.map((match) => match.lens)).toEqual([
      "verify suppression is keycode-scoped and callback ownership uses passUnretained",
    ]);
  });

  test("the passRetained leak fixture yields BOTH the tap lens and the passRetained lens, in entry order", () => {
    const text = readFixture("pass-retained-leak.swift");
    const matches = matchFileAgainstWriteVerifyTraps(text);
    expect(matches.map((match) => match.lens)).toEqual([
      "verify suppression is keycode-scoped and callback ownership uses passUnretained",
      "balance every passRetained with a matching release, or use passUnretained when the callback does not take ownership",
    ]);
  });

  test("a non-tap file yields no matches at all", () => {
    const text = `
      import Foundation
      struct Greeter {
        func greet(name: String) -> String { return "Hello, \\(name)!" }
      }
    `;
    expect(matchFileAgainstWriteVerifyTraps(text)).toEqual([]);
  });

  test("deterministic: repeated calls on the same text return the identical ordered result", () => {
    const text = readFixture("pass-retained-leak.swift");
    const first = matchFileAgainstWriteVerifyTraps(text).map((match) => match.lens);
    const second = matchFileAgainstWriteVerifyTraps(text).map((match) => match.lens);
    expect(first).toEqual(second);
  });

  test("an empty entries list yields no matches (pure function of its entries argument, no hidden global state)", () => {
    const text = readFixture("overbroad-tap.swift");
    expect(matchFileAgainstWriteVerifyTraps(text, [])).toEqual([]);
  });
});
