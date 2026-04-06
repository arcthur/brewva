# Research: Architecture Doc Precision Review

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-25`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/control-and-data-flow.md`

## Promotion Summary

This note is now a short status pointer.

The architecture layer now consistently distinguishes authority from
product-shape presentation. The precision rules described in this review have
been adopted into the stable architecture documents and have survived multiple
major feature cycles without re-thickening the default path.

Stable implementation now includes:

- `system-architecture.md` defines a four-level interpretation order with
  explicit precedence: design-axioms > invariants > system-architecture >
  product-shape/flow descriptions
- `cognitive-product-architecture.md` declares itself non-authoritative with
  explicit interpretation rule and normative status language, including
  concrete non-goals for default-path injections
- `exploration-and-effect-governance.md` declares itself explanatory and names
  concrete non-goals for the default hosted path
- `control-and-data-flow.md` declares diagrams as descriptive snapshots that
  do not override architectural invariants or public contracts

The split has survived at least five major feature cycles since the precision
language was added (subagent delegation, workflow artifacts, iteration facts,
deliberation planes, model-native closure) across 13 architecture-doc commits
without any regression toward product-shape prose expanding authority.

Stable references:

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/control-and-data-flow.md`

## Stable Contract Summary

The promoted contract is:

1. Architecture documents have a fixed interpretation order.
   Axioms and invariants win over system-architecture, which wins over
   product-shape and flow descriptions.
2. Product-shape docs explicitly declare themselves non-authoritative.
   They must not be used as sole justification for default-path injections,
   hidden phase logic, or durable control-state growth.
3. Authority statements use precise wording.
   Prefer `X owns Y`, `X must not own Y`, `default path may expose X`,
   `default path must not inject X`, `X is authoritative`, and
   `X is derived working state`.
4. Soft wording is allowed only after authority has been pinned.
   Words like `typically`, `usually`, `guides`, `lane`, `presentation`, and
   `soft default` are useful but must not appear as standalone authority
   claims.

## Document Roles

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

## Validation Status

Promotion is backed by:

- all four target architecture docs carrying explicit interpretation-order
  and non-authority language
- five major feature cycles completing without re-thickening the default path
  or treating product-shape prose as authority
- docs quality tests passing via `bun run test:docs` and
  `bun run format:docs:check`

## Remaining Backlog

The following is intentionally not part of the promoted contract:

- automated enforcement of precision wording rules beyond manual review

If drift recurs in a future feature cycle, it should be addressed through a
new focused RFC rather than reopening this promoted status pointer.

## Historical Notes

- Historical classification detail, drift pattern analysis, and per-document
  risk assessments were removed from this file after promotion.
- The stable precision rules now live in the architecture documents themselves
  rather than in `docs/research/`.
