# RFC: Review→Atom Attribution And The Grade Ceiling On Discharging Independence Debt

> **Superseded by subtraction (2026-07-09).** The grade ceiling, the static-guard
> producer, and the review→atom close-edges this RFC designed were removed — see
> `docs/research/decisions/harness-subtraction-trap-static-guard-grade-ceiling.md`.
> The `independenceDebtAtoms` sensor survives grade-free (a high-risk `must` atom
> with no deterministic or independent pass). Retained as provenance.

## Metadata

- Status: `archived`
- Kind: RFC (an independence-debt / delegation-activation increment, not a new plane)
- Owner: Runtime, gateway, and delegation maintainers
- Last reviewed: `2026-07-08`
- Depends on:
  - [RFC: Independence Debt — Surfacing The Authored-Review Blind Spot At Turn Close](../active/rfc-independence-debt-and-the-authored-review-blind-spot.md)
    (Part 1 — the sensor this attributes to; `FitnessProjection.independenceDebtAtoms`,
    the render-time advisory that names the debt atoms, the risk-class grade floor)
  - [Decision: Requirement Fitness And Independent Review](../decisions/requirement-fitness-and-independent-review.md)
    (the fitness grade gate this is bounded by — an independent LLM outcome is
    presence-grade; only `static_guard`+ deterministic evidence clears a high-risk atom)
  - [Decision: Delegation Activation Surface And Trigger Economics](../decisions/delegation-activation-surface-and-trigger-economics.md)
    (the review-request atoms path this extends — `target: atoms`, `reviewedAtomIds`)
  - [Design Axioms](../../architecture/design-axioms.md) (axiom 1 `Attention belongs
to the model`, axiom 3 `Subtraction beats switches`, axiom 7 `Inconclusive is
honest governance`, axiom 18 `Descriptive metadata derives views, never authority`)
- Promotion target:
  - `docs/research/decisions/` (an ADR once an eval round shows a covering review mark a
    high-risk debt atom `violated` — `open` drops for a genuinely-broken atom — and the
    unguarded-debt-stays-lit behavior is confirmed correct)
  - `docs/reference/tools/delegation.md` (the covering review attests outstanding
    requirement atoms, once landed)

> **Scope correction (2026-07-08, after an independent code review).** An earlier draft
> claimed a folded review's CLEAR outcome would drive the debt atoms to `satisfied` and
> read the `open` counter down. That is **architecturally false** for the atoms the
> sensor tracks, and the correction reshapes the whole RFC — see
> [The Grade Ceiling](#the-grade-ceiling-why-a-review-cannot-discharge-what-it-cannot-grade).
> The honest thesis is narrower: a review can be **attributed** to its atoms (a FAIL
> marks the specific violations; the model gets atom-anchored findings), but a
> presence-grade LLM review **cannot discharge** an at-grade debt — that needs
> deterministic or behavioral evidence, and where neither is reachable the debt is
> honestly irreducible.

## Problem Statement

Independence debt (Part 1) surfaces the high-risk `must` atoms that reach turn close
with no independent read at grade (`FitnessProjection.independenceDebtAtoms`), and the
advisory names them. `game_7` — the first eval on a build carrying delegation activation
plus this sensor — proved the activation half works well:

- The model delegated an independent fresh-context `explorer` review (`game_5` had
  delegated **zero**), which recorded **6 findings** and an independent `fail` verdict.
- Those findings drove **4 fixes before ship**, including the recurring `req-1` Fn
  keycode-scoping defect (a `high` every prior run shipped or fixed only via atomization;
  the `FnKeyMonitor.swift` review-time digest differs from the shipped digest — the review
  caused the fix). For the first time brewva scaffolding measured **net-positive** vs the
  same model unscaffolded (`game_3`).

And yet the ledger did not move: the authored pass shipped with **7 `unverifiedMustAtoms`**
and the independence-debt `open` counter read **2** at close (`req-8` waveform-RMS,
`req-11` LLM-refine) — after the model did exactly what the sensor asked and fixed the
real defects. There are **two** reasons the sensor stayed lit, and the second is the one
that reshapes this RFC:

1. **Attribution gap.** The review was dispatched as a `files` review; its findings
   carried empty `atomRefs` and its independent `fail` carried empty `atomRefs`, so the
   verdict named no atom. Nothing in the ledger changed. This is real and fixable.
2. **Grade ceiling (the deeper one).** Even with perfect attribution, a presence-grade
   LLM review **cannot** drive a high-risk atom to `satisfied` — Part 1's own grade floor
   forbids it. `req-8` and `req-11` have no headless at-grade check at all, so their debt
   is irreducible in this environment. The sensor staying lit is **correct governance**,
   not a bug.

The first draft of this RFC saw only (1) and proposed to "close the ledger" through the
review. That was the authorship-taints-verification blind spot the sensor is named for,
committed by the sensor's own author: it read the grade gate at `fitness.ts:402-418` and
never traced where the independent outcome is constructed (`verification.ts:293-306`,
with no grade). This revision is what survives that review.

## The Grade Ceiling: Why A Review Cannot Discharge What It Cannot Grade

The chain, verified end to end in code:

1. `independenceDebtAtoms` is **high-risk by construction**: the filter requires
   `requiredEvidenceKind(atom) !== "presence"` (`fitness.ts:532-542`), i.e. riskClass ∈
   {runtime, security}, whose grade floor is `static_guard` (`fitness.ts` risk map). It
   also counts state `unverified` **or `likelySatisfied`** as debt (`fitness.ts:539`).
2. An independent review outcome is **always presence-grade**: the projection builds the
   `FitnessIndependentOutcome` with only `{atomRefs, verdict, ref}` and no `evidenceKind`
   (`verification.ts:293-306`), which defaults to `presence` (`fitness.ts:403`). This is
   **deliberate** — the adjacent comment (`verification.ts:308-312`) states that only
   structured `evidenceItems` from a static-guard producer are graded, and "a pass at
   `static_guard`+ can clear a high-risk atom a presence re-grep cannot."
3. So for a high-risk atom, an independent CLEAR fails the grade gate
   (`meetsRequiredGrade(atom, "presence")` is false; `fitness.ts:415-419`) →
   `hasIndependentPass` is never set → `resolveState` returns **`likelySatisfied`**, not
   `satisfied` (`fitness.ts:561-573`).
4. `likelySatisfied` high-risk atoms remain in `independenceDebtAtoms` → **`open` does not
   move on a CLEAR.**

The one ledger transition a review _can_ drive is the opposite one: an independent
**FAIL** whose finding names an atom marks it **`violated`** (`resolveState:562-563`), and
`violated` is **excluded** from the debt filter — so a FAIL that names a genuinely-broken
debt atom **does** drop `open`. That is the review's real lever: not clearing, but
attributing violations.

For the clearing direction, the only at-grade producers are:

- a **`static_guard` deterministic pass** — the R3 static-guard producer over real source,
  which covers a **fixed set of 6 macOS-Fn lenses** (`static-guard/predicates.ts:30-37`,
  keyword-routed at `:149-173`); an atom that matches no lens contributes nothing and stays
  presence-grade;
- a **behavioral** pass (`runtime_smoke`) — **unavailable headlessly** for permission-gated
  macOS behavior.

`game_7`'s open atoms (`req-8` "waveform driven by RMS with weights […]", `req-11`
"LLM refine conservatively") match **no** static-guard lens and have no headless
behavioral check. Their independence debt is therefore **irreducible in this
environment** — and Part 1's sensor is _correct_ to keep it lit (axiom 7): the honest
state is "this could not be independently verified at grade here," not "verified."

## Cybernetic Reading: One Actuator Per Edge

The independence-debt loop has three distinct close-edges, and they need three distinct
actuators — conflating them is what broke the first draft:

```
surface debt (sensor)
  ├─ VIOLATION edge  → an attributed review FAIL marks the atom violated → open drops
  ├─ DISCHARGE edge  → an at-grade deterministic/behavioral pass → satisfied → open drops
  └─ IRREDUCIBLE     → no at-grade producer reachable → debt stays lit (axiom 7, honest)
```

`game_7` fired the model's _review_ actuator but into the **attribution gap** (edge 1
un-wired). This RFC wires edge 1 — coverage-scoped attribution — so a review's FAIL lands
on the atom it broke. It explicitly does **not** claim to serve edge 2 (that is the
static-guard producer's job, bounded by its lens coverage), and it names edge 3 as a
correct terminal state rather than a defect. A feedback loop converges only when each
edge is driven by an actuator that can actually move it; the first draft tried to drive
edge 2 with a presence-grade review, which the grade floor makes a null actuator.

## The Design: Coverage-Scoped Review→Atom Attribution

When a review is dispatched whose target **provably covers the session's fresh-touched
file universe**, brewva folds the outstanding debt atoms into it: it resolves those atoms,
sets `reviewedAtomIds`, and routes the reviewer objective through the atom-attestation
framing so the reviewer is instructed to name the atom id in each finding's `atomRefs`.
Then:

- a **FAIL** whose finding names a debt atom → that atom becomes `violated` → it leaves the
  debt set (`open` drops) and the model receives an **atom-anchored** finding instead of
  prose it must re-map itself;
- a **CLEAR** → the atom reaches at most `likelySatisfied`. This is honest and useful
  (an authored-only atom that an independent read did not contradict is in a better
  epistemic state) but it is **not** a discharge: the RFC makes **no** claim that `open`
  drops on a CLEAR for a high-risk atom.

**Coverage, not target kind, is the trigger.** `game_7`'s review was a `target: files`
listing all 12 files — it covered the whole change but was not a `session_diff`. Keying
the fold on `target.kind === "session_diff"` (the first draft) would have skipped exactly
the case it cited. The honest predicate is set coverage: fold when
`reviewTargetFilePaths(target)` ⊇ the session's **fresh-touched** universe
(`sessionFreshTouchedFilePaths` — bare writes _and_ applied patches, both relativized to
the workspace root), reusing the existing `universeCoveredBy` predicate
(`review.ts:390`). A `files`-covering-all review qualifies; a genuinely narrow `files`
subset does not.

**Why coverage is load-bearing.** A `RequirementAtom` carries no file anchors
(`task.ts:98-102`; it is recorded in the orient phase before its code exists), so brewva
cannot map an atom to its files. It can therefore only honestly fold **all** outstanding
atoms into a review that provably covers **all** touched files. A narrow review is left as
a pure adversarial code review that attests no atom — folding atoms whose realizing code
the reviewer was not asked to read would be a fabricated attestation (axiom 7).

**There is no "whole-diff default."** `review_request`'s `target` is a required
`Type.Union(files | session_diff | atoms)`; the model always names one. The fold rides
whichever chosen target happens to cover the change.

## Axiom Alignment

- **Axiom 7 (`Inconclusive is honest governance`) — now first-class.** The design's most
  important move is _refusing_ to fake-discharge. An unguarded high-risk atom that no
  at-grade producer can reach stays in `open` on purpose; the sensor reporting "not
  independently verified at grade" is the honest state. The RFC narrows its own claims to
  what the grades permit rather than inventing a discharge.
- **Axiom 1 (`Attention belongs to the model`).** The fold never forces a review; it
  enriches the review the model _chose_, within that review's own covering scope, with
  evidence brewva already holds. The decision to review, and which target to name, stays
  with the model.
- **Axiom 3 (`Subtraction beats switches`).** Coverage-based attribution removes the
  model's burden to know that `atoms` is the magic ledger-touching target variant of a
  review that already covers the change — no new toggle or primitive.
- **Axiom 18 (`Descriptive metadata derives views, never authority`).** The folded atoms
  are re-derived from the tape's fitness projection at dispatch, stored nowhere new.

## Relationship To Existing Mechanisms (Honest About The Seams)

The first draft claimed the review-request atoms machinery is reused "wholesale,
unchanged." That is wrong; the fold adds code paths:

- **Atom resolution runs only for `target.kind === "atoms"` today**
  (`resolveAtomsForTarget`, `review-request.ts:185-188`); a covering `files`/`session_diff`
  target resolves **zero** atoms. The fold must resolve the debt atoms for a covering
  target and set `reviewedAtomIds` accordingly (today only atoms sets it,
  `review-request.ts:234`).
- **The atom-attestation objective is gated on `target.kind === "atoms"`**
  (`describeTargetForObjective`, `review-request-packet.ts:301-325`); the `files` and
  `session_diff` branches ignore any atoms passed to `buildReviewPacket`. The fold must
  add a covering-target branch (or a merged framing) that carries the atoms **and** the
  "name the atom's id in that finding's `atomRefs`" instruction — without it, the FAIL
  path has nothing to attribute (`review-receipts.ts:347` reads `finding.atomRefs` from the
  reviewer's own output).
- **The FAIL/CLEAR split in `commitReviewReceipts` is reused unchanged**
  (`review-receipts.ts:299` forces outcome `atomRefs` empty on a fail; `:347` per-finding).
  The fold changes _which atoms the reviewer is given and told to name_, not how a named
  atom is recorded.
- **Capability + cost.** `review_request` declares only
  `capabilities.events.records.query`, so the debt source must be derived via
  `buildTapeRequirementFitness(records.query(sessionId))`, not the `.list`-based
  assembler. Re-folding the tape fitness per dispatch is a hot-path cost to weigh.

## Decision Options

### Option A — Coverage-scoped review→atom attribution (recommended)

Fold outstanding debt atoms into any review that covers the fresh-touched universe, so a
FAIL marks the specific violated atoms; make no claim that a presence-grade CLEAR
discharges high-risk debt.

- **Impact:** `review-request.ts` (resolve debt atoms + set `reviewedAtomIds` for a
  covering target), `review-request-packet.ts` (covering-target objective branch), the
  coverage gate (`universeCoveredBy` + `sessionFreshTouchedFilePaths`). No fitness or
  receipt-schema change.
- **Pro:** deterministic wherever a review covers the change, independent of the model
  guessing a target name; drops `open` for genuinely-broken debt atoms; gives the model
  atom-anchored findings; strictly honest about the grade ceiling.
- **Con:** only the VIOLATION edge; discharge-to-`satisfied` remains the static-guard
  producer's job (guarded properties only); unguarded debt stays lit.
- **Risk:** a longer reviewer objective; reviewer atom-attribution quality (it must name
  the right atom per finding).

### Option B — Claim the CLEAR path discharges (rejected — architecturally false)

The first draft. Refuted by [The Grade Ceiling](#the-grade-ceiling-why-a-review-cannot-discharge-what-it-cannot-grade):
a presence-grade independent CLEAR reaches only `likelySatisfied`; high-risk debt does not
drop. Kept here as the cautionary record.

### Option C — Key the fold on `target.kind === "session_diff"` (rejected)

Misses `game_7`'s `files`-covering-all review, the very case the RFC exists to fix, and
leans on a phantom "whole-diff default." Coverage-based scoping (Option A) subsumes it.

### Option D — Auto-upgrade any review's target to `atoms` (rejected)

Overrides the model's target choice and, because atoms carry no file anchors, would attest
atoms whose code a narrow review never covered — a fabricated attestation (axioms 1, 7).

## Landing Plan (Sketch, Not A Commitment)

> **Implementation status (2026-07-08).** Landed on branch `rfc/independence-debt-close`:
> the coverage gate + fold source + attribution (steps 1–3), the grade-ceiling liveness
> proof (steps 4–5, as synthetic fitness-level tests rather than a curated `game_7`
> fixture), and the discharge census (step 6). An independent code review ran after each
> step; step 1's empty-universe over-fold and step 6's census provenance framing were both
> corrected per those reviews — the census is a source-agnostic terminal-state census, NOT
> a review-isolated signal.

1. **Coverage gate.** At dispatch, compute `reviewTargetFilePaths(target)` and
   `sessionFreshTouchedFilePaths(runtime, sessionId)` (both workspace-relativized) and fold
   only when `universeCoveredBy(target-paths, fresh-touched)` holds.
2. **Resolve the debt source.** Derive `independenceDebtAtoms` from
   `buildTapeRequirementFitness(records.query(sessionId))` (the `.query` capability
   review_request already declares); fold that set (see Open Question 1 on high-risk vs the
   broader `unverifiedMustAtoms`).
3. **Attribute.** Set `reviewedAtomIds` to the folded atoms and add a covering-target branch
   to `describeTargetForObjective` carrying the atoms and the atomRef-naming instruction,
   so FAIL findings land on atoms. Leave narrow reviews untouched.
4. **State the ceiling in the receipts' consumers, not the code.** No fitness change: a
   CLEAR still reaches `likelySatisfied` and the atom stays in `open`. Document that this
   is intended, so a future reader does not "fix" the sensor to drop on a presence CLEAR.
5. **Prove the VIOLATION edge.** A fitness-liveness test on a real tape (build a `game_7`
   fixture — none exists yet) plus one eval round must show a covering review's FAIL mark a
   debt atom `violated` and `open` read down by one, while an unguarded clean atom stays
   lit.
6. **Discharge census, honestly.** Extend the Part 1 Step 3 counter into a terminal-state
   census of the high-risk `must` atoms — `{ open, violated, dischargedAtGrade }` on
   `FitnessProjection.independenceDebtResolution`, summed by `report:delegation-evidence`.
   No per-turn transition history is needed: the end-of-tape census IS the discharge
   outcome. It buckets by STATE, not evidence source — `violated` counts a live fail
   (review/independent OR deterministic static-guard) that named the atom broken;
   `dischargedAtGrade` counts an at-grade pass (independent OR deterministic). So a rising
   `violated` + `dischargedAtGrade` is at-grade CLOSURE, not a review-only signal (a
   static-guard-only session moves it too); the review→atom fold is one honest driver, not
   the sole one.

## Source Anchors

- `packages/brewva-tools/src/runtime-port/verification.ts` lines 293-312 — the independent
  outcome is built with no `evidenceKind` (presence); only static-guard `evidenceItems` are
  graded. **The root of the grade ceiling.**
- `packages/brewva-vocabulary/src/internal/fitness.ts` lines 403, 415-419, 532-542, 561-573
  — grade gate; `independenceDebtAtoms` (high-risk, counts `likelySatisfied`); `resolveState`
  (`violated` on fail, `satisfied` only at-grade, else `likelySatisfied`).
- `packages/brewva-tools/src/families/delegation/review-request.ts` lines 185-188, 234 —
  atom resolution and `reviewedAtomIds` only for `target.kind === "atoms"`.
- `packages/brewva-tools/src/families/delegation/review-request-packet.ts` lines 126-134,
  301-325 — `reviewTargetFilePaths`; the atom-attestation objective gated on `atoms`.
- `packages/brewva-tools/src/families/delegation/review-receipts.ts` lines 299, 347 —
  outcome `atomRefs` CLEAR-only; per-finding `atomRefs` from the reviewer.
- The static-guard producer and its fixed 6-lens set were removed in the harness
  subtraction (`docs/research/decisions/harness-subtraction-trap-static-guard-grade-ceiling.md`).
- `packages/brewva-tools/src/runtime-port/session-touched-files.ts` (`sessionFreshTouchedFilePaths`)
  and `packages/brewva-vocabulary/src/internal/review.ts` line 390 (`universeCoveredBy`) —
  the coverage predicate.
- `packages/brewva-vocabulary/src/internal/task.ts` lines 98-102 — `RequirementAtom` has no
  file anchors (why coverage must be whole-universe).

## Validation Signals

- **Violation attribution:** a covering review's FAIL marks the named debt atom `violated`
  and `open` drops by one — the model gets an atom-anchored finding, not prose.
- **Honest non-discharge:** a presence-grade CLEAR does **not** drop `open` for a high-risk
  atom (guards against a regression that fakes discharge).
- **Irreducibility is expected:** an unguarded high-risk atom (`req-8`/`req-11` class) stays
  in `open` after any review — confirmed correct, not counted as a miss.
- **No dishonest scope:** a narrow `files` review never gains an atom attestation it did not
  cover.
- **Silent-miss visibility:** the residual case this edge cannot force — a covering review
  that FAILS yet names no atom, so nothing lands and `open` stays flat — is now counted as
  `report:delegation-evidence.coverageAttributionMiss` (see the independence-debt RFC), so a
  wired-but-unattributed fail is no longer indistinguishable from "no review ran".

### Field Verification (game_8, 2026-07-08 — first replay after the merge)

Replaying game_8's tape through the merged census gave
`independenceDebtResolution {open: 0, violated: 3, dischargedAtGrade: 2}` — the census
MOVED, but the driver was the static-guard producer, not the fold (the fold was correctly
idle: with every high-risk atom deterministically decided at dispatch time there was no
residual debt to fold, so its own promotion gate remains structurally unmet on this run).
Two results matter:

1. **The deterministic lens caught the recurring defect independently of the model.**
   `event_tap_keycode_scoped` failed `req-1` (shipped without a keyCode gate) while the
   model's own authored PASS claimed it fine — the census overwrote the self-claim with
   `violated`. This is the discharge edge's value proposition working: deterministic
   evidence needs no delegation and no model cooperation.
2. **Attribution was the weak layer.** Statement-keyword routing false-attributed the
   keycode FAIL to `req-8` (an LLM-submenu UX atom whose prose mentioned "On Fn release"),
   and first-match-wins shadowed `pasteboard_restore` behind `input_source_selectable` for
   `req-6`; the two `dischargedAtGrade` were single-facet passes credited to multi-clause
   atoms (`req-4`, `req-7`). An evidence item's effective grade is
   **min(verdict grade, attribution grade)** — keyword attribution was presence-grade
   guessing under a `static_guard` stamp. Fixed by the declared-binding slice: attribution
   now flows only from a trap entry's `staticGuards` (`property` coverage — pass discharges,
   fail convicts) or the atom's own `observableSignals` construct join (`facet` coverage —
   fail convicts, pass is trail-only), unbound FAILs ride the receipt with empty `atomRefs`,
   and statement routing is deleted. CONFIRMED by forward simulation — game_8's real
   recorded atoms (provenance + `observableSignals` from the tape) plus its shipped
   sources through the new producer and join give exactly
   `{open: 2, violated: 3, dischargedAtGrade: 0}`: `req-1` violated at `property` (the
   trap join fired on the verbatim statement), `req-3`/`req-6` violated at `facet`,
   `req-4`/`req-7` facet passes trail-only (open), `req-8` unbound (the false positive
   gone), zero `insufficientGradeAtoms` pollution. Numerically "worse" than the routed
   census, epistemically right — same honesty line as the grade ceiling.

## Promotion Criteria And Destination Docs

Promote to `docs/research/decisions/` (and thread into
`docs/reference/tools/delegation.md`) when:

- an eval round shows a covering review mark ≥ 1 high-risk debt atom `violated` (`open`
  drops for a genuinely-broken atom), with the finding correctly atom-attributed;
- the fold never attests an atom outside the review's covered universe (the coverage gate
  holds on a narrow `files` subset — it stays atom-free);
- the discharge census (`open` / `violated` / `dischargedAtGrade`) is wired (done) and an
  eval round shows it MOVE — `violated` or `dischargedAtGrade` rising as reviews and guards
  run, read honestly as at-grade closure rather than a review-only signal;
- Open Question 2 (does a presence-grade FAIL legitimately clear the _debt_, given the debt
  is "an at-grade read owed") is resolved.

## Open Questions

1. **Fold source: high-risk only, or all unverified must-atoms?** Folding
   `independenceDebtAtoms` (high-risk) targets exactly the sensor's set, but a presence CLEAR
   can only reach `likelySatisfied` there — so the CLEAR branch's _only_ real closures are
   on **low-risk** atoms (a presence independent pass DOES satisfy a presence-floor atom).
   Folding the broader `unverifiedMustAtoms` would let CLEAR actually satisfy the low-risk
   tail while FAIL marks high-risk violations. Weigh reviewer-attention dilution against
   ledger coverage.
2. **Is a presence-grade FAIL a legitimate debt discharge?** The debt is "an _at-grade_
   independent read is owed." A presence-grade review that finds an atom broken marks it
   `violated`, which leaves the debt set — but the read was not at grade. Is dropping
   `open` on a sub-floor violation honest (the atom is known-broken, so no read is owed), or
   should `violated`-by-presence stay in `open` until an at-grade verdict? This is a Part-1
   filter question the fold forces into the open.
3. **Steer toward `atoms`/`session_diff` when patch sets exist?** When applied patch sets
   exist, an `atoms` target is available and its objective already attests; should the fold
   nudge the model there instead of enriching a `files` review — or is coverage-based
   enrichment strictly better because it needs no model target-selection at all? (`session_diff`
   fail-closes without patch sets, `review-request-packet.ts:242-256`, so it is not always
   available — a point for coverage-based over kind-based.)
4. **The discharge edge is a separate lever.** Extending the static-guard producer's lens
   coverage (beyond the 6 macOS-Fn lenses) is the real way to make more high-risk atoms
   _dischargeable_ at grade; unguarded atoms stay irreducible. Worth its own RFC — this one
   deliberately does not attempt it. **Precision precondition (RESOLVED post-game_8):**
   before coverage grows, attribution had to stop being statement-keyword inference — more
   lenses under prose routing would have meant more `req-8`-class false bindings. Done via
   declared bindings (trap `staticGuards` = `property`; `observableSignals` construct join =
   `facet`; falsification asymmetry: facet FAIL convicts, facet PASS is trail-only; unbound
   FAILs surface with empty `atomRefs`). New lenses now land as (predicate, domain, optional
   trap `staticGuards`) triples, and only `property`-bound passes discharge.

## Related Work

- [RFC: Independence Debt — Surfacing The Authored-Review Blind Spot At Turn Close](../active/rfc-independence-debt-and-the-authored-review-blind-spot.md)
  — Part 1: the sensor and its grade floor.
- [Decision: Requirement Fitness And Independent Review](../decisions/requirement-fitness-and-independent-review.md)
  — the grade gate: independent = presence, only `static_guard`+ deterministic clears high risk.
- The harness-defect KEYSTONE (`game_2_up4` analysis): "the reachable evidence ceiling for
  permission-gated macOS behavior is a static-guard-predicate tier brewva partly lacks." The
  grade ceiling here is that observation, met at the review seam.
