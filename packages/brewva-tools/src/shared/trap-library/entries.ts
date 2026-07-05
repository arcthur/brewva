import type { TrapEntry } from "./index.js";

// Seed data distilled from Run C (the greenfield-vs-review-ensemble
// comparison in docs/research/active/rfc-requirement-fitness-and-independent-
// review.md): the same event-tap-suppression prompt produced a WORSE semantic
// defect (an over-broad `.flagsChanged` swallow instead of Fn-only scoping)
// plus a new `passRetained` leak when review-ensemble/subagents were absent.
// Trace: game_2_up/.brewva/tape/95bbdb0d....jsonl.
const RUN_C_PROVENANCE = "game_2_up/.brewva/tape/95bbdb0d... (Run C, per the RFC)";

// Coordinated pair 1 of 2 (RFC "TWO coordinated rows"): orient-phase, task
// language input. Injects the atom-core before a line of code exists, so the
// implicit "Fn-only, not all .flagsChanged" requirement is on the ledger
// pre-write instead of discovered post-hoc in review.
const EVENT_TAP_ORIENT_NEEDLES = [
  "event tap",
  "cgevent",
  "global hotkey",
  "global key monitoring",
  "键盘监听",
  "全局快捷键",
] as const;

const EVENT_TAP_ATOM_CORE = {
  statement: "Fn suppression must be keycode-scoped, not all .flagsChanged",
  modality: "must",
} as const;

// Coordinated pair 2 of 2: write/verify-phase, changed-content input. Surfaces
// the review lens once `CGEvent.tapCreate` appears in a diff or file — see
// the module doc comment in ./index.ts for why this fires on ALL tap code,
// correct or not (lens != verdict).
const EVENT_TAP_LENS =
  "verify suppression is keycode-scoped and callback ownership uses passUnretained";

const EVENT_TAP_RETIREMENT = "retire when a deterministic adapter checks tap scoping";

export const TRAP_ENTRIES: readonly TrapEntry[] = [
  {
    id: "event-tap-orient-prompt",
    phase: "orient",
    input: "prompt",
    trigger: { kind: "substring_any", needles: EVENT_TAP_ORIENT_NEEDLES },
    atomCore: EVENT_TAP_ATOM_CORE,
    provenance: RUN_C_PROVENANCE,
    retirement: EVENT_TAP_RETIREMENT,
  },
  {
    id: "event-tap-orient-task-taxonomy",
    phase: "orient",
    input: "task_taxonomy",
    trigger: { kind: "substring_any", needles: EVENT_TAP_ORIENT_NEEDLES },
    atomCore: EVENT_TAP_ATOM_CORE,
    provenance: RUN_C_PROVENANCE,
    retirement: EVENT_TAP_RETIREMENT,
  },
  {
    id: "event-tap-write-diff",
    phase: "write",
    input: "diff",
    trigger: { kind: "substring_any", needles: ["CGEvent.tapCreate"] },
    lens: EVENT_TAP_LENS,
    provenance: RUN_C_PROVENANCE,
    retirement: EVENT_TAP_RETIREMENT,
  },
  {
    id: "event-tap-verify-file",
    phase: "verify",
    input: "file",
    trigger: { kind: "substring_any", needles: ["CGEvent.tapCreate"] },
    lens: EVENT_TAP_LENS,
    provenance: RUN_C_PROVENANCE,
    retirement: EVENT_TAP_RETIREMENT,
  },
  // Explicit passRetained lens so the leak fixture has its own trap, distinct
  // from (and narrower than) the general tap trap above: this one names the
  // retain/release imbalance directly instead of the broader tap-scoping
  // concern.
  {
    id: "event-tap-pass-retained-write-diff",
    phase: "write",
    input: "diff",
    trigger: { kind: "substring_any", needles: ["passRetained"] },
    lens: "balance every passRetained with a matching release, or use passUnretained when the callback does not take ownership",
    provenance: RUN_C_PROVENANCE,
    retirement: "retire when a deterministic adapter checks Unmanaged retain/release balance",
  },
  {
    id: "event-tap-pass-retained-verify-file",
    phase: "verify",
    input: "file",
    trigger: { kind: "substring_any", needles: ["passRetained"] },
    lens: "balance every passRetained with a matching release, or use passUnretained when the callback does not take ownership",
    provenance: RUN_C_PROVENANCE,
    retirement: "retire when a deterministic adapter checks Unmanaged retain/release balance",
  },
] as const;
