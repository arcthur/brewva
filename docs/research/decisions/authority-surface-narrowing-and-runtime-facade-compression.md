# Decision: Authority-Surface Narrowing And Runtime-Facade Compression

## Metadata

- Decision: Brewva's public runtime contract is organized around semantic root surfaces: `authority`, `inspect`, and `maintain`
- Date: `2026-04-04`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Brewva's public runtime contract is organized around semantic root surfaces: `authority`, `inspect`, and `maintain`
- the default coupling surface follows authority boundaries rather than implementation breadth
- `public width is not authority width` is the interpretation rule for runtime APIs and docs
- repo-owned implementation helpers stay under dedicated runtime subpaths and controlled extension ports, not the root public entrypoint
- future public APIs must explain which semantic surface they belong to before widening the root contract

## Superseded by

- None.
