# Decision: Authority-Surface Narrowing And Runtime-Facade Compression

## Metadata

- Decision: Historical runtime facade compression established semantic root surfaces. Current public root keeps `authority` and `inspect`; operations move through repo-owned operator ports.
- Date: `2026-04-04`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Historical note: this decision originally included a third public operational root. Current runtime root compression removes that root and exposes bounded operations through hosted/operator ports.
- the default coupling surface follows authority boundaries rather than implementation breadth
- `public width is not authority width` is the interpretation rule for runtime APIs and docs
- repo-owned implementation helpers stay under dedicated runtime subpaths and controlled extension ports, not the root public entrypoint
- future public APIs must explain which semantic surface they belong to before widening the root contract

## Superseded by

- `docs/research/decisions/runtime-public-root-compression.md`
