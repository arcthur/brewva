# Research: Convention Projectors And Substrate Review

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-05-12`
- Parent note:
  `docs/research/decisions/convention-lifecycle-governance.md`
- Promotion target:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/events/README.md`
  - `docs/reference/runtime.md`

## Problem Statement

The convention lifecycle foundation now registers the full convention event
vocabulary, but only the admission/application path has internal producers.
Three event types are intentionally stable but not yet projector-owned:

- `convention_health_degraded`
- `convention_conflict_detected`
- `convention_contested`

This is acceptable for the first implementation because the parent RFC
explicitly allowed later phases to ship under their own decision records. It
becomes debt if the event catalog implies automatic runtime behavior before
the writer services exist.

This note owns the missing automatic producers:

1. Health projector for decay and stale convention detection.
2. Governed/Pinned contradiction detector backed by compiled predicates.
3. Substrate-change reviewer that uses selection-plane shadow replay.

## Current Boundary

Current implementation:

- explicit convention contest requests can write `convention_contested`
- approved convention mutations can write `convention_change_applied` or
  `convention_emergency_applied`
- no internal runtime service writes `convention_health_degraded`
- no internal runtime service writes `convention_conflict_detected`
- no substrate-change reviewer writes projector-owned `convention_contested`

Until this note is implemented, health/conflict events are reserved event
names, not active automation guarantees.

## Design Constraints

- Event tape remains the only replay authority.
- Projectors write events; they do not mutate workspace files directly.
- Claim ledger may expose inspectable operational claims, but it is not a
  second source of convention lifecycle authority.
- Soft-lane conventions are not compiled into obligation predicates.
- Shadow replay is limited to selection-plane behavior. Tool-result replay is
  forensic only.
- Pinned convention `owner` is metadata until actor identity is implemented;
  projector outputs cannot treat owner as authorization.

## Workstream 1: Health Projector

Inputs:

- accepted/consumed convention state rebuilt from tape
- recall curation signals
- verification pass/fail outcomes
- convention application and rollback receipts
- model/tool/rule metadata from `EvidenceRef`

Outputs:

- `convention_health_degraded` when kind-specific thresholds are crossed
- optional operational claims for inspectable convention health degradation

Required behavior:

- compute `last_hit_at`, `last_violated_at`, and `decay_score`
- never auto-degrade `pinned` or `non_retirable_without_owner`
- classify low-risk decay into digest, not interrupt
- keep thresholds keyed by `ConventionKind`, not global age

## Workstream 2: Conflict Detector

Inputs:

- active Governed/Pinned conventions
- project guidance frontmatter
- skill contract frontmatter and contract fields
- runtime config convention targets

Core model:

```ts
interface ConventionPredicate {
  scope: ScopePredicate;
  modality: "must" | "must_not" | "should" | "may";
  action: ActionPattern;
  priority: number;
  exception: ScopePredicate[];
  owner?: string;
}
```

Outputs:

- `convention_conflict_detected` for overlapping obligation conflicts
- optional operational claims for inspectable conflict state

Required behavior:

- compile only Governed/Pinned conventions
- detect `must(A)` versus `must_not(A)` under overlapping scope
- detect mutually exclusive `must(A)` and `must(B)` resource contention
- avoid semantic-similarity-only conflict detection

## Workstream 3: Substrate-Change Reviewer

Inputs:

- future `runtime_upgraded`, `tool_signature_changed`, and
  `model_version_changed` events
- active convention state
- sampled historical tape
- selection-plane replay harness

Outputs:

- projector-owned `convention_contested` only when confidence delta exceeds a
  configured threshold
- digest entries for sub-threshold drift

Required behavior:

- compute impacted convention set from evidence metadata and target paths
- shadow-replay selection-plane decisions, not tool outputs
- cap per-upgrade review volume to prevent upgrade storms
- require explicit operator decision before any mutation follows from a
  contested convention

## Validation Plan

- Unit tests for kind-specific decay thresholds and pinned non-degradation.
- Unit tests for predicate compilation and obligation conflict patterns.
- Contract tests proving projector events rebuild into `ConventionState`
  without claim ledger authority.
- Contract tests proving substrate-change review writes no workspace files.
- Property tests for shadow replay determinism over sampled event sequences.
- Event reference tests documenting producer maturity for reserved versus
  active convention event types.

## Promotion Criteria

This note can promote when:

1. `convention_health_degraded` has an internal health-projector writer.
2. `convention_conflict_detected` has a predicate-backed writer.
3. Projector-owned `convention_contested` is distinct from explicit user
   contest requests in payload provenance.
4. Shadow replay is selection-plane-only and covered by contract tests.
5. Event reference docs no longer describe these events as reserved.
