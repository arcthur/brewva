# Research Docs (Incubation Layer)

`docs/research/` is the incubation layer for cross-cutting design work that is
not yet stable enough for `docs/architecture/` or `docs/reference/`.
This root page is a navigation and promotion playbook, not a stable product or
runtime contract.

The root stays intentionally small:

- workflow guidance for research notes
- lifecycle indexes for active, promoted, and archived notes

## Layout

- root
  - workflow guidance and lifecycle indexes only
- `docs/research/active/`
  - open incubation notes and planning material
  - split themes so they can be promoted or archived independently
- `docs/research/promoted/`
  - concise promoted status pointers
  - current contracts live in stable docs and code; these notes keep rationale,
    non-goals, and migration breadcrumbs
- `docs/research/archive/`
  - historical, superseded, or migration-focused notes
  - terminology may differ from current stable docs

## When to add a research note

- A decision spans multiple packages or runtime semantic surfaces / authority
  boundaries.
- The team needs to compare alternatives before locking a contract.
- Validation criteria are known, but implementation is still evolving.

Create new incubation notes under `docs/research/active/`.
Once a note is accepted, either:

1. promote it into stable docs and collapse it into a concise pointer under
   `docs/research/promoted/`, or
2. archive it under `docs/research/archive/` when it is mainly historical or
   superseded.

## Required metadata for active research notes

- `Status`: `proposed` | `active`
- `Owner`: responsible team or maintainer group
- `Last reviewed`: date in `YYYY-MM-DD`
- `Promotion target`: destination stable document(s)

## Required sections for active research notes

- Problem statement and scope boundaries
- Hypotheses or decision options
- Source anchors (code and docs paths)
- Validation signals (tests, metrics, or operational checks)
- Promotion criteria and destination docs

Promoted and archived notes retain the same metadata for traceability, but they
may be much shorter once the stable contract is carried elsewhere.

## Promotion workflow

1. Track open questions and hypotheses in a focused active note under
   `docs/research/active/`.
2. Validate with code changes, tests, and operational evidence.
3. Promote accepted decisions into stable docs:
   - `docs/architecture/` for design/invariant decisions
   - `docs/reference/` for public contracts
   - `docs/journeys/operator/` for operator workflows
   - `docs/journeys/internal/` for cross-package review flows
4. Move the research note to `promoted/` as a concise pointer or to `archive/`
   as a historical record.

## Governance Loop

Use `docs/research/**` as a managed incubation layer, not as a second stable
contract tree.

- `active/`
  - keep notes narrow and decision-shaped
  - review whenever the target stable docs change materially, and otherwise on
    a short operational cadence
  - once the promotion criteria are satisfied, convert the note into either a
    concise promoted pointer or an archive-era rationale record instead of
    letting it linger as a long-lived parallel spec
- `promoted/`
  - keep notes short; they preserve rationale, non-goals, and migration
    breadcrumbs after the stable docs absorb the contract
  - refresh `Last reviewed` when a stable-doc audit materially changes the
    target surfaces, but update the stable docs first
  - do not let promoted notes expand back into active RFCs
- `archive/`
  - keep notes intentionally historical
  - refresh only when the historical breadcrumb is wrong, the target stable
    references move, or the archive summary becomes misleading

Governance default:

1. code and stable docs move first
2. research notes are then either promoted, refreshed as concise pointers, or
   archived
3. if a note still carries unresolved design options, it stays `active`; if it
   only carries accepted rationale, it should not stay `active`

## Proposed notes

None currently.

## Active notes

- `docs/research/active/event-stream-consistency-and-replay-fidelity.md`
- `docs/research/active/context-budget-behavior-in-long-running-sessions.md`
- `docs/research/active/recovery-robustness-under-interrupt-conditions.md`
- `docs/research/active/cost-observability-and-budget-governance.md`
- `docs/research/active/rollback-ergonomics-and-patch-lifecycle-safety.md`
- `docs/research/active/prefix-stable-context-management-and-progressive-compaction.md`
- `docs/research/active/recovery-first-context-governance-and-history-view-baselines.md`

## Promoted notes (status pointers)

- `docs/research/promoted/rfc-architecture-doc-precision-review.md`
- `docs/research/promoted/rfc-authority-surface-narrowing-and-runtime-facade-compression.md`
- `docs/research/promoted/rfc-boundary-first-subtraction-and-model-native-recovery.md`
- `docs/research/promoted/rfc-boundary-policy-credential-vault-and-loop-guard.md`
- `docs/research/promoted/rfc-capability-compression-and-output-distillation.md`
- `docs/research/promoted/rfc-default-path-re-hardening-and-advisory-surface-narrowing.md`
- `docs/research/promoted/rfc-derived-session-wire-schema-and-frontend-session-protocol.md`
- `docs/research/promoted/rfc-durability-taxonomy-and-rebuildable-surface-narrowing.md`
- `docs/research/promoted/rfc-gateway-experience-ring-decomposition.md`
- `docs/research/promoted/rfc-hosted-turn-transitions-and-bounded-recovery.md`
- `docs/research/promoted/rfc-inspectable-operator-experience-overlays.md`
- `docs/research/promoted/rfc-iteration-facts-and-model-native-optimization-protocols.md`
- `docs/research/promoted/rfc-kernel-level-reasoning-revert-and-branch-continuity.md`
- `docs/research/promoted/rfc-model-native-product-reconstruction-and-closure-vnext.md`
- `docs/research/promoted/rfc-narrative-memory-product-and-bounded-semantic-recall.md`
- `docs/research/promoted/rfc-preparse-normalization-model-capability-and-live-audit-split.md`
- `docs/research/promoted/rfc-repository-fitness-plane-and-runtime-boundary.md`
- `docs/research/promoted/rfc-repository-native-compound-knowledge-and-review-ensemble.md`
- `docs/research/promoted/rfc-schedule-intent-hardening-and-control-plane-ergonomics.md`
- `docs/research/promoted/rfc-skill-contract-layering-project-context-and-explicit-activation.md`
- `docs/research/promoted/rfc-skill-distribution-refresh-and-catalog-surface.md`
- `docs/research/promoted/rfc-specialist-subagents-and-adversarial-verification.md`
- `docs/research/promoted/rfc-tool-search-advisor-and-auto-broadened-discovery.md`
- `docs/research/promoted/rfc-workflow-artifacts-and-posture-control-plane.md`

See `docs/research/promoted/README.md` for thematic grouping and the
status-pointer catalog.

## Archived / superseded notes

- `docs/research/archive/rfc-advisor-consultation-primitive-and-specialist-taxonomy-cutover.md`
- `docs/research/archive/rfc-delegation-protocol-thinning-and-replayable-outcomes.md`
- `docs/research/archive/rfc-deliberation-home-and-compounding-intelligence.md`
- `docs/research/archive/rfc-effect-governance-and-contract-vnext.md`
- `docs/research/archive/rfc-invocation-spine-and-posture-runtime-vnext.md`
- `docs/research/archive/rfc-runtime-decomposition-and-deliberation-thickening.md`
- `docs/research/archive/rfc-session-wire-v2-attempt-scoped-live-tool-frames.md`
- `docs/research/archive/rfc-skill-first-delegation-and-execution-envelopes.md`
- `docs/research/archive/rfc-subagent-delegation-and-isolated-execution.md`

See `docs/research/archive/README.md` for thematic grouping and historical
rationale catalog.

## Indexes

- Active research notes: `docs/research/active/README.md`
- Promoted research notes: `docs/research/promoted/README.md`
- Archived research notes: `docs/research/archive/README.md`

## Authority Rules

- Current code, tests, and runtime evidence outrank research notes.
- Stable architecture and reference docs outrank promoted research notes.
- Promoted notes may retain rationale and non-goals, but they are no longer the
  primary contract surface.
- Archived notes are historical only; read them for migration context and
  regression archaeology, not for current API truth.

## Related Docs

- Documentation map: `docs/index.md`
- Stable design docs: `docs/architecture/system-architecture.md`
- Stable contract docs: `docs/reference/runtime.md`
- Operator and internal workflows: `docs/journeys/README.md`
- Repository precedent layer: `docs/solutions/README.md`
