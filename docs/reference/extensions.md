# Reference: Extensions

Gateway extensions are opt-in control-plane behavior for hosted sessions. They
are not the default hosted lane, and they do not provide cross-agent saga
semantics, generalized compensation graphs, or automatic partial-failure repair.
In short: no cross-agent saga semantics, no generalized compensation, and no
automatic partial-failure repair.

The default hosted lane lives under `packages/brewva-gateway/src/hosted/`.
Extension authors use the narrow facade at
`packages/brewva-gateway/src/extensions/api.ts`.

## Public Surface

Stable exported extension symbols:

- `HostedExtensionPlugin`
- `HostedExtensionApi`
- `HostedExtensionCapability`
- `defineHostedExtensionPlugin`
- `LocalHookPort`

Local hook types are exported only for advisory, opt-in behavior registered by a
caller. Provider request recovery, context composition, tool-output distillation,
ledger writing, and hosted behavior installation are not extension facade
exports.

## Hosted Behavior

Hosted behavior installation is private to hosted session assembly. Extension
callers should treat the hosted lane as a closed default path and use only the
facade symbols listed above for opt-in behavior.

Runtime extension handles are exposed only through narrowed repo-owned ports:
the `hosted` port from `createBrewvaRuntime(...)` for hosted control-plane code
and the `tool` port for bundled tools. `HostedRuntimeBaseAdapterPort` does not expose
`extensions`, and no root-reflective helper can recover them.

Runtime extension ports are typed method ports only. They do not carry branded
runtime capability tokens or reflective `capabilities` arrays; capability
declaration remains a gateway/plugin concern, not a runtime-port guardrail.

Hosted context materialization is gateway-owned. Hosted lifecycle call sites
invoke the context owner directly for usage observation, telemetry, context
composition, evidence append, visible-read state, and delegation surfacing.
Extension-facing views must stay redacted and read-only; full effect payloads
remain inside hosted owner modules.

## Boundary

Default hosted behavior belongs to `@brewva/brewva-gateway/hosted`. External
callers should not import hosted internals or expect extension plugins to replace
the hosted session, turn-adapter, provider, or compaction policies.
