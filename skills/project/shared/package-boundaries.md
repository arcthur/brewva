---
strength: invariant
scope: package-boundaries
---

# Package Boundaries and Invariants

## Workspace Topology

| Package                        | Responsibility                                                                          | Must Not Own                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| `@brewva/brewva-runtime`       | governance kernel, contracts, gates, verification state, context boundaries             | CLI wiring or transport-specific behavior     |
| `@brewva/brewva-recall`        | recall ranking, curation semantics, trust labels, and result rendering                  | event tape authority or database ownership    |
| `@brewva/brewva-session-index` | rebuildable DuckDB query plane over session event tapes                                 | replay authority, tokenization policy, SQL UI |
| `@brewva/brewva-deliberation`  | narrative memory, optimization continuity, and non-authoritative deliberation substrate | kernel commitments or transport ownership     |
| `@brewva/brewva-skill-broker`  | post-execution skill-promotion brokerage and persisted promotion review state           | turn-time skill routing or kernel authority   |
| `@brewva/brewva-tools`         | concrete tool adapters and runtime-aware helpers                                        | orchestration policy                          |
| `@brewva/brewva-cli`           | user entrypoints and frontend command surface                                           | channel/control-plane ownership               |
| `@brewva/brewva-gateway`       | daemon control plane, session supervision, channel host, and runtime wiring             | kernel semantics                              |

## Invariants

- tool and budget enforcement are correctness rules, not advisory metadata
- skill outputs and runtime artifacts must stay explicit and auditable
- DuckDB session indexes are rebuildable query state; event tape remains replay
  authority
- search tokenization stays centralized in `@brewva/brewva-search`, including
  session-index token materialization
- project overlays may tighten or extend project context, but should not invent new semantic territory
