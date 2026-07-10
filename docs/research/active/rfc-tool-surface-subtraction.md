# RFC: Tool-Surface Subtraction And The Optimizer Last-Hop — What n=12 Real Sessions Say About Crystallized Heuristics

## Metadata

- Status: active
- Kind: RFC (an evidence-driven subtraction of model-facing tool surface, plus a
  forward note on closing the self-improvement loop on the substrate already
  shipped). Not a new plane.
- Owner: tools-registry / runtime-model-attention maintainers
- Last reviewed: `2026-07-09`
- Depends on / relates to:
  - [Design Axioms](../../architecture/design-axioms.md) — axiom 1 `Attention
belongs to the model.`, axiom 3 `Subtraction beats switches.`, axiom 4 `Govern
effects, not thought paths.`, axiom 7 `Inconclusive is honest governance.`,
    axiom 15 `Public width should compress toward authority width.`, axiom 19
    `A documented invariant that nothing checks is a promise, not a contract.`
  - [RFC: Durable Cross-Session Planning Map](./rfc-durable-cross-session-planning-map.md)
    (explicitly _gated on measured cross-session demand_ — this RFC supplies the
    first demand telemetry for its planning-map surface)
  - [RFC: Attention As An Accountable Effect](./rfc-attention-as-an-accountable-effect.md)
    and
    [RFC: Capability Legibility, Retention Contract, And Recovery Recurrence](./rfc-capability-legibility-retention-contract-and-recovery-recurrence.md)
    (both add or enrich the `attention` / capability surfaces this RFC measures at
    near-zero real invocation)
  - [Decision: Advisory Heuristics Carry Receipts And Offline Calibration, Not A Meta-Optimizer](../decisions/advisory-receipt-and-calibration-standard.md)
    — accepted case law this RFC must reconcile with: calibration derives reports,
    never rule changes; any optimizer output stays a proposal under governed
    promotion (see the forward half).
  - External: Lilian Weng, _"On Harness Engineering"_ (2026-07-04) — the
    optimization trajectory instruction → structured context → workflow → harness
    code → optimizer code, the ACE → MCE → Meta-Harness → Self-Harness maturation,
    and the hard requirement that the permission/security layer sit **outside** any
    self-improvement loop.
- Promotion target:
  - `docs/research/decisions/` — an ADR once the per-family fitness fixtures land
    and the cross-model re-measurement (below) confirms the near-zero result.
  - `docs/architecture/system-architecture.md` and
    `packages/brewva-tools/src/registry/managed-metadata.ts` — the compressed
    model-facing surface and the surface-ceiling fitness, once landed.

## Problem Statement

Brewva's constitution already implements the meta-methodology a mature harness is
supposed to converge on: general mechanisms over heuristic rules (the Ring Model,
axiom 3), a durable editable substrate (event tape, WAL, world/rewind,
receipt-based recoverable execution), a governed permission layer, and a fitness
lab. That layer is an asset and is **out of scope for subtraction**.

The drift is one layer down, in the **model-facing tool ontology**. Brewva manages
**116 tools** (base 35 / skill 47 / `control_plane` 24 / operator 10) and surfaces
**94-95** of them to the model each turn (`tool.surface.resolved` `activeCount`).
Many of these are domain heuristics crystallized into named capabilities:
`source_read`, the `source_patch` family, the `code` family, `task_set_spec` /
task-ledger, `verification_record`, `plan-map`, the `attention` family, `recall`,
`knowledge`. The hypothesis this RFC tests is Lilian Weng's central claim applied
to brewva: **a sufficiently strong model routes around crystallized heuristics and
reaches for general primitives instead** — which would make most of that ontology
dead model-facing surface (context cost, schema-token cost, decision noise) rather
than leverage.

### Scope boundaries

- **In scope:** the _model-facing_ active surface (base + skill tools surfaced in a
  turn). The subtraction target lives entirely inside the ~94 surfaced tools.
- **Out of scope:** the constitution / substrate layer (axioms, tape, WAL,
  world/rewind, fitness, capability fail-closed scoping) — those are the assets the
  forward half _builds on_. The `control_plane` (24) and operator (10) tools are
  CLI/operator surfaces, not model-invoked in a turn; this RFC's session evidence
  does not measure them and does not propose touching them.
- This RFC proposes a **measurement + subtraction discipline and its first
  dataset**, not a blind deletion list. Every removal is fitness-gated.

## Method: How This Was Measured (analysis process)

Brewva's own doctrine (`AGENTS.md`: _evidence over inference; durable layers over
presentation layers_) sets the bar: a tool is not "live" because it is designed —
it is live when a real session exercises it on the durable tape. The measurement
escalated sample size deliberately, and each step is reproducible from durable
evidence:

1. **n=1 (fixture).** The single committed hosted fixture tape exercised ~8 tools;
   the specialized families appeared only as string mentions, never as
   `tool.committed`. Suggestive, not decisive (n=1).
2. **n=7 (real read/analysis sessions).** Queried the real
   `.brewva/session-index/session-index.sqlite` read model (the `tool.committed`
   projection); reproduce with
   `sqlite3 .brewva/session-index/session-index.sqlite "select json_extract(payload_json,'$.call.toolName') t, count(*) c from events where type='tool.committed' group by t order by c desc"`.
   12 distinct tools cover 100% of committed calls; distribution `read` 82 /
   `glob` 31 / `grep` 24 / `code_digest` 9 / `exec` 7 / `source_read` 6, and
   **zero** for the `source_patch` family, the rest of the `code` family,
   `verification_record`, the `attention` family, `recall`, and `knowledge`.
   Honest caveat: these are read/analysis sessions (zero mutations), so the
   absence of verify tools is partly session-type — but the `attention` family
   scored zero in exactly the session type where it is most relevant.
3. **n=5 (fresh build + comprehension sessions).** Ran real sessions through the
   embedded runtime (`--print`, model `glm5.2` via a custom OpenAI-completions
   provider) in isolated `/tmp` git workspaces, and read each session's
   authoritative event tape (`tool.proposed` / `tool.committed` /
   `tool.surface.resolved`), not the projection:
   - A — fix an arithmetic bug (2-file); B — implement two missing functions
     (multi-step); C — debug a subtle regex bug (comprehension); D — summarize the
     architecture of a real 5.5K-LOC package (`brewva-session-index`, 32 files);
     E — add a utility + test at package scale (`brewva-std`, 14 files).
   - Every fix that reached `edit` landed correctly (tests pass). Combined distinct
     tools used across A-E: **`read`, `glob`, `edit`, `exec` — four**, out of 94-95
     surfaced. Plane note: `read` / `glob` / `edit` here are **host-plane
     primitives** (the embedded host's generic tools), not managed brewva tools —
     so the comparison "`read` 82 : `source_read` 6" spans two tool planes. That is
     the finding, stated precisely: when generic host primitives and the managed
     ontology are surfaced side by side, the model reaches for the primitives.

The key point for validity: in build sessions `read` / `glob` / `edit` auto-commit
**before** any `exec` (the only approval-gated primitive here), and every
specialized tool under test is non-`exec`, so it would be _proposed_ before the
gate. Truncation at the `exec` approval boundary therefore hides none of the
specialized families. Their absence is real, not an artifact of headless
truncation.

## Findings: What n=12 Real Sessions Show

- **Designed vs exercised.** 116 managed / 94-95 surfaced / **4** distinct tools
  used across the five fresh sessions; 12 across the seven read sessions. The
  model-facing surface is roughly an order of magnitude wider than what any real
  workload touches.
- **The specialized ontology is near-dead model-facing surface.** Across all twelve
  sessions, the `source_patch` family, six of the eight `code` tools,
  `verification_record`, the five `attention` tools, `recall`, and `knowledge` were
  **never proposed or committed**. Generic `read` beats purpose-built `source_read`
  **82 : 6**. (`task_set_spec` / task-ledger and `plan-map` also scored zero, but
  they are `control_plane` surface — not in the model-facing payload — so their
  zero is structural, not evidence; they are out of this RFC's demotion scope, per
  the scope note.)
- **The documented surface policy is not what ships.** The capability view renders
  `load_when: active_or_accepted_skill` for skill tools and its policy text says
  "skill tools follow current skill commitments; requestable managed tools can be
  surfaced for one turn with an explicit `$name` request" — but the tape shows
  `activeCount` 91-94 every turn (base 35 + skill 47 + host primitives): the whole
  base+skill surface ships unconditionally. The `loadWhen` label is a manifest
  annotation, not a gate (axiom 19: a documented invariant nothing checks). This
  reframes the subtraction: **demotion is implementing the surface contract the
  docs already state**, not inventing a new mechanism. _Implemented (and
  review-hardened) in this branch_: `shouldExposeManagedTool` gates skill-surface
  tools on three turn-scoped pull channels — a `$name` in the user prompt, a
  `$name` the model wrote in its previous reply (the model-native self-pull;
  without it the hidden-tool hint would be a promise the model cannot act on),
  and the instructed-tool union of the skills rendered this turn (extracted from
  each SKILL.md's backticked tool mentions and carried on the selection receipt)
  — plus selected-capability authorization as the authority-gated path. The
  `load_when` label and the capability-view policy text read `explicit_request` —
  label and gate agree, and the core skills' instructed tools (e.g.
  `verification_record` in the verifier ladder) stay reachable on the turns
  those skills render.
- **The model prefers primitives even where the ontology is the textbook fit.**
  Session D asked for a codebase architecture summary over 32 files — the canonical
  use case for `code_digest` / `source_read` / the `attention` family. `glm5.2`'s
  first move was a raw shell `find … -name "*.py" … | grep -v … | sort` (it even
  guessed Python). It reached for Unix tooling it already knows, not the ontology
  brewva built for exactly this.
- **Three dead/debt surfaces surfaced during measurement** (independent of the model
  result, and each already an axiom violation):
  - `getEnvApiKey` (formerly the provider-core `./auth` subpath) mapped
    `deepseek` to `DEEPSEEK_API_KEY` etc. but had **zero in-repo callers** — an
    exported capability wired to nothing (axiom 19: an uninvoked promise). Deleted
    in this RFC's debt-repayment step, together with the subpath.
  - `skills.routing` / `skills.overrides` were removed from the schema but with **no
    migration shim** (`packages/brewva-runtime/src/config/field-policy.ts`): every
    existing config carrying those keys **fails config load at startup** today.
    Subtraction was done; the migration half of axiom 3 was not.
  - `source_read` **rejected the URI grammar models actually guess**: the resource
    router recognized only `brewva-resource:///`, `file://`, and bare paths, so a
    model-written `source:///packages/…` fell into the bare-relative-path branch
    and was joined into `<cwd>/source:/packages/…` → `not_found` (live tape:
    session `5d433e0b-7f11-4414-badc-5fffa2d6e360`, GLM5.2), after which the model
    fell back to host-plane `read`. The `uri` parameter documented no accepted
    form, and the error named the mangled path instead of the grammar — a
    plausible friction mechanism inside the 82:6 `read` : `source_read` ratio,
    which means part of that ratio measures a broken door, not a rejected
    ontology. Repaired in this RFC's debt-repayment step: the router now aliases
    `source:` (1-3 slashes, abs-or-repo-relative payload) to the file scheme,
    unknown schemes return `unknown_scheme` plus the accepted grammar instead of
    a path-mangled `not_found`, and `source_read.uri` carries a grammar
    description in its schema.
- **Headless has no in-loop approval path.** Both `--print` backends (embedded and
  gateway) suspend on the first `exec` (`approval_pending`) with no config/env/flag
  to auto-decide, so an unattended tool-using session cannot complete. For a harness
  that aims at auto-research, the absence of an _in-loop, out-of-authority_ approval
  policy is a structural gap, not a UX nit.

## Reasoning: Why This Is Crystallized Heuristic, Not Missing Adoption

The natural objection is _"the tools are unused because adoption is immature / the
prompt does not advertise them / the workspaces are small."_ The evidence answers
each:

- **Advertisement is not the gap.** All 94-95 tools were _surfaced_ (present in the
  model's schema every turn). The model saw `code_digest` and chose `find | grep`.
- **Scale is not the whole story.** The read-session corpus is a real 17 MB session
  index over genuine multi-thousand-file work, and _there_ `code_digest` still fires
  only 9 times against `read`'s 80. Session D exercised a real 5.5K-LOC package and
  still drew shell / `read`. Small synthetic workspaces explain some absence; they
  do not explain the large-corpus ratios.
- **This is the predicted behavior, not a surprise.** Lilian Weng's thesis is that
  harness value migrates _up_ the trajectory (instruction → context → workflow →
  harness code → optimizer) and that **crystallizing heuristics as fixed rules is
  precisely what stronger models make obsolete**. A specialized tool is a heuristic
  rule with a schema. `glm5.2` — a capable model — demonstrably prefers the general
  mechanism (`read` / `glob` / `edit` / `exec`) over the specialized rule. That is
  the thesis reproduced in brewva's own tape.

### Not every named tool is a heuristic: the receipt-plane exception

One correction the raw counts hide: several zero-invocation families are not
heuristics wearing schemas — they are **receipt surfaces** (axiom 5). The
`source_patch` family mints snapshot/patch receipts that `rollback_last_patch` and
recovery replay depend on; `verification_record` is the commit point for
verification outcomes. For these, "the model routed around it" does not merely mean
wasted schema tokens — it means the session may be **silently losing receipts**
today (an `edit` through the host plane only carries whatever the tool boundary
records, not what the specialized tool would have minted). The demotion rule for
receipt-bearing families is therefore stricter: **verify boundary-receipt
equivalence first** (the hosted tool boundary — ledger-writer — must mint the
equivalent receipt for the generic-plane path), move the receipt to the boundary if
it is missing, and only then demote the named tool. If the receipt only exists
inside the specialized tool, that is a pre-existing gap this measurement exposed —
the boundary fix is owed regardless of whether the demotion happens.

_Verified in this branch_: `source.patch.*` receipts are minted only inside the
`source_patch` tools (`families/navigation/source-patch.ts`); host-plane `edit`
never minted them, so `rollback_last_patch` never covered host edits — the gate
regresses nothing. Host-plane recoverability is carried by the world-checkpoint
substrate (checkpoint-coupled world snapshots and the rewind lane); minting
boundary-level patch receipts for host edits stays the owed follow-up only if
patch-granular rollback (rather than world rewind) is ever demanded there.
`verification_record` keeps its receipt plane reachable after the flip: the
deterministic producers and `review_request` still mint verification outcomes,
and the tool itself is one `$name` away.

So the ontology is not _pre-adoption_; it is a heuristic layer the model has already
routed around. Keeping it surfaced costs schema tokens (the very cost
[RFC: Accountable Tool-Schema Cost](./rfc-accountable-tool-schema-cost-and-deferred-definition-compression.md)
is trying to observe), widens the capability-selection decision space, and adds
context noise — while returning near-zero exercised value. Under axiom 15 (`Public
width should compress toward authority width`) and axiom 3 (`Subtraction beats
switches`), the surface should compress toward what the model actually reaches for.

Crucially, several active RFCs (durable-cross-session-planning-map,
attention-as-an-accountable-effect, capability-legibility) explicitly defer
promotion **until measured demand exists**. This RFC is the demand telemetry they
were waiting on, and it reads near-zero. That does not auto-kill those RFCs — but it
flips the burden of proof: their surfaces must now justify themselves against
observed non-use, not against assumed need.

## Decision Options (hypotheses)

- **Option A — Measure-then-subtract (recommended).** Instrument first: extend the
  offline calibration recipe (`bun run analyze:advisory-receipts`, per the
  advisory-receipt standard) with a per-family invocation view over any tape
  corpus, and land a hard **surface ceiling fitness** (max default-surfaced
  model-facing tools — pinned at the current count first as an anti-growth
  ratchet, then lowered with the demotion). A per-family invocation _fitness_ over
  a committed fixture corpus is deliberately NOT proposed: a fixture corpus small
  enough to commit cannot exercise the families, so the assertion would be a
  permanently-open census (the exact failure the census-subtraction decision just
  removed). Then demote: families that score zero across the real corpus leave the
  default surface — the mechanism is **implementing the documented surface policy**
  (base always; explicit request surfaces a tool for one turn), with
  receipt-bearing families gated on the boundary-receipt equivalence check above.
  Reversible (axiom 3): demotion first, deletion after the cross-model
  re-measurement confirms. _Landed in this branch_: the ceiling fitness
  (base 23 / skill 59 / default-surfaced 23), the per-family invocation view in
  `analyze:advisory-receipts`, the skill-surface pull gate, and the registry
  flips (the five `attention_*` tools, the six zero-invocation `code_*` tools,
  and `verification_record` moved base → skill). The default per-turn payload is
  now 23 managed tools plus host primitives; deletion remains gated on the
  cross-model re-measurement.
- **Option B — Keep, but stop surfacing by default.** Move the near-zero families
  behind the dormant `shadowToolAuthority` / `capability_expand` seam (already
  contemplated by the capability-legibility RFC) so they exist but do not cost
  schema/context by default. Lower blast radius, keeps optionality, but leaves the
  inventory large.
- **Option C — Status quo + observe.** Ship only the fitness _observability_ (no
  demotion) and re-decide after N weeks of real telemetry. Lowest risk, slowest.

The recommendation is **A**, staged as B-then-deletion: demote by default now
(reversible), delete per family only after the cross-model re-measurement and a
second corpus agree.

## The Forward Half: Closing The Optimizer Last-Hop On The Substrate We Already Built

Weng's endpoint is a harness that runs its own optimizer code inside a safe,
editable substrate, with the permission layer outside the loop. Brewva already has
every safety precondition — world/rewind isolation, replayable tape, fitness
scoring, capability fail-closed scoping — and uses them only for **manual**
provenance (decision records authored by humans). The last hop is to let those same
mechanisms drive an optimization loop:

1. **Make this measurement an in-repo self-eval, not an ad-hoc script.** The
   sandbox-in-a-world + real-tape + fitness-assertion recipe used here is exactly an
   ACE-grade eval loop; it should live behind a `report:` control-plane job over the
   world substrate.
2. **Parameterize what is currently asserted.** The attention/compaction constants
   (`predictedTurnGrowthRatio` ~0.175, `tailProtectRatio` ~0.2, a threshold of 3;
   `packages/brewva-runtime/src/config/normalize-infrastructure.ts`) justify their
   _mechanism_ in docs but never their _magnitude_ — asserted, not calibrated
   (axiom 7). Exposing them as searchable parameters gives an optimizer its first
   safe, reversible action surface; the tool-surface subset above is a second.
3. **Name the permission layer as the loop boundary.** The existing approval /
   capability fence is already the _outside-the-loop_ security layer Weng requires;
   the headless in-loop approval gap (a Findings item) is the one piece to add so
   the loop can run unattended without widening authority.

This half stays a **note**, not a landing plan — it is gated behind the subtraction
half and behind an explicit go-ahead. It is recorded here so the subtraction is
understood as the first step of an alignment direction, not an isolated cleanup.

Reconciliation constraint: the accepted
[advisory-receipt-and-calibration-standard](../decisions/advisory-receipt-and-calibration-standard.md)
decision holds that calibration derives reports and **rule changes land as reviewed
code, not a learning loop**. Any promotion of this forward half must either keep
the optimizer's outputs as proposals under that governed-promotion boundary (the
loop generates candidates + evidence; a human lands them), or explicitly supersede
that decision — it cannot silently route around it.

## Surface Budget

Counts are **model-facing** (base + skill families surfaced in a turn). Operator /
control-plane tools are excluded (not model-invoked; unmeasured here).

- Default-surfaced model-facing tools: **~94 → 23 managed + host primitives**
  (landed: the skill-surface pull gate plus the base → skill flips; the ceiling
  fitness pins base at 23). The `< 40` target is met with room.
- Required authored fields: **0 → 0** (no new authored fields).
- Author-facing concepts: **net negative** (retires the `source_patch`, `code`,
  `attention`, `verification_record`, `recall`, and `knowledge` tools as _default_
  model-facing surface; `plan-map` and task-ledger are `control_plane` and were
  never in it).
- Config keys: **0 new**; proposes one _tolerant-read migration behavior_ for the
  already-removed `skills.routing` / `skills.overrides` (warn-and-drop instead of
  fail-closed load) — a debt repayment, not a new key.
- Routing / control-plane decision points: **net negative** (fewer families for
  capability-selection to weigh).
- Inspect surfaces: **0 new**.
- Exported symbols: **-1** (`getEnvApiKey` removed, with its `./auth` subpath —
  it stopped being an uninvoked promise).

No positive delta requiring a debt owner. The one debt owner needed is for the
`skills.routing` migration shim (owner: runtime-config maintainer; re-evaluation
trigger: next config-schema change).

## Source Anchors

- Managed tool registry / metadata:
  `packages/brewva-tools/src/registry/managed-metadata.ts`,
  `packages/brewva-tools/src/registry/runtime-bound-tool.ts`.
- Model-facing surface event: `tool.surface.resolved` (`activeCount`,
  `activeToolNames`); invocation events `tool.proposed` / `tool.committed` on the
  session tape (`.brewva/tape/<sessionId>.jsonl`).
- Session-index read-model projection: `packages/brewva-session-index/src/index.ts`.
- Config field policy (the `skills.routing` / `skills.overrides` removal without
  migration): `packages/brewva-runtime/src/config/field-policy.ts`.
- Env-key dead surface: `getEnvApiKey` had zero in-repo callers and was deleted
  with its `./auth` subpath (formerly under `packages/brewva-provider-core/src/`;
  root export list: `packages/brewva-provider-core/src/index.ts`).
- Attention/compaction constants: context-budget normalization in
  `packages/brewva-runtime/src/config/normalize-infrastructure.ts`.
- Approval suspension in headless print: embedded/gateway print paths
  (`packages/brewva-cli/src/io/gateway-print.ts` and the embedded backend);
  `runtime.suspended` `cause=approval_pending` on the tape.

## Validation Signals

- **Confirming:** across n=12 real sessions, the named specialized families score
  zero `tool.committed` and zero `tool.proposed`; `read` : `source_read` is roughly
  80 : 6; the codebase-overview task (D) drew raw shell over `code_digest`.
- **Falsifying / still-owed:** a single model (`glm5.2`) produced the fresh-session
  data; the harness may have been tuned for models that use the ontology. The fresh
  workspaces are small; `code_digest` / `source_read` are scale tools. The corpus is
  n=12, not a statistical population. Schema presence is also not the same as
  effective instruction: `glm5.2` ran through a bare completions provider, so
  near-zero use partly measures prompt design rather than tool value. **Promotion
  requires re-measuring the fresh corpus across at least two additional models (one
  frontier, one mid-tier), including a taught-ontology control arm (a prompt
  variant that explicitly instructs when to use the specialized families), and
  confirming the near-zero result before any deletion** (demotion may proceed on
  current evidence since it is reversible).

## Promotion Criteria And Destination Docs

- Per-family invocation view landed in the offline calibration recipe
  (`analyze:advisory-receipts`) and the surface ceiling fitness landed and enforced
  (pinned, then lowered with the demotion).
- Cross-model re-measurement (at least two more models, including the
  taught-ontology control arm) confirms near-zero for the demoted families.
- Boundary-receipt equivalence verified (or the receipt moved to the boundary) for
  every receipt-bearing demoted family.
- `skills.routing` migration shim landed with a regression test that an existing
  config carrying the removed keys loads with a warning.
- On acceptance: ADR in `docs/research/decisions/`; contract text in
  `docs/architecture/system-architecture.md`; the compressed default surface in
  `packages/brewva-tools/src/registry/managed-metadata.ts`.

## Non-Goals

- Not touching the substrate/constitution layer (tape, WAL, world/rewind, fitness,
  capability fail-closed scoping, axioms).
- Not deleting `control_plane` / operator tools — unmeasured here.
- Not building the optimizer in this RFC. The forward half is a direction note,
  gated behind the subtraction and an explicit go-ahead.
- Not removing any family on current evidence alone — deletion waits for the
  cross-model confirmation; only reversible demotion proceeds now.

## Honest Limitations

Single-model fresh data (`glm5.2`); small synthetic build workspaces; n=12 is a
lead, not a population; headless `exec` truncation is argued (not proven) to be
non-biasing for the non-`exec` families under test. These are the reasons deletion
is gated and only reversible demotion is proposed now — consistent with axiom 3
(reversible subtraction) and axiom 7 (inconclusive is honest governance).

## Under The Line

`A tool the model never reaches for is a heuristic wearing a schema. Subtract the
ontology, keep the primitives — and let the substrate you already built calibrate
what remains.`
