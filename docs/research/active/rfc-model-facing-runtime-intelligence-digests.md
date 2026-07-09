# RFC: Model-Facing Runtime Intelligence Digests

## Metadata

- Status: active
- Implementation state: Phase 1 landed (the legibility contract + `[RuntimeBrief]`
  block replacing the 16-line `[Context Status]` ledger dump and the raw
  consequence digest: provenance frame, salience order, posture rendering,
  demote-then-drop budget; sections = context-pressure posture + last-turn
  effects). Phase 2 landed the cache-break posture section (relevance-gated to an
  unexpected prefix-cache break, naming the cause, e.g. `tool_schema_set_changed`).
  All sections are relevance-gated (pressure only under advised/forced/predicted
  overflow; effects only on non-zero counts; cache only on an unexpected break),
  so the brief is absent entirely on a fully calm turn — its presence is itself a
  signal.
  Gated/deferred by the contract's own rules: tool-schema-cost section omitted (no
  model lever until `capability_expand` exists); compaction-economics
  `netReuseValue`/grade section deferred (no cheap per-turn source — the verdict is
  only derived inside the expensive context-evidence report; needs a latest-verdict
  accessor stored at compaction-commit); verifier findings relocated to the
  delegation-outcomes surface (sub-agent results, not runtime physics) rather than
  duplicated in the brief. Generalizes the existing `[TurnConsequenceDigest]`
  pattern to other runtime intelligence.
- Owner: Runtime, gateway, and provider-core maintainers
- Last reviewed: `2026-06-29`
- Depends on:
  - [Decision: Model-Operated Working Memory And Context Governance Reset](../decisions/model-operated-working-memory-and-context-governance-reset.md)
    (`Model owns attention; Runtime owns physics`; the inform-not-seize axis)
  - [Decision: Consequence-Aware Effect Commitment Model](../decisions/consequence-aware-effect-commitment-model.md)
    (the bounded model-facing digest precedent, `renderTurnDigest`)
  - [Decision: Cost Observability And Budget Governance](../decisions/cost-observability-and-budget-governance.md)
    (the standing "cost visibility does not widen context admission" boundary this note revisits)
  - [RFC: Accountable Tool-Schema Cost And The Deferred Definition-Side Compression Trigger](./rfc-accountable-tool-schema-cost-and-deferred-definition-compression.md)
    (one intelligence source this digest would surface)
- Promotion target:
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/runtime.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Problem Statement

Brewva's runtime is intelligent: it computes net-reuse economics and graded
evidence honesty (`netReuseValue`, `measured|estimated|inconclusive`),
request-shape attribution (`tool_schema_set_changed`, tool-schema token
estimate), provider cache postures, verification evidence, and context pressure.
But almost all of that intelligence is rendered for the **operator** —
`report:context-evidence`, `brewva inspect`, `--recommend`, obs snapshots — and
deliberately kept out of the model's context (`cost-observability` even states
"cost visibility does not widen ... context admission").

The principle this note acts on: **a strong model is the best consumer of
runtime intelligence.** A heuristic-era runtime hid its smarts from a weak model
because the model could not use them. As models strengthen, the asymmetry
inverts — the model can act on rich diagnostics the operator currently reads
alone (self-moderate tool-schema cost, prefer cache-stable compaction
boundaries, act on a verifier's open finding). Routing that intelligence only to
humans leaves its highest-value consumer uninformed.

There is exactly one place brewva already does this right: the
`[TurnConsequenceDigest]` — the runtime computes consequence posture and renders
a **bounded** model-facing block, budget-capped by
`consequenceDigestMaxChars`. This RFC generalizes that single, proven pattern
into a small **runtime-brief** family, under a strict legibility and
non-seizure contract — so the digest informs without becoming a prompt-manager
that seizes attention or thrashes the prefix cache.

## Scope Boundaries

In scope:

- A bounded, structured, model-facing **runtime brief** that composes the
  consequence digest with a few additional inform-only sections derived from
  already-computed runtime intelligence (context pressure, compaction economics
  posture, tool-schema cost posture, open verification findings).
- A **legibility contract** for any model-facing runtime block (structure,
  salience order, units, redaction, bounded structure-preserving truncation).
- Turn-tail placement so the brief stays cache-stable.

Out of scope:

- Any change that lets the brief **decide** anything — hide a tool, drop a turn,
  route a provider, gate admission. The brief is read-only inform.
- Pushing raw dollar cost, raw hashes, or operator-only internals into the model.
- Replacing operator inspect surfaces (they stay; the brief is a sibling render
  of the same intelligence, not a replacement).
- New recorded quantities — every section derives from existing receipts/tape.
- The tool-schema economy lever itself (gated in its own RFC); this only surfaces
  its cost posture.

Out of scope but tracked:

- An explicit-pull `context_brief` tool (model asks for a fuller brief on demand)
  as an alternative/complement to the auto-pushed tail digest.

## Why

### Why surface intelligence to the model at all

The runtime sees what the model structurally cannot in-context: the cache it is
about to break, the cross-turn economics of its last compaction, the share of
its prefix spent on tool schema, a verifier's open finding. Surfacing these as
**information the model can act on** is the complement to "model owns attention":
the model can only own attention well if it can see the physics it is acting
against. This is the inform half of `Runtime owns physics, Model owns attention`.

### Why it must be a digest, not a dump (the legibility requirement)

Model-facing context is not a log. An unstructured or unbounded dump (a) thrashes
the prefix cache, (b) drowns the decision-relevant signal in noise so the model
tunes it out, and (c) costs tokens every turn for intelligence that is only
sometimes relevant. The value is realized only if the brief is **reasonable,
readable, and structured** — bounded, salience-ordered, stably formatted, and
silent when it has nothing decision-relevant to say.

### Why it does not violate the standing boundaries

The `cost-observability` decision kept cost out of model context to avoid the
runtime seizing routing/authority via cost signal. This RFC honors that intent:
the brief is **read-only inform in the volatile turn tail** — it admits nothing
as history truth, widens no tool authority, drives no routing or admission. It
surfaces **posture** (a ratio, a graded verdict, a pressure level), never a
running ledger the model would obsess over. It revisits _where the intelligence
is rendered_, not _what authority it carries_.

## Direction

1. **One computed source, two renders.** The intelligence is computed once
   (context-evidence, effect posture, break-detector, verification). The operator
   render (full, explicit-pull) and the model brief (bounded, salience-ordered)
   are two projections of the same source, so they never drift.
2. **Inform, never seize.** The brief is a context contribution the model reads;
   it changes nothing the runtime owns. It carries no lever it does not pair with
   an existing model tool.
3. **Legible by contract.** A provenance frame, lowest priority, stable
   structure, salience order, explicit units, no model-unusable internals
   (hashes, ids), cadence-gated, and budgeted by demote-then-drop. Silent when
   nothing is decision-relevant. (See the Legibility Contract.)
4. **Cache-stable by placement.** The brief lives in the **turn tail** (volatile,
   post-prefix), never the durable system prompt, so a per-turn-varying brief
   never breaks the provider prefix cache.

## Architectural Positions

- **The brief is a deliberate bounded model-facing push, distinct from inspect.**
  Operator inspect views stay explicit-pull and never auto-push (the shared
  projection discipline). The brief is the sanctioned exception already
  established by the consequence digest: a small, budgeted, redaction-bounded
  block the runtime composes into the model request. It does not reuse or widen
  the inspect-pull surfaces.
- **Read-only, authority-neutral.** The brief admits nothing as replay truth,
  widens no tool/routing/admission authority, and is a pure deterministic
  projection from receipts/tape — same receipts render the same brief.
- **Turn-tail only, volatile not frozen.** Composed into the existing
  dynamic-tail summary, never the stable prefix. A changing brief must not move
  `stablePrefixHash`. This is the deliberate inverse of `hermes`'s frozen
  load-time memory snapshot: `hermes` freezes for prefix-cache stability, but a
  brief whose whole value is _current_ runtime state (live pressure, latest
  verdict) must stay fresh — so it lives in the tail (already post-prefix) rather
  than being frozen into the cached block.
- **Budgeted and fail-closed.** A hard char/token budget (sibling to
  `consequenceDigestMaxChars`); over budget it demotes then drops low-salience
  sections (see the legibility contract), never truncates mid-structure. A render
  failure yields no brief, never a malformed block.
- **Paired with a lever or omitted.** A section is surfaced only when the model
  has an action for it (e.g., tool-schema cost posture surfaces meaningfully only
  once a `capability_expand`-class lever exists; until then it stays
  diagnostic-light or omitted). Inform without an actionable lever is noise.

## Legibility Contract (the core of this RFC)

Any model-facing runtime block must satisfy the following. Several rules adopt
presentation craft proven in peer harnesses (`claude-code`, `hermes`) whose
attention-ownership stance differs from Brewva's but whose model-facing rendering
is orthogonal to that stance and directly reusable.

- **Provenance frame.** The brief opens with a one-line declaration that it is
  system-injected, render-time runtime state, advisory, and not a user
  instruction — so the model treats it as system metadata, not a directive to
  obey or a fact to act on blindly. This is `claude-code`'s `<system-reminder>`
  framing ("automatically added by the system ... bear no direct relation"),
  which is precisely how to inject runtime context without the prompt-manager
  trap.
- **Lowest priority.** The brief sits explicitly below user instructions, the
  current task, and the model's own judgment in the instruction-priority order
  (mirroring `claude-code`'s Override > Agent > Custom > Default ordering). It
  informs a decision; it never outranks one.
- **Stable structure.** A fixed, tagged, sectioned shape with stable section
  keys and field order across turns, so the model parses it reliably and
  identical content renders identically (cache-friendly within the tail).
  Reuse the `[Tag] ... [/Tag]` block convention the consequence digest already
  establishes; the brief is a small block family, not a new parallel format.
- **Salience order.** Most decision-relevant section first; a stable priority
  ranking, not arrival order.
- **Adaptive content, stable format, cadence-gated.** _What_ appears is gated by
  current decision-relevance (surface a `wasteful` compaction posture only just
  after a compaction; surface tool-schema cost only past a threshold). _How_ it
  appears never changes. An unchanged posture is not re-emitted every turn — it
  re-renders only on change or every N turns (both `claude-code`'s turn-count
  reminder gating and `hermes`'s terminal "do not repeat" framing), which avoids
  both nagging and tail churn. Empty/irrelevant sections are omitted, not blank.
- **Posture, not ledger; units and plain terms.** Every number carries its unit
  and frame as a compact posture ("82% of advisory limit", "schema ≈ 18% of
  prefix input") — the `hermes` usage-bar form (`[XX% — used/limit]`), never a
  running ledger. No bare hashes, event ids, or internal enum names the model
  cannot act on.
- **Demote, don't drop.** Enforce the budget by first collapsing low-salience
  sections to a one-line stub (keep the section key + a "more available" cue),
  dropping a section entirely only as a last resort. A model cannot reach for
  what it does not know exists — this is `hermes`'s skills-index rule ("NEVER
  remove entries entirely ... models don't reach for what the index stops
  showing"). Never cut mid-line or mid-block; below budget the brief is always a
  well-formed, parseable whole.
- **Redaction-reuse.** Render through the existing redaction layer; never expand
  raw command, environment, credential, or secret-bearing text.

Illustrative shape (not a final schema):

```
[RuntimeBrief] (runtime state at render time — advisory, not an instruction)
context: 82% of advisory limit — compaction would help
economics: last compaction netReuseValue negative (wasteful) — prefer larger cuts
verify: 1 open finding (correctness) — resolve before commit
[/RuntimeBrief]
```

Sections present only when decision-relevant; `[TurnConsequenceDigest]` either
folds in as a section or remains a sibling block under the same contract
(open question).

## Source Anchors

Stable docs and decisions:
`docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`,
`docs/research/decisions/consequence-aware-effect-commitment-model.md`,
`docs/research/decisions/cost-observability-and-budget-governance.md`,
`docs/architecture/design-axioms.md`,
`docs/reference/hosted-dynamic-context.md`.

Internal implementation anchors:
`packages/brewva-runtime/src/runtime/kernel/policy/effect-posture.ts`
(consequence posture + digest precedent),
`packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`
(`netReuseValue`, grade, tool-schema estimate),
`packages/brewva-gateway/src/hosted/internal/provider/cache/break-detector.ts`,
`packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.ts`
(`delegationAdvisoryTracker`, pressure),
`packages/brewva-gateway/src/hosted/internal/session/managed-agent/provider-payload-pipeline.ts`
(`buildProviderDynamicTailSummary`, the turn-tail seam),
`packages/brewva-gateway/src/delegation/structured-outcome.ts`
(verifier evidence).

External comparison anchors (model-facing presentation craft only, not their
attention-ownership stance):
`/Users/bytedance/new_py/claude-code/src/constants/prompts.ts`
(`<system-reminder>` provenance framing, static/dynamic boundary, turn-count
reminder gating, instruction-priority order),
`/Users/bytedance/new_py/hermes-agent/agent/context_compressor.py`
(`SUMMARY_PREFIX` "background reference, not active instructions" negative frame),
`/Users/bytedance/new_py/hermes-agent/tools/memory_tool.py`
(`format_for_system_prompt` usage-bar `[XX% — used/limit]`, terminal "do not
repeat" framing),
`/Users/bytedance/new_py/hermes-agent/agent/prompt_builder.py`
(skills-index demote-don't-hide rule).

## Architecture Proposal

1. **Brief composer (gateway, pure).** A deterministic function over the
   already-computed per-turn intelligence (consequence posture, context pressure,
   latest compaction economic verdict, tool-schema cost posture, open verifier
   findings) producing an ordered list of `{ sectionKey, salience, line }`.
2. **Legibility renderer.** Sorts by salience, applies the budget by dropping
   whole low-salience sections, renders the stable tagged block through the
   redaction layer. Returns `""` (no block) when nothing is decision-relevant.
3. **Tail placement.** The rendered brief composes into
   `buildProviderDynamicTailSummary` so it sits in the dynamic tail and never
   perturbs `stablePrefixHash`. The consequence digest either migrates into the
   brief or stays a sibling under the same renderer.
4. **Budget.** As landed, the brief uses an internal `RUNTIME_BRIEF_MAX_CHARS`
   constant, deliberately decoupled from `consequenceDigestMaxChars` (which caps
   only the digest string). Promote to an `infrastructure.contextBudget.runtimeBriefMaxChars`
   config key (the gated surface +1 below) only if per-deployment tuning is needed.

## How To Implement

### Phase 0: Boundary confirmation

- Confirm the dynamic-tail seam can carry the brief without moving the stable
  prefix, and that each candidate section derives purely from existing receipts.
- Decide consequence-digest composition: fold-in vs sibling block.

### Phase 1: Contract + one real section — LANDED

- `runtime-brief.ts` (pure): provenance/lowest-priority header, salience-ordered
  composer with demote-then-drop budget, and posture renderers. Wired into
  `workbench-context.ts buildRuntimeBriefBlockForSession`, replacing the 16-line
  `[Context Status]` ledger dump and the bare consequence-digest block with one
  `[RuntimeBrief]` block in the dynamic tail. Sections: context-pressure posture +
  last-turn effects (consequence digest reframed, internal `runtimeTurn=` cursor
  stripped). Consequence digest composes in as a section (the fold-in choice).
- Decided in build: pressure hints were STATE-only ("advisory limit reached"), the
  imperative ("compact now") staying with the cadence-gated compaction nudge. That
  split was FOLDED (2026-07-09 heuristic->mechanism subtraction): the imperative now
  rides the posture `line` and shows every turn under sustained pressure (persistent,
  like the review-closure section) instead of the old full/brief turn cadence; the
  `stub` (state-only) is the demote target only when the brief's own budget is
  crowded. The standalone `[ContextCompactionGate]`/`[ContextCompactionAdvisory]`
  blocks and the compaction `nudgeTracker` were removed.
- Tests: `runtime-brief.unit.test.ts` (contract) + `hosted-workbench-context.unit.test.ts`
  (end-to-end wiring). `bun run check` green.

### Phase 2: Additional sections, salience-gated — cache-break LANDED; rest gated

- LANDED: cache-break posture section — relevance-gated to an unexpected
  prefix-cache break on the previous turn (cheap O(1) latest
  `provider_cache_observation`), naming the cause (e.g. `tool_schema_set_changed`)
  and the re-sent cost. This is the operator→model bridge for the tool-schema
  cache physics.
- GATED (contract's own rules, not skipped): tool-schema-cost section omitted —
  no model lever until `capability_expand` exists. Compaction-economics
  (`netReuseValue`/grade) deferred — no cheap per-turn source (only derived in the
  expensive report); needs a latest-verdict accessor at compaction-commit.
  Verifier findings relocated to the delegation-outcomes surface (sub-agent
  results, not runtime physics) to avoid duplicating the same run across two
  blocks.
- Fitness: each section appears only when relevant; no authority/routing change;
  the brief is a pure projection of cheap per-turn runtime state.

## Validation Signals

- Structure fitness: the brief is always a well-formed `[Tag]…[/Tag]` block with
  its provenance line; over budget it demotes low-salience sections to stubs and
  only then drops them, never truncating mid-structure.
- Cache fitness: brief content lives in the tail; changing it does not move
  `stablePrefixHash`.
- Relevance + cadence fitness: a section is absent when not decision-relevant;
  the brief is empty (no block) when nothing is; an unchanged posture is not
  re-emitted every turn (re-renders only on change or every N turns).
- Authority fitness: rendering the brief changes no tool availability, routing,
  admission, or replay truth; it is a pure projection.
- Redaction fitness: no raw command/credential/secret text escapes into the brief.
- Single-source fitness: operator render and model brief are two projections of
  the same computed intelligence.
- `bun run test:docs` and `bun run format:docs:check`.

## Surface Budget

_Net additions introduced by this RFC._

| Surface                               | Before | After | Notes                                                                                            |
| ------------------------------------- | -----: | ----: | ------------------------------------------------------------------------------------------------ |
| Required authored fields              |      0 |     0 | No new required configuration.                                                                   |
| Optional authored fields              |      0 |     0 | As landed: brief budget is an internal constant. `runtimeBriefMaxChars` config stays a gated +1. |
| Author-facing concepts                |      0 |     1 | The model-facing "runtime brief" as a bounded, legible context block.                            |
| Routing/control-plane decision points |      0 |     0 | Inform-only; the brief decides nothing.                                                          |
| Inspect surfaces                      |      0 |     0 | Reuses existing operator intelligence; the model brief is not an inspect surface.                |
| Public tools                          |      0 |     0 | The auto-pushed tail digest needs none; an explicit-pull `context_brief` is an open question.    |

Positive surface delta:

- Debt owner: runtime + gateway maintainers.
- Why unavoidable: surfacing runtime intelligence to the model needs one
  author-facing concept (the brief) and one budget knob; the budget is held
  minimal by reusing the consequence-digest pattern, the dynamic-tail seam, and
  already-computed intelligence — no new recorded quantity, no new authority.
- Dated re-evaluation trigger: by `2026-09-30`, evaluate whether the brief
  measurably improved model decisions (compaction-boundary choice, tool-schema
  self-moderation, acting on verifier findings) against turns without it; if not,
  archive and keep intelligence operator-only.

## Promotion Criteria

Move to `docs/research/decisions/` only after:

- The legibility contract holds under fitness (structure, budget, relevance,
  cache, redaction, single-source).
- At least the context-pressure section and the consequence digest render through
  the shared contract in the turn tail with no `stablePrefixHash` perturbation.
- Stable docs (`hosted-dynamic-context.md`) carry the brief contract, and the
  `cost-observability` boundary is documented as honored (inform-only, no
  authority widening).

## Open Questions

- Does `[TurnConsequenceDigest]` fold into the brief as a section, or stay a
  sibling block under the shared renderer?
- Auto-pushed tail digest only, or also an explicit-pull `context_brief` tool for
  a fuller on-demand view?
- What is the salience ranking across sections, the default
  `runtimeBriefMaxChars`, and the cadence N (turns between re-emitting an
  unchanged posture)?
- How is "decision-relevant this turn" defined per section without becoming an
  adaptive runtime judgment that drifts toward seizing attention?
