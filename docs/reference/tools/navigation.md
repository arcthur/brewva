# Tool Family: Navigation

Navigation tools orient the agent in repository, browser, source, symbol,
search, and output-artifact space.

## Boundary

Most navigation tools are read-only and produce inspection evidence rather than
approval receipts. Source-changing navigation helpers must prepare a
`SourcePatchPlan`; `source_patch_apply` is the only source mutation gate.

Representative surfaces:

- browser state, screenshots, PDFs, and snapshots
- file globbing (`glob`), goal-focused content analysis (`look_at`), grep,
  search-advisor recovery, output search, and hash-anchored `source_read`
- `brewva-resource:///` reads through `resource_read`
- real language-server status, diagnostics, references, definitions, and edit
  preparation
- multi-language source outline, digest, surface, dependency, cycle, caller, and callee views
- `source_patch_prepare` and `source_patch_apply` for anchored multi-file edits
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
navigation helpers must surface denial, defer, or failure through source patch
snapshot, preflight, and apply receipts.
