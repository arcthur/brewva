# Decision: Boundary-First Subtraction and Model-Native Recovery

## Metadata

- Decision: Runtime complexity tracks system boundaries, not model compensation. If a subsystem mainly predicts or prescribes the next cognitive step, it does not belong in the kernel or default host path.
- Date: `2026-03-25`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Runtime complexity tracks system boundaries, not model compensation. If a subsystem mainly predicts or prescribes the next cognitive step, it does not belong in the kernel or default host path.
- Stronger models reduce path prescription, not the need for recovery. Review, verification, rollback, and repair evidence remain first-class.
- Removed control-plane surfaces are deleted rather than toggled off. No dormant config switches, shadow profiles, compatibility wrappers, or no-op adapters for removed behavior.
- The default product path stays narrow. `CLI -> hosted session -> effect gate -> governed tools -> tape/WAL -> verification/repair`
- Tape is commitment memory, not a general telemetry sink.

## Superseded by

- None.
