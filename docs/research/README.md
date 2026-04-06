# Research Docs (Incubation Layer)

`docs/research/` is the incubation layer for cross-cutting design work that is
not yet stable enough for `docs/architecture/` or `docs/reference/`.

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

## Proposed notes

None currently.

## Active notes

- `docs/research/active/event-stream-consistency-and-replay-fidelity.md`
- `docs/research/active/context-budget-behavior-in-long-running-sessions.md`
- `docs/research/active/recovery-robustness-under-interrupt-conditions.md`
- `docs/research/active/cost-observability-and-budget-governance.md`
- `docs/research/active/rollback-ergonomics-and-patch-lifecycle-safety.md`

## Promoted notes (status pointers)

See `docs/research/promoted/README.md` for the promoted-note index and the
status-pointer catalog.

## Archived / superseded notes

See `docs/research/archive/README.md` for the archived-note index and
historical rationale catalog.

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
