# Research Docs

`docs/research/` is the incubation and provenance layer for cross-cutting
design work. It is not a second stable contract tree. Current code, tests,
architecture docs, and reference docs outrank research notes.

## Layout

- `active/`: unresolved research, hypotheses, open validation, and promotion
  criteria.
- `decisions/`: accepted, immutable decision records after stable docs/code
  carry the contract.
- `archive/`: superseded or abandoned research kept for archaeology.

There is no promoted middle state. Accepted work moves to `decisions/`.

## When To Add Active Research

Add an active note when a decision spans packages, runtime authority
boundaries, persisted formats, public CLI/API surfaces, or operator workflows.

Required active metadata:

- `Status`: `active`
- `Owner`
- `Last reviewed`
- `Promotion target`

Required active sections:

- problem statement and scope boundaries
- hypotheses or decision options
- source anchors
- validation signals
- promotion criteria and destination docs
- `Surface Budget` when the note changes authored fields, required fields,
  author-facing concepts, inspect artifacts, routing/control-plane decision
  points, plugin/hook surfaces, config keys, persisted formats, or public
  CLI/API surfaces

`Surface Budget` must include numeric before/after counts for required
authored fields, optional authored fields, author-facing concepts, inspect
surfaces, and routing/control-plane decision points. Surface-affecting
promotion requires runtime/gateway maintainer review. Positive deltas for net
required authored fields, net author-facing concepts, or net
routing/control-plane decision points require a debt owner, why the increase is
unavoidable, and a dated re-evaluation trigger.

inspect surfaces are counted separately from routing/control-plane decision
points.
net required authored fields require a debt owner and a re-evaluation trigger.

## Decision Records

The generated `docs/reference/axiom-enforcement.md` is the scannable view of what
each axiom forbids and which rules enforce it; the records below stay
provenance-only.

Accepted records under `decisions/` are short, single-decision provenance
records. They carry only:

- Decision
- Date
- Status: accepted
- Stable docs
- Code anchors
- Decision summary
- Superseded by

Decision records inherit their common why and non-goal constraints from
`docs/research/decisions/README.md`. Do not repeat generic boilerplate in each
file. Keep decision-specific non-goals only when they preserve a real boundary.

Accepted decisions are immutable. Do not revise their decision content. If a
decision changes, create a new active note and add a `Superseded by` link after
the new decision is accepted.

## Archive Records

Archive notes are historical. They may retain older terminology and migration
steps, but they are not current API truth. Fix them only when links,
metadata, or historical summaries become misleading.

## Docs Writing Principles

- Handwritten docs explain boundaries, contract semantics, and why. Generated
  segments or inspect tools carry enumerations, full field lists, and exact
  inventories.
- Each page should be independently readable and target 400 lines or less.
- Stable reference pages own contracts; research notes own provenance.
- Avoid new parallel directories when a generated segment, split file, or
  provenance footnote can solve the duplication.

## Indexes

- Active research: `docs/research/active/README.md`
- Accepted decisions: `docs/research/decisions/README.md`
- Archived research: `docs/research/archive/README.md`

## Related Docs

- Documentation map: `docs/index.md`
- Stable architecture: `docs/architecture/system-architecture.md`
- Stable runtime contract: `docs/reference/runtime.md`
- Repository precedent layer: `docs/solutions/README.md`
