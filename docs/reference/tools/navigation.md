# Tool Family: Navigation

Navigation tools read repository structure, source spans, symbols, references,
and diagnostics. They should improve orientation without changing workspace
state.

## Boundary

Navigation tools are read-only. They may produce inspection evidence, but they
do not create mutation receipts or approval truth.

Representative surfaces:

- language-server navigation and rename preparation
- table-of-contents document and search views
- structural search
- span reads and path-aware file inspection
- git status, diff, and log inspection

## Scope

Repository reads are scoped to current task target roots unless the tool family
explicitly documents a wider observation boundary. A navigation tool that
discovers a wider path should surface that as evidence instead of silently
expanding authority.

## Failure Semantics

Navigation failures are inspection failures. They should return explicit
diagnostics and avoid mutating session truth beyond replay-visible tool result
records.
