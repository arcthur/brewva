# RFC: Harness Candidate Integrity And Descriptive-Authority Subtraction

## Metadata

- Status: active
- Implementation state: ALL PHASES (P1-P6) landed on the working branch, each
  with a post-review evolution note. P1 (D1): coarse registry-version comparison was
  replaced by per-entry `manifestHash` revalidation (authorization requires a
  matching content hash; carry revalidates every entry against the current
  registry and policy each carried turn), the prompt block now renders
  view-only selections under `selectable` instead of `selected`, and tool
  exposure keys off a structured `selectionAuthorized` field. One accepted
  one-time effect: receipts recorded before manifest hashing existed cannot
  revalidate and drop fail-closed until the next fresh selection. P2 (D2):
  the tool-layer read gate is deleted; the arming lifecycle emits exactly at
  the threshold crossing so each new failure run re-arms fresh evidence, and
  `tool.contract.warning` was retired with its only producer (constant and
  inspect consumer leg deleted per the liveness-audit convention). The
  evidence block still renders for the rest of the session once armed —
  decay is an open product call. P3 (D3 phase A): the CLI flag is spelled
  `--candidate-manifest`; replay modes reject loaded manifests with
  `harness_candidate_delta_not_materialized`, `executedManifestId` is a
  REQUIRED field of every execution block, and the API pushes an
  `execution_candidate_delta_not_executed` regression (recommendation
  `reject`) whenever a report's executed manifest differs from its
  candidate. P4 (D4): `attention_verify_plan` is deleted (tool, kernel
  admission entry, action-kind union member, docs); consume resolves
  `precedent:` ids to the knowledge document body and refuses
  non-materializable ids (for example `tape:` recall hits) with a typed
  `content_unavailable` error that names the `recall_search` stable-id path —
  reusing the existing deep-read tool instead of duplicating broker wiring
  was the landed refinement of D4's rootRef-resolution sketch; pin stores
  the resolved content with the workbench entry; ignore suppresses the
  option from later card sets for the session. P5 (D3 phase B): landed with
  substantial review-driven evolution. The trial world reuses
  `createIsolatedWorkspace` (the delegation fork substrate: CoW copy,
  git-scoped enumeration, basis world capture, atomic dispose) rather than a
  raw worlds snapshot; the materialization seam is the hosted session's
  `model` input, not a BrewvaConfig projection (config carries no model
  field), so the first materializable field is exactly `provider.model`. The
  classifier (`harness/internal/materialize.ts`) is exact-leaf and
  default-deny — no prefix rules (a prefix admitted the value-bearing
  `plugins.mutatingHookIds` as derived), and the model-removal direction
  refuses (`field_removal_not_materializable`). Honesty is enforced at
  every layer the review found it leaking: the API re-derives the
  materialization proof itself in real mode (self-computed diff; blocked
  fields become `execution_candidate_field_not_materializable` regressions),
  the workspace input is a discriminated union so a trial-world claim cannot
  exist without its root/basis/source evidence, a loaded candidate refuses
  when the base manifest no longer describes the current runtime
  (`harness_base_manifest_stale_vs_current_runtime`), and a materialized
  model is verified against the session's active model before the run
  (creation-time fallback: `harness_materialized_model_unavailable`) and
  after it (mid-turn provider fallback:
  `harness_materialized_model_diverged`; the fallback selection also lands
  durably on the target session's tape). The fork's durable evidence does
  not die with the trial world: `toHarnessRuntimeFactory` absolutizes the
  runtime data roots (tape/ledger/projection/worlds) against the operator
  workspace, so the target session stays auditable and the target-emptiness
  guard inspects the store the fork writes, while tool path authority roots
  at the trial world. Project settings (`.brewva/agent`) are copied into the
  fork (config, not run data) so model presets and routing chains resolve as
  they would in the workspace. Known cost, documented in `--help`: the fork
  copy plus basis capture reads and hashes the tracked tree; linked-worktree
  forks are git-less (`trialWorldSource: "walk"`). P6 (D5): landed with two
  settled-at-landing deviations from the letter of the phase plan. The
  lifecycle receipts are NOT tape events: candidates are cross-session
  artifacts (created against one session's base, evaluated in another,
  decided later with no session at all), and session tapes are deliberately
  single-writer, so the receipts live in a workspace-scoped append-only
  sidecar — `.brewva/harness/candidates.jsonl`, fsync-durable per append
  (`appendFileDurable`), read through the substrate's shared torn-tail
  boundary (`scanAppendOnly`), registered in
  `docs/reference/artifacts-and-paths.md` as preservable receipts. And
  `created` is subsumed by the first `evaluated` row (there is no authoring
  touchpoint that could mint it earlier). `candidateId` is the stable hash
  of the (base, candidate) manifest-id pair, minted by
  `compareHarnessCandidate` into every report — eval A/B reports inherit it
  through the same factory — and printed by the CLI text format. `brewva
harness candidate accept|reject|archive --candidate <id> --reason <text>`
  appends the accountable decision (unknown ids warn but still record: the
  ledger is per-workspace while candidates span checkouts); no code path
  reads the ledger for authority. The surface budget correction: +0 event
  types, +1 durable sidecar format, +3 CLI verbs as promised. The exit
  criterion holds against the ledger: one candidateId traces from its first
  evaluated row through the operator's decision receipt.
- Owner: Gateway, tools, and CLI maintainers
- Last reviewed: `2026-07-10`
- Provenance: an external expert review of the harness/capability/attention
  subsystems (2026-07-10), then a line-level double review that re-verified
  every claim against source before this RFC was written. Findings below are
  the _verified_ set: two expert claims were corrected during verification
  and the corrections are recorded inline (F1 nuance, F6).
- Depends on:
  - [Decision: Iteration Facts And Model-Native Optimization Protocols](../decisions/iteration-facts-and-model-native-optimization-protocols.md)
    (`Brewva is substrate, not optimizer` — the boundary every phase here is
    filtered through)
  - [RFC: Coupled World Rewind, Delegation Changesets, And Reversibility Tiers](./rfc-coupled-world-rewind-delegation-changesets-and-reversibility-tiers.md)
    (the world-snapshot substrate P5's trial-world isolation reuses)
  - [RFC: Capability Legibility, Retention Contract, And Recovery Recurrence](./rfc-capability-legibility-retention-contract-and-recovery-recurrence.md)
    (R1's selectable-catalog legibility is the remedy path P1's authority
    contraction relies on; P2 explicitly supersedes that RFC's read-gate
    enforcement stance)
- Promotion target:
  - `docs/reference/tools.md` (attention surface contraction, capability
    authority contract)
  - `docs/reference/runtime.md` (harness comparison execution contract)
  - `docs/reference/hosted-dynamic-context.md` (read-path recovery as
    evidence-only context)
  - `docs/research/decisions/` (a new accepted decision recording the
    optimization-surface boundary in D6)

## Problem Statement

Two failure families, one root: descriptive signals and improvement loops
have both drifted away from the axioms that govern them.

**Family A — descriptive signals leak into blocking authority (axiom 18).**
Authored capability metadata (`whenToUse`, `triggers`, path globs) is
token-matched against turn intent, and the resulting auto-ranked selection
receipt then _authorizes_ gated tools and external CLIs at kernel level. A
heuristic string match on `read` failures arms a hard gate that blocks
subsequent `read` calls entirely. Both violate
`Descriptive metadata derives views, never authority`: a view became a gate.

**Family B — the improvement loop is structurally open.** `brewva harness
compare` labels a replay with a candidate manifest id but executes the
current runtime config, in the operator's live working directory — a
candidate-tagged rerun of the current harness, not an A/B experiment. The
attention-options protocol advertises a discover/consume/pin/ignore/verify
loop whose feedback edges are mostly disconnected. Three self-improvement
workflows (harness snapshot/patrol/compare, `test/eval` scenarios,
`.brewva/learnings/` promotion) share no candidate identity, no trial world,
no evaluation report, and no promotion receipt.

Under the line:

> A selection is a view until someone accountable grants it; an experiment
> that does not run its candidate is a label; a loop that cannot feel its
> own feedback never closes.

## Scope Boundaries

In scope: capability selection authority filtering and registry-version
integrity; read-path recovery gate subtraction; harness comparison honesty,
candidate materialization, and trial-world isolation; attention-options loop
closure and tool-surface contraction; a unified candidate lifecycle
vocabulary; the optimization-surface boundary list.

Out of scope, tracked elsewhere or evidence-gated:

- Any runtime-owned global meta-optimizer (rejected; see the iteration-facts
  decision — evaluator maturity and corpus size do not support one, and it
  would itself become the next over-design layer).
- Retiring or rebuilding `workflow_status`. The expert claim that it
  "always returns unknown" did not survive static verification (F6); any
  action waits on tape forensics.
- `look_at` CJK tokenization (`goal_keywords_insufficient` on non-ASCII
  goals) — real, verified, and independent; small standalone fix.
- UI convergence to a single wire/receipt projection and the
  `HostedRuntimeAdapterPort.ops.*` freeze/migration — separate subsystem,
  separate RFC territory.
- Shepherd process adoption. Settled by prior evaluation: borrow the model,
  not the process.

## Verified Findings

Every anchor below was read at source during the double review. Verdicts:
CONFIRMED (claim held exactly), CONFIRMED-WITH-NUANCE (claim held, framing
adjusted), CORRECTED (claim did not survive verification).

### F1 — Harness compare does not run the candidate (CONFIRMED-WITH-NUANCE)

- The replay runtime factory clones the _current_ adapter config:
  `structuredClone(adapter.config)` in `toHarnessRuntimeFactory`,
  `packages/brewva-gateway/src/harness/api.ts` (line 74-89). The candidate
  manifest reaches execution only as a fork tag
  (`harness:${manifestId}`, line 253) and as report metadata.
- Real-mode execution ports are created against the operator's live working
  directory: `createRealHarnessExecutionPorts` calls `createHostedSession`
  with `cwd: input.options.cwd`,
  `packages/brewva-cli/src/operator/harness.ts` (line 357-378). The declared
  `sideEffectPolicy` is `explicit_real_target_session_only` — session
  isolation only, no filesystem isolation.
- Nuance: the default candidate path is self-consistent.
  `buildCurrentHarnessCandidateManifest` (line 411-424) builds the candidate
  _from_ the current runtime (base manifest + current `configHash` /
  `runtimeIdentityHash`), so "execute the current config" is exactly what
  that manifest describes: a legitimate regression replay of an old session
  under today's harness. The semantic break is confined to
  `--candidate-manifest-path` (line 252-260): an arbitrary loaded manifest
  diffs and labels the report, but its prompt/tool/context delta never
  reaches `createRuntime`. That mode produces a false A/B report.
- Consequence: every downstream consumer (signal taxonomy, promotion
  recommendation) currently builds on an experiment whose treatment arm may
  not exist.

### F2 — Descriptive capability metadata becomes authority (CONFIRMED)

- `selectCapabilities` has three tiers: explicit target (score 1000), policy
  default (900), and an auto-ranked fallback where ASCII token overlap
  against `whenToUse`/`triggers`/path globs selects up to three manifests
  with `source: "deterministic"`,
  `packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.ts`
  (line 434-536; the deterministic push at 524-532).
- `selectedCapabilitiesAuthorize` checks receipt membership without regard
  to `source`,
  `packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts`
  (line 279-294) — an auto-matched capability authorizes exactly like an
  explicit one.
- The receipt is real kernel authority: `resolveCapabilityAuthorityAccess`
  returns `allowed: false, reason: "missing_selected_capability"`
  (line 314-373), and the quality gate renders `kernelDecision: "deny"` for
  gated surfaces (MCP tools, external CLIs via `exec`, gated action classes,
  operator-surface tools),
  `packages/brewva-gateway/src/hosted/internal/session/tools/quality-gate.ts`
  (line 147-160, 202). The denial advisory itself states "the selection
  receipt remains the only authority" (capability-selection.ts line 400) —
  the system knows the receipt is authority; it has not noticed that one of
  the receipt's producers is a similarity heuristic.
- `computeCapabilityRegistryVersion` hashes only
  name/provider/domain/action/toolNames/riskLevel/filePath-basename
  (capability-registry.ts line 405-419). Editing `whenToUse`, `triggers`,
  `pathGlobs`, `agentScope`, `workspaceScope`, or `authProfile` — the fields
  that drive selection and scoping — does not change the version.
- `carryCapabilitySelection` re-issues the previous receipt with
  `registry_version: input.previous.registry_version` and no comparison
  against the current registry (capability-registry.ts line 579-605); the
  carry call site performs no validation either,
  `packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts`
  (line 485).

### F3 — Read-path recovery is a hard heuristic gate (CONFIRMED)

- Trigger: two consecutive `read` failures whose output text matches
  `/enoent|no such file or directory|...|not found/i` arm the gate,
  `packages/brewva-gateway/src/hosted/internal/context/read-path-recovery.ts`
  (line 14-19, 249-284).
- Enforcement is a real block, not advice: when armed and the requested path
  is not under an observed directory, the hosted `read` tool returns a guard
  result and the actual read delegate is never invoked,
  `packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts`
  (line 382-395).
- The injected context block already carries the useful part (typed failure
  evidence, observed paths/directories, discovery suggestion) —
  read-path-recovery.ts (line 286-315) — but its wording is imperative
  ("No additional `read` calls are allowed") and the tool layer enforces it.
- This is not a security or data-integrity boundary. It is a hardcoded
  reasoning path derived from a string heuristic — axiom 18's exact failure
  shape, plus a false-positive class (any failed read whose output happens
  to contain "not found" counts).
- Supersession note: the capability-legibility RFC's implementation state
  records this gate as deliberately re-armed and contract-tested
  ("deflect, discover, unlock; an armed gate has no decay"). This RFC
  supersedes that stance on axiom-18 grounds; P2 amends that RFC's note when
  it lands.

### F4 — Attention options advertise a loop that does not close (CONFIRMED)

All five advertised edges verified at
`packages/brewva-tools/src/families/memory/attention-options.ts`:

1. `precedent:*` cards cannot be consumed. Live repository search mints ids
   as `precedent:${relativePath}` (line 379-416), while recall-surfaced
   repository precedents carry bare `stableId`s (line 314-349).
   `resolveConsumedContent` (line 620-694) resolves `skill:`, `workbench:`,
   recall-event ids, and `event:` — a `precedent:*` id falls through every
   branch and returns `unknown_option`.
2. Consuming a recall card returns identifiers, not content: the resolved
   "content" is the three lines `stable_id` / `source` / `root_ref`
   (line 666-677).
3. `attention_ignore` records a metric observation and nothing else
   (line 875-899); neither `collectOptionDocuments` nor `selectCards` reads
   ignore state, so an ignored option reappears unchanged next call. The
   tool description promises a "session-scoped advisory suppression" that
   does not exist.
4. `attention_pin` stores the caller's note or a placeholder sentence — it
   never resolves the option's content (line 837-873). A pin without a note
   preserves nothing but the id.
5. `attention_verify_plan` returns a static four-step recipe with the
   option id interpolated (line 901-942) — a prompt wearing a tool schema.

Fairness note: `skill:` / `workbench:` / `event:` consumption is a genuine
closed loop (full markdown / entry content / event summary). The breakage
concentrates on the recall/precedent path and the feedback edges.

### F5 — Three disconnected improvement workflows (CONFIRMED)

- Harness: `brewva harness snapshots|patrol|compare`
  (`packages/brewva-cli/src/operator/harness.ts`).
- Eval: `test/eval` scenarios, rubrics, graders, A/B variants
  (`test/eval/graders/rubric-grader.ts`, `test/eval/scenarios/`).
- Learnings: `.brewva/learnings/` with duplicate-count-driven manual
  promotion (`skills/meta/self-improve/references/promotion-targets.md`).

No shared candidate id, no shared trial world, no shared evaluation report,
no promotion receipt. Each loop can "improve" something the others cannot
see.

### F6 — Corrections to the expert's agent-native audit (CORRECTED)

- "Goal clear is missing" is false at the runtime-ops layer:
  `goal.lifecycle.clear` exists alongside
  start/pause/resume/continue/complete/block,
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/goal.ts`
  (line 14). If a gap exists it is in the model-facing tool projection, and
  any CRUD-parity claim must state which layer it measures.
- "`workflow_status` always returns unknown" is an unverified universal.
  The tool derives a full posture/finish/artifact projection from tape and
  task state (`packages/brewva-tools/src/families/workflow/workflow-status.ts`);
  `unknown` appears as field-level fallbacks. Whether real sessions
  degenerate to all-unknown is a tape question, not a code-reading question
  — forensics before any retirement decision.
- `look_at` rejecting non-ASCII goals is confirmed
  (`packages/brewva-tools/src/families/navigation/look-at.ts` line 83) and
  matters for CJK operators; tracked as adjacent work.
- The 63% aggregate score is not reproducible (self-defined dimensions and
  weights); the value of that audit is its gap list, and the gap list is
  corrected by the two items above.

## Design Principles

- Subtraction before construction: remove illegitimate authority (P1, P2)
  and false labels (P3) before building the loop (P5, P6).
- Axiom 18 everywhere: rankings, matches, and heuristics may produce views
  and advisories; only explicit targets, trusted policy, or accountable
  human action produce authority.
- Honest reports or no reports: a comparison report must state what actually
  executed; if the candidate cannot execute, the command refuses rather than
  labeling.
- The loop closes outside the runtime: candidate creation, evaluation, and
  promotion are operator- and model-visible protocol, never a background
  runtime optimizer (iteration-facts decision).

## Design

### D1 — Capability authority: filter by source, harden the version

Keep the receipt shape; change what authorizes. `selected_capabilities`
entries already carry `source` (`"explicit" | "policy" | "deterministic"`),
and `carryCapabilitySelection` copies entries verbatim, so provenance
survives carry chains without new types.

- `selectedCapabilitiesAuthorize` counts only entries with
  `source ∈ {explicit, policy}` toward authorization. `deterministic`
  entries remain in the receipt and remain advisory — a view, as axiom 18
  requires. The rejected alternative (new `CapabilityCandidate` /
  `CapabilityGrant` types) adds a type system where a filter suffices.
- As landed (review evolution): coarse registry-version comparison proved to
  be the wrong altitude — it missed the actual authority chokepoint (a stale
  receipt paired with a freshly loaded registry authorized by name), ignored
  policy drift on carried turns, and revoked valid explicit grants on any
  unrelated registry churn, file rename, or locale-dependent hash ordering.
  The landed mechanism is per-entry: every selected entry is stamped with a
  content `manifestHash` (filePath excluded; byte-order sorting), an entry
  authorizes only while its hash matches the live manifest, and
  `resolveCarriedCapabilityReceipt` revalidates each entry (manifest exists,
  hash matches, current policy passes) on every carried turn — dropping
  exactly the invalidated entries with recorded reasons instead of the whole
  receipt. `computeCapabilityRegistryVersion` derives from the manifest
  hashes and remains the receipt-level context stamp.
- The prompt block partitions by authority: only granting entries render as
  `selected`; view-only matches lead the `selectable` (requestable) list, so
  the prompt never claims an authority the gate would deny. Tool exposure
  reads the structured `selectionAuthorized` fact field, not the advisory
  string.

Behavioral consequence, intended: a session whose receipt contains only
deterministic matches loses gated-tool authorization it should never have
had. The remedy path is already legible — the denial advisory names covering
capabilities and the `/capability:<name>` explicit request path
(capability-selection.ts line 394-400), which produces an `explicit` entry.
The request is user-mediated by design: an accountable actor, not the model,
upgrades a view into a grant.

### D2 — Read-path recovery: evidence in, gate out

Delete the enforcement, keep the evidence.

- Remove the interception branch in the hosted `read` tool
  (session-assembly.ts line 382-395): `read` always reaches its delegate.
- Keep `gateArmed` (rename target: recovery-evidence, naming settled at P2)
  and discovery-observation events — the tape story stays.
- Keep the context block, reworded from imperative to evidential: recent
  consecutive missing-path failures, the failed paths, observed
  paths/directories since, and the discovery primitives available. The model
  decides how to recover.
- `isReadPathVerified`, `buildReadPathGuardResult`, and
  `recordReadPathGuardWarning` lose their callers and are deleted with the
  branch; `test/unit/gateway/read-path-gate-enforcement.unit.test.ts`
  becomes a contract test for the evidence block instead of the gate.

### D3 — Harness compare: refuse the false label now, materialize later

Phase A (P3, immediate honesty):

- `--candidate-manifest-path` combined with `--mode fixture|real` fails with
  `harness_candidate_delta_not_materialized` — replay execution cannot apply
  a loaded manifest's delta yet, so the only honest modes for an arbitrary
  manifest are field diffing (`--mode manifest`).
- The comparison report grows an optional
  `metrics.execution.executedManifestId`. Invariant: a replay report is
  valid evidence only when `executedManifestId === candidateManifestId`. On
  the default path (candidate built from the current runtime) this holds by
  construction today.

Phase B (P5, materialization + isolation):

- A projection `materializeHarnessCandidateConfig(baseConfig, candidateManifest)`
  produces the runtime config for the fork. It may override only the
  optimizable surface (D6): prompt/skill assets, visible tool subset,
  selector policy parameters, context-budget soft parameters,
  presentation/distillation policy. Fields on the frozen surface
  (`security.*`, permissions, credentials, approval routing) are never read
  from a candidate manifest — materialization of a manifest that differs on
  a frozen field fails closed with the offending field named.
- `toHarnessRuntimeFactory` takes the materialized config for the fork
  instead of cloning the adapter's config unconditionally.
- Real-mode execution acquires a trial world: the hosted session's `cwd` is
  a disposable workspace snapshot, never the operator's live cwd. Substrate
  choice (worlds clonefile snapshot vs git-worktree clone) is an open
  question resolved at P5 design review; the contract is fixed here:
  disposable, isolated, recorded in the report
  (`execution.workspaceMode: "trial_world"`), and torn down or archived with
  the candidate.
- The materialized manifest + source events + divergence point together form
  the replayable context snapshot for the run — this subsumes the expert's
  separate "bind provider requests to a ContextSnapshot" item for the
  harness path; no second snapshot object is introduced.

### D4 — Attention options: close the loop, shrink the surface

- Unify precedent identity: recall-surfaced repository precedents and live
  search mint the same `precedent:<relativePath>` id, and
  `resolveConsumedContent` gains a `precedent:` branch that resolves the
  document content (bounded) via the knowledge-search reader.
- Consume returns content or refuses: the recall branch resolves the
  underlying record's content through its `rootRef`; when a ref cannot be
  materialized the tool returns a typed `content_unavailable` error instead
  of identifiers formatted as content.
- `attention_pin` resolves the option content first and stores it (bounded)
  in the workbench entry alongside the caller's note; the placeholder
  sentence survives only for resolution failures, marked as such.
- `attention_ignore` writes suppression state that
  `collectOptionDocuments`/`selectCards` actually read: ignored option ids
  are excluded (session-scoped) from subsequent card sets. Axiom-18-safe:
  option selection is an advisory view, not authority, so feedback shaping
  it is legitimate — this is the corrected reading of the expert's
  three-primitive proposal.
- Delete `attention_verify_plan`. A static recipe belongs in skill/prompt
  guidance, not on the tool surface (tool-surface subtraction discipline).
  The broader consolidation to `context_discover`/`context_read`/
  `context_feedback` is deferred until these repairs prove insufficient —
  repairing four edges is cheaper than a rename-shaped rewrite.

### D5 — One candidate lifecycle across three workflows

A shared vocabulary, not a shared engine:

- `candidateId`: stable hash of (baseManifestId, changed fields, delta
  digest) minted at candidate creation.
- Event family `harness.candidate.created|evaluated|accepted|rejected|archived`
  in `@brewva/brewva-vocabulary/harness`, emitted by: compare runs
  (`evaluated`, carrying the comparison report ref), and new operator verbs
  `brewva harness candidate accept|reject|archive` (accountable human
  action; closes the audit's accept/reject/archive CRUD gap without any
  auto-promotion).
- `test/eval` A/B reports and `.brewva/learnings/` promotions reference the
  `candidateId` when one exists; learnings stay prompt-native
  (`promotion-targets.md` gains a "cite the candidate id" step), the
  runtime gains no promotion authority. `.brewva/learnings/` is thereby a
  readable projection of the protocol, exactly as the external review
  proposed.

### D6 — The optimization-surface boundary (promotes to a decision)

Optimizable surface (candidate deltas may touch):

- prompt and skill assets;
- the visible tool subset;
- selector/ranking policy parameters — carried as versioned policy values,
  not as new boolean config switches;
- context-budget soft parameters;
- presentation/distillation policy.

Frozen surface (never candidate-mutable, never auto-tuned):

- permission, credential, and approval surfaces;
- tape/WAL/receipt schemas;
- evaluator definitions and held-out splits (Goodhart guard);
- promotion authority;
- world isolation and rollback machinery.

Enforcement lands with P5 (materialization fails closed on frozen fields).
The list promotes to `docs/research/decisions/` as an accepted decision once
P5's enforcement exists, cross-linked to the iteration-facts decision.

## What This RFC Rejects

- A runtime-internal global meta-optimizer (weakness miner → auto-tuner):
  rejected on the iteration-facts decision and on current evaluator/corpus
  maturity. The conservative fallback — keep accumulating receipts and a
  larger cross-model corpus before any optimization — remains open and
  cheap.
- New `CapabilityCandidate`/`CapabilityGrant` types: the `source` field
  already encodes provenance; D1 is a filter, not a type system.
- Retiring `workflow_status` on the "always unknown" claim: unverified;
  forensics first (Adjacent Work).
- Treating attention-selection feedback as an axiom-18 violation: selection
  is a view; feedback into views is legal and is precisely what makes the
  loop close.
- Runtime-owned learnings: `.brewva/learnings/` stays a skill-owned,
  human-promoted practice; P6 gives it shared identity, not an engine.

## Implementation Plan

Ordering rationale: P1-P4 are small, independent, and strictly
subtractive/honest; they land first in any order. P5 is the large
construction phase and reuses P3's contract. P6 rides on P5's identifiers.
Each phase carries its own tests and lands green through
`bun run check` plus the full `bun test` (both gates, per repo convention).

### P1 — Capability authority subtraction

- Files:
  - `packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts`
    (`selectedCapabilitiesAuthorize`: source filter)
  - `packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.ts`
    (`computeCapabilityRegistryVersion`: full-manifest hash)
  - `packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts`
    (line 485 carry site: version validation + reselect fallback)
- Tests:
  - `test/unit/gateway/capability-selector.unit.test.ts` — deterministic
    selection still produces receipt entries; those entries no longer
    authorize; explicit/policy entries still do; carry preserves per-entry
    `source` and explicit-through-carry still authorizes.
  - `test/unit/gateway/capability-selection-legibility.unit.test.ts` —
    prompt block still renders deterministic candidates (view unchanged).
  - `test/unit/tools/runtime-capability-scope.unit.test.ts` — quality-gate
    deny path for deterministic-only receipts, advisory names the explicit
    request path.
  - New assertions: version changes when any authored selection/scoping
    field changes; carry with stale version reselects and records the
    policy decision.
- Verify: targeted suites above, then `bun run check` and full `bun test`.
- Exit: no authorization path consumes a `deterministic` entry; registry
  version covers the full authored manifest; stale-version carry is
  impossible.

### P2 — Read-path gate subtraction

- Files:
  - `packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts`
    (delete the interception branch, line 382-395)
  - `packages/brewva-gateway/src/hosted/internal/context/read-path-recovery.ts`
    (delete `isReadPathVerified`/guard-result/guard-warning surface; reword
    the context block to evidential)
  - `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
    and `packages/brewva-gateway/src/hosted/context.ts` (drop re-exports)
  - Amend the capability-legibility RFC's implementation-state note
    (supersession, F3).
- Tests: rewrite
  `test/unit/gateway/read-path-gate-enforcement.unit.test.ts` as the
  evidence contract — after two matched failures the context block appears
  with failed paths and discovery evidence; `read` calls are never blocked;
  block disappears when evidence is observed.
- Verify: targeted suite, `bun run check`, full `bun test`.
- Exit: no tool-layer path can refuse a `read` on recovery-state grounds;
  the evidence block and tape events remain.

### P3 — Harness compare honesty

- Files:
  - `packages/brewva-cli/src/operator/harness.ts` (`runHarnessCompare`:
    reject `--candidate-manifest-path` with `--mode fixture|real` as
    `harness_candidate_delta_not_materialized`)
  - `packages/brewva-gateway/src/harness/api.ts` +
    `packages/brewva-vocabulary/src/harness.ts` (optional
    `metrics.execution.executedManifestId`, populated from the manifest that
    actually governed the fork)
  - `docs/reference/` operator docs for the compare command (flag contract).
- Tests: `test/unit/cli/harness-output.unit.test.ts` (report text carries
  `executedManifestId`); `test/unit/gateway/harness-patrol.unit.test.ts`
  untouched; new unit for the CLI rejection path.
- Verify: targeted suites, `bun run check`, full `bun test`.
- Exit: no report can claim a candidate it did not execute.

### P4 — Attention loop closure

- Files:
  - `packages/brewva-tools/src/families/memory/attention-options.ts` (all
    four edge repairs from D4; delete the `attention_verify_plan`
    definition)
  - `packages/brewva-tools/src/registry/managed-metadata.ts` (drop the tool
    entry)
  - `docs/reference/tools.md` (surface contraction; the
    reference-tools-coverage fitness enforces this stays in sync)
- Tests: `test/unit/tools/attention-options.unit.test.ts` — precedent cards
  round-trip through consume with content; recall consume returns content or
  typed `content_unavailable`; pin persists resolved content; ignored
  options are absent from the next `attention_options` result in the same
  session; verify_plan tool no longer registered.
- Verify: targeted suite, `bun run check`, full `bun test`.
- Exit: every card the options tool can emit is either consumable with
  content or fails typed; feedback edges (`ignore`, `pin`) observably change
  behavior.

### P5 — Candidate materialization and trial-world isolation (gated on P3)

- Files (new): a `materializeHarnessCandidateConfig` projection module
  (new file `materialize.ts` beside
  `packages/brewva-gateway/src/harness/api.ts`, frozen-surface
  fail-closed); trial-world acquisition in
  `packages/brewva-cli/src/operator/harness.ts`
  (`createRealHarnessExecutionPorts` gains a workspace provider).
- Files (modified): `packages/brewva-gateway/src/harness/api.ts`
  (`toHarnessRuntimeFactory` accepts the materialized config;
  `executedManifestId` now reflects it), report schema
  (`execution.workspaceMode`).
- Design review before build: substrate choice for the trial world (worlds
  clonefile snapshot vs git worktree), teardown/archive policy, and the
  materializable field map — the map is the first enforcement of D6 and
  must quote the decision list.
- Tests: materialization unit (optimizable fields apply; frozen fields fail
  closed with the field named); real-mode compare integration proving the
  hosted session cwd is the trial world, not the operator cwd; lifting the
  P3 rejection replaced by materialized execution.
- Exit: `executedManifestId === candidateManifestId` holds for loaded
  manifests; real-mode tool effects land in a disposable world.

### P6 — Unified candidate lifecycle (gated on P5)

- Files: `packages/brewva-vocabulary/src/harness.ts` (candidate lifecycle
  event family + `candidateId`), `packages/brewva-cli/src/operator/harness.ts`
  (`candidate accept|reject|archive` verbs), `docs/reference/events/`
  (coverage fitness will demand registration),
  `skills/meta/self-improve/references/promotion-targets.md` (cite the
  candidate id).
- Tests: event vocabulary unit; CLI verb unit (accept/reject/archive write
  tape events with the shared id); eval-report linkage carries the id when
  present.
- Exit: one candidate id is traceable from creation through evaluation to an
  accountable accept/reject/archive receipt across all three workflows.

## Adjacent Work (evidence-gated, not phased here)

- `workflow_status` forensics: query recent session-index tapes for posture
  field distributions; only if real sessions degenerate to all-unknown does
  a redesign item open.
- `look_at` non-ASCII goal support: replace the ASCII-token gate with
  CJK-aware tokenization; independent small change,
  `packages/brewva-tools/src/families/navigation/look-at.ts` (line 71-90).

## Validation Signals

- P1: zero authorization basis facts with a deterministic-only receipt in
  new tapes; denial advisories observed followed by `/capability:` explicit
  requests (the capability-request eval scenario in
  `test/eval/scenarios/harness-fluency-capability-request.yaml` measures
  exactly this remedy path).
- P2: sessions that previously hit the gate show discovery-then-read
  recovery without blocked reads; no recurrence-of-failure regression in
  the read family (recurrence brief stays quiet on calm sessions).
- P3/P5: every stored comparison report satisfies the
  `executedManifestId === candidateManifestId` invariant; real-mode compare
  tapes show `workspaceMode: "trial_world"`.
- P4: `attention.option_consume_ratio` becomes interpretable (consume can
  no longer silently no-op on half the card families); ignored ids absent
  from subsequent option sets in-session.
- P6: a full lifecycle trace (created → evaluated → accepted/rejected)
  reconstructable from tape for at least one real candidate.

## Surface Budget

| Surface                              | Before | After | Notes                                                                                             |
| ------------------------------------ | ------ | ----- | ------------------------------------------------------------------------------------------------- |
| Public tools                         | 5      | 4     | `attention_verify_plan` deleted (P4); its recipe moves to prompt guidance                         |
| Authority-granting selection sources | 3      | 2     | `deterministic` demoted to view-only (P1) — an authority subtraction, the point of the RFC        |
| Blocking tool-layer gates            | 1      | 0     | read-path hard gate deleted (P2); evidence block remains                                          |
| CLI verbs                            | 0      | +3    | `harness candidate accept\|reject\|archive` (P6) — accountable human actions closing the CRUD gap |
| Event types                          | 0      | +5    | candidate lifecycle family (P6), tape-derived projections only                                    |
| Config fields                        | 0      | 0     | selector policy versioning rides existing manifest/receipt shapes; no new switches                |
| Report fields                        | 0      | +2    | `executedManifestId`, `workspaceMode` — honesty fields (P3/P5)                                    |

## Promotion Criteria

- P1+P2 promote the capability-authority and read-recovery contracts into
  `docs/reference/tools.md` / `docs/reference/hosted-dynamic-context.md`
  once their suites are green and one dogfood session shows the explicit
  request remedy path working.
- P3+P5 promote the comparison execution contract into
  `docs/reference/runtime.md` when the invariant holds over stored reports.
- D6 promotes to a `docs/research/decisions/` record when P5's fail-closed
  enforcement exists in code.
- P6 promotes the lifecycle vocabulary into `docs/reference/events/` docs
  with its registration.

## Open Questions

Settled at landing time (P1-P4):

- P1: upgrades from `deterministic` stay user-mediated — the denial advisory
  names `/capability:<name>`, an accountable actor re-issues it, and the
  fresh explicit selection carries its own `manifestHash`. No in-session
  auto-upgrade path was added.
- P2: `gateArmed` keeps its event name for tape continuity; the evidence
  block's decay (it renders for the rest of the session once armed) stays an
  open product call, recorded in the implementation-state note.
- P3: `executedManifestId` landed as a REQUIRED field of the (optional)
  execution block with no schema version bump; the only producer and all
  fixtures were updated in the same change, and no persisted reader exists.

Open for the P5 design review (proposed resolutions, to be confirmed before
build):

- P5 substrate: proposed — the worlds clonefile snapshot substrate (already
  landed by the coupled-world-rewind RFC; no git-clean requirement, and the
  trial world archives with the candidate through the same worlds
  machinery). Git worktrees stay the fallback if snapshot setup cost proves
  prohibitive for large workspaces.
- P5 materializable map first iteration: proposed — the narrowest honest
  slice: prompt/skill assets and the visible tool subset only. Selector
  policy parameters, context-budget soft parameters, and presentation policy
  join in later iterations once the first two prove the fail-closed frozen
  boundary. The map must quote D6's decision list either way.
- P6: proposed — a manifest is a precondition for a candidate id; eval A/B
  runs without a manifest reference the run id in their reports but mint no
  candidate. This keeps the candidate lifecycle anchored to a materializable
  delta instead of a free-floating label.

## Source Anchors

- `packages/brewva-gateway/src/harness/api.ts` (line 74-89, 253, 300)
  (current-config clone; fork tag; hosted tool executor mode)
- `packages/brewva-cli/src/operator/harness.ts` (line 252-260, 357-378,
  411-424) (candidate manifest branch; real ports on live cwd; current-
  runtime candidate builder)
- `packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.ts`
  (line 405-419, 434-536, 579-605) (weak version hash; three-tier selection;
  carry without validation)
- `packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts`
  (line 279-294, 314-373, 394-400) (source-blind authorization; authority
  resolution; denial advisory)
- `packages/brewva-gateway/src/hosted/internal/session/tools/quality-gate.ts`
  (line 147-160, 202) (kernel deny on missing receipt)
- `packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts`
  (line 485) (unvalidated carry site)
- `packages/brewva-gateway/src/hosted/internal/context/read-path-recovery.ts`
  (line 14-19, 215-247, 286-315) (heuristic trigger; verification walk;
  context block)
- `packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts`
  (line 382-395) (the hard interception)
- `packages/brewva-tools/src/families/memory/attention-options.ts`
  (line 314-349, 379-416, 620-694, 837-942) (recall identifier cards;
  precedent id mint; consume resolution; pin/ignore/verify handlers)
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/goal.ts`
  (line 14) (goal.clear exists)
- `packages/brewva-tools/src/families/workflow/workflow-status.ts` (derived
  posture projection, unknown fallbacks)
- `packages/brewva-tools/src/families/navigation/look-at.ts` (line 71-90)
  (ASCII-only goal tokens)
- `skills/meta/self-improve/references/promotion-targets.md` (learnings
  promotion practice)
- `docs/research/decisions/iteration-facts-and-model-native-optimization-protocols.md`
  (substrate-not-optimizer boundary)
