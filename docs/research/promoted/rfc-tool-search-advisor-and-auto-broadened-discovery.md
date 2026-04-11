# Research: Tool Search Advisor And Auto-Broadened Discovery

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-04-11`
- Promotion target:
  - `docs/reference/tools.md`
  - `docs/reference/events.md`

## Promotion Summary

This note is now a short status pointer.

The decision has been promoted: `grep` and `toc_search` keep search assistance
in the tools layer. Stable implementation now folds existing discovery and
mutation evidence into session-local path memory, adds process-local
query-conditioned combo memory, reranks results as advisory post-processing,
and treats zero-result `grep` as a bounded recovery ladder instead of a dead
end.

Stable references:

- `docs/reference/tools.md`
- `docs/reference/events.md`

## Stable Contract Summary

The promoted contract is:

1. Search assistance stays in the tools layer.
   `SearchAdvisor` changes result ordering and zero-result recovery only. It
   does not widen runtime authority, replay truth, or target-root enforcement.
2. Path memory is rebuildable, combo memory is not.
   `grep` and `toc_search` fold existing runtime events into session-local path
   hints, while query-conditioned `query -> file` combo memory remains
   process-local advisory state and is intentionally lost across process
   restart.
3. `grep` uses a bounded zero-result recovery ladder.
   Stable behavior is exact search, one-shot path auto-broaden for explicit
   narrow `paths`, one delimiter-insensitive retry, then compact suggestion-only
   output or final no-match.
4. `toc_search` keeps structural scoring authoritative.
   Advisor influence is applied through bounded multiplicative scaling and
   suggestion-only no-match guidance, so weak session memory does not displace
   clearly stronger structural matches by additive bias alone.
5. Inspection surfaces are explicit.
   Stable tool results expose advisor metadata through `details.advisor`, while
   repo-owned `tool_toc_query` records remain telemetry rather than durable
   search-memory truth.

## Validation Status

Promotion is backed by:

- `SearchAdvisor` integration in `grep`, `toc_search`, and the shared TOC
  search core
- non-happy-path regression coverage for combo attribution, combo decay,
  one-shot auto-broaden, delimiter-insensitive retry, composed recovery,
  suggestion-only follow-through, and telemetry alignment
- repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`

## Source Anchors

- `packages/brewva-tools/src/search-advisor.ts`
- `packages/brewva-tools/src/grep.ts`
- `packages/brewva-tools/src/toc.ts`
- `packages/brewva-tools/src/toc-search-core.ts`
- `test/unit/tools/search-advisor.unit.test.ts`
- `test/unit/tools/tools-grep.unit.test.ts`
- `test/contract/tools/tools-toc.contract.test.ts`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- durable cross-process query-conditioned combo memory
- multi-target combo associations instead of one dominant file per query
- a gateway-resident long-running search service
- search-engine replacement or `fff-bun` backend cutover
- promotion-gating operational telemetry beyond the current regression suite and
  stable contract docs

If those areas become priorities later, they should start from a new focused
RFC rather than silently widening this promoted pointer.

## Historical Notes

- Proposal-era option analysis, helper API sketches, and promotion criteria were
  removed from this file after the stable contract moved into reference docs.
- The operator inspect/replay journey did not change as part of this promotion,
  so it is not a stable target for this note.
