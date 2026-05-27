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
- `ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1`
- `VERIFICATION_GATE_MANIFEST_SCHEMA_V1`
- `parseAdvisoryExtensionManifest`
- `resolveAdvisoryExtensionManifests`
- `parseVerificationGateManifest`
- `evaluateVerificationGateManifest`

Local hook types are exported only for advisory, opt-in behavior registered by a
caller. Provider request recovery, context composition, tool-output distillation,
ledger writing, and hosted behavior installation are not extension facade
exports.

## Hosted Behavior

Hosted behavior installation is private to hosted session assembly. Extension
callers should treat the hosted lane as a closed default path and use only the
facade symbols listed above for opt-in behavior.

Runtime extension handles are exposed only through narrowed repo-owned gateway
and tool facades. The public `createBrewvaRuntime(...)` root does not expose
`hosted`, `tool`, `operator`, `authority`, `inspect`, or `extensions`.
`HostedRuntimeBaseAdapterPort` does not expose `extensions`, and no
root-reflective helper can recover them.

Runtime extension ports are typed method ports only. They do not carry branded
runtime capability tokens or reflective `capabilities` arrays; capability
declaration remains a gateway/plugin concern, not a runtime-port guardrail.

Hosted context materialization is gateway-owned. Hosted lifecycle call sites
invoke the context owner directly for usage observation, telemetry, context
composition, evidence append, visible-read state, and delegation surfacing.
Extension-facing views must stay redacted and read-only; full effect payloads
remain inside hosted owner modules.

## Advisory Ring Inventory

Existing extension-like seams map onto the Bub-shaped advisory ring as follows:

| Current seam                                                                                                       | Advisory slot                  | Authority boundary                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Shell slash and palette handlers under `packages/brewva-cli/src/commands/shell-extensions/`                        | `surface.command`              | Command veneers may present or queue operator actions; they do not grant tools, accounts, budgets, model routes, or approvals. |
| Skill catalog providers under hosted skill selection and project skill loading                                     | `skill.provider`               | Skill cards are prompt-visible advisory objects with authority posture `none`.                                                 |
| Hosted context materialization, workbench pins, surfaced recall, tape evidence, and `docs/solutions/**` precedents | `context.contributor`          | Contributors produce inspectable attention candidates; they do not auto-inject hidden context or mutate model attention.       |
| Work card and inspect drill-down renderers under `packages/brewva-cli/src/operator/inspect/`                       | `inspect.renderer`             | Renderers consume a shared projection payload and preserve canonical refs for drill-down.                                      |
| Verifier delegates and verification recipe adapters                                                                | `verifier.adapter`             | Adapters are advisory by default; only explicit verification gate manifests produce kernel policy input.                       |
| Channel inspect renderers under channel session surfaces                                                           | `channel.renderer`             | Channel renderers share the same projection payload with channel-specific line budgets.                                        |
| Capability registry and managed-tool manifest providers                                                            | `capability.manifest_provider` | Manifest providers cannot bypass selected capability receipts or kernel admission.                                             |

Manifest precedence is `built_in > package > project > user`. Duplicate
`slot/name` pairs from lower-precedence sources emit diagnostics and do not
override the accepted manifest. Unknown fields fail closed.

`context.contributor` manifests must declare one ambient capability class:
`pure`, `read_tape`, or `read_fs`. Network access is not a manifest field; a
network-shaped declaration fails closed as an unknown field.

Local hooks are advisory receipts only. They may observe and recommend, but they
cannot block tool execution or form hidden policy. Non-advisory result shapes are
rejected as invalid advisory results. Defer or abort behavior must flow through
an explicit verification gate manifest backed by receipt evidence.

## Verification Gates

Verifier adapters are advisory unless a separate schema-tagged verification gate
manifest is present. The gate manifest binds:

- `adapter`
- `targetRoots`
- `patchSetRefs`
- `evidenceRefs`
- `freshness.maxAgeMs`
- `posture.missing`, `posture.stale`, and `posture.failed`

`evaluateVerificationGateManifest(...)` compares manifest-bound evidence with
freshness and status, then emits a structural policy input only for
`missing`, `stale`, or `failed` states. Kernel admission accepts that policy
input through `ToolCallProposal.verificationGates`; adapters never call kernel
admission or modify approval state directly.

Verification gate manifests are valid only on `verifier.adapter` extension
plugins. Other advisory slots cannot attach verification gate manifests.

## Boundary

Default hosted behavior belongs to `@brewva/brewva-gateway/hosted`. External
callers should not import hosted internals or expect extension plugins to replace
the hosted session, turn-adapter, provider, or compaction policies.
