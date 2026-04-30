# Decision: Architecture Doc Precision Review

## Metadata

- Decision: Architecture documents have a fixed interpretation order. Axioms and invariants win over system-architecture, which wins over product-shape and flow descriptions.
- Date: `2026-03-25`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Architecture documents have a fixed interpretation order. Axioms and invariants win over system-architecture, which wins over product-shape and flow descriptions.
- Product-shape docs explicitly declare themselves non-authoritative. They must not be used as sole justification for default-path injections, hidden phase logic, or durable control-state growth.
- Authority statements use precise wording. Prefer `X owns Y`, `X must not own Y`, `default path may expose X`, `default path must not inject X`, `X is authoritative`, and `X is derived working state`.
- Soft wording is allowed only after authority has been pinned. Words like `typically`, `usually`, `guides`, `lane`, `presentation`, and `soft default` are useful but must not appear as standalone authority claims.

## Non-goals

- automated enforcement of precision wording rules beyond manual review

## Superseded by

- None.
