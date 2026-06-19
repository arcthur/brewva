# RFC: Reversible References, Advisory Compression Routing, And Replay-Distilled Precedent

## Metadata

- Status: active
- Implementation state: all three phases landed against a green check pipeline.
  - **Phase 1 (RCR):** vocabulary `RcrReference` core, `brewva-recall` resolver,
    `recall_expand` tool, and `workbench_evict` attachment for `event:` spans.
    Resolution projects only the model-visible content field (`tool.committed` →
    `result.content`, `msg`/`reason.committed` → `text`) so internal metadata is
    never reproduced. Deferred: compaction-drop attachment (the compaction
    transcript carries positional provider messages with no resolvable tape event
    id at the drop point) and exact distilled/injection-sanitized projection
    fidelity for tool outputs (the gateway-side projection is out of the recall
    boundary; v1 returns the committed model-visible content field, key-redacted).
  - **Phase 2 (ACR):** pure `detectContentShape` (brewva-std) and the
    `ReductionCandidate` builder (vocabulary), surfaced as the model-invoked
    advisory `context_route` tool rather than a pushed `context.contributor` (see
    the Direction note below). Deferred: the deterministic emergency cut-shape
    hint.
  - **Phase 3 (RDP):** deterministic analysis core (`collectRdpFailureSignals` →
    `distillFailurePatterns` → `renderRdpCandidate`, brewva-recall) plus the
    operator-invoked `script/rdp-distill.ts` job. Failures are identified by the
    authoritative outcome verdict (`"fail"`). Deferred: the LLM enrichment pass,
    the DuckDB query-plane read path, and `knowledge_search` over
    `.brewva/knowledge/**`.
- Owner: Runtime, recall, and gateway maintainers
- Last reviewed: `2026-06-14`
- Depends on:
  - [Decision: Context Operating System And Compaction Physics](../decisions/context-operating-system-and-compaction-physics.md)
- Promotion target:
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/solutions/README.md`
  - `docs/architecture/cognitive-product-architecture.md`

## Problem Statement

We want the three capabilities that make external context-compression systems
(specifically `headroom`) effective: reversible compression, multi-strategy
content-aware routing, and learning from prior failures. These capabilities are
attractive because they reduce token cost without destroying information, adapt
the reduction shape to the content, and stop an agent from repeating known
mistakes.

The difficulty is that `headroom` and Brewva hold **opposite positions on who
owns compression**. `headroom` is built on _the runtime owns compression_: an
out-of-band proxy detects content types, selects a strategy, compresses the
model's context, stores originals in a side database, and rewrites the agent's
instruction files so the next run silently inherits learned guidance. Brewva is
built on the inverse axiom: **the model owns attention**. Adaptive ranking and
summarization belong to the deliberation layer, never the kernel or runtime
physics; tape owns truth; the host is a gatekeeper, not a hidden memory editor.

A direct port of `headroom` would therefore violate Brewva's first and second
axioms and reintroduce both traps the context-OS RFC explicitly warns against:
the **prompt-manager trap** (the host silently injects, summarizes, and removes
context) and the **message-array trap** (compaction mutates conversation arrays
instead of producing auditable evidence).

This RFC takes the opposite engineering stance. It does not port a compression
engine. It **re-homes each of the three capabilities into the ring that already
owns the relevant authority**, reusing Brewva primitives instead of adding a
parallel mechanism. It also closes a concrete question already tracked as future
work in the context-OS RFC:

> cross-session long-memory responsibility boundaries between `brewva-recall`
> evidence and `session_compact` summaries when they refer to the same fact.

The answer this RFC commits to is that an eviction or compaction note carries the
canonical tape reference for the fact it replaces, so the fact has exactly one
source of truth (tape) and the note is a pointer plus advisory digest, never a
second authority.

## Scope Boundaries

In scope:

- **Reversible Context References (RCR):** tape-anchored, redaction-bounded
  references that reproduce the previously model-visible span behind an evicted or
  compacted span, plus an explicit `recall_expand` retrieval path. Re-homes
  `headroom` CCR.
- **Advisory Compression Routing (ACR):** a deliberation-ring content-shape
  detector that renders inspectable reduction candidates the model may adopt,
  plus optional cut-shape hints for the existing deterministic emergency
  compaction path. Re-homes `headroom` ContentRouter.
- **Replay-Distilled Precedent (RDP):** an opt-in control-plane job that distills
  failure and retry patterns from the session-index query plane into warm
  `.brewva/knowledge/**` promotion candidates (gated through `knowledge_capture`
  for promotion to active `docs/solutions/**` precedent), retrieved only by
  explicit search. Re-homes `headroom learn`.
- The invariants that keep all three inside Brewva's authority model.

Out of scope:

- a standalone content-hash store separate from tape (rejected as a second
  source of truth)
- runtime or kernel auto-detection or auto-application of compression on the
  default turn path
- automatic injection of learned guidance into prompts or instruction files
- cross-user or global learning (`headroom` TOIN-style shared tables)
- changes to context budget derivation, compaction eligibility, cut-point token
  mechanics, or `session_compact` authority (owned by the context-OS RFC)
- new ACP/MCP wire changes
- provider-specific memory products as replay authority

Out of scope but tracked for future work:

- promoting an ACR reduction candidate into a deterministic default-path
  transform (would require re-opening the model-attention boundary and is
  intentionally deferred)
- using RDP precedent as a verification-gate input rather than advisory recall

## Why

### Why each capability is worth having

Reversible compression lets a session drop large, low-salience spans (tool
output, search results, diffs) from active attention while keeping the option to
recover the exact original later. Without reversibility, every eviction is a
lossy bet; with it, the model can be aggressive about working-memory hygiene
because nothing committed is actually lost.

Content-aware routing matters because a single reduction shape is wrong for
heterogeneous content. A JSON array, a build log, a unified diff, and a search
result page each have a different "what is safe to drop" profile. Choosing the
shape per content type is what makes `headroom` reach high reduction ratios
without measurable task-quality loss.

Learning from prior failures closes the loop that coding agents otherwise leave
open: the same missing file, the same permission error, the same blind retry,
session after session. Distilling those into retrievable precedent is high
leverage.

### Why a direct port is the wrong design

Every `headroom` mechanism assumes the runtime may act on the model's context
without the model's participation. In Brewva that assumption is the failure
mode, not the feature:

- `headroom` ContentRouter auto-selects a strategy. Brewva forbids adaptive
  logic in the kernel and forbids the runtime owning salience judgment. So
  routing cannot be a default-path runtime transform; it can only be an
  inspectable candidate the model adopts, or a bounded emergency-physics hint.
- `headroom` CCR keeps originals in a side database. Brewva already has a
  content-addressed source of committed truth: the event tape. A second store
  would duplicate tape's responsibility and create two recovery semantics that
  can disagree after a crash.
- `headroom learn` rewrites instruction files that are silently re-injected.
  Brewva forbids hidden context injection and already has a cold-knowledge plane
  (`docs/solutions/**`) whose entire contract is explicit-pull retrieval with a
  defined power order below code and promoted docs.

### Why re-homing is strictly better here

Re-homing reuses three mechanisms Brewva already maintains — tape, the
workbench/recall plane, and the session-index query plane — instead of running a
parallel compression stack with its own store, its own router, and its own
file-rewriting side effects. It keeps replay authority in one place, keeps the
model in control of its own attention, and keeps learned knowledge inspectable
and demotable. It also directly answers the fact-ownership question the
context-OS RFC left open, which means this RFC reduces an open architectural
question rather than adding one.

## Direction

Present the three capabilities as **model-operated, runtime-governed, and
receipt-anchored**, exactly like the context-OS RFC presents compaction:

1. **Reversibility is a tape reference, not a copy.** When the model evicts or
   compacts a span, the resulting workbench note may carry a canonical reference
   (and digest) to the _previously model-visible, sanitized_ content the span
   replaced. Reversal recomputes that exact sanitized span through recall, using
   the same redaction layer that already governs tape-evidence consumption. There
   is no second store and no lossy placeholder; an unresolvable or sensitive
   reference fails closed to an inspectable posture rather than widening
   visibility.
2. **Routing is an advisory candidate, not a transform.** A deliberation-ring
   contributor detects content shape and renders a bounded, inspectable
   reduction candidate (shape, estimated savings, reversibility reference). The
   model decides. The runtime never mutates attention from this signal. The only
   place the detector may influence bytes is the already-existing deterministic
   emergency cut path, and only as a cut-shape hint that remains
   replay-non-authoritative until `session_compact`.
3. **Learning is distilled precedent, not injected memory.** An opt-in
   control-plane job reads the rebuildable session-index over tape, distills
   failure and retry patterns, and writes them as _promotion candidates_ into the
   warm `.brewva/knowledge/**` layer, each carrying an investigation-record-shaped
   artifact. Promotion to an active `docs/solutions/**` record happens only
   through `knowledge_capture` under human review. Candidates and records are
   retrieved only when the model explicitly searches for them, and they sit at or
   below their respective power-order ranks, never above current code or promoted
   docs.

This preserves Brewva's posture: the model is an active context operator, the
host is a gatekeeper, replay truth stays in tape, and advisory material stays
inspectable and demotable.

## Architectural Positions

- **No second source of truth.** RCR introduces no store. Originals already live
  on the event tape as content-addressed committed facts (`msg.committed`,
  `tool.committed`). An RCR reference is a vocabulary-owned value that points at a
  tape event and a canonical sanitized span within it (see the RCR schema below).
  The note is a pointer; tape remains the only authority. This is the resolution
  of the context-OS RFC's open fact-ownership question.
- **Reversal reproduces the model-visible span, or fails closed.**
  `recall_expand` must return the exact span the model previously saw, recomputed
  through the same redaction layer that governs `session_tape_evidence`
  consumption and verified against a named digest. This maps `headroom`'s
  byte-faithfulness invariant (I1) onto Brewva's "tape owns truth" _without_
  widening visibility: RCR never exposes raw command, content, credential, or
  result payloads that were not part of the original sanitized model-visible
  projection. If the event is unavailable, the digest does not match, or the span
  would expose withheld payload, the result is an inspectable
  `unresolvable_reference` (or `sensitive_payload_withheld`) posture, never a
  silent summary, approximate reconstruction, or privilege escalation.
- **Routing authority stays in deliberation.** ACR detection and candidate
  generation are advisory and declare an ambient capability class of `pure` or
  `read_tape`. They never call kernel admission, never mutate workbench state,
  and never auto-apply a reduction. They emit inspectable attention candidates
  only.
- **Emergency physics may consume detection, narrowly.** The deterministic
  emergency compaction path defined by the context-OS RFC may consult ACR
  detection to choose a better cut shape under hard pressure. This is the only
  runtime-physics consumer, it is bounded, and its output is non-authoritative
  until a `session_compact` receipt is committed.
- **Learning is opt-in control-plane, not background runtime.** RDP runs as an
  explicitly invoked job, not on the turn path. Its input is the rebuildable
  `brewva-session-index` DuckDB plane over tape, not external agent logs. Its
  output is _promotion candidates_ in the warm `.brewva/knowledge/**` layer, never
  `status: active` records written directly. Promotion to an active
  `docs/solutions/**` precedent runs only through `knowledge_capture` with the
  required `investigation_record` authority and human review, preserving the
  power order (code > promoted docs > active solution records > promotion
  candidates > workbench notes).
- **Per-repository only.** RDP never aggregates across users or repositories;
  cross-repo learning would cross the repository-governance boundary and is out
  of scope.

## Source Anchors

Stable docs and project rules:
`docs/research/decisions/context-operating-system-and-compaction-physics.md`,
`docs/architecture/design-axioms.md`,
`docs/architecture/cognitive-product-architecture.md`,
`docs/architecture/invariants-and-reliability.md`,
`docs/reference/tools/memory-and-recall.md`,
`docs/reference/extensions.md`,
`docs/solutions/README.md`,
`skills/project/shared/package-boundaries.md`.

Internal implementation anchors:
`packages/brewva-vocabulary/src/workbench.ts`,
`packages/brewva-vocabulary/src/internal/workbench.ts`,
`packages/brewva-vocabulary/src/session.ts`,
`packages/brewva-runtime/src/runtime/tape/impl.ts`,
`packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts`,
`packages/brewva-recall/src/types.ts`,
`packages/brewva-recall/src/broker/broker.ts`,
`packages/brewva-recall/src/evidence`,
`packages/brewva-recall/src/knowledge`,
`packages/brewva-tools/src/families/memory/workbench.ts`,
`packages/brewva-tools/src/families/memory/recall.ts`,
`packages/brewva-session-index/src/query`,
`packages/brewva-session-index/src/evidence`,
`packages/brewva-gateway/src/extensions/api.ts`,
`packages/brewva-gateway/src/hosted/internal/context/materialization.ts`,
`packages/brewva-gateway/src/hosted/internal/context/compaction-input-provenance.ts`,
`packages/brewva-gateway/src/hosted/internal/compaction/summary-generator.ts`.

External comparison anchors:
`/Users/bytedance/new_py/headroom/headroom/ccr/tool_injection.py`,
`/Users/bytedance/new_py/headroom/headroom/ccr/response_handler.py`,
`/Users/bytedance/new_py/headroom/headroom/transforms/content_router.py`,
`/Users/bytedance/new_py/headroom/headroom/learn/analyzer.py`,
`/Users/bytedance/new_py/headroom/headroom/learn/writer.py`.

## Ring Homing Summary

| `headroom` mechanism                       | Brewva ring / plane                                            | Reused primitive                                                                                 | Added contract                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CCR store + `headroom_retrieve` tool       | Tape (truth) + Workbench (advisory)                            | content-addressed tape events, `recall_search`, Dropped Digests allowlist, compaction provenance | RCR: vocabulary-owned tape-ref eviction/compaction notes + redaction-bounded `recall_expand` reproducing the previously model-visible span |
| ContentRouter auto-detect + auto-apply     | Deliberation ring (advisory); Runtime physics (emergency only) | `context.contributor` advisory slot, attention candidates, deterministic emergency cut           | ACR: content-shape detector to inspectable reduction candidates; bounded emergency cut-shape hint                                          |
| `learn` (scrape logs to instruction files) | Control plane (opt-in) to cold-knowledge plane                 | `brewva-session-index` DuckDB over tape, `docs/solutions/**`, `knowledge_search`                 | RDP: replay-distilled promotion candidates, `knowledge_capture`-gated, explicit-pull only                                                  |

## Architecture Proposal

### 1. RCR: Reversible Context References

Extend the workbench eviction and compaction note shape — a vocabulary-owned
schema, not a runtime one — so a note may carry an optional reversible reference
to the _previously model-visible, sanitized_ content it replaced:

```
RcrReference {                       // owned by @brewva/brewva-vocabulary
  schema: "brewva.rcr.reference.v1"  // single version pin for canonicalization, digest algorithm, and encoding
  eventRef: { sessionId, eventId }   // stable tape event identity, not a raw byte offset
  contentPath: string                // canonical dotted path into the event payload; "" selects the whole payload
  contentDigest: string              // sha-256 hex over the redacted, stable-key-ordered JSON of the located content
}
```

Why this shape and not a raw byte range: tape events are structured records with
multiple fields, and `session_tape_evidence` consumption is already redacted, so
a bare `{ start, end }` over "the event payload" cannot survive JSON
re-serialization, index rebuild, or replay, and could leak unredacted payload.
The reference instead locates content by a stable event identity plus a
`contentPath` into the event payload. The `schema` version is the single pin for
the canonicalization, digest algorithm, and encoding — v1 is sha-256 (lowercase
hex, utf-8) over the redaction-bounded, stable-key-ordered JSON serialization of
the located content. Pinning these to the version rather than storing them per
instance keeps the digest deterministic and verifiable across replay and index
rebuild without carrying redundant constant fields; a future v2 can change the
rules and resolvers branch on `schema`.

The reference is **derived from tape, not copied from it**. When the model uses
`workbench_evict` or a span is dropped during `workbench_compact`/`session_compact`,
the runtime records a receipt whose note carries this vocabulary-typed reference
for the dropped content, rather than only an allowlisted Dropped Digest. This
makes the existing Dropped Digests allowlist recoverable instead of merely
auditable.

Add a recall verb, `recall_expand`, in the memory-and-recall tool family:

- input: an `RcrReference` (or a workbench note id that carries one)
- capability: a dedicated expansion capability, distinct from ordinary recall
  search, resolved through the same redaction layer as `session_tape_evidence`
  consumption
- behavior: re-derive the canonical sanitized span through `brewva-recall`,
  verify it against `contentDigest`, and return the exact span the model
  previously saw
- fail-closed: yield `unresolvable_reference` if the event is gone or the digest
  mismatches, and `sensitive_payload_withheld` if the span would expose command,
  content, credential, or result payload outside the original sanitized
  projection — never raw bytes, never an approximate reconstruction, never new
  visibility

`recall_expand` may be folded into `recall_search` as a reference-resolution mode
rather than a separate tool if the surface budget review prefers it; the contract
is identical either way.

Authority placement: the reference schema lives in `@brewva/brewva-vocabulary`
(extending `WorkbenchEntry` and the compaction provenance types); the runtime
tape only records receipts/events that carry the vocabulary-typed reference and
does not own its shape; resolution and redaction live in `@brewva/brewva-recall`
(broker/evidence); the verb lives in `@brewva/brewva-tools` memory family. Tape
is the substrate; no new package and no new store.

### 2. ACR: Advisory Compression Routing

Add a deliberation-ring advisory contributor that, given a candidate span the
model is considering reducing, renders an inspectable reduction candidate:

```
ReductionCandidate {
  spanRef: string                   // span label the model can act on
  detectedShape: "json_array" | "build_log" | "unified_diff" | "search_results" | "prose" | "unknown"
  suggestedReduction: string        // human-inspectable description of the proposed shape
  estimatedTokensSaved: number
  confidence: "low" | "medium" | "high"
  indicators: string[]              // signal names that drove the classification, for inspectability
}
```

The detector is the brewva-native counterpart of `headroom`'s ContentRouter
strategy table (SmartCrusher for JSON arrays, log extraction, diff condensation,
search top-k). The difference is decisive: in `headroom` the router _applies_ the
strategy; here it only _describes a candidate_. The advisory surface:

- is pure: it reads only the content the model hands it, records nothing, and
  declares no runtime capabilities
- returns a `ReductionCandidate` (or null) as an inspectable result
- never mutates attention, never calls admission, never applies a reduction

The model adopts a candidate by issuing its own workbench operation
(`workbench_evict`/`workbench_compact`), at which point RCR attaches the
reversible reference. This keeps the entire path inside "model owns attention".

**Direction note — pull tool, not pushed contributor.** This RFC first framed ACR
as a pushed `context.contributor` advisory extension. The implementation instead
exposes it as the model-invoked `context_route` tool, and that is the better fit:
a pushed contributor injects candidates into the prompt — exactly the
prompt-manager trap this RFC warns against — whereas a pull tool lets the model
ask "how would I reduce this?" only when it chooses, keeping attention fully
model-owned. The pure detector also has no clean message-content seam in the
gateway's `beforeAgentStart` context assembly. The `context.contributor` slot
stays available for a future opt-in push surface.

Deferred runtime-physics consumer: the deterministic emergency compaction path
defined by the context-OS RFC may later consult the same pure detector to choose
a safer cut shape (for example, prefer dropping a detected log tail over splitting
a tool-result pair) — bounded, emergency-path-only, and non-authoritative until a
`session_compact` receipt commits. This hint is not yet wired (the current
cut-point selector has no clean shape-aware seam) and is tracked as a follow-up.

Authority placement: the pure detector is a small shape-detection module in
`@brewva/brewva-std`; the `ReductionCandidate` builder is vocabulary-owned; the
`context_route` tool lives in `@brewva/brewva-tools`. No extension slot, no
attention mutation, no admission.

### 3. RDP: Replay-Distilled Precedent

Add an opt-in control-plane job (operator-invoked CLI command and/or a hosted
routine) that distills precedent from tape:

- **Input:** the rebuildable `brewva-session-index` DuckDB query plane over the
  session event tapes. Query for `tool.committed` failures, `tool.aborted`
  events, and repeated retries against the same target. This is replay-derived
  and rebuildable; it is not external agent log scraping.
- **Analysis:** an LLM pass (via `@brewva/brewva-provider-core`) summarizes each
  recurring failure pattern into a candidate record. This mirrors
  `headroom/learn/analyzer.py` but reads tape, not `~/.claude` logs.
- **Output:** _promotion candidates_ in the warm `.brewva/knowledge/**` layer,
  not `status: active` records. Each candidate carries an
  investigation-record-shaped artifact derived from the tape evidence (failure
  class, symptoms, failed attempts, observed resolution), because
  `docs/solutions/**` bug-fix and incident capture requires `investigation_record`
  authority and a `Failed Attempts` section. Promotion to an active solution
  record under `docs/solutions/<problem-family>/` happens only through
  `knowledge_capture` with human review; RDP never writes `status: active`
  directly and never merges silently into runtime authority.

Retrieval is explicit-pull only, through `knowledge_search`/`recall_search`,
exactly as the cold-knowledge plane already works. A promotion candidate ranks
below active precedent, which itself ranks below promoted docs and current code,
so learned precedent never auto-injects into prompts and never outranks code. The
loop is honest: the model searches precedent when it chooses to, and operators
promote, demote, or delete records.

Authority placement: the job lives in `@brewva/brewva-gateway` (control plane)
and/or `@brewva/brewva-cli` (operator command); it reads `brewva-session-index`,
writes promotion candidates into `.brewva/knowledge/**`, and uses
`knowledge_capture` for any promotion to `docs/solutions/**`. It holds no kernel
authority and emits no verification-gate input.

Implementation note (v1): the landed job is deterministic, not LLM-backed — it
identifies failures by the authoritative outcome verdict (`"fail"`), groups
recurring `(toolName, failureClass)` patterns, and renders an
investigation-record-shaped candidate with the Observed Resolution left for human
or `knowledge_capture` review. It currently reads `events.records` over tape
(still rebuildable, replay-derived) rather than the DuckDB query plane, and ships
as `script/rdp-distill.ts` rather than a gateway routine. The LLM enrichment pass,
the DuckDB read path, and the hosted-routine form are tracked follow-ups.

## How To Implement

### Phase 0: Boundary Confirmation And Characterization

- Confirm the vocabulary-owned workbench/compaction note shape that will carry
  `RcrReference` (extending `WorkbenchEntry` and the compaction provenance types
  in `@brewva/brewva-vocabulary`), and confirm it composes with the existing
  Dropped Digests allowlist and `SessionCompactionInputProvenance` rather than
  replacing them.
- Confirm `brewva-recall` can re-derive a sanitized model-visible span through the
  existing redaction layer and verify it against a named digest, and define the
  `unresolvable_reference` and `sensitive_payload_withheld` postures.
- Confirm the `context.contributor` advisory result shape can carry
  `ReductionCandidate` without widening any authority.
- Confirm `brewva-session-index` exposes the failure/retry queries RDP needs, and
  confirm `.brewva/knowledge/**` is the correct promotion-candidate location.

### Phase 1: RCR (highest alignment, highest value)

- Add `RcrReference` to the workbench eviction and compaction note schema in
  `@brewva/brewva-vocabulary` (extending `WorkbenchEntry` and the compaction
  provenance types); the runtime tape only records receipts/events that carry the
  vocabulary-typed reference.
- Attach references when the model evicts a span and when compaction drops a span
  with a recoverable, previously model-visible original.
- Implement `recall_expand` (or the `recall_search` resolution mode) in the memory
  tool family backed by `brewva-recall`, resolving through the same redaction
  layer as `session_tape_evidence` consumption and declaring a dedicated
  expansion capability.
- Enforce the contract: reproduce the previously model-visible sanitized span
  verified against the named digest, or fail closed.
- Add fitness coverage: a reference resolves to content identical to the
  previously model-visible sanitized span (stable across replay and index
  rebuild); a missing event or digest mismatch yields `unresolvable_reference`; a
  span that would expose withheld payload yields `sensitive_payload_withheld`; no
  second store is introduced.

### Phase 2: ACR (advisory routing)

- Add the pure content-shape detector module (JSON array, build log, unified
  diff, search results, prose).
- Add the `context.contributor` advisory contributor that renders
  `ReductionCandidate` options, declaring `pure`/`read_tape` capability.
- Wire the same detector into the deterministic emergency cut selector as a
  cut-shape hint only.
- Add fitness coverage: candidates never mutate attention or call admission; the
  emergency hint stays non-authoritative until `session_compact`; the default
  turn path applies no automatic reduction.

### Phase 3: RDP (replay-distilled precedent)

- Add the opt-in control-plane/CLI job reading `brewva-session-index`.
- Add the LLM distillation pass producing investigation-record-shaped promotion
  candidates.
- Write promotion candidates into `.brewva/knowledge/**`; gate any promotion to
  active `docs/solutions/**` precedent through `knowledge_capture` with
  `investigation_record` authority and human review.
- Add fitness coverage: no prompt auto-injection; RDP never writes `status:
active` directly; output is retrieved only via explicit search; candidates rank
  below active precedent in the power order; the job holds no kernel authority and
  aggregates no cross-repository data.

## Validation Signals

Required tests and checks:

- RCR reversal fitness: resolved content equals the previously model-visible
  sanitized span (stable across replay and index rebuild) for representative
  content types
- RCR redaction fitness: expansion resolves through the shared redaction layer and
  never exposes command, content, credential, or result payload outside the
  original sanitized projection
- RCR fail-closed fitness: a missing event or digest mismatch yields
  `unresolvable_reference`, and a withheld-payload span yields
  `sensitive_payload_withheld`, never approximate content or new visibility
- RCR single-source fitness: no second persistent store is created; tape remains
  the only authority
- ACR non-mutation fitness: advisory candidates never mutate workbench attention,
  never call kernel admission, and never auto-apply a reduction
- ACR emergency-hint fitness: the cut-shape hint affects only cut location, runs
  only on the emergency path, and is non-authoritative until `session_compact`
- ACR default-path fitness: no automatic compression occurs on the ordinary turn
  path
- RDP candidate-only fitness: RDP writes promotion candidates into
  `.brewva/knowledge/**` and never writes `status: active` directly; active
  promotion requires `knowledge_capture` with `investigation_record` authority
- RDP explicit-pull fitness: distilled candidates are never auto-injected and are
  retrieved only through explicit search
- RDP power-order fitness: candidates rank below active precedent, which ranks
  below promoted docs and current code, and any record can be demoted or deleted
- RDP boundary fitness: no cross-repository or cross-user aggregation
- docs verification with `bun run test:docs`
- Markdown formatting check with `bun run format:docs:check`

Promotion should also require at least one inspect artifact showing a reversible
reference resolving to its previously model-visible span, and at least one example
distilled promotion candidate produced from real session-index data.

## Surface Budget

_Counts are net additions introduced by this RFC (`before = 0`), except
author-facing concepts, which counts against the established public set._

| Surface                               | Before | After | Notes                                                                                                           |
| ------------------------------------- | -----: | ----: | --------------------------------------------------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | No new required user-authored configuration.                                                                    |
| Optional authored fields              |      0 |     0 | RDP is opt-in by invocation (`bun run rdp:distill`); no authored config field.                                  |
| Author-facing concepts                |      4 |     7 | Adds reversible reference (RCR), content-shape routing (`context_route`), and replay-distilled precedent (RDP). |
| Routing/control-plane decision points |      0 |     1 | The opt-in RDP distillation run. ACR and RCR add none.                                                          |
| Inspect surfaces                      |      0 |     0 | No new inspect surface in this pass.                                                                            |
| Public tools                          |      0 |     2 | `recall_expand` and `context_route`; both could later fold into existing verbs.                                 |
| Advisory extension slots              |      0 |     0 | ACR ships as the model-invoked `context_route` tool, not an extension slot.                                     |

Positive surface delta:

- Debt owner: runtime, recall, and gateway maintainers.
- Why unavoidable: reversibility, content-aware reduction shaping, and precedent
  distillation are genuinely new capabilities; the budget is kept minimal by
  reusing tape, the recall plane, and the `.brewva/knowledge/**` plus
  `docs/solutions/**` planes instead of adding a store, a router, or an injector.
- Dated re-evaluation trigger: by `2026-09-30`, before any promotion to
  `docs/research/decisions/`, re-evaluate whether the two new tools
  (`recall_expand`, `context_route`) should collapse into existing verbs, whether
  the one control-plane decision point remains justified, and whether the RDP job
  warrants a stable CLI surface.

## Promotion Criteria

Move this note to `docs/research/decisions/` only after:

- RCR references resolve to the byte-exact previously-model-visible sanitized span
  under fitness tests, through the shared redaction layer, with proven
  `unresolvable_reference` and `sensitive_payload_withheld` postures and no second
  source of truth
- ACR candidates are advisory-only under fitness tests, the emergency hint stays
  non-authoritative, and the default path applies no automatic reduction
- RDP writes only promotion candidates, gates active promotion through
  `knowledge_capture` with `investigation_record` authority, is explicit-pull
  only, obeys the power order, and aggregates no cross-repository data under
  fitness tests
- the fact-ownership boundary tracked by the context-OS RFC is documented as
  resolved by RCR in stable docs
- stable docs carry the accepted contracts for all three capabilities
- source anchors in this note either move into stable docs or decision records

## Open Questions

- Should `recall_expand` remain a separate verb or collapse into a
  `recall_search` resolution mode? (Surface-budget preference: collapse.)
- What is the right confidence threshold for an ACR `ReductionCandidate` to be
  surfaced at all, so the option set stays small and high-signal?
- Should RDP distillation run as an operator CLI command, a hosted routine, or
  both, and what is the minimal opt-in configuration?
- When an RCR reference and an RDP solution record refer to the same incident,
  how should inspect surfaces cross-link them without implying shared authority?
