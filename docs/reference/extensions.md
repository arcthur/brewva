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

## The Gate-Bridge Recipe: Promoting a Recurring Discrepancy to a Gate

The requirement-fitness projection (`@brewva/brewva-vocabulary/fitness`,
`projectRequirementFitness`) annotates a `pass` claim's
`verification.outcome.recorded` receipt with graded `discrepancies[]` when the
claim contradicts a requirement atom — visible debt on the Work Card fitness
line and `inspect run-report`'s Fitness section. The annotation never
blocks anything (axiom 18): recording it is the same claim, made honest. This
section documents the operator's OWN move for turning a recurring, high-risk
instance of that debt into an actual blocking gate, using the mechanism this
page already describes above — it adds no second blocking path.

**Eligibility: `deterministic_conflict` only.** A discrepancy's `grade` is
either `deterministic_conflict` (a deterministic evidence entry — a scripted
check, a lint with a stable rule id — drove the violation) or
`advisory_conflict` (only an LLM review finding did). **`advisory_conflict`
findings are never gate-eligible.** An LLM judgment is not deterministic
evidence and promoting one to a blocking gate would smuggle non-deterministic
authority into kernel admission through the back door. Only a
`deterministic_conflict` — because it is backed by a check an operator can
point at and re-run — is a valid input to the recipe below.

**When to promote.** Not on the first occurrence — the fitness annotation
already makes a single instance visible as debt without blocking anyone. The
recipe applies once a `deterministic_conflict` on the same atom (or the same
underlying check) recurs across sessions on a genuinely high-risk atom
(`riskClass: security | runtime`, or any atom an operator judges
ship-blocking) and the operator decides visible-but-passable debt is no
longer the right posture for that specific risk.

**Current wiring note.** `assembleRequirementFitnessInput` now feeds the
`independent` outcome channel: a clear independent atoms-review commits a `pass`
naming its reviewed atoms (`atomRefs`), so the positive half — `satisfied`
via an independent confirmation — is production-live. The other two channels
remain honest gaps: `authoredOutcomes` (which would yield `likelySatisfied`)
has no producer yet, and `deterministicEvidence` has no default tape source —
a caller (or an operator-supplied deterministic check) must feed it explicitly
to produce a `deterministic_conflict` in the first place. This recipe describes
the bridge FROM a `deterministic_conflict` (however it was produced) TO a gate;
it does not itself wire new deterministic-evidence producers, and it names no
producer that does not already exist.

**The promotion, field by field.** A `VerificationGateManifest`
(`VERIFICATION_GATE_MANIFEST_SCHEMA_V1`) is only valid on a `verifier.adapter`
extension plugin (see above). Populate it from the recurring discrepancy's own
evidence:

- `adapter` — the identity of the SAME deterministic check whose fail produced
  the `deterministic_conflict` (the check the discrepancy's `evidenceRef`
  traces back to). This is not a new adapter; it is the existing scripted
  check being given a gate identity.
- `targetRoots` — the path(s) the check actually covers, per the manifest's
  existing semantics (unrelated to and no wider than the fitness atom's own
  scope).
- `patchSetRefs` — populated per the manifest's existing freshness semantics;
  the same tape-derived patch-set identity `reviewTargetRefMatchesTapeOnly`
  already uses for staleness elsewhere in this RFC's surfaces.
- `freshness.maxAgeMs` — the evidence-staleness budget the operator is willing
  to accept before treating a gap as `missing`/`stale`, same field the
  manifest always had.
- `posture.missing` / `posture.stale` / `posture.failed` — chosen by the
  operator (`advisory | defer | abort`) exactly as for any other verification
  gate; nothing about the fitness origin changes what postures are legal
  here.

`evaluateVerificationGateManifest(...)` then compares this manifest's bound
evidence with freshness and status, and emits a structural policy input for
`missing`, `stale`, or `failed` states — the same evaluation path every other
verification gate already goes through. Kernel admission accepts that policy
input through `ToolCallProposal.verificationGates`, unchanged.

**What this recipe is not.** The `VerificationGateManifest` remains the
SINGLE blocking path (axiom 18) for this whole fitness surface — this recipe
does not add a second one. The fitness annotation itself, the Work Card
fitness line, and `inspect run-report`'s Fitness section stay exactly what
they are: read-only pressure. Promotion is a manifest an operator authors and
owns; the projection that made the recurring discrepancy visible in the first
place never gates on its own, no matter how many times a `deterministic_conflict`
recurs. Nothing automates this promotion — it is a deliberate operator
decision, not a threshold-triggered escalation.

## Boundary

Default hosted behavior belongs to `@brewva/brewva-gateway/hosted`. External
callers should not import hosted internals or expect extension plugins to replace
the hosted session, turn-adapter, provider, or compaction policies.

A borrowed peer mechanism lands in the ring that already owns the decision, never
with the authority shape that would break a Brewva invariant (axiom 11; axiom 19).
`opencode`'s `baseline/update/removed` block algebra is reused internally as
`diffKeyedBlocks` over dynamic-tail materialization blocks — a cache-stability
view, not a context-source registry; there is still no context-source admission
path, and the only context-write capability remains `context_messages.write`.
`pi-mono`'s `renderCall` / `renderResult` display ergonomics already exist on
`BrewvaToolDefinition` in the advisory ring, so nothing was ported. The rule is:
borrow the mechanism, never the authority shape.
