---
strength: invariant
scope: package-boundaries
convention_kind: safety_boundary
retirement_sensitivity: pinned
owner: runtime-maintainers
---

# Package Boundaries and Invariants

## Workspace Topology

| Package                            | Responsibility                                                                                                                                                                             | Must Not Own                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `@brewva/brewva-runtime`           | four-port runtime root, canonical tape, kernel authority policy, model attention planning, config/security contracts, and small product vocabulary helpers                                 | CLI wiring, transport-specific behavior, or read-model truth                            |
| `@brewva/brewva-capabilities`      | capability manifest parsing, registry versioning, deterministic selection, and authority receipt primitives                                                                                | tool execution or hosted policy wiring                                                  |
| `@brewva/brewva-provider-core`     | provider contracts, catalog lookup, typed registry, streaming, cache rendering, drivers                                                                                                    | replay authority or credential ownership                                                |
| `@brewva/brewva-substrate`         | contract root plus explicit session, turn, prompt/resource, provenance, execution, compaction, tools/tool-protocol, host-api, persistence, provider, and sdk subpaths                      | replay authority, credentials, hosted policy                                            |
| `@brewva/brewva-effect`            | Effect infrastructure foundation, explicit primitives subpath, edge runners, scoped resource and schedule helpers, retry, platform integration, cancellation, timeout, and testing helpers | product policy, domain ownership, semantic runtime layers, or root Effect alias barrels |
| `@brewva/brewva-search`            | shared normalization, mandatory CJK segmentation, and semantic query/content token policy                                                                                                  | recall ranking or event evidence projection                                             |
| `@brewva/brewva-token-estimation`  | leaf model token estimation primitives                                                                                                                                                     | model routing or provider policy                                                        |
| `@brewva/brewva-recall`            | curated root plus explicit broker, knowledge, and evidence subpaths for on-demand recall search, curation semantics, trust labels, and result rendering                                    | event tape authority or database ownership                                              |
| `@brewva/brewva-session-index`     | curated root plus explicit evidence subpath for the rebuildable DuckDB query plane over session event tapes                                                                                | replay authority, tokenization policy, SQL UI                                           |
| `@brewva/brewva-std`               | leaf standard primitives for async, collections, hashing, JSON, markdown, text, unknown readers, and Node-only filesystem helpers                                                          | product policy, runtime authority, or domains                                           |
| `@brewva/brewva-tools`             | family-sliced concrete tool adapters, pure tool contracts, managed-tool registry/capability spine, runtime-port helpers, internal BoxLite execution, and default bundle assembly           | orchestration policy or model routing                                                   |
| `@brewva/brewva-mcp-adapter`       | MCP protocol translation into substrate tool descriptors and guarded MCP client calls                                                                                                      | managed-tool capability policy or hosted UX                                             |
| `@brewva/brewva-channels-telegram` | Telegram channel protocol translation, update projection, callback handling, and Telegram transports                                                                                       | gateway hosted policy or generic ingress                                                |
| `@brewva/brewva-ingress-telegram`  | Telegram-specific webhook ingress server, auth/dedupe processing, and edge worker forwarding                                                                                               | generic multi-channel ingress contracts                                                 |
| `@brewva/brewva-cli`               | user entrypoints, frontend command surface, and CLI-internal terminal UI runtime                                                                                                           | channel/control-plane ownership                                                         |
| `@brewva/brewva-gateway`           | domain-sliced control-plane/admin seams, session supervision, channel host, hosted extension composition, and gateway-owned shared utilities                                               | kernel semantics                                                                        |

## Invariants

- tool and budget enforcement are correctness rules, not advisory metadata
- Effect is an infrastructure island, not the semantic runtime root. Runtime
  package code stays ordinary TypeScript and must not import raw Effect,
  `@brewva/brewva-effect/primitives`, Effect services, or Effect layers.
- raw Effect and `@effect/*` dependencies stay owned by `@brewva/brewva-effect`;
  other packages use Brewva Effect foundation helpers and explicit primitives
  only where an infrastructure island requires them
- `runBoundaryOperation` is allowed only in the Effect foundation, tests, and
  declared adapter files enforced by
  `test/fitness/effect-runtime-boundary.fitness.test.ts`; provider stream core,
  channel queue core, tool execution internals, and runtime package code are
  not boundary runner sites
- package-owned Effect services that expose Promise adapters use
  `@brewva/brewva-effect/runtime` `createBrewvaServiceRuntime(...)` to own one
  scoped runtime and one service access path; do not hand-roll package-local
  Scope/ManagedRuntime assemblies for serial queues, registries, or similar
  long-lived infrastructure islands
- runtime/provider/tool handoff that must remain plain TypeScript uses
  `@brewva/brewva-std/async` `createAsyncBridge(...)` for backpressure,
  cancellation, close, failure, and early-consumer-exit cleanup
- managed exec process state is owned by an explicit
  `ManagedExecProcessRegistryRuntime`; host, box, process-session, cleanup, and
  background-session APIs must not revive module-level default registry
  ownership
- runtime root exports stay narrow: `createBrewvaRuntime`, the four-port runtime
  contract types, `DEFAULT_BREWVA_CONFIG`, and the minimal config/deep-readonly
  types. Do not reintroduce the `BrewvaRuntime` class, root-reflective runtime
  port factories, or operator-selection helpers. Domain contracts are imported
  through explicit owner subpaths such as
  `@brewva/brewva-runtime/core`, `/config`, `/events`, `/session`,
  `/governance`, `/task`, `/skills`, `/context`, and `/security`
- runtime subpath ownership is registered in
  `skills/project/shared/runtime-subpaths.json`; new runtime package exports must
  add an owner, stability, decision, and allowed-consumer entry before they can
  pass fitness
- skill outputs and runtime artifacts must stay explicit and auditable
- DuckDB session indexes are rebuildable query state; event tape remains replay
  authority
- search tokenization stays centralized in `@brewva/brewva-search`, including
  query/content token-mode policy and session-index token materialization
- recall broker/knowledge/evidence imports use explicit
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
- provider-core consumption follows the explicit matrix below. New consumers or
  subpaths require updating both this document and
  `test/fitness/provider-core/provider-core-consumption-matrix.fitness.test.ts`
- substrate root is cross-domain vocabulary only. `/contracts` is reserved for
  vocabulary that has no single mechanism owner, such as context state, session
  phase, and thinking levels. Domain-owned contracts such as tool definitions
  and provider model catalogs are imported from `/tools` and `/provider`
- tool descriptor/catalog protocol vocabulary belongs to
  `@brewva/brewva-substrate/tools`; the removed
  `@brewva/brewva-tool-protocol` package must not return as a standalone
  workspace package or import path
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
- tools root exports default bundle construction only. Tool vocabulary,
  registry/capability helpers, runtime-port helpers, and family adapters use
  explicit `@brewva/brewva-tools/*` subpaths; old top-level implementation
  files and broad factory barrels are not compatibility surfaces
- BoxLite execution containment is internal to `@brewva/brewva-tools`; do not
  reintroduce `@brewva/brewva-box` as a workspace package or import path unless
  a new accepted decision names a second production consumer
- tools managed capability policy is centralized in
  `@brewva/brewva-tools/registry`; family adapters receive scoped runtime
  facades and must fail closed when an undeclared capability is accessed. The
  static capability inventory is generated from the runtime capability type
  union by `bun run tools:capability-inventory`
- runtime projection admission is explicit: canonical projection code belongs in
  `packages/brewva-runtime/src/runtime/tape/` and must not import gateway hosted
  internals, provider packages, tool families, or removed runtime port contracts
- gateway public/domain entrypoints stay explicit by domain (`/admin`, `/ingress`,
  `/host`, `/session`, `/channels`, `/daemon`, `/delegation`,
  `/extensions`, `/protocol`); control-plane CLI routing lives under
  `/admin`, while `/ingress` stays transport/auth oriented
- Telegram ingress is owned by `@brewva/brewva-ingress-telegram`; do not
  reintroduce generic `@brewva/brewva-ingress` until a second channel or
  transport proves a generic ingress contract
- CLI terminal UI primitives and OpenTUI runtime are internal to
  `@brewva/brewva-cli`; do not reintroduce `@brewva/brewva-tui` as a workspace
  package or import path
- `@brewva/brewva-mcp-adapter` translates MCP protocol and tool descriptors
  only. Hosted action classes and managed-tool capability policy remain in
  gateway/tools composition
- gateway extension callers use `@brewva/brewva-gateway/extensions`
  or `src/extensions/api.ts`; default hosted implementation stays under
  `src/hosted/` owner modules
- gateway provider connection metadata uses `ProviderConnectionDescriptor`;
  the split control seam remains `credential`, `authFlow`, `catalog`, and
  `renderer`
- gateway `src/utils` is the only shared root under gateway source; it must not
  import gateway domains
- provider session resources are a controlled lifecycle port; hosted callers
  that replace session context or change provider/model must await
  `clearSession(sessionId)` before continuing
- `@brewva/brewva-std` is the only package that may directly depend on generic
  utility substrate libraries such as Remeda, `p-limit`, and `@noble/hashes`;
  product packages import Brewva-owned std subpaths instead
- std has no root export. Callers use explicit subpaths such as
  `@brewva/brewva-std/hash`, `/json`, `/collections`, `/async`, and `/node/fs`
- portable std subpaths must not import Node builtins; Node-only utilities live
  under explicit `/node/*` subpaths
- generic stable hashing, short SHA-256 IDs, redacted digests, and cache
  fingerprints use `@brewva/brewva-std/hash`; protocol-owned HMAC, PKCE,
  credential-vault byte digests, and byte-stream fingerprints stay local

## Provider-Core Consumption Matrix

| Provider-core surface | Substrate | Gateway                                                                           | Notes                                                                                                             |
| --------------------- | --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `./contracts`         | Yes       | Yes                                                                               | Shared provider vocabulary and runtime-layer contracts.                                                           |
| `./catalog`           | No        | Yes                                                                               | Hosted model/provider lookup and rendering only.                                                                  |
| `./cache`             | No        | Yes                                                                               | Hosted cache policy, fingerprint, and render helpers.                                                             |
| `./registry`          | No        | Yes                                                                               | Hosted lifecycle and session cleanup port.                                                                        |
| `./stream`            | No        | Via `packages/brewva-gateway/src/hosted/internal/provider/execution-port.ts` only | Gateway stream execution is centralized behind one hosted provider execution port.                                |
| `./auth`              | No        | No                                                                                | Provider-core owned auth helper surface; no gateway/substrate direct consumption without a new boundary decision. |
| `./parse`             | No        | No                                                                                | Internal implementation domain; not a package export.                                                             |
| `./providers/<api>`   | No        | No                                                                                | Internal driver implementations; not package exports.                                                             |
