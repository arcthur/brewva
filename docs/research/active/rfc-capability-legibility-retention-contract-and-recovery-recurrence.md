# RFC: Capability Legibility, Retention Contract, And Recovery Recurrence

## Metadata

- Status: active
- Implementation state: implemented on `rfc/harness-fluency` except the
  numerically gated tails. Landed: R1a/R1b (selectable catalog + actionable
  denial advisory reaching the model), R2a/R2b/R2c (pin survival physics,
  note-scoped eviction release path, pinned-mass accounting, documented
  vocabulary; promoted to `docs/reference/runtime.md` and
  `docs/reference/tools.md` on the green survival property test), R3
  (generalized failure-recurrence `[RuntimeBrief]` section from committed
  receipts), R4 Phase 0+1 (observation-shape classifier mounted shadow-only,
  post-turn divergence drain to tape, explicit-pull `shadowAdmission` inspect
  projection). R5 landed instrument-first: two `harness-fluency` eval
  scenarios (fixture-mode grader validation green); the two prompt statements
  stay in this RFC until a runtime-mode eval delta exists. The generic-scenario
  runtime executor is now WIRED: each run is one real `brewva --print` turn in
  a hermetic temp workspace (named-fence output parsing, no fixture
  contamination; proven end-to-end against the fake-assistant gateway
  harness), with prompt-variant A/B via
  `bun run eval --skill harness-fluency --ab --appendix
test/eval/variants/harness-fluency-statements.md` and a third scenario
  measuring R1's unselected-capability request signal
  (`harness-fluency-capability-request`, hermetic workspace manifest +
  config). The live delta itself is still unmeasured: this machine's
  `--print` path currently fails auth
  (`hosted_runtime_provider_auth_failed: Token refresh failed: 401` — the
  openai-codex OAuth slot expired 2026-05-24 and model selection reaches its
  refresh even with `--model deepseek-v4-flash`), so the one-command A/B waits
  on an operator environment with working provider auth. Two deliberate behavior
  notes: restoring the `tool.result.recorded` producer re-arms every dormant
  consumer of that receipt — including read-path recovery's read-gate
  enforcement (now also un-drifted on the write side and contract-tested
  end to end: deflect, discover, unlock; note for a product call — an armed
  gate has no decay, it holds for the session and each new directory needs
  fresh discovery evidence), stall adjudication, session-index text
  ingestion, and recall classification — not only the new brief section; and pin identity is now
  keyed on `retentionHint` alone (the shared vocabulary predicate), so a
  hand-authored pin-reason-without-hint note no longer projects into
  `pinnedRefs`. Still gated, not built: R1c `discover_capabilities`, R4
  Phase 2 promotion.
- Owner: Runtime, gateway, and tools maintainers
- Last reviewed: `2026-07-02`
- Depends on:
  - [RFC: Accountable Tool-Schema Cost And The Deferred Definition-Side Compression Trigger](./rfc-accountable-tool-schema-cost-and-deferred-definition-compression.md)
    (advertisement/permission orthogonality; the gated `capability_expand`
    verb R1 must stay compatible with)
  - [RFC: Model-Facing Runtime Intelligence Digests](./rfc-model-facing-runtime-intelligence-digests.md)
    (the `[RuntimeBrief]` carrier and legibility contract R3 rides on)
  - [RFC: Attention As An Accountable Effect](./rfc-attention-as-an-accountable-effect.md)
    (persisted `retention_hint` and attention receipts R2 builds on)
  - [Candidate Axiom: Accounting For Unmeasurable Benefit](./candidate-axiom-accounting-for-unmeasurable-benefit.md)
    (names recovery and admission as un-applied rings; R3/R4 are candidate
    instances)
  - [Decision: Model-Operated Working Memory And Context Governance Reset](../decisions/model-operated-working-memory-and-context-governance-reset.md)
    (`Model owns attention. Runtime owns physics.` — the line every residue
    is filtered through)
  - `docs/reference/proactivity-engine.md` (the removed cognition-driven
    planner; the boundary R5 must not re-cross)
- Promotion target:
  - `docs/reference/tools.md` (R1, R2 tool-surface contracts)
  - `docs/reference/hosted-dynamic-context.md` (R1 prompt block, R3 brief
    section)
  - `docs/reference/runtime.md` (R2 compaction contract, R4 admission
    evidence)
  - `docs/architecture/design-axioms.md` (only via the candidate axiom's own
    promotion path if R3/R4 validate it)

## Problem Statement

Operators of a peer harness (codename `ika`, a hosted Claude-Code-derived
multi-channel agent platform) consistently report four experienced qualities:

1. Intent lands even when the instruction is under-specified.
2. Long threads do not lose working context; earlier facts stay live without
   restating them.
3. Complex multi-step prompts run to completion; approval is effectively the
   only interrupt, and errors are absorbed rather than escalated.
4. External tools get used proactively — the model finds and uses the right
   integration without being told it exists.

A mechanism-level audit of `ika` against brewva shows brewva already owns most
of the load-bearing structure behind these qualities, and that the parts it
does not own are mostly parts it has deliberately rejected. The genuine
residue is three structural closures and one eval-gated prompt closure. None
of them adds runtime authority; each one makes something the model already
owns _legible_, _contractual_, or _evidenced_.

Under the line:

> What the model cannot see it cannot choose; what it pinned, physics keeps;
> what failed twice, the brief says so.

## Scope Boundaries

In scope: capability advertisement legibility, workbench retention semantics
across compaction, in-session failure-recurrence evidence, shadow-first
admission refinement, and two bounded system-prompt statements.

Out of scope: any runtime-owned attention admission, any auto-granted
approval, retry orchestration or auto-remediation, cross-session failure
distillation (owned by the reversible-references RDP path), wake/planning
cognition (removed; stays removed), and `ika`-style hidden per-turn context
pipelines.

## Audit: Covered, Rejected, Residue

Quality-by-quality, with the `ika` mechanism described behaviorally and the
brewva verdict anchored:

| Quality                     | `ika` mechanism                                                                                                                                            | brewva state                                                                                                                                                                        | Verdict                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Intent (1)                  | Domain-anchored prompt ("interpret unclear instructions as engineering tasks in this cwd") + env/git context injection + per-turn relevant-skill reminders | Per-turn advisory SkillCard shortlist with explicit-mention/path/name/text scoring and CJK intent bridges; `discover_skills` fallback                                               | COVERED except two prompt lines (R5)                                   |
| Continuity (2)              | LLM continuation-summary compaction + a never-compacted preference file layer + FTS recall                                                                 | LLM compaction primary + tape replay + `recall_search`; `retention_hint` persisted but with no survival contract                                                                    | RESIDUE (R2)                                                           |
| Uninterrupted execution (3) | Error-as-`tool_result` feedback loop + layered permission classifiers before interactive ask + bounded auto-recovery ladders                               | `err`/`inconclusive`/`aborted` receipts all observable, turn continues; minimal ask surface; provider retry + over-window compaction resume; one static downgrade (`exec` readonly) | COVERED except recurrence evidence (R3) and classifier generality (R4) |
| Proactive tools (4)         | Per-turn tool/skill hints + searchable deferred tool catalog                                                                                               | SkillCards per turn; but capability-gated tools are invisible before selection and the denial advisory names no remedy                                                              | RESIDUE (R1)                                                           |

Rejected from `ika`, with the axiom that rejects it:

- Runtime-assembled per-turn context admission (hidden relevance pipeline):
  rejected by `Model owns attention`; brewva's advisory shortlist is the
  ceiling, content push is over the line.
- Runtime-owned permission auto-grant layers: the kernel never decides an
  ask; approval decisions require an external actor. Classification may
  narrow _what is asked_ (R4), never answer it.
- Flat single-bit error taxonomy: `err`/`inconclusive`/`aborted` carry more
  governance information; `Inconclusive is honest`.
- Deterministic auto-compaction as the primary continuation path: settled;
  LLM compaction is primary, deterministic is emergency fallback.
- Cognition-driven wake/planning: removed with the `ProactivityEngine`;
  heartbeat stays an explicit operator-authored trigger.
- A parallel un-receipted always-injected memory file: re-homed instead as a
  tape-accountable retention contract on workbench entries (R2).

## Residue R1 — Selectable-Capability Legibility

Visibility is currently coupled to authorization. The capability prompt block
renders only what is already selected and what is forbidden
(`formatCapabilitySelectionSection`,
`packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts` (line 368-406)),
and the fail-closed denial advisory says only that a receipt is missing
(`:364`) — it names neither the capability nor the request path. A model
cannot request what it cannot see; `ika`'s quality (4) rests precisely on
per-turn visibility of what _could_ be used.

The data to fix this is already authored: capability manifests carry
`whenToUse` and `triggers`
(`packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.ts` (line 23),
authored-key whitelist at `:180-189`).

Proposal:

- R1a: extend the existing capability prompt block with a bounded
  `selectable` sub-list — name plus `whenToUse`, deterministic order, capped
  (8 entries) — for manifests that are neither selected nor forbidden.
  Listing is descriptive; the selection receipt remains the only authority
  (same catalog-trust language as MCP admission).
- R1b: enrich the denial advisory to name the missing capability and the
  concrete request path instead of the bare receipt sentence.
- R1c (deferred, gated): a `discover_capabilities` search verb mirroring
  `discover_skills` TF-IDF. Deferred until R1a's inline list is measurably
  insufficient (cardinality gate, same ethos as the tool-schema RFC's
  measured trigger); if the tool-schema RFC's `capability_expand` lands
  first, R1c should fold into its group listing rather than exist twice.

## Residue R2 — Retention Contract

The pin _vocabulary_ exists; the pin _physics_ does not. `retention_hint` is
persisted on workbench entries
(`packages/brewva-vocabulary/src/internal/workbench.ts` (line 183);
`packages/brewva-tools/src/families/memory/workbench.ts` (line 62,75-105)), the
attention-consume flow writes `retentionHint: "attention_pin"`
(`packages/brewva-tools/src/families/memory/attention-options.ts` (line 846)), and
compaction provenance projects pinned refs — projection only
(`readAttentionPinnedRefsFromWorkbench`,
`packages/brewva-gateway/src/hosted/internal/context/compaction-input-provenance.ts` (line 416-443)).
No compaction or eviction path enforces survival, and the tool schema
documents no retention vocabulary at all — `attention_pin` is folklore the
model cannot know (`retention_hint` is a free string ≤ 128 chars).

`Model owns attention` includes owning what to preserve. Today that ownership
is written but not enforceable: a pin survives as evidence, not as a
guarantee. `ika` reaches quality (2) partly through a never-compacted
preference layer; brewva's correct re-homing is not a parallel memory file
but a pin whose survival is contractual and tape-accountable.

Proposal:

- R2a: define the contract — entries with `retentionHint: "attention_pin"`
  are excluded from workbench compaction/eviction candidate sets and carried
  verbatim across session-compaction baselines. Explicit `workbench_evict` or
  un-pinning by the model remains the only removal path.
- R2b: account the pinned mass — pinned tokens counted and surfaced through
  the existing context-status/brief physics so pinning stays a paid,
  visible choice (reuse the attention RFC's budget taxonomy when its deferred
  phase lands; do not invent a second budget).
- R2c: document the vocabulary — `attention_pin` becomes a documented
  `retention_hint` value in the workbench tool prompt and reference docs,
  so the contract is legible to the model that owns it.

## Residue R3 — Recovery Recurrence Evidence

Model-native recovery is the settled brewva posture: errors come back as
`err`/`inconclusive`/`aborted` receipts and the turn continues. What the
model does not get is evidence that it is _repeating_ a failure. The
recurrence projection exists for exactly one family
(`projectRecentExecFailures`,
`packages/brewva-tools/src/runtime-port/verification-diagnostics.ts` (line 91),
consumed at `packages/brewva-tools/src/runtime-port/observability.ts` (line 33)),
and the model-facing carrier for exactly this kind of runtime intelligence
already landed (`[RuntimeBrief]`,
`packages/brewva-gateway/src/hosted/internal/context/runtime-brief.ts`).
`ika` reaches quality (3) through runtime-orchestrated retry ladders; the
brewva re-homing is evidence, not orchestration — the candidate axiom already
names recovery as an un-applied ring.

Proposal:

- Generalize failure-recurrence projection across tool families: key on tool
  name + normalized failure kind + digest-stable argument identity, derived
  from committed `err`/`aborted` receipts (tape-derived, replay-consistent —
  never in-memory counters).
- Surface it as one relevance-gated `[RuntimeBrief]` section under the
  existing legibility contract: silent below threshold, present only when an
  identical failure has recurred (≥ 2), stating count and last variant. No
  retry orchestration, no auto-remediation, no posture change.
- Cross-session precedent stays with the reversible-references RDP path
  (explicit-pull `docs/solutions/**`); this section is strictly in-session.

## Residue R4 — Evidence-Gated Admission Refinement

Ask-class admission is coarse: whole action classes defer, with exactly one
static per-call downgrade in the tree (`execCanUseReadonlyPolicy`,
`packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts` (line 109),
consumed at `:331`). `ika` reaches quality (3) partly through per-call
classification ahead of interactive approval. Brewva already holds the safe
form of that idea in one place, and the seam to generalize it exists and is
dormant: `shadowToolAuthority`
(`packages/brewva-runtime/src/runtime/kernel/port.ts` (line 234),
`packages/brewva-runtime/src/runtime/kernel/impl.ts` (line 741-798)) runs shadow
resolvers isolated from real decisions and records divergence evidence; the
promotion seat also exists (`resolveToolAuthority` physics option,
`packages/brewva-runtime/src/runtime/runtime.ts` (line 153,207-209)).

Proposal (strictly phased):

- Phase 0: mount a broader static classifier (readonly/observation-shaped
  calls in currently-ask classes) as shadow only. Zero outcome change;
  divergence evidence accumulates on tape.
- Phase 1: publish the divergence report as an explicit-pull inspect view
  under the shared inspect host (would-allow where real asked, with reason).
- Phase 2 (gated): promote only call-shapes with zero unsafe-allow
  divergence over a defined window into the real `resolveToolAuthority`
  resolver. The `maxAdmission` ceiling and critical floor are untouched; the
  kernel still never decides an ask — classification narrows what is asked,
  never answers one.

This is the account/grade/calibrate method applied to admission — a second
ring for the candidate axiom, alongside R3's recovery ring.

## Residue R5 — Prompt Residue (Eval-Gated)

Two bounded system-prompt statements, both absent today (no goal-holding or
under-specified-instruction anchoring language exists in the substrate or
hosted prompt builders):

- Goal holding: a short continuation ("continue", "ok") means push the
  already-authorized goal to a terminal state — result, blocker, or one
  concrete question — not one increment.
- Under-specified anchoring: interpret terse instructions against the
  working directory and active goal before asking.

These are prompt text, not an engine; the `ProactivityEngine` removal
boundary stays intact (the runtime stays out of the planning business). Both
land only behind a measured eval delta in `test/eval`, and are dropped if the
delta does not replicate.

## Source Anchors

- `packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts` (line 356-406)
  (denial advisory; selected/forbidden-only prompt block)
- `packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.ts` (line 23,180-189)
  (`whenToUse`/`triggers` authored manifest fields)
- `packages/brewva-vocabulary/src/internal/workbench.ts` (line 183) (persisted
  `retentionHint`)
- `packages/brewva-tools/src/families/memory/workbench.ts` (line 62,75-105)
  (free-string `retention_hint` tool argument, undocumented vocabulary)
- `packages/brewva-tools/src/families/memory/attention-options.ts` (line 846)
  (`attention_pin` writer)
- `packages/brewva-gateway/src/hosted/internal/context/compaction-input-provenance.ts` (line 416-443)
  (pin projection without survival enforcement)
- `packages/brewva-tools/src/runtime-port/verification-diagnostics.ts` (line 91) and
  `packages/brewva-tools/src/runtime-port/observability.ts` (line 33) (exec-only
  recurrence projection)
- `packages/brewva-gateway/src/hosted/internal/context/runtime-brief.ts`
  (brief carrier)
- `packages/brewva-runtime/src/runtime/kernel/port.ts` (line 234),
  `packages/brewva-runtime/src/runtime/kernel/impl.ts` (line 741-798) (dormant
  shadow-authority seam)
- `packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts` (line 109,331)
  (the one existing static downgrade)
- `packages/brewva-runtime/src/runtime/runtime.ts` (line 153,207-209)
  (`resolveToolAuthority` physics seat)
- `docs/reference/proactivity-engine.md` (removed-planner boundary)

## Validation Signals

- R1: eval scenario — a task whose correct path needs an unselected
  capability; measure whether the model requests it unprompted. Token cost of
  the `selectable` block stays within the capability section's existing
  budget. Admission outcomes without receipts: zero change.
- R2: property test — no compaction/eviction path ever drops an
  `attention_pin` entry; pinned-mass accounting visible in context status;
  replay equivalence unchanged.
- R3: baseline first — count identical-failure recurrences per session in
  recent tapes (quantifies the waste before any code lands); after landing,
  recurrence-after-brief rate and a no-noise check (section absent on calm
  turns).
- R4: shadow divergence rate; share of deferrals downgradable with zero
  unsafe-allow divergence over the evaluation window; promotion is numeric,
  not vibes.
- R5: eval delta on multi-step continuation and terse-instruction scenarios;
  drop on non-replication.

## Surface Budget

| Surface                               | Before | After | Notes                                                                                                                                                                                                                                 |
| ------------------------------------- | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required authored fields              | 0      | 0     | R1 renders existing `when_to_use`; nothing new required                                                                                                                                                                               |
| Optional authored fields              | 0      | 0     | `retention_hint` already exists; R2c documents, does not add                                                                                                                                                                          |
| Author-facing concepts                | 0      | +1    | `attention_pin` becomes a documented retention value. Debt owner: tools maintainers. Unavoidable: an unenforced, undocumented pin is folklore, not a contract. Re-evaluate when the attention RFC's budget phase lands (`2026-10-01`) |
| Inspect surfaces                      | 0      | +1    | R4 divergence report under the shared inspect host, explicit-pull                                                                                                                                                                     |
| Routing/control-plane decision points | 0      | +1    | R2a pin-exclusion rule inside compaction candidate selection. Debt owner: gateway maintainers. Unavoidable: survival-by-contract is the entire point of R2. Re-evaluate with the same trigger (`2026-10-01`)                          |

R1c and R4 phase 2 are gated and add their surfaces (`+1 public tool`,
admission-outcome changes) only if their numeric gates pass; they are not
counted here.

## Promotion Criteria

- R1 promotes to `docs/reference/tools.md` +
  `docs/reference/hosted-dynamic-context.md` when the eval scenario passes
  and the token budget holds.
- R2 promotes to `docs/reference/runtime.md` + `docs/reference/tools.md` when
  the survival property test is green and pinned-mass accounting ships.
- R3 promotes to `docs/reference/hosted-dynamic-context.md` when the baseline
  and post-landing measurements exist and the no-noise check passes.
- R4 phase 2 promotes to `docs/reference/runtime.md` only on its numeric
  divergence gate; phases 0-1 are evidence-only and promote nothing.
- R5 promotes nowhere; it either survives its eval or is deleted.

## Open Questions

- R1a rendering: extend `formatCapabilitySelectionSection` or add a sibling
  block, given the section currently renders only when a receipt has content?
- R2a: does the pin contract bind only `workbench_compact` candidates, or
  also model-side eviction suggestions rendered during compaction pressure?
- R3 identity: how aggressive should argument normalization be before two
  failures count as identical (exact digest vs shape-level)?
- R4 classifier scope: which ask-class call shapes beyond readonly exec have
  statically decidable observation-only semantics worth shadowing first
  (`browser` snapshot-only? `process` list-only?)?
- Peer codename: keep `ika` or align with the existing peer-naming registry
  if one is established elsewhere.
