# Research: Architecture Doc Precision Review

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-03-23`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/control-and-data-flow.md`

## Direct Conclusion

The architecture layer is directionally strong, but not uniformly precise.

The current split is:

- precise and stable:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/invariants-and-reliability.md`
- mostly precise, but requires tight sync with implementation:
  - `docs/architecture/system-architecture.md`
- directionally right, but soft enough to drift if read as authority:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/control-and-data-flow.md`

The failure mode is not that architecture chooses the wrong direction. The
failure mode is that product-shape prose is sometimes read as if it were an
authority contract.

## Current Status

Stable architecture docs now include explicit interpretation-order and
non-authority language:

- `system-architecture.md` defines the precedence order and authority map
- `cognitive-product-architecture.md` declares product-shape-only status
- `exploration-and-effect-governance.md` names concrete non-goals for the
  default hosted path
- `control-and-data-flow.md` declares itself descriptive rather than normative

That means the highest-value precision fixes are now in the stable layer rather
than living only in this research note.

## Classification

### Precise And Stable

#### `docs/architecture/design-axioms.md`

Why it is strong:

- it states evaluative rules instead of narrating current features
- it defines what the kernel may not do
- it is compact enough to stay legible during major refactors

What to preserve:

- constitutional line
- negative constraints
- subtraction-first posture
- authority-over-thought-path boundary

#### `docs/architecture/invariants-and-reliability.md`

Why it is strong:

- it names replay, rollback, event, and config invariants directly
- it points to concrete implementation anchors
- it can be checked against tests and failure modes

What to preserve:

- invariant wording
- implementation anchors
- containment expectations

### Mostly Precise, But Needs Ongoing Sync

#### `docs/architecture/system-architecture.md`

Why it is valuable:

- it defines the authority map
- it separates rings, planes, and state taxonomy
- it gives the most useful shared vocabulary for design review

Why it can drift:

- it mixes stable authority boundaries with some current-shape descriptions
- it is often the first place people read, so ambiguous wording becomes
  de facto policy quickly

Rule:

- keep this file focused on authority ownership, state taxonomy, and explicit
  interpretation order
- move incidental product narration elsewhere

### Directionally Right, But Too Soft If Read As Authority

#### `docs/architecture/cognitive-product-architecture.md`

Why it drifts:

- it explains product shape using planes and lanes
- that language is useful, but highly permissive
- new features can almost always justify themselves somewhere in that narrative

Risk pattern:

- planner-shaped default-path logic returns as "presentation"
- advisory push reappears as "recovery-facing product behavior"

Rule:

- keep it explicitly subordinate to axioms, invariants, and system architecture
- describe product presentation, not hidden authority

#### `docs/architecture/exploration-and-effect-governance.md`

Why it drifts:

- it is philosophically correct, but broad
- phrases like negotiation, hints, lanes, and planner work can be stretched too
  far by later features

Risk pattern:

- governance prose gets used to justify control-plane thickness
- planner behavior is described as a soft default and then quietly becomes
  part of the default hosted path

Rule:

- use this document to explain intent, not to bless implementation thickness

#### `docs/architecture/control-and-data-flow.md`

Why it drifts:

- sequence and flow docs age faster than authority docs
- readers often treat diagrams as normative even when the implementation has
  already moved

Risk pattern:

- stale diagrams become design arguments
- flow snapshots hide whether a path is authoritative, advisory, or dead

Rule:

- keep diagrams descriptive
- prefer narrower contracts in runtime/reference docs when exact semantics
  matter

## Drift Patterns Seen Across The Last Two Large Refactors

### 1. Product Narration Quietly Expands Authority

Examples:

- advisory summaries become default injected guidance
- workflow visibility becomes lane-shaped prescription
- diagnostics become phase resolution or blocker text

### 2. Durable Evidence Quietly Turns Into Control State

Examples:

- model-writable durable facts start influencing later path summaries
- telemetry remains persisted long after it stops carrying replay or recovery
  semantics

### 3. Current Shape And Permanent Architecture Get Mixed

Examples:

- "current hosted behavior" is written in architecture tone
- diagrams are interpreted as durable contracts
- journey-level product flow leaks upward into architecture docs

## Precision Rules For Future Architecture Edits

When editing `docs/architecture/**`, prefer statements of this form:

- `X owns Y`
- `X must not own Y`
- `default path may expose X`
- `default path must not inject X`
- `X is authoritative`
- `X is derived working state`
- `if conflict exists, document A wins over document B`

Avoid relying on wording of this form unless it is backed by a stricter rule:

- `typically`
- `usually`
- `helps`
- `guides`
- `lane`
- `presentation`
- `soft default`
- `product behavior`

Those phrases are useful, but only after authority has already been pinned down.

## Recommended Document Roles

- `design-axioms.md`
  - constitutional taste and non-negotiable design rules
- `invariants-and-reliability.md`
  - safety, replay, rollback, and persistence invariants
- `system-architecture.md`
  - authority map, state taxonomy, and interpretation order
- `cognitive-product-architecture.md`
  - product-shape narrative, explicitly non-authoritative
- `exploration-and-effect-governance.md`
  - governance philosophy and explanatory boundary framing
- `control-and-data-flow.md`
  - descriptive flow snapshots of the current implementation

## Validation Signals

This review is successful when:

- architecture documents more clearly distinguish authority from presentation
- product-shape docs stop being used as justification for default-path
  expansion
- future refactors require fewer cross-doc cleanups after control-plane
  subtraction
- new design reviews can cite one document for authority and one for current
  product shape, instead of treating both as the same thing

## Promotion Criteria

Promote parts of this review into stable architecture docs only after:

1. document-precedence language exists in stable architecture docs
2. product-shape docs explicitly declare themselves non-authoritative
3. future architecture edits consistently preserve that split across at least
   one more major feature cycle

Status check:

- criteria 1 and 2 are now satisfied
- criterion 3 remains intentionally open so the repo can prove the wording
  survives another feature cycle without re-thickening the default path
