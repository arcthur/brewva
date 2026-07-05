# RFC: Realizing The Requirement Loop — Routing Activation, Pre-Write Atomization, And Graded Evidence

## Metadata

- Status: `active`
- Kind: RFC (implementation proposal over an already-accepted decision)
- Owner: Runtime and architecture maintainers
- Last reviewed: `2026-07-05`
- Depends on:
  - [Decision: Requirement Fitness And Independent Review](../decisions/requirement-fitness-and-independent-review.md)
    (the landed loop this RFC activates)
  - [Candidate Axiom: Authorship Taints Verification](./candidate-axiom-authorship-taints-verification.md)
    (this RFC adds the orthogonal _grade_ axis and is a candidate second-ring instance)
  - [Design Axioms](../../architecture/design-axioms.md) (axioms 1, 4, 7, 10, 12, 18)
  - [Decision: Goal Control Plane](../decisions/goal-control-plane.md) (the
    capability-scoped-tool + advisory-skill shape reused here)
- Promotion target:
  - `docs/research/decisions/`
- Promotion gate: the routing activation and the graded-evidence join ship with
  liveness fitness and one real-trace calibration (see Promotion Criteria below).

Grammar (candidate lines for `design-axioms.md`):

> `Route the loop to the requirement, atomize before the write, and grade how the
check knows — else the loop realizes its memory, not its output.`

> `Authorship taints verification grades who checked; a realized loop must also
settle whether it ran at all, and how well the evidence knows.`

---

## Why This RFC Exists

The intent-realization loop landed a complete requirement-fitness anatomy —
perspective-tagged evidence, an independent `review_request` that closes a must
atom, whole-tape fitness re-derivation, and the operator-promotable
`VerificationGateManifest` as the sole gate. The anatomy is correct. But a
controlled four-build experiment shows the anatomy is **inert on the exact task
shape it was built for**: a greenfield implementation from an empty workspace.

The experiment fixed the model and varied only the harness. Same prompt (a
macOS Fn-dictation menu-bar app spec, ~30 concrete requirements), same
`gpt-5.5 @ xhigh`:

| Build        | Harness                 | Score /110       |
| ------------ | ----------------------- | ---------------- |
| reference    | Claude Code (Opus 4.8)  | 104              |
| control      | native codex, no brewva | 96               |
| brewva run 3 | brewva + codex          | 93               |
| brewva run 4 | brewva + codex          | ~85 (regression) |

Two facts from `game_2_up4/.brewva/tape/f556168a-…jsonl` matter more than the
scores:

1. **The loop never ran.** The turn's skill shortlist was
   `architecture, debugging, office-hours, plan, repository-analysis, strategy,
frontend-design` — byte-identical to run 3, every entry a flat `text_match`
   score of 100. `greenfield`, `verifier`, `review`, and `implementation` were
   all omitted. No `review_request` was ever dispatched (zero review events on
   tape). The requirement atoms were minted by `task_set_spec` at **t+510s — 171
   seconds and nine source files after the code was already written and codesigned
   at t+473s**. The verification receipt recorded
   `outcome:"pass", level:"requirements"` with `unverifiedMustAtoms:[req-1…req-7]`
   (all seven) and `atomRefs:[]`. Its "requirement re-derivation" was five
   `grep` calls (e.g. `grep 'maskSecondaryFn|return nil|CGEvent.tapCreate'`). The
   turn used 8% of the context window. Every organ exists; none is wired to the
   turn.

2. **Only atomized requirements ratchet; everything else is a random walk.**
   Between run 3 and run 4 the single requirement brewva had captured as an atom
   from `t+0.3s` — `req-1: "Fn suppression must be keycode-scoped, not all
.flagsChanged"` (trap provenance) — was **fixed** (`FnKeyMonitor.swift:35-37`
   now gates `keyCode == 63`). In the same diff, three requirements that were
   _not_ atomized **regressed**: the Speech final-result handler dropped its
   `isFinal`/watchdog guard (every dictation now loses its last word), the paste
   injector removed its clipboard-settle delay, and the overlay label width moved
   from the spec's 160–560 to 260–680. The harness ratcheted the one measured
   requirement — a rare Fn-combo edge case — while a core-happy-path defect
   regressed unmeasured. **The requirement-atom set is the only quality ratchet
   the harness has; the loop that maintains it is exactly the loop that never
   ran.**

This RFC is the minimal, constitution-respecting set of couplings that make the
landed loop actually turn on a greenfield task, without adding a single new
runtime gate.

---

## What Already Landed (Covered — Do Not Rebuild)

Per [Requirement Fitness And Independent Review](../decisions/requirement-fitness-and-independent-review.md)
and the `main` HEAD (`feat(verify): surface unverified-requirement debt so an
artifact-green with ungraded must atoms meets resistance`):

- **Perspective evidence.** `verification.outcome.recorded` carries
  `perspective` (`authored` | `independent`) and `independenceBasis[]`;
  `verification_record` has no perspective input, so a producer cannot certify
  itself independent (`verification-record.ts:192-202`).
- **The close path.** An independent `review_request` commits
  `review.finding.recorded` (mandatory `targetRef`) and one `independent` outcome
  with `atomRefs`; the fitness join reads that as `satisfied`
  (`fitness.ts:378-389`, `hasIndependentPass`).
- **Whole-tape re-derivation.** `run-report` and the Work Card fold _current_
  fitness over the whole tape (`buildTapeRequirementFitness`), so a late
  independent atoms-review's `satisfied` surfaces even though no single receipt
  carries it.
- **The sole gate.** `VerificationGateManifest`
  (`packages/brewva-gateway/src/extensions/api.ts`) is an operator-promoted
  `verifier.adapter` extension. It evaluates tape evidence and, at `abort`
  posture, blocks a **tool commit** (durable `tool.aborted`), never run
  completion. Only a recurring `deterministic_conflict` is bridge-eligible into
  it; LLM findings gate nothing (Inv 16).
- **Debt disclosure.** `run-report.unverifiedRequirementDebt`
  (`inspect/run-report.ts:111-116, 474`) and the `verification_record`
  result-text marker (`verification-record.ts:48-58, 240-258`) already name the
  "artifact-green that never graded its atoms" shape — advisory only.

The loop's anatomy and its one legitimate gate are done. This RFC does **not**
touch any of them; it makes them fire.

---

## What Does Not Survive The Constitution

The naive framing of "make requirements bite" is a pair of hard gates. Both are
axiom-rejected, and stating why fixes the shape of the real proposal:

- **A kernel ingress gate — "block writes until an atom graph exists."**
  Rejected by **axiom 4** (`Govern effects, not thought paths`): atomize-first is
  a reasoning order, not an effect class, and the kernel prescribes neither. Also
  by the proposal boundary (`the only proposal kind is effect_commitment; skill
routing is not a proposal boundary`). The ingress coupling must be **advisory
  model-facing skill sequencing**, not a write admission gate.
- **A kernel egress gate — "withhold run completion while must atoms are
  unverified."** Rejected by **axiom 18** (`Descriptive metadata derives views,
never authority`) and the landed decision's own ruling (`the single blocking
path unchanged … the sole gate stays the operator-promoted
VerificationGateManifest`). Requirement debt is advisory by constitution. And
  it _must_ be: today a must atom is only closable by an independent review
  (`atomRefs`); an autonomous "non-empty `unverifiedMustAtoms` blocks
  completion" rule would **deadlock every greenfield run**, because nothing
  auto-dispatches that review. The egress coupling must be **honest advisory
  disclosure** (to operator _and_ model) plus routing the _right_ debt into the
  _existing_ operator-promotable gate.

Everything below is therefore advisory ranking, advisory skill prose, evidence
_grading_, projections, and an inform-only brief. **Runtime decision points
added: 0.** The one behavior that can ever block stays the operator-promoted
`VerificationGateManifest`; this RFC only changes what becomes _eligible_ to be
promoted into it.

---

## The Genuine Residue

Five couplings, ordered by dependency. R1 is the keystone — it alone converts the
inert anatomy into a running loop and, as a side effect, fixes atomization timing.
R3 is the net-new epistemics: the axis the landed loop is missing.

### R1 — Routing activation (keystone)

**Why.** The loop is dead because its skills never render. The shortlist scorer is
`scoreReasons = Math.max(reasonPriority)` with `text_match = 100`
(`skill-selection.ts:494-496, 140-150`); every text-matched skill ties at 100, and
the 8-card cap (`MAX_RENDERED_SKILLCARDS = 8`) resolves ties by
`category.localeCompare` then `name.localeCompare` (`:542-548`) — alphabetical
luck, not task fit. The one forced candidate is `post_green_review`
(`:1012-1014`). A greenfield "请实现一个 app" prompt never reaches `greenfield`
(its CJK bridge is `从零/从头搭/新项目/脚手架/初始化项目`, `:120-123`; "实现" maps
only to `[implementation, code]`, `:108-111`), and `verifier`/`review` have no
pre-write signal at all.

**How.**

1. **A task-shape forced-candidate bundle.** Mirror the `post_green_review`
   mechanism: derive a `greenfield_implement` signal (analogous to
   `projectPostGreenReviewSignal`, `skill-adoption.ts:332-375`) and, when active,
   force `{greenfield, implementation, verifier, review}` into `forcedCandidates`
   (`skill-selection.ts:1012-1014`). `buildCandidate` already consumes forced
   reasons generically (`:515-518`) and forced reasons bypass neglect-demotion
   (`:682-690`), so no new wiring shape is needed — one more entry in the same Map.
2. **The signal's inputs.** The selector already receives `prompt`,
   `promptPaths`, `recentToolPaths`, and `workspaceRoot` (`:498-505, 996-1006`).
   An imperative-implement prompt with **no `recentToolPaths` yet** is a strong
   proxy for turn-one greenfield. For a precise, non-heuristic predicate, add one
   read-only input the selector does not have today — a **workspace-emptiness
   fact** (does `workspaceRoot` contain source files at turn entry) — computed
   once at turn entry and passed into the projector. This is a new _input to
   advisory ranking_, not a new authority (axiom 18's registered-advisory
   exception).
3. **TF-IDF tie-break.** Replace the alphabetical cull among score-100 ties with
   the TF-IDF ranker that already exists in `@brewva/brewva-search`
   (`ranking/tfidf.ts`) and is currently used only by `discover_skills`. The
   8-card cap then keeps the _relevant_ eight, not the alphabetical eight.

**Constitution.** Forced candidates are advisory shortlist ranking — the model may
ignore any rendered card (Inv 5 routing scope; axiom 18 registered-advisory
exception). The workspace-emptiness input is read-only. Per Inv 8 routing
overrides apply before runtime construction; the _selection projection_ stays
per-turn like `post_green_review` and touches no `runtime.config`.

**Side effect — makes two other behaviors _possible_, not proven.** Once
`greenfield` and `verifier`/`review` render, their doctrine _can_ carry the
ingress and close-path behavior the model otherwise never performs: greenfield's
Phase-1b atomize step (R2) and the verifier/review instruction to dispatch an
independent `review_request` before claiming done (the dispatch is manual — the
observer only commits receipts for a run already tagged by `review_request`,
`review-receipt-observer.ts:28-34`; no kernel auto-dispatch is added, axiom 10).
But rendering a card is not adoption. This RFC must not claim the gaps close "for
free" — adoption is an ACCEPTANCE obligation, proven by the liveness fitness
below, not a consequence of routing.

**Acceptance (liveness, not optional).** Land R1/R2 only with a liveness fitness
asserting, on a canonical greenfield run, that `firstSourceMutationAt >
taskAtomizationAt` (atoms precede substantial writes) AND that an independent
`review_request` was dispatched before finalization. Per axiom 19 ("a documented
invariant that nothing checks is a promise, not a contract") and "surfaces ship
with producers", this fitness — not the rendered card — is the evidence the loop
actually ran.

**Runtime decision points added: 0.**

### R2 — Pre-write atomization (advisory skill sequencing)

**Why.** Atoms arriving at t+510s are an audit appendix, not a control input.
`task_set_spec` is a free-floating tool (`task-ledger.ts:248-289`, guideline "Use
this early when …"); `greenfield/SKILL.md` never names it (grep: zero hits), and
its Phase 2 (`Grow in compilable milestones`, `:49`) begins writing with no
atomization precondition. The orient trap-lens machinery already exists; nothing
sequences it ahead of generation.

**How.** Insert an advisory phase in `greenfield/SKILL.md` **between Phase 1
(`Probe the toolchain`, `:37`) and Phase 2 (`:49`)**:

> `### Phase 1b: Atomize the spec` — before substantial writes, decompose the
> stated requirements into `task_set_spec` atoms with a risk lens (see R3). The
> atoms are the working set the ladder verifies against in Phase 3; a requirement
> that is not an atom before you write is a requirement you will only check from
> memory.

Mirror one line into `plan/SKILL.md` Phase 5 (`Emit bounded artifacts`, `:107`)
so a planned spec emits atoms as a first-class artifact alongside `design_spec`.

**Constitution.** Skill prose is model-facing advisory guidance (axiom 12; Inv 16
failure-semantics — advisory by construction). It sequences reasoning, not
effects. No runtime change.

**Runtime decision points added: 0.**

### R3 — Graded evidence: the axis the loop is missing (net-new)

**Why.** The landed loop grades evidence by _perspective_ (who checked:
`authored` vs `independent`, `fitness.ts:42-46`). It has no axis for _how the
check knows_. That is precisely the gap run 4 fell through: `req-1` was "verified"
by `grep 'maskSecondaryFn|return nil|CGEvent.tapCreate'` — a presence match that
is **structurally incapable** of expressing `req-1`'s property (keycode-scoping is
a _negative_ condition; the tokens are present whether or not the code is scoped).
The three regressions (Speech `isFinal` guard, ASCII-source selectability, tap
`tapDisabledBy` re-enable) are all **absence/failure-mode properties**: presence
grep cannot see them, and — critically — an _independent_ reviewer re-running the
same grep would close them just as wrongly. Perspective does not fix this;
authorship-taints-verification is orthogonal to grade.

The ladder already implies the missing distinction: `requirements` typical
evidence is "re-derivation from the code … not from memory" (static);
`runtime_smoke` is "behave when actually executed" (behavioral)
(`verification-ladder.md:15-16`). But for permission-gated macOS behavior,
`runtime_smoke` is unreachable headlessly (run 4's own receipt: "Live … runtime
smoke was not run because it requires Accessibility/Microphone/Speech
permission"). The reachable ceiling is a **static-guard predicate** — "does
`stop()` defer `cancel()` to `result.isFinal`?", "does the tap handle
`tapDisabledBy`?" — which brewva has no producer for. It has only presence-grep
(too weak) and unavailable runtime probes.

**How.** Add the grade as a **structured fact**, not a receipt decoration — the
failure mode to avoid is R3 re-becoming a string protocol (`grep` with labels).

1. **A structured `evidenceItems[]` receipt field — not a top-level flag.**
   `checks` is `string[]` (`iteration.ts:477`) with no per-item identity, verdict,
   or anchor, so a single top-level `evidenceKind` would degrade to a
   receipt-level grade ("this whole receipt is roughly static_guard"), and
   restructuring `checks` would break every existing reader/producer. Keep
   `checks: string[]` as the human summary and add `evidenceItems: EvidenceItem[]`
   to `VerificationOutcomeRecordedEventPayload` (`iteration.ts`), each item
   `{ id, atomRefs, sourceKind: "deterministic"|"independent",
evidenceKind: "presence"|"static_guard"|"behavioral", verdict: "pass"|"fail",
anchors: string[]  /* file-local */, statement }`. **Erratum (impl):** the field
   is REQUIRED on the receipt payload (the defensive reader always supplies `[]`, so
   consumers never see `undefined`); the OPTIONAL form lives on the tool-input type
   (`RecordVerificationOutcomeInput.evidenceItems?`). `sourceKind` is
   `deterministic|independent` — the two grade-bearing satisfying sources; an
   `authored`/`finding` source carries no grade. Idiomatic: the receipt already
   carries the structured `discrepancies` and `atomRefs`, and it is
   backward-compatible by the defensive-reader pattern — a missing/malformed array
   reads `[]`, with `context_evidence.report.v3`'s optional `grade?` the
   additive-graded-field precedent.
2. **The fitness join consumes `evidenceItems`, never `checks` text.**
   `projectRequirementFitness` already reads only structured fields
   (`discrepancies`, `atomRefs`, deterministic entries) and never parses the
   `checks` prose; R3 keeps it that way by feeding it `evidenceItems` (+
   deterministic adapter events). Extend the projection's `AtomFitnessEvidence`
   (`fitness.ts:42-46`) with the `evidenceKind` grade **alongside** its existing
   `kind`/source axis — the two are orthogonal (who-checked × how-well-known), so
   a reader can join, anchor, and downgrade a _specific_ evidence item rather than
   infer a whole receipt's character.
3. **Risk-class → minimum grade, as a state cap — NOT a conflict.** An atom's risk
   lens (the trap library already carries lenses) sets the minimum `evidenceKind`
   that lets it read `satisfied`. A `high`-risk / failure-mode atom (event-tap,
   input source, pasteboard, speech lifecycle, LLM privacy) whose only evidence is
   `presence`-grade is **capped at `likelySatisfied`** — the grade gates the state
   transition. It does **not** raise a `deterministic_conflict`: that grade means
   "a deterministic entry drove a _violation_" and is a conflict for a _violated_
   atom pointing at _fail_ evidence (`fitness.ts:55-84`, "only deterministic
   evidence can produce `deterministic_conflict`"), whereas insufficient grade is
   neither a violation nor a fail. Wrapping insufficiency as a conflict would
   pollute the gate-bridge truth (an operator would read "conflict" when the fact
   is "not checked well enough"). Instead emit a distinct, honestly-named debt —
   `insufficient_evidence_grade` — as its OWN projection output
   (`FitnessProjection.insufficientGradeAtoms`), **NOT** a member of the discrepancy
   grade tuple (`FITNESS_DISCREPANCY_GRADES`, `fitness.ts:67`). **Erratum (impl):**
   an earlier draft said "add to the grade tuple"; that is wrong — a
   `FitnessDiscrepancy` is a _violated_ atom with fail evidence, so folding
   insufficiency there would create a permanently-zero `insufficient_evidence_grade`
   column in every `discrepanciesByGrade` consumer (`fitness-summary`, `run-report`,
   `work-card`). A distinct output keeps axiom 7 (honest inconclusive) literal AND
   the discrepancy tuple's truth clean.
4. **Static-guard adapters (the missing producer).** Add a small library of
   deterministic static predicates keyed by atom class — the guard-existence
   checks a reviewer should run instead of a token grep ("does `stop()` defer
   `cancel()` to `result.isFinal`?"). They emit `sourceKind: "deterministic"`,
   `evidenceKind: "static_guard"` items. A predicate that **fails** raises a real
   `deterministic_conflict` on a genuinely violated atom; its **absence** on a
   high-risk atom is what leaves the `insufficient_evidence_grade` debt. They are
   the second evidence producer the "surfaces ship with producers" rule wants, and
   what a routed independent `review_request` (R1) actually executes.

**How it reaches the one real gate — without laundering insufficiency as
conflict.** `deterministic_conflict` stays reserved for an actual static-guard /
deterministic adapter FAIL, and stays the only discrepancy the operator bridges
into the `VerificationGateManifest` — unchanged truth semantics: a bridged
conflict is a checker that said _fail_, never "we didn't check well enough."
`insufficient_evidence_grade` is advisory by default; whether an operator may
_separately_ promote a manifest posture on ungraded-high-risk is an explicit,
honestly-typed follow-up (see Open Questions), never folded into the conflict
bridge.

**Constitution.** `evidenceItems` is a durable, structured fact on a durable
receipt — Inv 17 requires the `Durable` honesty class (not `Lossy`/`Advisory`);
Inv 1 evidence-integrity holds (it rides the existing ledger entry). The grade
drives a _view_, a state _cap_, and an honest _debt grade_ — never a gate (axiom
18; Inv 16). `insufficient_evidence_grade` is a debt annotation distinct from the
fail-bearing `deterministic_conflict`.

**Runtime decision points added: 0** (structured grading + a new advisory debt
grade; the `deterministic_conflict` bridge is unchanged and still requires a real
fail).

### R4 — Model-facing finalization brief (inform, not gate)

**Why.** Run 4's producing model declared "done" having never seen its own debt —
the seven `unverifiedMustAtoms` were computed and surfaced to the _operator_
projection, but nothing put them in front of the model at turn-tail. `run-report`
already computes the exact verdict (`unverifiedRequirementDebt`,
`inspect/run-report.ts:111-116, 474` — "the artifact-green that never graded the
atoms termination shape run-report exists to catch"); it just doesn't reach the
producer.

**How.** Add a relevance-gated `renderRequirementDebtSection(...)` returning a
`RuntimeBriefSection` (`runtime-brief.ts:35-43`) and wire it into the
`[pressure, cache, effects, recurrence]` array at
`workbench-context.ts:434`, mirroring `renderFailureRecurrenceSection`
(`failure-recurrence.ts:149-171`). It fires on two independent conditions: fresh
code with `unverified` `must` atoms below the requirements rung (the ladder/coverage
debt), OR any high-risk atom capped on presence-only grade (the grade debt — modality-
independent, since grade tracks a failure-mode/risk property orthogonal to a `must`
vs `should` binding). It renders a graded line: `requirements: N must atom(s)
unverified (<reason>); K high-risk atom(s) on presence-only evidence — dispatch an
independent review or climb to a behavioral check before finalizing`. `rfc-model-facing-runtime-intelligence-digests.md` already names
"open verifier findings" as an intended brief section, so this is an anticipated
slot, not a new channel.

**Constitution.** `[RuntimeBrief]` is inform-only, turn-tail, silent-when-clean,
"informs your decisions, never overrides them" (`runtime-brief.ts:4-7, 29-31`).
Inv 12 (context admission) and the Shared Projection Discipline (explicit
turn-tail admission, no `stablePrefixHash` move) hold.

**Runtime decision points added: 0.**

### R5a — Baseline requirement lifecycle (explicit-pull projection, build first)

**Why.** Run 4's inertness took a full tape parse to see; the _timeline_ alone —
when each atom appeared, whether writes preceded it, whether any review ran, what
debt remains — should be one projection, and it needs nothing R3 adds.

**How.** Extend the existing `run-report` Fitness section (`inspect/run-report.ts`)
/ `fitness-summary.ts` with a per-atom baseline: `createdAt`, `firstWriteAt` (first
`tool.committed` source mutation), review status (was any `review_request`
dispatched), and residual `unverifiedMustAtoms` debt. Every field is already on
tape — no dependency on R3. This is the acceptance baseline: it makes the
"atomized-after-the-write, never-reviewed" shape visible before any other change
lands, and it is where R1/R2's liveness fitness reads `firstSourceMutationAt` vs
`taskAtomizationAt`.

### R5b — Evidence-anchored lifecycle (depends on R3)

**How.** Once R3's `evidenceItems` exist, add the anchored columns:
`atom → claimed-by(anchors: file:line) → closed-by(evidenceKind, perspective) →
why-no-review`. These are exactly the structured evidence fields the current
`checks: string[]` cannot carry, so **R5b must follow R3** — sequencing it earlier
would only let it fake `file:line` claims from prose, the very regression R3
exists to end.

**Constitution (R5a + R5b).** Shared Projection Discipline (`README.md:17-33`) and
Inv 9 (rebuildable, non-truth) / Inv 14 (no mutation on open) hold; a pure
read-model over receipts + fitness, no new stored state (axiom 6), explicit-pull.

---

## Sequencing And Dependency

```
R5a (baseline life) ── build first: read-only, tape-only, makes inertness visible; the acceptance baseline
   │
R1 (routing)        ── keystone: renders greenfield/verifier/review; makes R2 + close-path dispatch POSSIBLE
   │                    (adoption proven by the pre-write-atomization liveness fitness, not assumed)
   ├── R2 (atomize) ── carried by greenfield doctrine once R1 renders it; shares R1's liveness acceptance
   └── R3 (grade)   ── net-new structured evidence: the how-well-known axis; new debt + the fail-only gate unchanged
          │
          ├── R4 (brief)          ── surfaces R3's graded debt to the producer at turn-tail
          └── R5b (anchored life) ── adds claimed-by/closed-by anchors (needs R3's evidenceItems)
```

Land R5a first (tape-only baseline visibility), then R1 (gated by its liveness
fitness), then R2/R3, then R4 and R5b — both of which depend on R3's structured
evidence. R5b must follow R3, not precede it.

## Runtime Decision Points Added: 0

Every change is advisory ranking (R1), advisory skill prose (R2), structured
evidence grading plus a new advisory debt grade (R3), an inform-only brief (R4),
or a projection (R5a/R5b). The sole blocking path remains the operator-promoted
`VerificationGateManifest`, and it still bridges only on a real
`deterministic_conflict` (a static-guard adapter FAIL) — never on
`insufficient_evidence_grade`. This RFC changes what becomes _eligible_ to promote
and makes the loop that produces that evidence actually run.

## Relationship To `Authorship Taints Verification`

That candidate axiom grades evidence by **perspective** (who checked) and needs a
second-ring instance to reach the constitution. This RFC adds the orthogonal
**grade** axis (how well the check knows) and the **activation** precondition
(whether the loop ran at all). The two compose: a `satisfied` atom should require
both an `independent` perspective _and_ a grade that matches the atom's risk
(`static_guard`/`behavioral` for failure-mode atoms). R3's static-guard adapters
are a `deterministic`-source, non-authored evidence producer — a candidate
second-ring datapoint for promoting the authorship axiom (its named negative
space includes "tool self-attestation", which a deterministic guard adapter
begins to close).

## Non-Goals

- No new kernel gate, proposal kind, or run-completion authority. The
  `VerificationGateManifest` stays the only block.
- No auto-dispatched review as kernel choreography (axiom 10). Dispatch stays
  model-native, carried by routed skill doctrine.
- No workspace-shape templating (App/Core/Checks imposed). The control comes from
  evidence incentives (a testable core closes atoms at a higher grade), not a
  mandated scaffold — the native-codex control produced that structure unprompted,
  so the fix is to stop suppressing it, not to hardcode it.
- No change to compaction, cost, or attention surfaces.

## Implementation Status (2026-07-05)

All slices (R1a/R1b routing activation, R2 pre-write atomization, R3 graded
evidence, R4 debt brief, R5a/R5b lifecycle) are IMPLEMENTED on
`rfc/requirement-realization-coupling`, each reviewed and green (typecheck, lint,
knip, full unit + fitness suites). Two independent high-level reviews after the
first pass reshaped three things worth recording here:

- **`EvidenceItem` shape narrowed — no `sourceKind` (revises R3.1).** The shape
  shipped as `{ id, atomRefs, evidenceKind, verdict, anchors, statement }`; the
  once-proposed `sourceKind` axis was DROPPED. An evidence item is deterministic by
  construction (the runtime ran a static-guard predicate over real source);
  authorship is already carried by the receipt's `perspective` axis, and an
  independent review's positive signal rides the top-level `atomRefs`, not an item.
  A per-item `sourceKind` was a second, redundant home for the same distinction,
  with no producer for its `independent` value — removed.

- **Risk-class source RESOLVED (closes R3.2).** `TrapEntry.atomCore` now carries
  `riskClass`, and the event-tap orient trap seeds `riskClass: "runtime"`. This is
  load-bearing: the min-grade cap engages only on a classified atom, and the orient
  trap is the ONE automatic atom producer on the motivating greenfield shape —
  without it the entire graded half of R3 was inert in production (a presence
  re-grep could `satisfied` a failure-mode atom, the exact up4 false-clear R3 exists
  to stop). The trap's compiled hindsight IS the risk classification.

- **Claim-time evidence injection (R3 implementation note).** `verification_record`
  runs the static-guard producer and injects the resulting items into the
  claim-time fitness cross-check BEFORE they reach the tape (via the assembler's
  `deterministicEvidence` option), so the receipt's own `discrepancies` and the
  model-facing summary reflect a `deterministic_conflict` immediately — not only on
  a later operator re-derivation. A pure tape re-read passes no option and reads the
  same evidence back from the committed `evidenceItems`; the two channels are
  mutually exclusive (claim-time items are not yet on the tape), so nothing
  double-counts. Verified by a real-producer test driving the tool over a real Swift
  fixture, not a hand-built receipt.

**Still blocking promotion** (see below): both liveness fitnesses landed, but the
empirical gate — one real-trace re-run showing the score gap to native-codex closed
— has not been run, and the stable architecture/reference docs do not yet carry the
contract. Per `docs/research/README.md`, `decisions/` requires the stable docs to
carry the contract first, so this note stays in `active/`.

## Open Questions / Promotion Criteria

- **Structured evidence model (R3.1) — RESOLVED (revised).** Shipped as
  `EvidenceItem { id, atomRefs, evidenceKind, verdict, anchors, statement }` —
  WITHOUT the once-proposed `sourceKind` (see Implementation Status: redundant with
  the receipt `perspective` axis, no producer for its `independent` value).
  `static_guard` adapters emit items; an independent review emits its positive
  signal on the receipt's top-level `atomRefs`, not items. `evidenceKind` was added
  to the projection's `AtomFitnessEvidence`. `checks` stays the human summary; the
  fitness join never parses it.
- **`insufficient_evidence_grade` (R3.3).** Modelled as a distinct projection
  output (`FitnessProjection.insufficientGradeAtoms`), **NOT** a member of
  `FITNESS_DISCREPANCY_GRADES` — a discrepancy is a violation with fail evidence, so
  folding insufficiency there would leave a permanently-zero by-grade column
  downstream. Open: whether an operator may _separately_ promote a manifest posture
  on it — kept out of the fail-only conflict bridge, never folded into it.
- **Workspace-emptiness input (R1.2).** Confirm the cheapest turn-entry source of
  the emptiness fact within the read-only projection discipline (a single
  `readdir` at turn entry vs a session-start flag). Until then the prompt-shape +
  empty-`recentToolPaths` proxy ships advisory-only.
- **Risk-class source (R3.2) — RESOLVED.** The trap library carries it:
  `TrapEntry.atomCore` gained `riskClass`, and the event-tap orient trap seeds
  `riskClass: "runtime"`, threaded through the same `resolveRequirementAtoms` seam
  `task_set_spec` uses. The trap's compiled hindsight IS the classification, so the
  min-grade cap engages on the automatic atom. A general atomizer beyond the
  event-tap trap family remains the larger follow-up.
- **Static-guard adapter scope (R3.4).** Start with the five high-risk macOS lenses
  this experiment exercised (event-tap re-enable, input-source selectability,
  pasteboard restore ordering, speech finalization, LLM-key privacy); generalize
  only after a second task shape.
- **R1/R2 acceptance (adoption liveness).** The pre-write-atomization liveness
  fitness — `firstSourceMutationAt > taskAtomizationAt` AND a `review_request`
  dispatched before finalization, read off the R5a baseline — is ACCEPTANCE, not
  promotion: R1/R2 do not land without it (axiom 19; "surfaces ship with
  producers"). Rendering the right skill card is not evidence the model adopted it.
- **R3/R4 producer liveness — LANDED.** A join-level fitness asserts a graded
  `evidenceItems` receipt clears what presence cannot, and a real-producer tool test
  drives `verification_record` over a real Swift fixture (so a producer regression
  to `[]` goes red, not just a hand-built receipt). The R4 debt brief has its own
  producer-liveness assertion.
- **Promotion.** Move to `decisions/` after R1 + R3 land with both liveness
  fitnesses and one real-trace re-run shows the atom set both complete (atomized
  before writes) and graded (no failure-mode atom `satisfied` on presence-only),
  with the score gap to the native-codex control closed rather than random-walking.

## Evidence Appendix

Trace `game_2_up4/.brewva/tape/f556168a-…jsonl` (run 4), all timestamps relative
to turn input:

- `t+0.3s` `req-1` (trap) recorded; `t+30s…339s` nine files written; `t+473s`
  build + codesign complete; `t+510s` `task_set_spec` + `req-2…req-7`; `t+519s`
  artifact-rung pass; `t+538–539s` five presence greps; `t+559s`
  requirements-rung pass with `unverifiedMustAtoms:[req-1…req-7]`, `atomRefs:[]`.
- Skill shortlist identical to run 3; `greenfield/verifier/review/implementation`
  omitted. Zero review events. Context peak 32,445 / 400,000 tokens.
- Run 3 → run 4 diff: `req-1` (atomized) fixed; Speech `isFinal` guard, paste
  timing, and label-width range (all un-atomized) regressed.
