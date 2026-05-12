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

## Boundary

Default hosted behavior belongs to `@brewva/brewva-gateway/hosted`. External
callers should not import hosted internals or expect extension plugins to replace
the hosted session, thread-loop, provider, or compaction policies.
