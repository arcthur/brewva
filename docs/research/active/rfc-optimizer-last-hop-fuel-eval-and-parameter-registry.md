# RFC: The Optimizer Last-Hop — Unattended-Run Approval Provenance, In-Repo Self-Eval, And The Calibration Parameter Registry

## Metadata

- Status: active
- Kind: RFC (the landing plan for the forward half that
  [RFC: Tool-Surface Subtraction](./rfc-tool-surface-subtraction.md) recorded as
  a gated note — fuel, utility function, and the first safe action surface for
  the self-improvement loop). Not a new plane, and explicitly not an optimizer.
- Owner: gateway control-plane / calibration maintainers
- Last reviewed: `2026-07-12`
- Depends on / relates to:
  - [RFC: Tool-Surface Subtraction](./rfc-tool-surface-subtraction.md) — its
    forward half names the three steps this RFC turns into phases; its
    measurement recipe is the seed of Phase 2.
  - [Decision: Advisory Heuristics Carry Receipts And Offline Calibration, Not A Meta-Optimizer](../decisions/advisory-receipt-and-calibration-standard.md)
    — binding case law: recipes derive reports, never rule changes; this RFC
    keeps every output a proposal under that governed-promotion boundary.
  - [Decision: Iteration Facts And Model-Native Optimization Protocols](../decisions/iteration-facts-and-model-native-optimization-protocols.md)
    — `Brewva is substrate, not optimizer`; unchanged here.
  - [Decision: Schedule Intent Hardening](../decisions/schedule-intent-hardening-and-control-plane-ergonomics.md)
    and the provenance-authorized envelope
    (`packages/brewva-gateway/src/daemon/session-supervisor/turn-envelope.ts`)
    — the `origin: config_policy` stamp Phase 1 generalizes.
  - [Candidate Axiom: Accounting For Unmeasurable Benefit](./candidate-axiom-accounting-for-unmeasurable-benefit.md)
    — Phases 2 + 3 are designed to become its second-ring instance.
  - [Design Axioms](../../architecture/design-axioms.md) — axioms 1, 3, 5, 7,
    9, 18, 19.
- Promotion target:
  - `docs/research/decisions/` — one ADR per landed phase, or one combined ADR
    if the phases land as a single arc.
  - `docs/architecture/system-architecture.md` — a named self-improvement-loop
    section, so the calibration/promotion machinery gains architecture-level
    visibility (today `promotion` appears once and `calibration` zero times in
    `docs/architecture/*.md`).

## Problem Statement

A 2026-07-11 alignment audit read the constitution, the architecture docs, the
improvement-loop decisions, and the kernel/control-plane code against the
harness-engineering thesis the tool-surface RFC already tests (Lilian Weng,
2026-07-04): harness value migrates from heuristic rules toward general
mechanisms, and a mature harness runs a self-improvement loop whose permission
layer stays outside the loop.

The audit's headline: the loop's **machinery is built and guarded** — six
receipt-bearing improvement loops exist (advisory calibration, harness
candidates, learnings promotion, the `schedule.selfImprove` heartbeat,
independent review, RDP), authorship is structurally isolated, the freeze
surface fails closed, and subtraction case law shows the system already sheds
crystallized heuristics on tape evidence. What breaks the loop is not
machinery; it is three specific absences:

1. **Fuel.** The calibration corpus is starved. The accepted calibration
   standard itself records that eight single-task sessions "cannot power
   held-out validation" and that zero-firing surfaces may not be retuned. The
   structural cause is that unattended sessions cannot finish real work: both
   `--print` backends suspend on the first `exec`
   (`runtime.suspended`, `cause=approval_pending`) with no config path to
   decide, so tool-using corpora must be babysat.
2. **A utility function.** Fitness tests prove structural invariants, not
   outcome quality. The n=12 measurement that justified the tool-surface
   subtraction was an ad-hoc recipe (isolated workspaces + tape reads + sqlite
   queries), not a repeatable in-repo evaluation. Until "did this harness
   change help" is machine-answerable, every optimizer-shaped ambition is
   correctly blocked — a feedback loop without a decidability condition is
   random control.
3. **A named action surface.** Behavior constants are asserted, not
   calibrated: `predictedTurnGrowthRatio: 0.175`, `tailProtectRatio: 0.2`,
   `advisoryRatio: 0.82`, two divergent recall freshness scales (30/180-day
   tape vs 90/365-day knowledge), a 45-day curation half-life, and
   trigger-thresholds of 2 and 3 across recovery/recurrence/stall advisories.
   They are measured by receipts but no artifact declares which parameters are
   calibration-eligible, so patrol reports observe a heuristic no one is
   authorized to move — measured dead water.

### Scope boundaries

- **In scope:** unattended-run approval provenance (fuel), an in-repo
  self-eval report job (utility), a declarative calibration parameter registry
  (action surface), and a demand-gated backpressure note for the proposal
  lane.
- **Out of scope:** building any optimizer or auto-tuner; touching the D6
  freeze surface (permission/credential/approval semantics, tape/WAL schemas,
  evaluator definitions and held-out splits, promotion authority, world
  isolation); repairing the architecture-vocabulary debts the same audit filed
  (ring-classification drift, phase-vocabulary mapping, compaction-trigger
  ownership prose) — those are a separate architecture-doc precision pass.

## Phase 1 — Unattended-Run Approval Provenance (fuel) — AS BUILT

Landed. An unattended `--print` run answers its own tool-call approvals within
an operator-declared effect-class envelope instead of suspending forever. The
build reuses the governed-envelope primitive the schedule and delegation lanes
already share, rather than paralleling the schedule lane's forgery-defense
machinery — that machinery guards a model-mintable intent id in a replayable
map, a threat that does not exist for a policy read once from deep-readonly
config.

Shape as built:

- **Config surface.** `security.unattendedApproval`, a
  `Partial<Record<ToolEffectClass, "allow" | "deny">>`
  (`UnattendedApprovalPolicy` in
  `packages/brewva-runtime/src/governance/policy-types.ts`). Empty by default,
  so every effectful tool suspends exactly as today. `allow` auto-accepts;
  `deny` auto-denies (the run continues, tool refused); a class ABSENT suspends
  for a human (fail-closed) — absence is the implicit "ask", so the value set is
  deliberately `allow`/`deny`, not the kernel's `allow`/`ask`/`deny`. Keyed by
  `ToolEffectClass` (the effect a call will have) because the decision is made at
  the pending-approval boundary where projected effect classes are visible —
  distinct from `actionAdmissionOverrides` (`ToolActionClass`), which retunes
  kernel admission at a different stage.
- **Decision.** `decideUnattendedApproval` folds a call's effect classes with
  precedence `suspend > deny > allow`: any unlisted (or non-`allow`/`deny`)
  class → suspend; else any denied class → deny; else accept. An empty effect
  set never auto-accepts.
- **Envelope.** The generic `resumeApprovalsWithinEnvelope` (moved to
  `hosted/internal/turn/`, now shared by the schedule worker, delegation
  orchestrator, and this lane) takes an optional `decide` predicate; the
  capability-scoped schedule/delegation callers pass none and keep accept-all,
  the unattended lane passes the config-derived decider. Any `suspend` decision
  halts the loop fail-closed with no partial application; the resume cap (32) is
  unchanged.
- **Provenance / receipt.** Each auto-decision records the existing approval
  receipt through `kernel.recordApprovalDecision` with actor
  `unattended-config-policy` — no new persisted field, mirroring the
  `schedule-envelope` / `delegation-envelope` actors. The RUNNING snapshot is
  unforgeable by construction: the resolved policy is read from `runtime.config`
  (deep-readonly) with no prompt/skill/tape input channel, so the model cannot
  mutate the policy in flight. But that protects the snapshot, not its SOURCE —
  the hardening below closes the source gap.
- **Backend routing.** The in-loop approval seam lives in the embedded print
  runner (`runCliTurn`). A `--print` run defaults to `--backend auto` and
  prefers a running gateway daemon, whose worker only auto-resolves the schedule
  lane; so a policy-bearing run is routed to the embedded backend (mirroring the
  existing `taskSpec → embedded` precedent, with the same `[backend]`
  diagnostic), and an explicit `--backend gateway` with an active policy errors
  rather than silently ignoring it. The policy therefore always takes effect on
  the path that can honor it — the path the Phase 2 self-eval fuel loop uses.
  **Scoped follow-up:** native unattended support inside the gateway
  daemon/worker path needs the daemon to thread the client's unattended mode
  through to the worker's envelope gate; the daemon does not track client mode
  today, so it is a separate, larger surface deferred out of Phase 1 rather than
  a silent gap.
- **Operator-source barrier + turn scope + non-zero on unconverged (review
  hardening).** The "model cannot widen" guarantee protects only the running
  snapshot, not its source: an `unattendedApproval` in a model-writable config
  is unsafe because a child `brewva` can re-read it. The loader strips policy
  from any source whose logical path or canonical target is inside the active
  workspace; for an explicit `--config` (the one caller-steerable source) it
  additionally rejects any spelling that lives in **any detected workspace
  tree**, closing both an outside symlink into a workspace and a child that
  changes cwd before pointing `--config` at a different workspace. The
  auto-resolved global config stays an operator source — operator-owned by
  construction, so it is honored even when the operator version-controls their
  config directory (a git-tracked `~/.config`). The embedded print lane mints
  one UUID-backed `turnId`
  for its checkpoint, initial run, and every resume; the envelope then decides
  only pending approvals carrying that exact `turnId`, leaving prior, concurrent,
  and legacy requests without correlation for a human. A `--print` run that ends
  still suspended (cap-exhausted — now surfaced as `capExhausted` — or
  fail-closed) exits non-zero, matching the worker path that projects an
  unconverged turn as failed, rather than exiting 0 on incomplete work. One
  residual the barrier does NOT close: granting `local_exec` is host command
  execution, broader than any brewva tool-effect gate — do not put it in an
  unattended envelope for a model you would not trust with a shell, and prefer a
  sandboxed backend for untrusted runs.

This is the Weng constraint made concrete: the loop may contain approval
**execution**, never approval **policy authorship**. It is also the first real
precedent for axiom 9 (`Resource expansion is negotiated, not assumed`) —
previously the only axiom with zero enforcing rules and zero precedent
decisions: an unattended run negotiates its authority envelope through declared
config instead of assuming it. The Phase 1 ADR (a companion task) records this.

## Phase 2 — In-Repo Self-Eval (the utility function) — AS BUILT

Landed. The tool-surface RFC's ad-hoc measurement recipe is now a repeatable
report job, `report:self-eval` (sibling of `report:context-evidence`,
implemented under `test/eval/self-eval/` beside the other evaluator
definitions). Shape as built:

- **Frozen evaluator core.** `extractSelfEvalRunMetrics`
  (`test/eval/self-eval/metrics.ts`) is a pure function over a run's committed
  tape → `{distinctTools, perFamilyCounts, turnCount, terminalOutcome, cost?}`.
  Determinism given the same events IS the repeatability gate: the structural
  fields depend on nothing but tape order. It reads only `tool.committed` (the
  same "a tool ran" signal `analyze:advisory-receipts` scores), never
  `tool.proposed`/`started`. `terminalOutcome` reads the CANONICAL tape tail —
  the `turn.ended` `status` field (its `cause` is always `terminal_commit`, so
  the status, absent on success, is the real signal) and an unresolved
  `runtime.suspended{approval_pending}` — separating `completed` /
  `suspended_for_approval` / `incomplete`, the Phase-1 chain made observable.
  This is TURN LIVENESS — how the turn ended, not whether the task succeeded; a
  `completed` turn only means the model stopped cleanly. Task SUCCESS is a
  separate signal from the post-run oracle (below), so a model that ends its turn
  without fixing the bug, with a wrong fix, or claiming a success it did not
  achieve scores `task_failed`, not `completed`.
- **Driver.** `driveSelfEvalRun` (`test/eval/self-eval/driver.ts`) spawns one
  hermetic `brewva --json --backend embedded` turn per fixture (JSON mode so the
  per-run cost summary lands on stdout as a `brewva_event_bundle`), through the
  shared `test/eval/print-turn.ts` spawn the generic executor now also uses and
  the shared `test/eval/workspace-staging.ts` staging. It then reads the run's
  durable `.brewva/tape/*.jsonl` RAW — not the runtime.ops-operational remap,
  which would fold the advisory empty-payload `turn.ended`/`turn.started`
  duplicates onto the canonical ones and misscore a completed run. Unlike the
  generic executor a non-zero exit is a diagnostic, not a throw — a fail-closed
  suspend is a valid, readable outcome. `collectRunOutcome` is split out so the
  read/collect path is unit-tested without a provider. Cost is a separate
  observation read from that stdout cost bundle (never a fabricated tape event —
  the tape does not carry per-run cost).
- **Fixtures (frozen, D6).** Five build/debug/comprehension tasks
  (`test/eval/self-eval/fixtures.ts`) seeded from the n=12 recipe, each small
  and self-contained (`bun test`, zero external deps). Each DECLARES an
  `operatorApprovalPolicy` (local-dev
  `workspace_read`/`workspace_write`/`local_exec` allow; external classes
  uncovered → fail-closed) that the driver delivers from OUTSIDE the workspace —
  the operator-source barrier, since a workspace-internal policy is model-writable
  and would be stripped — plus a post-run `oracle`. They are DATA off the
  candidate optimizable allowlist, so the yardstick is not candidate-mutable.
  The model receives only task inputs: fixed command verifier files are materialized
  in a fresh directory after its process exits, alongside only declared subject
  files copied from the final workspace. A rewritten workspace test, a vacuous
  model-authored test, symlinked subject, or undeclared support file cannot grade
  the task.
- **Post-run oracle (task success).** `runFixtureOracle`
  (`test/eval/self-eval/oracle.ts`) decides `task_passed` / `task_failed` from
  this isolated verifier for build/debug tasks. The comprehension fixture now
  requires a machine-readable final architecture response from the durable
  `msg.committed` record, with exact module/dependency coverage and a frozen
  responsibility-term contract, as well as unchanged source bytes. It runs ONLY
  on a `completed` turn; a timed-out / suspended / incomplete / unknown run is
  `terminal_incomplete` and never oracle-scored, because task success is
  undefined on a run that never finished. The driver also preserves the spawn's
  `timedOut` as a distinct outcome, so the report's task tally
  (`task_passed`/`task_failed`/`terminal_incomplete`) and liveness tally
  (`completed`/`suspended`/`incomplete`/`timed_out`/`unknown`) each sum to the run
  count — no run silently dropped. The report schema is
  `brewva.self-eval.report.v2`: v1 task-pass totals used model-writable tests and
  are not comparable to the trusted-verifier baseline. This is what turns the
  tool-exercise PROFILE into a task-success signal: without it, self-eval measured
  only that the turn ended, not that the work was done.
- **Report.** `buildSelfEvalReport` / `formatSelfEvalReport` /
  `persistSelfEvalReport` emit a dated
  `.brewva/reports/self-eval/<YYYY-MM-DD>.{md,json}` (sibling of the calibration
  report's dir). The calibration-report skill gained a self-eval leg and a
  `## Self-Eval` section, so baseline drift is a standing chart, not a one-off
  table.

Relation to `harness compare`: compare is A/B over a candidate in a trial
world; self-eval is the end-to-end outcome face that runs even with no
candidate, supplying the baseline both need once run. Together they give the
improvement loop its decidability condition — the instrument that MAKES "the
harness got better" checkable rather than asserted (axiom 19 applied to the loop
itself). Built, not yet run: the baseline is a job to run, not a stored number,
until a corpus fires offline.

The live corpus generation is offline (a `report:self-eval` invocation with a
provider, or the calibration schedule); CI's machine gate is the deterministic
metric extraction, not a flaky live run — the honest split the eval harness's
runtime-vs-fixture modes already model.

## Phase 3 — The Calibration Parameter Registry (first safe action surface) — AS BUILT

Landed. `CALIBRATION_PARAMETER_REGISTRY`
(`packages/brewva-runtime/src/governance/calibration-registry.ts`) is the
code-owned list of 12 calibration-eligible parameters, each
`{path, value, source, evidenceSource, status, note?}` — pure literals + metadata
that grant no authority and auto-tune nothing (axiom 18). Initial statuses are
uniformly `asserted` (the honest default; an unexercised threshold cannot be
retuned). A parity fitness (`test/fitness/calibration-registry.fitness.test.ts`)
asserts every cleanly-importable mirror matches its live source;
`analyze:calibration-registry` renders it as a view, and the calibration-report
skill gained a leg + a `## Calibration Registry` section that cites it. Both
parameter-honesty debts are worked off: the freshness scales [30, 180] (tape) vs
[90, 365] (knowledge) **earn** their divergence — they grade different corpora
(an epoch-ms session memory vs a frontmatter-dated normative doc), recorded with
the justification — and the duplicate compaction threshold is **removed**:
`advisoryRatio: 0.82` is the wired successor of the removed
`compactionThresholdPercent`, and the production-dead
`DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.80` helper (`context-threshold.ts`,
test-only) was deleted, leaving one canonical trigger.

The design intent follows.

A declarative in-repo registry (code-owned, docs-generated) of
calibration-eligible parameters. One entry per parameter:

- parameter path (config key or named constant), current value;
- its evidence source — which receipt/report can grade it
  (e.g. `session.pre_compact_prune` for prune thresholds, compaction economics
  verdicts for `tailProtectRatio`, recall receipts for freshness windows);
- calibration status: `asserted` | `calibrated(date, corpus)` | `contested`.

Initial membership from the audit inventory: the context-budget constants
(`predictedTurnGrowthRatio`, `tailProtectRatio`, `advisoryRatio`,
`dynamicTailTokens`), the two recall freshness scales and the curation
half-life, the distiller minimum-gain ratio, and the advisory trigger
thresholds (failure-recurrence 2, read-path-recovery 2, stall
recent-failures 3).

Three uses, none of which changes any rule automatically:

1. The calibration report names `asserted` and `contested` parameters
   explicitly instead of leaving them implicit in code.
2. It is the EVOLVE-BLOCK equivalent for any future optimizer: the registry
   is the _only_ CALIBRATION-eligible surface (behavior constants a human
   retunes in source when evidence grades them); everything outside it stays
   frozen by default. This is a different axis from the harness candidate
   MATERIALIZATION seam (`materialize.ts`, today `provider.model`) — the two do
   not overlap: registry parameters are calibration-eligible but not
   materializable, and `provider.model` is materializable but not a calibration
   constant, so there are not two competing tunable lists. It fences the NAMES,
   not admissible ranges — there is no per-parameter bound and `evidenceSource`
   is prose, so bounding each parameter's domain and making `evidenceSource` a
   runnable grader are the extension a proposer needs before it could "propose
   within the fence." Naming the membership now is what makes a later optimizer
   phase reviewable instead of open-ended.
3. It is the ledger where the audit's parameter-honesty debts get worked off:
   the divergent freshness scales either earn their difference or converge,
   and the standalone `DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8` compaction
   helper either merges with the configured `advisoryRatio: 0.82` or documents
   why two near-identical thresholds coexist. (As built: the freshness scales
   earned their difference and the dead `0.8` helper was removed — see the AS
   BUILT note above.)

Values still change only as reviewed code (the calibration standard is
binding). The registry adds legibility, not authority (axiom 18).

## Phase 4 (demand-gated) — Proposal-Lane Backpressure — AS BUILT

The audit found the human gate has no backpressure design: calibration
reports, RDP candidates, and pattern candidates queue with no aging, no
consumption SLA, and rejected candidates are receipts nobody mines. Today
throughput is low and this is not the binding constraint — so, applying this
RFC's own lesson (demand telemetry before building), Phase 4 lands only a
counter: the calibration report gains one line counting unconsumed proposals
by age bucket. Designing aging/expiry and rejected-candidate mining is gated
on that counter showing a real backlog across consecutive report cycles.

Landed as exactly that counter, over the ONE lane with a truthful age +
consumption model: the pure `countProposalBacklog`
(`packages/brewva-gateway/src/harness/internal/proposal-backpressure.ts`) folds
the harness candidate ledger (evaluated-but-undecided, aged from FIRST
evaluation) into unconsumed proposals bucketed by age, over the canonical
`readHarnessCandidateLifecycleRecords`. RDP promotion candidates are deliberately
excluded: `rdp-distill` overwrites each candidate's `distilled_at` every pass (age
never accrues) and nothing flips an RDP file out of `promotion_candidate` on
consumption (the lane never drains) — counting it would report a permanent,
un-aging `<7d` inflation, so it is gated on first earning a real age + consumption
model. `analyze:proposal-backpressure` prints the one line, and the
calibration-report skill runs it under a `## Proposal Backpressure` section. No
aging, expiry, or mining was built — the counter is the trigger, nothing more.

## Constitutional Companions

- **Second-ring instance (scaffolded, not yet exercised).** Phases 2 + 3
  together SCAFFOLD the second-ring instance for the candidate axiom
  `Unmeasurable benefit must be accounted, not asserted` — self-eval is the
  instrument to account the counterfactual benefit of harness changes, and
  registry statuses are the honesty grade. But no corpus has run and all 12
  statuses are `asserted`, so it is SUBMITTED as second-ring evidence, not a
  satisfied instance: the first instance (compaction economics, context ring)
  is exercised; this one (harness-improvement ring) is built but unexercised,
  and the distinct-rings bar clears on the first grading that moves a
  parameter off `asserted`.
- **Axiom 9 precedent.** Phase 1's ADR should be written as the first
  precedent decision citing axiom 9, moving it out of pure negative space.
- **Diversity-collapse residue (claimed here).** No mechanism manages
  candidate diversity; with promotion throughput near zero this cannot bite
  yet. Residue trigger: the first time two candidates target the same mined
  weakness, patrol/self-eval reports must add a per-weakness
  distinct-approach count before any selection pressure is applied.

## Incidental Debts Surfaced By The Audit

- **Distiller salience posture.** `registerToolResultDistiller` is installed
  unconditionally and its `tool_result` hook returns replacement content — the
  model sees the distilled text, which is a salience decision (axiom 1
  tension), not only presentation. The accepted calibration decision audited
  and kept it; what is owed is not removal but evidence: the distiller already
  has receipts and a calibration view, so the named trigger is the first
  calibration report with enough distiller firings — at that point decide
  config gate vs keep, from data. Recorded here as debt, not implemented.
- **Freshness scale divergence** and **duplicate compaction threshold** —
  absorbed into Phase 3's registry work above.

## Surface Budget

- New config keys: **+1** (the unattended approval policy; empty default,
  deny-first, config-provenance only). Debt owner: gateway control-plane
  maintainer. Why unavoidable: unattended fuel collection is impossible
  without a declared approval source, and the alternative (env flags or
  per-run CLI switches) would be a wider, less auditable surface.
  Re-evaluation trigger: when the self-eval corpus first reaches held-out
  scale, or `2026-10`, whichever comes first.
- Routing / control-plane decision points: **+1** (the unattended
  auto-decision path inside existing approval resolution). Same owner and
  trigger; the decision is provenance-stamped and fail-closed.
- Inspect surfaces: **+1** (`report:self-eval` dated report).
- Author-facing concepts: **+1** (calibration-eligible parameter registry).
- Required authored fields: **0 → 0**. Optional authored fields: **0 → 0**.
- Persisted formats: **0 new** (approval receipts reuse the envelope
  provenance shape; self-eval reads existing tape events).

## Source Anchors

- Headless suspend gap: `packages/brewva-cli/src/io/gateway-print.ts` and the
  embedded print backend (no approval-decision path exists in either);
  `runtime.suspended` `cause=approval_pending` on the tape.
- Provenance envelope to generalize:
  `packages/brewva-gateway/src/daemon/session-supervisor/turn-envelope.ts`,
  `packages/brewva-gateway/src/daemon/schedule-runner.ts`,
  `packages/brewva-vocabulary/src/internal/schedule.ts` (`config_policy`).
- Asserted constants: `packages/brewva-runtime/src/config/defaults.ts`
  (`contextBudget.thresholds`, `predictedTurnGrowthRatio`,
  `compaction.tailProtectRatio`),
  `packages/brewva-runtime/src/config/normalize-infrastructure.ts`.
- Divergent freshness scales: `packages/brewva-recall/src/broker/text.ts`
  (30/180 days) vs `packages/brewva-recall/src/knowledge/search.ts`
  (90/365 days); curation half-life
  `packages/brewva-recall/src/types.ts`.
- Duplicate threshold (RESOLVED in Phase 3 — the production-dead `0.8` helper
  was removed): the surviving canonical trigger is `defaults.ts`
  `advisoryRatio: 0.82`.
- Distiller installation:
  `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
  (`registerToolResultDistiller(hostApi, runtime)`), replacement content in
  `packages/brewva-gateway/src/hosted/internal/session/tools/tool-result-distiller.ts`.
- Existing report/analyze family: `package.json`
  (`report:context-evidence`, `analyze:advisory-receipts`,
  `analyze:promotion-readiness`, `eval:recall`).

## Validation Signals

- **Confirming:** an unattended fixture task that needs `exec` completes under
  a declared policy with a provenance-stamped approval receipt per
  auto-decision, and still suspends the moment it proposes an uncovered
  effect class; two consecutive `report:self-eval` runs over the same
  fixtures produce stable metrics; the calibration report names at least the
  initial registry membership with honest statuses.
- **Falsifying / still-owed:** if unattended corpora do not materially grow
  the receipt corpus within two calibration cycles, Phase 1 solved the wrong
  bottleneck; if self-eval metrics are unstable across identical runs, the
  fixtures are underspecified and may not join the freeze surface until they
  stabilize; if the registry degenerates into an unread inventory, it has
  become the census failure mode the subtraction case law warns about and
  must shrink to the parameters a report actually cites.

## Validation Log — 2026-07-12 (glm5.2, live + deterministic)

An RFC-validation pass exercised every phase. The confirming signal is met on its
mechanism axis; promotion stays blocked on the empirical-maturity axis
(cross-model, multi-cycle) the note always named.

- **Phase 1 — confirmed live.** A live `glm5.2` unattended run that needs `exec`
  auto-approved `local_exec` under a declared envelope with the provenance receipt
  on the tape (`approval.decided` `actor=unattended-config-policy`,
  `reason="unattended config policy allows this effect class within its declared
envelope"`), committed the `exec`, and completed the task unattended
  (`echo BREWVA_P1_OK` → reported output → `turn.ended`). The suspend-on-uncovered
  half is pinned deterministically by
  `test/unit/gateway/unattended-approval-flow.unit.test.ts` (an unlisted
  `credential_access` halts fail-closed after the covered `local_exec` accepts).
  Environment note: the frozen fixtures carry only the unattended envelope, so on
  a host without the default `box` backend (`boxlite` absent) their `exec` is
  auto-approved but cannot execute — the receipt fires, the task cannot finish; a
  `security.execution.backend: host` override completes it. The fixtures are
  self-contained on the approval axis but not on the execution-backend axis.
- **Phase 2 — repeatable.** `report:self-eval` runs live against the durable tape;
  the metric gate (`test/unit/eval/self-eval-metrics.unit.test.ts`) is green. Real
  `glm5.2` fixture metrics land as host-plane primitives (`read`/`edit`/`glob`);
  cross-model stability across a grown corpus stays owed.
- **Phase 3 — registry honest.** `analyze:calibration-registry` lists the 12
  `asserted` parameters with per-parameter source + evidence; both named debts read
  as resolved (tape/knowledge freshness divergence documented as earned; the `0.80`
  duplicate removed). Gate (`test/fitness/calibration-registry.fitness.test.ts`)
  green.
- **Phase 4 — counter present.** `analyze:proposal-backpressure` emits its one
  demand line (`0` unconsumed, no aging mechanism). Gate
  (`test/unit/gateway/proposal-backpressure.unit.test.ts`) green.
- **Not promoted.** The cross-model self-eval re-measurement and the two-cycle
  corpus-growth signal are unmet — only `glm5.2` was reachable this pass
  (`deepseek` keyless, `openai-codex` token stale). Promotion stays a reviewed
  human act.

## Promotion Criteria And Destination Docs

Prose criteria now; machine gates are added as each phase's tests land (a
gate line must reference an existing repo-runnable check).

- Phase 1 landed: policy resolution is config-provenance only, empty-default,
  fail-closed, with regression coverage for the uncovered-class suspend path
  and a provenance receipt per auto-decision.
- Phase 2 landed: `report:self-eval` is repeatable (stable metrics across
  consecutive runs on unchanged fixtures), reads only durable evidence, and
  its fixtures are documented as freeze-surface members (the fixtures + scoring
  are named in the harness-candidate-integrity RFC's D6 frozen surface, and the
  fixture-shape gate `test/unit/eval/self-eval-fixtures.unit.test.ts` proves
  each carries the Phase-1 unattended envelope).
  - gate: `bun test test/unit/eval/self-eval-metrics.unit.test.ts`
- Phase 3 landed: the registry exists with the initial membership, the
  calibration report cites it, and the two parameter-honesty debts (freshness
  divergence — earned; duplicate threshold — removed) are resolved.
  - gate: `bun test test/fitness/calibration-registry.fitness.test.ts`
- Phase 4 landed: the proposal-lane backpressure counter exists and the
  calibration report carries its one line; no aging/expiry mechanism was built.
  - gate: `bun test test/unit/gateway/proposal-backpressure.unit.test.ts`
- The cross-model re-measurement the tool-surface RFC still owes runs on
  Phase 2 infrastructure instead of another ad-hoc recipe.
- On acceptance: ADR(s) in `docs/research/decisions/` (Phase 1's ADR cites
  axiom 9); a self-improvement-loop section in
  `docs/architecture/system-architecture.md`; Phases 2 + 3 submitted as the
  second-ring evidence on the accounting-for-unmeasurable-benefit candidate
  axiom.

## Non-Goals

- No optimizer, no auto-tuning, no learning loop inside the runtime — every
  output remains a report or proposal; changes land as reviewed code.
- No approval-policy authorship by the model under any phase.
- No new managed tools, no model-facing surface growth.
- No architecture-vocabulary repair in this RFC (separate precision pass).
- No Phase 4 mechanism before its counter shows demand.

## Honest Limitations

Phase 2's fixture set starts small and synthetic — the same limitation the
n=12 measurement disclosed; it bounds what self-eval can claim until the corpus
grows (which is exactly what Phase 1 exists to fix). The registry's initial
statuses are uniformly `asserted` (all 12), which is the honest starting point,
not a failure. And the loop's last hop — letting an optimizer
propose within the registry fence — stays out of scope until the utility
function has proven stable; this RFC builds the fence and the scoreboard, not
the player.

## Under The Line

`The loop is built; it is starving, unscored, and fenceless. Feed it under
declared provenance, score it from the tape, and name exactly what it may
touch — the permission layer stays outside, and every change still lands as
reviewed code.`
