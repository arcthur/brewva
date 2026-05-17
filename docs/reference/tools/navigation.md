# Tool Family: Navigation

Navigation tools orient the agent in repository, browser, source, symbol,
search, and output-artifact space.

## Boundary

Most navigation tools are read-only and produce inspection evidence rather than
approval receipts. Structural source-change tools in this family, such as
AST-backed replacement or rename helpers, still go through runtime capability
checks and receipt recording; the family boundary does not bypass mutation
governance.

Representative surfaces:

- browser state, screenshots, PDFs, and snapshots
- grep, search-advisor recovery, output search, and TOC search
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

Current task target roots include existing absolute paths explicitly mentioned
in the latest turn input. These prompt-mentioned roots are read scope only and
must still pass each tool's ordinary runtime capability checks. Shallow host
roots are ignored to avoid widening navigation across a whole home or volume.
Prompt-mentioned roots are canonicalized to their real paths before filtering,
so symlinks cannot disguise a shallow host root.

## Failure Semantics

Navigation failures should return explicit diagnostics and avoid mutating
session state beyond replay-visible tool result records. Source-changing
navigation helpers must surface denial, defer, or failure through the same
runtime receipt path as other effect-bearing tools.
