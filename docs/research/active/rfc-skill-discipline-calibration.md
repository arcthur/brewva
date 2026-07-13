# RFC: Skill Discipline Calibration — Hard Safety Gates, Soft Cognitive Defaults, And Rules That Earn Their Keep

## Metadata

- Status: active
- Kind: RFC (a wording-authority recalibration of the built-in skill corpus,
  plus two mechanism closures found during the audit — the `AGENTS.md`
  promotion bypass and the adoption-measurement validity gap). Text-layer
  first; no new runtime plane.
- Owner: skills-catalog / harness-calibration maintainers
- Last reviewed: `2026-07-13`
- Depends on / relates to:
  - [Design Axioms](../../architecture/design-axioms.md) — axiom 1 `Attention
belongs to the model.`, axiom 3 `Subtraction beats switches.`, axiom 4
    `Govern effects, not thought paths.`, axiom 5 `Every commitment has a
receipt.`, axiom 7 `Inconclusive is honest governance.`, axiom 18
    `Descriptive metadata derives views, never authority.`, axiom 19 `A
documented invariant that nothing checks is a promise, not a contract.`
  - [Decision: Advisory Heuristics Carry Receipts And Offline Calibration, Not A Meta-Optimizer](../decisions/advisory-receipt-and-calibration-standard.md)
    — accepted case law this RFC both enforces (finding F8 documents a live
    bypass of it) and stays inside (the retirement loop derives reports; rule
    changes land as reviewed code).
  - [RFC: Tool-Surface Subtraction](./rfc-tool-surface-subtraction.md) — the
    method precedent. That RFC measured designed-vs-exercised for the tool
    ontology and found near-dead surface; this RFC applies the same
    designed-vs-exercised discipline one layer up, to the skill corpus's
    behavioral clauses — which today have no exercise measurement at all.
  - [RFC: The Optimizer Last-Hop](./rfc-optimizer-last-hop-fuel-eval-and-parameter-registry.md)
    — Phase 3 of this RFC lands skill strictness as named calibration-registry
    parameters and uses `report:self-eval` as the behavior gate for wording
    changes.
- Promotion target:
  - `docs/research/decisions/` — an ADR once the phased changes land and the
    self-eval before/after comparison confirms no completion-rate regression.
  - `skills/meta/skill-authoring/references/skill-anatomy-v2.md` → v3 (the
    two-tier rule grammar and the script-input rule).
  - The skill corpus itself (`skills/core/**`, `skills/domain/**`,
    `skills/meta/**`) — rewritten clauses per the proposal.

## Problem Statement

The built-in skill corpus (35 SKILL.md bodies plus invariants, scripts, and
references; ~9.5k lines) is a defensive discipline system: Iron Laws, Red
Flags, rationalization tables, count budgets, and judgment scripts, built from
observed failures of current-generation models. For weak models this is a real
guardrail. The structural problem: **the corpus does not distinguish content
that appreciates as models get stronger (domain facts, safety invariants,
honesty contracts) from content that depreciates (patches for one generation's
cognitive deficits)** — both are written in the same absolute register
(`NO X WITHOUT Y`, `STOP`, `MUST`).

SkillCards are advisory (axiom 18: authority posture `none`), so a skill's
entire constraint force comes from the normative power of its wording —
instruction-tuned models comply strongly with `STOP`-register text. That the
runtime enforces none of it means **the wording is the governance**. And the
current wording rebuilds, at the skill layer, exactly what axiom 4 forbids at
the kernel layer: prescribing the exact reasoning path intelligence must take.
As models grow stronger, each such prescription flips from guardrail to
ceiling; a corpus with no retirement loop only accumulates them.

### Scope boundaries

- **In scope:** skill-text wording authority; judgment scripts shipped with
  skills; the learning-promotion channel (`promote.sh`); adoption-measurement
  semantics (`skill-adoption.ts`); the authoring anatomy that stamps the genre.
- **Out of scope:** effect governance (approval, capability, sandbox — those
  constrain the world, not thought, and stay exactly as hard); the skills
  discovery/selection runtime (its catalog + `discover_skills` escape hatches
  are adequate; only measurement semantics are touched); deleting the skill
  corpus or weakening it for weak models (Phase 3 is per-model calibration,
  not removal).

## Evidence Base

Three passes, deliberately independent, then cross-checked:

1. **Full-corpus first read.** All 35 SKILL.md bodies, the meta anatomy, the
   shared project rules, key invariants (`planning-posture`,
   `simplicity-check`, goal-loop preflight/outcome), key scripts
   (`hypothesis_tracker.py`, `check_scope_drift.py`), and the verifier ladder.
2. **Two external expert reviews** (independent LLM analyses) covering the
   skill text and — uniquely in the second — the runtime chain
   (`skill-selection.ts`, `skill-adoption.ts`, `promote.sh`,
   `promotion-targets.md`, `bento-paradigm.md`).
3. **Claim-by-claim verification** of both reviews against source. Three
   expert-one claims did not survive (frontend-design ignores the greenfield
   exemption; self-improve's 2-occurrence gate misread — single incidents route
   to `knowledge-capture`; workflow-gates misread as per-edit rather than
   per-change-set). Every expert-two runtime claim reproduced, and two were
   worse than claimed (F8, F9 below). Findings below survived verification.

## Findings

### F1 — The self-sealing meta-clause

`skills/meta/skill-authoring/references/authored-behavior.md` ships a
cross-skill table: `"I'll follow the spirit, not the letter"` → `"Follow the
steps, then adapt."`, plus `"Violating the letter of a skill's hard rule is
violating the spirit of that rule."` This defines _the judgment that a rule
does not apply_ as itself a rationalization — an unfalsifiable loop with no
exit. It is the amplifier for every other finding: while it stands, any
conditional wording elsewhere is overridden at execution time by
letter-compliance. The same file's own boundary section says skills "should
improve specialist behavior without reintroducing hidden control loops";
mandatory step-compliance is precisely such a loop. The anatomy additionally
mandates one-way accumulation: "Every rationalization a model uses during eval
testing becomes a new row" — rows are added on observed failure, and nothing
retires them when the failure mode disappears with the next model generation.

### F2 — Iron Laws mix safety invariants with efficiency heuristics

Compare: `NO GITHUB WRITE WITHOUT EXPLICIT TARGET CONFIRMATION` (github — a
true external-effect boundary), `NO PASS VERDICT WITHOUT EXECUTABLE EVIDENCE`
(verifier — an honesty contract), versus `NO PATCH WITHOUT CONFIRMED ROOT
CAUSE` (debugging) and `NO PLANNING WITHOUT EXPLICIT PRECEDENT CONSULT`
(learning-research) — efficiency heuristics wearing invariant grammar. The
model cannot tell which laws are load-bearing safety and which are calibrated
defaults, so the safe reading is: all absolute. The heuristic ones then block
strictly better paths (see F6).

### F3 — Judgment scripts consume only self-reported data

The discriminating test for a skill script: **does its input contain any
information the model does not already possess?** Perception scripts pass —
`parse_ci_state.sh` reads real CI, `locate_session_artifacts.sh` reads the
real filesystem, `verification_record`'s static guards run on real source
("the grade is earned by the predicate RUNNING"). Judgment scripts fail:
`hypothesis_tracker.py` validates a JSON array the model itself authored
(checking only format — a non-empty `evidence` string passes regardless of
quality — and clamping `max_active` to a hard 3), `check_scope_drift.py`
adjudicates the semantic question "is this file part of the change?" by path
prefix (a shared helper outside the target list forces a full
return-to-plan; an unrelated edit inside a target directory passes), and
`classify_verifier_verdict.py` computes a three-row decision table from
model-supplied counts. These defend against unintentional drift — which
shrinks with model strength — while costing a tool round-trip per phase and
lending false "checked by a script" authority to unexamined inputs.

### F4 — Count budgets where evidence conditions belong

Hard-coded small integers throughout: max 3 active hypotheses and
3-falsified → escalate (debugging + tracker script), 2 same-symptom attempts →
hard stop, "One more attempt (when already tried 2+)" as a red flag
(ci-iteration), 2 no-information browser actions → stop (agent-browser), 2
discovery passes → stop, 3 below-noise-floor runs → escalate (goal-loop).
These conflate _repeating the same strategy_ (should stop) with _consecutive
attempts each informed by new evidence_ (should continue), and truncate
exactly when information gain peaks — three falsified hypotheses is when the
next hypothesis is best-informed, yet the tracker returns `should_escalate`
with "escalate instead of inventing more". The corpus already contains the
correct form: ci-iteration's own Iron Law `NO RETRY WITHOUT FRESH EVIDENCE
FROM THE LAST ATTEMPT` is information-theoretic, unbounded, and fully general.
The numeric budgets are redundant with it and strictly worse.

### F5 — Numeric formulas with cascade amplification

`skills/core/plan/invariants/planning-posture.md`: `affected_paths_count > 1`
→ `moderate`, `> 5` or `boundaries_crossed > 1` → `complex`.
`skills/core/prep/invariants/simplicity-check.md`: `max new abstractions =
max(requested_features.length * 2, 1)`. Path count is a crude risk proxy (a
20-file mechanical rename classifies `complex`; a 1-file WAL format change is
rescued only by the `has_persisted_format` flag), and abstraction-count-per-
feature has no basis. Worse, the formula output **cascades**: `moderate`+ is
the trigger condition for learning-research's mandatory precedent consult and
for prep's mandatory plan escalation — formula error is amplified by the
skill chain downstream.

### F6 — Phase-identity constraints beyond permission truth

Two kinds of "this skill must not do X" exist. Permission-true ones are
correct and stay: retro "does not hold `workspace_write` permission".
Identity-purity ones bind the same model in the same session: debugging Phase
4 "Do not patch" outlaws the controlled experiment (change one line under a
declared hypothesis with expected observation and revert — the strongest
causal instrument in a cheaply-reversible git world); "If not reproducible:
Stop" forecloses the legitimate path for concurrency/intermittent failures
(instrumentation, containment, evidence-limited investigation from tape and
history); Phase 3's "the single explanation that fits the full signal" bakes
in a single-cause model that mis-serves compound failures; review's "fixes
must be routed, not applied here" makes a one-line typo fix a cross-skill
round-trip when reviewer and implementer are the same context. And nearly
every Red Flag prescribes "STOP and return to Phase 1" — a punitive full reset
where repairing the violated precondition and continuing loses nothing.

### F7 — Mandated cognition topology

review Phase 2: "treat each activated lane as an independent slice: … fan them
out in one `subagent_fanout` message" — unconditional for non-trivial review.
predict-review Phase 3: "If majority agreement forms with no recorded dissent:
Stop. The Iron Law is violated. **Force explicit disagreement.**" Two errors:
organization is mistaken for evidence (multiple same-model, same-context
subagents are highly correlated samples, not independent verification), and
manufactured dissent against genuinely convergent evidence produces
low-quality noise — the skill already requires falsification conditions on
`ranked_hypotheses`, which is the strictly better test. Contrast the correct
conditional form already present in repository-analysis and discovery: "When
the surface splits into independent slices … keep single-file reads inline."

### F8 — The promotion bypass (verified; conflicts with accepted case law)

`skills/meta/self-improve/scripts/promote.sh` appends learning entries
directly to `AGENTS.md` (`echo "$AGENTS_ENTRY" >> "$AGENTS_FILE"`).
`references/promotion-targets.md` qualifies a learning when "**any** of these
hold" — including single-occurrence `resolved`, "required actual debugging",
or the user saying "remember this" (an authorization signal, not a correctness
signal). No human-approval step, no expiry, no rollback beyond `--dry-run`.
This contradicts three standing authorities at once: (a) the accepted
[advisory-receipt-and-calibration-standard](../decisions/advisory-receipt-and-calibration-standard.md)
decision — "calibration derives reports … rule changes land as reviewed
code"; (b) self-improve's own Iron Law `NO SYSTEMIC CLAIM WITHOUT REPEATED
EVIDENCE` (the "any" matrix side-steps the 2-occurrence gate its own Phase 1
enforces); (c) calibration-report's stated boundary "promotion runs through
the knowledge-capture flow with human review" — an invariant nothing checks
(axiom 19, twice: the documented review requirement is unenforced, and the
bypass makes descriptive learning text feed the highest-priority instruction
surface, the exact one-way derivation axiom 18 forbids). This is the ratchet
that would let one generation's local experience permanently constrain the
next.

### F9 — Adoption measures `opened`, not `followed`

`skill-adoption.ts` records a rendered SkillCard as adopted when any
read-class tool invocation targets its SKILL.md after the selection receipt.
The presentation line is honest ("N/M rendered SkillCards **read**"), but the
metric is named adoption, and `analyze:advisory-receipts` feeds
"offer-vs-adoption" into calibration passes. If subtraction decisions ever
key on it, Goodhart bites in both directions: skills followed from context
without a re-open count as un-adopted (kill signal for a working skill);
skills opened and ignored count as adopted (keep signal for a dead one). The
corpus's own standard — "a receipt or advisory surface is not shipped until a
liveness fitness asserts a canonical run emits it" — is not met by the
conduct level of this metric.

### F10 — No reality-arbitration rule; accumulation without retirement

Nothing in the corpus says what wins when skill text contradicts observed
code/runtime reality. Skills embed decaying facts (tape paths, "#1 hidden
root cause" experience claims) in invariant register, and learning-research
even red-flags the thought "The precedent is probably outdated so I'll ignore
it" — suppressing the correct response to a stale precedent. Combined with
F1's add-only rationalization tables and F8's open intake, the corpus has an
entry ratchet and no exit: nothing measures whether a clause ever fires, and
nothing retires one that stops earning its keep (axiom 3).

### F11 — Minor cluster (verified, lower stakes)

goal-loop's preflight requires `metric_mechanical: metric source produces a
parseable number` — the entire loop substrate is closed to rubric/suite/
pairwise evaluation, locking out qualitative long-running work.
`frontend-design/references/bento-paradigm.md` "**Enforces** a 'Vercel-core
meets Dribbble-clean' aesthetic", "All cards **must** contain perpetual
micro-interactions", naming fonts and a React/Framer-Motion stack — in direct
tension with its own SKILL.md ("Do not import a new visual identity").
office-hours converts any code-requiring validation into a "no-code
assignment", foreclosing disposable-prototype premise tests. The anatomy's
mandatory ten-section body plus 150-line cap forces judgment content out to
lazy-loaded references even for skills that are one fact plus one judgment.
`discover_skills` TF-IDF indexes only card metadata, not SKILL.md bodies.

## What Appreciates (explicitly out of subtraction scope)

These are the assets the recalibration must not weaken — they grow more
valuable with model strength, not less:

- **The verification ladder + evidence grades** (`exit_code` →
  `runtime_smoke`; `presence`/`static_guard`/`behavioral`): epistemic
  vocabulary, not process constraint. The best design in the corpus.
- **Honesty/disclosure contracts**: verifier's verbatim `fitness:` /
  `review_debt:` read-back, extract's evidence-or-null, calibration-report's
  "unexercised, not unnecessary" and skipped-leg recording. Capability growth
  does not remove reporting bias; these stay absolute.
- **External side-effect confirmation gates** (github/git write confirmation,
  destructive-op rollback posture) and **permission-truth constraints**.
- **Project invariants** (`critical-rules.md` axiom-anchored rules) — private
  facts no model derives from first principles.
- **Question escalation protocol** (blocking → live `question` tool) and the
  **failure-branch genre itself** (each phase says where failure goes — only
  the reset semantics change, per F6).
- **Anti-theater clauses** (repository-analysis Phase 4 "Do not scan more
  files to look thorough").

## Decision Options

- **Option A — Phased recalibration + retirement loop (recommended).** Close
  the live mechanism gaps first (F8, F9), then recalibrate wording authority
  (F1–F7), then wire clause-level exercise measurement into the existing
  calibration substrate so the corpus can shrink with evidence (F10). Detailed
  below.
- **Option B — Per-model strictness profiles only.** Leave text as-is; select
  strictness by model tier at injection time. Rejected as sole path: F8
  conflicts with an accepted decision today regardless of model tier, F1's
  meta-clause overrides profile softening at execution time, and dual-text
  maintenance without a retirement loop doubles the ratchet. Survives as
  Phase 3's delivery mechanism.
- **Option C — Measure first, change nothing.** Land only receipts/statistics
  and re-decide later. Rejected as sole path: F8 is a live bypass with
  day-one blast radius, and F1/F2 wording costs are already documented from
  text alone. Survives as Phase 3's evidence discipline.

## Proposal (Option A)

### Phase 0 — Close the mechanism gaps (smallest blast radius, first)

1. **Retire the `AGENTS.md` direct-write path.** `promote.sh agents` stops
   appending; it emits a reviewable candidate (reuse the harness-candidates
   lane / `.brewva/learnings/candidates/`) whose landing is a human-reviewed
   diff. Rewrite `promotion-targets.md` criteria from "any of these" to
   recurrence-or-reviewed: repeated evidence per self-improve's own Iron Law,
   or an explicit human instruction that still lands as a reviewed diff.
   Candidate entries carry scope, provenance (`candidateId`), and an expiry /
   re-evaluation trigger.
2. **Rename adoption → opened; add the conduct level.** The projection and
   trace line say what they measure. Add a per-skill conduct receipt where
   cheap and deterministic: skills with producer artifacts count conduct by
   artifact presence (debugging → `investigation_record` exists; verifier →
   executed checks recorded; plan → decisions + targets present). Ladder:
   `offered → opened → conduct_observed`, tape-derived like today's
   projection. No selector may key subtraction on `opened` alone.

### Phase 1 — Recalibrate wording authority (pure text)

1. **Two meta-rules in skill-authoring, replacing the self-sealing clauses**
   (delete "Follow the steps, then adapt" and "violating the letter is
   violating the spirit"):
   - _Deviation with disclosure._ Any non-safety rule may be deviated from,
     but the deviation must be declared in the produced artifact — what was
     skipped, why, and what evidence covers the risk (axiom 5: a deviation is
     a commitment; it leaves a receipt the tape can count). Safety-tier rules
     admit no deviation.
   - _Reality beats skill text._ When skill text contradicts observed
     code/runtime evidence, evidence wins; the conflict routes to
     self-improve as a candidate correction. Remove learning-research's
     red-flag row that suppresses doubting stale precedent.
2. **Two-tier rule grammar — the tier is the wording, no new fields.**
   Safety-tier laws (external writes, destructive ops, honesty disclosures,
   permission truth) keep the absolute register. Default-tier laws are
   rewritten conditional: debugging becomes `NO SHIPPED PATCH WITHOUT
CONFIRMED ROOT CAUSE — experimental probes are encouraged: declare the
hypothesis and expected observation, revert after`; learning-research
   becomes consult-or-state-why. Anatomy v3 documents the two registers and
   requires each Iron Law to be classifiable at author time.
3. **Count budgets → evidence conditions.** Template: ci-iteration's `NO
RETRY WITHOUT FRESH EVIDENCE FROM THE LAST ATTEMPT`. Numbers survive only
   as soft self-check triggers ("on the third attempt, ask what is new"),
   never as stops. Red-flag reset semantics change from "return to Phase 1"
   to "repair the violated precondition, then continue".
4. **Debugging specifics** (the most-constrained skill): probe/fix
   distinction per above; "not reproducible" routes to evidence-limited
   investigation (instrumentation, containment, tape/history archaeology)
   instead of Stop; multi-cause explanations are legal ("the smallest set of
   causes that explains the full signal").
5. **Cognition topology → conditional.** review/predict-review adopt the
   repository-analysis form: fan out when slices are independent and the
   parallel budget buys information; single-context is legal with the
   stated reason. Forced dissent is replaced by mandatory falsification
   conditions (already required on `ranked_hypotheses`). Verifier keeps
   "attempt the strongest adversarial probe"; drops "at least one must be"
   when the change class makes adversarial probing meaningless.

### Phase 2 — Scripts and formulas

1. **Retire self-reported-data judgment scripts.** `hypothesis_tracker.py`
   deleted (its discipline moves to two prose lines: every hypothesis carries
   an evidence status; falsification cites a concrete observation).
   `check_scope_drift.py` demoted to informational — it lists files outside
   the declared prefix set; the model must attribute each to the change
   intent or return to plan, and the attribution sentence is the receipt.
   `classify_verifier_verdict.py` and the debate-setup invariant return to
   prose decision tables. Anatomy v3 adds the script-input rule: **a skill
   script must consume information the model does not already possess**
   (world-reading scripts stay; self-report validators do not).
2. **Formulas → anchors.** planning-posture and simplicity-check outputs
   become stated defaults the model may override with a one-line diff reason
   ("formula says complex — 20 mechanical renames, treating as moderate
   because …"). Downstream triggers (learning-research, prep) key on the
   final posture judgment, not the raw formula output, dissolving the F5
   cascade.

### Phase 3 — Retirement loop + per-model strictness (gated on 0–2)

1. **Clause-level exercise receipts.** Deviation declarations, red-flag
   triggers, and rationalization-row hits become countable tape signals;
   `calibration-report` gains a skill-clause section with a zero-firing
   watchlist ("unexercised, not unnecessary" wording applies). Consistent
   with the advisory-receipt decision: the report proposes retirement; the
   retirement itself lands as reviewed skill-text diffs.
2. **Strictness as calibration parameters.** Count-budget values, script
   enforcement, and formula authority become named parameters in the
   optimizer-last-hop calibration registry with per-model profiles: weak-tier
   models keep hard budgets and tracker-style scaffolds; strong-tier models
   get the evidence-condition register. Values change only as reviewed code.
3. **Provenance on rationalization rows.** Each row gains observed-model and
   date; rows unfired across N calibration windows on current-tier models
   enter the retirement watchlist.

## Surface Budget

- Required authored fields: **0 → 0**. Optional authored fields: **0 → 0**
  (the rule tier is expressed by wording register, not frontmatter).
- Author-facing concepts: **net negative** (two meta anti-deviation clauses
  deleted; one add-only-table rule deleted; `hypothesis_tracker.py` and the
  debate-setup invariant retired; `promote.sh`'s `agents` branch removed).
  New concepts: deviation-with-disclosure, the two-tier register, the
  script-input rule — three added against six retired.
- Automated writers of `AGENTS.md`: **1 → 0**.
- Config keys: **0 new** (Phase 3 parameters land in the already-proposed
  calibration registry mechanism, gated on that RFC).
- Inspect surfaces: **0 new** (Phase 3 receipts surface inside the existing
  calibration report).
- Routing / control-plane decision points: **0 new** (receipts are
  observability; nothing gates on them).

## Source Anchors

- Meta genre: `skills/meta/skill-authoring/SKILL.md`,
  `skills/meta/skill-authoring/references/skill-anatomy-v2.md`,
  `skills/meta/skill-authoring/references/authored-behavior.md` (F1).
- Iron Laws / budgets / identity constraints: `skills/core/debugging/SKILL.md`
  (+ `scripts/hypothesis_tracker.py`), `skills/core/implementation/SKILL.md`
  (+ `scripts/check_scope_drift.py`), `skills/core/review/SKILL.md`,
  `skills/domain/predict-review/SKILL.md`, `skills/domain/ci-iteration/SKILL.md`
  (the evidence-condition template), `skills/domain/agent-browser/SKILL.md`,
  `skills/core/learning-research/SKILL.md` (F2–F4, F6, F7).
- Formulas + cascade: `skills/core/plan/invariants/planning-posture.md`,
  `skills/core/prep/invariants/simplicity-check.md`,
  `skills/core/learning-research/SKILL.md` when-to-use, prep do-NOT-use (F5).
- Promotion bypass: `skills/meta/self-improve/scripts/promote.sh` (the
  `agents` case), `skills/meta/self-improve/references/promotion-targets.md`
  ("any of these"), `skills/core/calibration-report/SKILL.md` (the human-review
  boundary claim) (F8).
- Adoption semantics:
  `packages/brewva-gateway/src/hosted/internal/session/skills/skill-adoption.ts`
  (read-class match = adopted),
  `packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.ts`
  (catalog + shortlist escape hatches — the reason selection itself is out of
  scope) (F9).
- Appreciating assets: `skills/core/verifier/references/verification-ladder.md`,
  `skills/project/shared/critical-rules.md`.
- Minor cluster: `skills/domain/goal-loop/invariants/preflight.md`
  (`metric_mechanical`), `skills/domain/frontend-design/references/bento-paradigm.md`,
  `skills/core/office-hours/SKILL.md` Phase 4,
  `packages/brewva-tools/src/families/skills/discover-skills.ts` (F11).

## Validation Signals

- **Confirming (verified in this audit):** every finding above is anchored to
  quoted source; F8's three-way contradiction and F9's opened-vs-followed gap
  reproduce from code; two independent expert reviews converged on F2, F4,
  F6, F7 without coordination.
- **Falsifying / still owed:**
  - _Weak models may genuinely need the hard register._ This is why Phase 3
    is per-model calibration, not deletion — and why Phase 1 rewrites keep
    the strict form recoverable as a profile. The falsifier to watch:
    self-eval completion-rate regression on weak-tier fixtures after Phase 1
    wording lands.
  - _Deviation-with-disclosure may be abused as laundered shortcutting._
    The deviation receipt exists precisely to measure this: a rising
    deviation rate with flat-or-negative outcome quality on the self-eval
    fixtures falsifies the mechanism and argues for re-hardening specific
    clauses.
  - _This RFC's evidence is textual/code analysis, not behavioral A/B._ No
    measurement exists of how often each clause fires, blocks, or mis-blocks
    — that absence is itself finding F10, and Phase 0/3 receipts are the
    remedy. Before/after `report:self-eval` runs on the frozen fixtures are
    the behavior gate for every wording phase.
  - Expert-review base rate: 3 of ~21 external claims failed verification —
    the findings here were re-anchored to source, but a re-read may still
    find over-statement; treat each Phase 1 rewrite as its own review unit.

## Promotion Criteria And Destination Docs

- Phase 0 landed: `promote.sh` has no `AGENTS.md` write path; promotion
  criteria text requires recurrence-or-reviewed; adoption projection and
  trace line renamed `opened` with the conduct ladder recorded on tape.
- Phase 1 landed across `skills/core/**` and `skills/domain/**`: two-tier
  register applied, meta-clauses replaced, count budgets rewritten as
  evidence conditions, debugging probe/fix distinction in place.
- Phase 2 landed: retired scripts removed from skill frontmatter and disk;
  anatomy v3 published with the script-input rule; formula invariants carry
  anchor semantics.
- Behavior gate: `report:self-eval` before/after comparison on the frozen
  fixtures shows no completion-rate regression (weak-tier profile) and
  reduced ritual overhead (fewer tool round-trips per fixture) on the
  default profile.
- Phase 3 (gated): calibration report carries the skill-clause section for
  two consecutive windows; strictness parameters registered.
- On acceptance: ADR in `docs/research/decisions/`; anatomy v3 replaces v2;
  this note archives.

## Non-Goals

- No change to effect governance: approval, capability, sandbox, and
  destructive-op gates stay exactly as hard. Deviation-with-disclosure never
  applies to safety-tier rules and is not an approval bypass.
- No deletion of the skill corpus, and no weakening of the weak-model
  profile before Phase 3 measurement exists.
- No optimizer: retirement stays report-then-reviewed-code per the accepted
  calibration standard.
- No rewrite of reference knowledge content (bento-paradigm is re-labeled
  opt-in recipe with `when_not_to_use`, not rewritten).
- No selection/retrieval overhaul (catalog + `discover_skills` already
  provide the escape hatches; only F9's measurement semantics change).

## Honest Limitations

Textual and code-level evidence only; zero behavioral A/B backing any
individual clause judgment. All three analysis passes (including the
first-hand read) are LLM analyses — the verified expert error rate in this
very audit (3/21) is the standing reminder to re-anchor every claim before
acting on it. The deviation mechanism's behavior on weak models is unknown
until Phase 3 profiles exist; until then Phase 1 wording ships with the
self-eval gate as the tripwire.

## Under The Line

`Govern effects, not thought paths — in the skill text too. Make every hard
rule a safety boundary, every default a calibrated anchor, and every rule
earn its keep on the tape.`
