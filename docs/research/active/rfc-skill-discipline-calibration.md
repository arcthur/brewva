# RFC: Skill Discipline Calibration — Hard Safety Gates, Soft Cognitive Defaults, And Rules That Earn Their Keep

## Metadata

- Status: active
- Kind: RFC (mechanism closures first — the `AGENTS.md` promotion bypass and
  the adoption-measurement honesty gap — then a **piloted** kernel/scaffold
  recalibration of the skill corpus's wording authority, expanded only on
  paired-eval evidence). No new runtime plane; one new authored surface (the
  rule manifest, budgeted below).
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
    method precedent: designed-vs-exercised measurement, reversible demotion
    before deletion, and a taught-arm control. This RFC applies the same
    discipline to the skill corpus's behavioral clauses.
  - [RFC: The Optimizer Last-Hop](./rfc-optimizer-last-hop-fuel-eval-and-parameter-registry.md)
    — supplies the behavior gate (`report:self-eval` with its per-fixture
    post-run oracle) and the registry precedent. Note: the current registry
    carries numeric literals only (`value: number | number[]`); skill-text
    variants do NOT fit it today, which is one reason per-model profiles are
    out of this RFC (see Review Log).
  - External: Anthropic Agent Skills authoring guidance — the description is
    the activation surface and deserves its own should-trigger /
    should-not-trigger evaluation; include only what the model does not
    already know; calibrate constraint strength to task fragility.
- Promotion target:
  - `docs/research/decisions/` — an ADR once Phase 0 lands and the pilot
    paired evaluation reports task-success non-inferiority.
  - `skills/meta/skill-authoring/references/skill-anatomy-v3.md` — landed,
    replacing v2 (the kernel/scaffold anatomy, the three-tier rule grammar,
    the rule manifest, and the validator-authority rule).
  - The pilot skills first (`skills/core/debugging`, `skills/core/review`,
    `skills/core/learning-research`), the rest of the corpus only after the
    pilot gate.

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

The counter-risk is named with equal weight, because the naive fix is worse
than the disease: replacing hard rules with "the model declares why it skipped
them" swaps one failure mode (ossified ritual) for another (self-licensed
shortcutting with no accountable trace). The proposal therefore never trades a
hard rule for an unaccountable soft one: every softening step is paired with
an identity mechanism (rule manifest), an evidence requirement (exceptions
cite evidence, not eloquence), and a paired-eval gate scored on task success.

### Scope boundaries

- **In scope:** skill-text wording authority; judgment scripts shipped with
  skills; the learning-promotion channel (`promote.sh`); adoption-measurement
  semantics (`skill-adoption.ts`); the authoring anatomy that stamps the
  genre; description trigger-quality **measurement** for the pilot skills.
- **Out of scope:** effect governance (approval, capability, sandbox — those
  constrain the world, not thought, and stay exactly as hard); the skills
  discovery/selection **runtime** (catalog + `discover_skills` escape hatches
  exist; their trigger precision/recall is unmeasured — this RFC adds the
  measurement assets, not a retrieval redesign); per-model text-variant
  materialization (see Review Log — deliberately deferred); deleting the
  skill corpus or weakening it ahead of evidence.

## Evidence Base

Four passes, deliberately independent, then cross-checked:

1. **Full-corpus first read.** All 35 SKILL.md bodies, the meta anatomy, the
   shared project rules, key invariants (`planning-posture`,
   `simplicity-check`, goal-loop preflight/outcome), key scripts
   (`hypothesis_tracker.py`, `check_scope_drift.py`), and the verifier ladder.
2. **Two external expert reviews of the corpus** (independent LLM analyses)
   covering the skill text and — uniquely in the second — the runtime chain
   (`skill-selection.ts`, `skill-adoption.ts`, `promote.sh`,
   `promotion-targets.md`, `bento-paradigm.md`).
3. **Claim-by-claim verification** of both reviews against source. Three
   expert-one claims did not survive (frontend-design ignores the greenfield
   exemption; self-improve's 2-occurrence gate misread — single incidents route
   to `knowledge-capture`; workflow-gates misread as per-edit rather than
   per-change-set). Every expert-two runtime claim reproduced, and two were
   worse than claimed (F8, F9 below).
4. **Two external expert reviews of this RFC's first draft**, again verified
   against source before absorption — three repo-fact spot-checks all
   confirmed (the self-eval oracle exists and grades `task_passed` /
   `task_failed`; `promote.sh` has zero automated callers; the calibration
   registry carries numeric literals only). Their corrections reshaped the
   proposal; the Review Log section records what was absorbed and what was
   pushed back.

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

### F3 — Self-reported-data scripts claim authority they cannot earn

The first filter for a skill script: **does its input contain any information
the model does not already possess?** Perception scripts pass —
`parse_ci_state.sh` reads real CI, `locate_session_artifacts.sh` reads the
real filesystem, `verification_record`'s static guards run on real source
("the grade is earned by the predicate RUNNING"). Self-report scripts fail
it: `hypothesis_tracker.py` validates a JSON array the model itself authored
(checking only format — a non-empty `evidence` string passes regardless of
quality — and clamping `max_active` to a hard 3), `check_scope_drift.py`
adjudicates the semantic question "is this file part of the change?" by path
prefix (a shared helper outside the target list forces a full
return-to-plan; an unrelated edit inside a target directory passes), and
`classify_verifier_verdict.py` computes a three-row decision table from
model-supplied counts.

Input novelty is not the whole rule, though (see Review Log): a self-report
validator can still provide durable state externalization and format
consistency across turns and agents — value that is real but categorically
weaker than evidence. The governing principle is therefore an **authority
ceiling**: a validator over self-reported data may serve as advisory lint,
but may never be cited as independent evidence, never gate a phase
transition, and never solely decide a high-impact verdict. Today's scripts
violate the ceiling (drift verdicts force a return-to-plan; the tracker's
escalation signal ends investigations), and none of them currently persists
state — the externalization value is hypothetical until one does.

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

Threat model, stated precisely: the script has **zero automated callers**
(verified by repo-wide grep) — it is an unreviewed promotion **primitive**,
armed whenever a model holds `local_exec` inside a self-improve flow or an
operator runs it as documented, not a standing automated writer. Even as a
primitive it contradicts three standing authorities at once: (a) the accepted
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
skills opened and ignored count as adopted (keep signal for a dead one).

The causality gap runs deeper than the name: tool events carry no
`selectionId`, so even "opened" is a temporal join, and any richer
"conduct" claim built from artifact presence would still be a correlation
(the artifact may predate the selection, come from a fallback path, or
belong to another skill). Honest levels, in order of what the tape can
support today: `offered` (receipt-backed), `opened` (temporal join),
`conduct` (**requires** a receipt that binds `selectionId` + rule/skill
identity + the producer artifact — a runtime change, not a projection
tweak). The corpus's own standard — "a receipt or advisory surface is not
shipped until a liveness fitness asserts a canonical run emits it" — is not
met above `opened` today.

### F10 — No reality-arbitration rule; accumulation without retirement

Nothing in the corpus says what happens when skill text contradicts observed
code/runtime reality. Skills embed decaying facts (tape paths, "#1 hidden
root cause" experience claims) in invariant register, and learning-research
even red-flags the thought "The precedent is probably outdated so I'll ignore
it" — suppressing the correct response to a stale precedent. Combined with
F1's add-only rationalization tables and F8's open intake, the corpus has an
entry ratchet and no exit: nothing measures whether a clause ever fires, and
nothing retires one that stops earning its keep (axiom 3). The arbitration
rule must itself be tiered, though — observation can refute a **descriptive**
claim, but a **normative** rule being widely violated in code is not evidence
the rule is wrong (the code may be the regression); see the Review Log.

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

## Review Log — 2026-07-13 (two external reviews of the first draft)

Both reviewers accepted the diagnosis (F1, F8, F9 called out as strong) and
converged, independently, on four structural defects in the first draft's
proposal. All four are absorbed; two pushbacks are recorded at the end.

- **Sequencing contradiction (both reviewers, P0).** The draft softened the
  shared corpus in its Phase 1, deleted strict-era scripts in Phase 2, and
  promised weak-model protection via per-model profiles in Phase 3 — but no
  model-aware variant selection exists, and the calibration registry carries
  numeric literals only (verified: `CalibrationParameter.value: number |
number[]`). Softening the single shared text would strip weak-model
  protection with nothing to restore it from. **Absorbed:** strict material
  is never deleted — it is _relocated_ into per-skill scaffold references
  (the lazy-loading layer that already exists), the rewrite runs on 2–3
  pilot skills only, and per-model profile machinery is deferred out of this
  RFC entirely (its own design problem: profile identity, unknown-model
  fallback, variant storage, selection provenance).
- **Unaccountable deviation (both reviewers, P0).** The draft's
  deviation-with-disclosure was free text with no stable clause identity —
  unfired would conflate "not applicable", "complied", and "silently
  skipped"; the receipts Phase 3 wanted to count could not be counted. This
  reproduced, inside the proposal, the exact self-report defect F3/F9
  diagnose. **Absorbed:** a minimal **rule manifest** (stable `ruleId`, tier,
  exception-evidence class) becomes the precondition for any softening;
  disclosures must cite a `ruleId` and attach evidence, making them
  deterministically countable from the tape; the zero-new-authored-surface
  claim is honestly withdrawn (Surface Budget below carries the debt).
- **Two tiers are not enough (reviewer one).** Safety/default collapses two
  different non-safety cases: high-impact cognitive processes (release,
  complex debugging, cross-package migration) where an exception needs
  _evidence_, and low-impact heuristics (fanout width, retrieval depth,
  hypothesis count) where mandatory disclosure would just be new ritual.
  **Absorbed:** three tiers — `non-negotiable` / `controlled-exception` /
  `adaptive-heuristic` (see proposal).
- **Wrong primary gate metric (reviewer one).** "No completion-rate
  regression + fewer tool round-trips" can reward skipped investigation.
  Verified: `report:self-eval` already grades `task_passed` / `task_failed`
  through a deterministic post-run oracle over the final workspace —
  completion and task success are separate axes by design. **Absorbed:** the
  gate leads with oracle-graded task-success non-inferiority (strong- and
  weak-tier fixtures, paired, with repetitions and a declared threshold);
  round-trip cost is secondary and only counts as improvement at equal task
  success.
- **"Reality beats skill text" over-broad (both reviewers).** Observation may
  refute descriptive claims; a violated normative rule is not thereby wrong —
  the code may be the regression, and derived projections can lie.
  **Absorbed:** two-lane arbitration (descriptive → evidence wins + report;
  normative → conflict escalates, never auto-overridden).
- **Smaller corrections absorbed:** F8's threat model restated as an
  unreviewed primitive, not an automated writer (zero callers verified);
  `conduct_observed` demoted from Phase 0 to a gated design sketch pending
  `selectionId` receipt binding (F9); the promotion-candidate lane aligned to
  the existing RDP candidate pattern (`.brewva/knowledge/rdp/` —
  files-for-human-review) instead of overloading the harness ledger, whose
  payload is manifest deltas; "text-layer first" framing corrected to
  mechanism-first; `skills/meta/**` added to the rewrite acceptance scope;
  the draft's unmeasured "selection escape hatches are adequate" claim
  replaced with trigger-quality measurement assets for the pilots.
- **Pushback 1 (partial):** reviewer one defended self-report validators as
  state externalization against context loss. Real in principle — but none of
  today's scripts persists state (stdin→stdout), so that value is
  hypothetical until one does. Resolution: F3 keeps input-novelty as the
  first filter, adds the authority ceiling as the governing rule, and leaves
  each script's fate to the scaffold's paired eval instead of decreeing
  deletion.
- **Pushback 2 (partial):** reviewer two read the draft's selection-scope
  exclusion as contradicting the kernel goal (description quality is
  in-corpus). Resolution: description trigger-quality measurement joins the
  pilot (should-trigger / should-not-trigger query sets per pilot skill); the
  selection **runtime** stays out of scope — no retrieval redesign here.

## Decision Options

- **Option A — Kernel/scaffold split, piloted, paired-eval gated
  (recommended; absorbed from review).** Close the two mechanism gaps, build
  rule identity + eval assets, rewrite 2–3 pilot skills into kernel +
  relocated strict scaffold, expand only on task-success non-inferiority.
  Detailed below.
- **Option B — Deterministic fixes and measurement only.** Land Phase 0 and
  the eval assets; do not touch skill bodies. Lowest risk, preserves the
  ritual cost indefinitely; kept as the fallback if the pilot gate fails.
- **Option C — Per-model strictness profiles as the primary mechanism.**
  Rejected for this RFC: requires profile identity, unknown-model fallback,
  variant storage, selection provenance, and registry type expansion — a new
  runtime plane this RFC explicitly does not open. Revisit as its own RFC
  only if the pilot shows the strict scaffold helps weak tiers while taxing
  strong tiers.

## Proposal (Option A)

### The target anatomy (v3): kernel / scaffold / capability, with a rule manifest

- **Kernel** (SKILL.md body, short and stable): the description (trigger
  surface), non-derivable domain and project facts, external-effect gates,
  honesty contracts, handoff expectations, and outcome boundaries. What a
  strong model needs and cannot know.
- **Scaffold** (per-skill `references/` files, lazy-loaded as today):
  observed-deficit countermeasures — step workflows, count budgets,
  rationalization tables, detailed checklists, and the strict-era material
  relocated (never deleted) from kernels. Each scaffold names the failure
  mode it counters and carries an eval contract: it earns default-loading
  only while the paired eval shows it helps.
- **Deterministic capability** (`scripts/`): world-reading or
  world-transforming code, unchanged. Self-report validators live under the
  authority ceiling (advisory lint at most — never independent evidence,
  never a phase gate, never sole verdict authority).
- **Rule manifest** (the one new authored surface): each pilot skill's rules
  get a stable `ruleId`, a tier, and — for controlled exceptions — the
  evidence class an exception must cite. Kept in a structured block the
  anatomy validator can extract, so receipts, calibration, and any future
  profile all have identity to bind to.

Three tiers replace the draft's two:

1. `non-negotiable` — permissions, external side effects, secrets, persisted
   formats, honesty-of-claims. No self-exemption; wording stays absolute.
2. `controlled-exception` — high-impact cognitive process rules (root-cause
   before a shipped fix, precedent consult before high-risk planning,
   independent review before release). Exceptions are legal but must cite
   the `ruleId` plus the manifest's required evidence class (or explicit
   operator approval) — an exception needs evidence, not eloquence.
3. `adaptive-heuristic` — fanout width, retrieval depth, hypothesis count,
   browse step budgets. The model tunes freely; skills state the default and
   why. No mandatory disclosure (that would be new ritual); exercised values
   are observable from the tape where they matter.

### Phase 0 — Close the mechanism gaps (deterministic, immediate)

1. **Retire the `AGENTS.md` direct-write path.** `promote.sh agents` stops
   appending; it emits a promotion candidate for human review, following the
   existing RDP candidate pattern (files under a candidates directory, never
   active records — the harness ledger is not reused; its payload is
   manifest deltas, not learning text). Rewrite `promotion-targets.md`
   criteria from "any of these" to recurrence-or-reviewed: repeated evidence
   per self-improve's own Iron Law, or an explicit human instruction that
   still lands as a reviewed diff. Candidates carry scope, provenance, and a
   re-evaluation trigger.
2. **Rename adoption → opened.** The projection and trace line say what they
   measure (a temporal join, per F9). No conduct metric ships in this phase:
   anything beyond `opened` waits for receipt-level causality
   (`selectionId` bound into producer-artifact receipts — a runtime design
   of its own, sketched in F9 and deliberately not promised here).

### Phase 1 — Identity and measurement assets (before any rewrite)

1. **Rule manifest for the pilot skills** (`debugging`, `review`,
   `learning-research`): every Iron Law, red flag, and budget gets a
   `ruleId` + tier + exception-evidence class. A docs fitness validates
   manifest shape and tier vocabulary.
2. **Trigger-quality sets:** should-trigger / should-not-trigger query sets
   per pilot skill (the description is the activation surface; measure it,
   don't assume it).
3. **Eval extension:** pilot-targeted fixtures in `report:self-eval`
   covering what the generic five cannot — a review task, a stale-precedent
   trap, a non-reproducible failure, and a deviation-laundering probe (a
   tempting shortcut where the correct behavior is a cited exception, the
   wrong one a silent skip). Report gains paired comparison (same fixture,
   same model, wording variants), repetition counts, and a declared
   non-inferiority threshold on oracle task-success.

### Phase 2 — Pilot rewrite (2–3 skills, kernel + scaffold)

1. Rewrite the pilot skills into the v3 anatomy: kernel keeps facts, gates,
   and honesty contracts; strict workflows/budgets/tables relocate into
   scaffold references (loaded by default initially — the eval decides
   whether default-loading survives); rules annotated per the manifest.
2. Apply the wording corrections inside the pilots: meta-clauses replaced
   (delete "Follow the steps, then adapt" and letter=spirit; add
   deviation-with-evidence for `controlled-exception` rules and the two-lane
   reality-arbitration rule — descriptive claims yield to evidence,
   normative conflicts escalate); count budgets → evidence conditions
   (ci-iteration's Iron Law as the template); debugging gains the probe/fix
   distinction, the evidence-limited path for non-reproducible failures, and
   multi-cause explanations; "return to Phase 1" → "repair the violated
   precondition, then continue"; review/predict-review fanout and dissent
   become conditional on evidence independence, with falsification
   conditions replacing manufactured disagreement.
3. `skills/meta/skill-authoring/**` updates land here too (anatomy v3, the
   authority ceiling, the three-tier grammar) — the meta layer is in the
   acceptance scope, not an afterthought.

### Phase 3 — Gate, expand, and only then retire

1. **The pilot gate:** three-arm paired eval per pilot skill — no-skill /
   kernel-only / kernel+scaffold — on strong- and weak-tier fixtures.
   Primary metric: oracle task-success non-inferiority (declared threshold,
   paired runs, repetitions reported). Secondary: safety/honesty failure
   count (never worse), then round-trip cost. A weak-tier regression on
   kernel-only keeps the scaffold default-loaded; a strong-tier tax from the
   scaffold demotes it to on-demand for that skill.
2. **Corpus expansion** only after the gate passes, skill by skill, same
   mechanics.
3. **Retirement semantics** (replacing the draft's zero-firing watchlist):
   a clause is retirement-eligible only with (a) an eligible-opportunity
   denominator (fixtures or tape situations where it _could_ have fired),
   (b) behavior receipts distinguishing complied / excepted-with-evidence /
   not-applicable, and (c) an outcome delta at equal task success. Zero
   observations alone are never deletion evidence ("unexercised, not
   unnecessary"). Retirement lands as reviewed skill-text diffs via the
   calibration report's proposal lane, per the accepted standard.

## Surface Budget

- Required authored fields: **0 → 0**.
- Optional authored fields / author-facing concepts: **+1** — the rule
  manifest block (`ruleId`, tier, exception-evidence class) on pilot skills,
  extending to the corpus only with the expansion. This is a real positive
  delta, accepted because clause-level accounting is impossible without
  identity (the first draft's "the tier is the wording" claimed zero surface
  and was rightly rejected in review as unaccountable). Debt owner:
  skills-catalog maintainers; re-evaluation trigger: the Phase 3 pilot gate —
  if the manifest's receipts are not consulted by then, the manifest is
  itself retirement-eligible.
- Offsetting retirements: two meta anti-deviation clauses deleted; the
  add-only rationalization-table rule deleted; `promote.sh`'s `agents`
  branch removed; self-report scripts stripped of gate authority (three
  fewer mandatory tool round-trips on the pilot paths).
- Unreviewed write primitives targeting `AGENTS.md`: **1 → 0**.
- Config keys: **0 new**. Runtime planes: **0 new** (profiles deferred; the
  conduct receipt explicitly not promised here).
- Inspect surfaces: **0 new** (receipts surface inside the existing
  calibration report).

## Source Anchors

- Meta genre: `skills/meta/skill-authoring/SKILL.md`,
  `skills/meta/skill-authoring/references/skill-anatomy-v3.md` (v2 at audit
  time), `skills/meta/skill-authoring/references/authored-behavior.md` (F1).
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
  `packages/brewva-gateway/src/hosted/internal/session/skills/skill-projections.ts`
  (named `skill-adoption.ts` at audit time; read-class match = opened, no
  `selectionId` on tool events),
  `packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.ts`
  (catalog + shortlist escape hatches) (F9).
- Behavior gate: `test/eval/self-eval/oracle.ts`,
  `test/eval/self-eval/types.ts` (`task_passed` / `task_failed` /
  `terminal_incomplete`; completion and task success are separate axes).
- Registry limits: `packages/brewva-runtime/src/governance/calibration-registry.ts`
  (`value: number | readonly number[]` — numeric literals only).
- Appreciating assets: `skills/core/verifier/references/verification-ladder.md`,
  `skills/project/shared/critical-rules.md`.
- Minor cluster: `skills/domain/goal-loop/invariants/preflight.md`
  (`metric_mechanical`), `skills/domain/frontend-design/references/bento-paradigm.md`,
  `skills/core/office-hours/SKILL.md` Phase 4,
  `packages/brewva-tools/src/families/skills/discover-skills.ts` (F11).

## Validation Signals

- **Confirming (verified in this audit and its reviews):** every finding is
  anchored to quoted source; F8's three-way contradiction, F9's
  opened-vs-followed gap, the oracle's existence, the registry's
  numeric-only shape, and promote.sh's zero callers all reproduce from code;
  two corpus reviews converged on F2/F4/F6/F7 and two RFC reviews converged
  on the four structural defects — all without coordination.
- **Falsifying / still owed:**
  - _Weak models may genuinely need the strict scaffold._ The pilot's
    weak-tier arm answers this before anything expands; a kernel-only
    regression keeps the scaffold default-loaded (and would validate keeping
    strict material relocatable rather than deleted).
  - _Deviation-with-evidence may still be laundered._ The
    deviation-laundering fixture probes exactly this; a cited `ruleId` with
    fabricated evidence is measurable against the oracle (the task fails, or
    the honesty check does — either way it lands in the paired report).
  - _The rule manifest may be dead weight._ Its own re-evaluation trigger is
    declared in the Surface Budget: unconsulted receipts by the pilot gate
    make the manifest retirement-eligible.
  - _The pilot may be unrepresentative._ Three skills, chosen for maximum
    constraint density, not randomness; expansion stays skill-by-skill with
    the same gate rather than a bulk rewrite.

## Landing Log — 2026-07-14 (Phases 0–2 implemented on this branch)

Phases 0, 1, and 2 landed as code on `claude/rfc-skill-discipline-calibration`;
Phase 3 (the live paired gate and any expansion/retirement) remains open —
it needs provider runs, which is exactly what the landed assets exist to feed.

- **Phase 0.** `promote.sh agents` emits a reviewable candidate under
  `.brewva/learnings/candidates/` (qualification checklist, provenance,
  re-evaluation date; the never-matching status-update awk fixed in passing);
  `promotion-targets.md` criteria are recurrence-or-reviewed. The projection
  renamed: `skill-adoption.ts` → `skill-projections.ts`,
  `projectLatestSkillOpened` / `SkillOpenedSample` / `Previous Selection
Opened` trace line, with the module header documenting the `selectionId`
  receipt binding a real conduct metric would need. Delegation-domain
  adoption vocabulary untouched.
- **Phase 1.** Rule manifests landed in the three pilot kernels and are
  enforced twice: `quick_validate.py` (authoring side) and
  `test/fitness/skills/skill-rule-manifest.fitness.test.ts` (repo gate:
  grammar, skill-name prefix, tier vocabulary, exception-evidence presence,
  global ruleId uniqueness, pilot coverage pin). Trigger-quality sets landed
  as `test/fitness/skills/skill-trigger-quality.fitness.test.ts` —
  should-trigger / should-not-trigger queries scored with the exact
  `discover_skills` text shape + TF-IDF ranking, green on the real catalog.
  The eval side landed four pilot fixtures (`review-seeded-defect` with the
  new `review_response` oracle, `stale-precedent-fix`,
  `nonrepro-incident-fix`, `symptom-patch-temptation`) each with
  discriminative-power unit tests proving the oracle passes the genuine fix
  and fails the tempting shortcut; `report:self-eval:compare` implements the
  paired comparison (per-fixture pairing, declared non-inferiority margin
  0.1, min 10 paired runs per side, `inconclusive` under that — never a
  silent pass; tool-call cost secondary).
- **Phase 2.** Anatomy v3 replaced v2 (kernel/scaffold, rule-manifest
  grammar, wording registers, validator authority ceiling, provenance-carrying
  rationalization tables); `authored-behavior.md` carries
  deviation-with-evidence and two-lane reality arbitration, with the
  letter-compliance clauses deleted and the layout fitness sentinel moved to
  the new rule. The three pilot kernels rewrote to v3 with strict material
  relocated into `references/strict-protocol.md` scaffolds (failure-mode
  preamble + three-arm eval contract); `check-skill-dod.sh` and
  `quick_validate.py` moved to v3 required-section sets; `calibration-report`
  gained its missing kernel sections in passing.
- **Verification at landing:** `bun run check` green; skills gates green
  (DoD pass over 35 skills, layout + rule-manifest + trigger-quality
  fitness, quick_validate contract tests); eval unit suite green including
  the fixture discriminative-power tests. Full-suite and docs-gate results
  are recorded in the landing commits.

## Promotion Criteria And Destination Docs

- Phase 0 landed: `promote.sh` has no `AGENTS.md` write path; promotion
  criteria text requires recurrence-or-reviewed; the adoption projection and
  trace line say `opened`.
- Phase 1 landed: rule manifests + docs fitness on the three pilots;
  trigger-quality sets recorded; self-eval extended with the pilot fixtures,
  paired comparison, and the declared non-inferiority threshold.
- Phase 2 landed: pilot skills rewritten to v3 anatomy (kernel + relocated
  scaffold, three-tier manifest); `skills/meta/skill-authoring/**` carries
  anatomy v3, the authority ceiling, and the arbitration rule.
- Phase 3 gate reported: three-arm paired eval on strong- and weak-tier
  fixtures with oracle task-success non-inferior, safety/honesty failures
  not worse, and round-trip deltas reported alongside.
- On acceptance: ADR in `docs/research/decisions/`; anatomy v3 replaces v2;
  corpus expansion proceeds under the same gate; this note archives.

## Non-Goals

- No change to effect governance: approval, capability, sandbox, and
  destructive-op gates stay exactly as hard. Exceptions never apply to
  `non-negotiable` rules and are not an approval bypass.
- No bulk corpus rewrite ahead of the pilot gate, and no deletion of strict
  material — relocation into scaffolds only.
- No per-model profile runtime in this RFC (profile identity, fallback,
  variant storage, and provenance are a separate design; the registry's
  numeric-only shape is a hard boundary today).
- No conduct-level adoption metric before receipt-level causality exists.
- No optimizer: retirement stays report-then-reviewed-code per the accepted
  calibration standard.
- No retrieval/selection runtime redesign (measurement assets only).
- No rewrite of reference knowledge content (bento-paradigm is re-labeled
  opt-in recipe with `when_not_to_use`, not rewritten).

## Honest Limitations

Textual and code-level evidence only; zero behavioral A/B backing any
individual clause judgment until Phase 1's eval assets exist — which is why
nothing irreversible happens before Phase 3's gate, and why Phase 0 contains
only deterministic mechanism fixes. All analysis passes, including the
first-hand read and both review rounds, are LLM analyses; the verified error
rates (3/21 corpus-review claims, four structural defects in this RFC's own
first draft) are the standing reminder that each rewrite lands as its own
reviewed unit. The deviation mechanism's behavior on weak models is unknown
until the pilot runs it; the strict scaffold stays default-loaded until then.

## Under The Line

`Govern effects, not thought paths — in the skill text too. Every hard rule a
safety boundary, every default a calibrated anchor, every exception carrying
evidence instead of eloquence — and every rule earning its keep on the tape.`
