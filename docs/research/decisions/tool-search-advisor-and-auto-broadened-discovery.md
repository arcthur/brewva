# Decision: Tool Search Advisor And Auto-Broadened Discovery

## Metadata

- Decision: Search assistance stays in the tools layer. `SearchAdvisor` changes result ordering and zero-result recovery only. It does not widen runtime authority, replay truth, or target-root enforcement.
- Date: `2026-04-11`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-tools/src/families/navigation/search-advisor.ts`
  - `packages/brewva-tools/src/families/navigation/grep.ts`
  - `packages/brewva-tools/src/families/navigation/toc.ts`
  - `packages/brewva-tools/src/families/navigation/toc-search-core.ts`
  - `test/unit/tools/search-advisor.unit.test.ts`
  - `test/unit/tools/tools-grep.unit.test.ts`
  - `test/contract/tools/tools-toc.contract.test.ts`

## Decision Summary

- Search assistance stays in the tools layer. `SearchAdvisor` changes result ordering and zero-result recovery only. It does not widen runtime authority, replay truth, or target-root enforcement.
- Path memory is rebuildable, combo memory is not. `grep` and `toc_search` fold existing runtime events into session-local path hints, while query-conditioned `query -> file` combo memory remains process-local advisory state and is intentionally lost across process restart.
- `grep` uses a bounded zero-result recovery ladder. Stable behavior is exact search, one-shot path auto-broaden for explicit narrow `paths`, one delimiter-insensitive retry, then compact suggestion-only output or final no-match.
- `toc_search` keeps structural scoring authoritative. Advisor influence is applied through bounded multiplicative scaling and suggestion-only no-match guidance, so weak session memory does not displace clearly stronger structural matches by additive bias alone.
- Inspection surfaces are explicit. Stable tool results expose advisor metadata through `details.advisor`, while repo-owned `tool_toc_query` records remain telemetry rather than durable search-memory truth.

## Superseded by

- None.
