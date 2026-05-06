---
strength: invariant
scope: package-boundaries
---

# Package Boundaries and Invariants

## Workspace Topology

| Package                        | Responsibility                                                                                                                                          | Must Not Own                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `@brewva/brewva-runtime`       | governance kernel, contracts, gates, verification state, context boundaries                                                                             | CLI wiring or transport-specific behavior     |
| `@brewva/brewva-provider-core` | provider contracts, catalog lookup, typed registry, streaming, cache rendering, drivers                                                                 | replay authority or credential ownership      |
| `@brewva/brewva-substrate`     | contract root plus explicit session, turn, prompt/resource, provenance, execution, compaction, tools, host-api, persistence, provider, and sdk subpaths | replay authority, credentials, hosted policy  |
| `@brewva/brewva-search`        | shared normalization, mandatory CJK segmentation, and semantic query/content token policy                                                               | recall ranking or event evidence projection   |
| `@brewva/brewva-recall`        | curated root plus explicit broker, context, knowledge, and evidence subpaths for ranking, curation semantics, trust labels, and result rendering        | event tape authority or database ownership    |
| `@brewva/brewva-session-index` | curated root plus explicit evidence subpath for the rebuildable DuckDB query plane over session event tapes                                             | replay authority, tokenization policy, SQL UI |
| `@brewva/brewva-deliberation`  | narrative memory, optimization continuity, and non-authoritative deliberation substrate                                                                 | kernel commitments or transport ownership     |
| `@brewva/brewva-skill-broker`  | post-execution skill-promotion brokerage and persisted promotion review state                                                                           | turn-time skill routing or kernel authority   |
| `@brewva/brewva-tools`         | concrete tool adapters and runtime-aware helpers                                                                                                        | orchestration policy                          |
| `@brewva/brewva-cli`           | user entrypoints and frontend command surface                                                                                                           | channel/control-plane ownership               |
| `@brewva/brewva-gateway`       | daemon control plane, session supervision, channel host, and runtime wiring                                                                             | kernel semantics                              |

## Invariants

- tool and budget enforcement are correctness rules, not advisory metadata
- skill outputs and runtime artifacts must stay explicit and auditable
- DuckDB session indexes are rebuildable query state; event tape remains replay
  authority
- search tokenization stays centralized in `@brewva/brewva-search`, including
  query/content token-mode policy and session-index token materialization
- recall broker/context/knowledge/evidence imports use explicit
  `@brewva/brewva-recall/*` subpaths; the recall root is shared vocabulary only
- session-index evidence imports use `@brewva/brewva-session-index/evidence`
  only for indexed evidence contracts; recall consumes typed query rows for
  production recall instead of rebuilding event search text
- project overlays may tighten or extend project context, but should not invent new semantic territory
- provider streaming parse is an advisory projection of TypeBox tool schemas;
  TypeBox remains the canonical schema source and terminal AJV validation
  remains authoritative
- TypeBox-Value streaming helpers stay internal to
  `@brewva/brewva-provider-core`; other packages consume only normalized
  provider events such as optional `parseStatus`
- provider-core implementation stays domain-sliced under `contracts/`,
  `catalog/`, `registry/`, `stream/`, `parse/`, `cache/`, and
  vertical `providers/<api>/` folders; the root is a compatibility surface, not
  an implementation home
- substrate root is cross-domain vocabulary only. `/contracts` is reserved for
  vocabulary that has no single mechanism owner, such as context state, session
  phase, and thinking levels. Domain-owned contracts such as tool definitions
  and provider model catalogs are imported from `/tools` and `/provider`
- substrate mechanisms are imported through explicit domain subpaths:
  `@brewva/brewva-substrate/session`, `/prompt`, `/resources`, `/tools`,
  `/host-api`, `/persistence`, `/provider`, `/turn`, `/sdk`, `/provenance`,
  `/execution`, and `/compaction`
- substrate `/sdk` is a thin in-memory mechanism composition entrypoint. It may
  assemble substrate services, session host, host plugin runner, and turn loop,
  but it must not own gateway hosted envelopes, recovery decisions, profile
  policy, runtime replay authority, or provider credential authority
- substrate `/compaction` owns pure message/session compaction mechanics such
  as summary projection, token estimation, and cut-point selection. Gateway
  still owns hosted compaction trigger/recovery policy, and runtime still owns
  durable compaction authority receipts
- substrate `/provenance` owns reusable source-info vocabulary for mechanism
  domains that attach source metadata. It is not exported from the substrate
  root unless a future decision deliberately expands the contract root
- substrate `/execution` owns small execution primitives. Event buses must
  keep subscriber access separate from controller emit authority
- substrate public/domain API files use curated exports. They must not grow
  wildcard barrels or revive old source-path shims for moved implementation
  files
- provider session resources are a controlled lifecycle port; hosted callers
  that replace session context or change provider/model must await
  `clearSession(sessionId)` before continuing
