# Exploration And Effect Governance

This is an explanatory companion for why Brewva governs effects rather than
reasoning paths. Stable authority lives in `docs/architecture/design-axioms.md`,
`docs/architecture/system-architecture.md`, `docs/architecture/invariants-and-reliability.md`,
and `docs/reference/runtime.md`.

## Stable Rule

Deliberation may explore, search, summarize, recall, rank, and propose.
Runtime authority decides whether an effect may commit.

The boundary is practical:

- model-native exploration can stay flexible and cheap to change
- effectful actions need receipts, exact approval binding, recovery posture,
  and replay-visible outcomes
- advisory memory or retrieval can inform a decision without becoming hidden
  authority

## Effect Governance

Tool calls pass through action policy, runtime capability scope, capability
selection, command policy, boundary policy, numeric context status, and
approval state. Those inputs produce facts. The runtime authority decision owns
allow, block, defer, receipt, and rollback meaning.

Skills are deliberately outside this authority chain. `SkillCard` metadata can
make advisory context discoverable, and producer contracts can describe
structured workflow artifacts, but neither grants an account, tool surface,
budget, or external side effect.

External authority first needs a selected capability receipt. The current
selector is deterministic-only: explicit capability target, policy default
inside scope, then deterministic filters and selection-field ranking. Embedding
ranking and LLM fallback are reserved extension points, not active authority
paths.

## Runtime Effect Substrate

The Effect runtime library is an execution substrate, not the authority
manifest. It may run the model stream, tool execution, provider request,
channel handler, IPC call, schedule, or cleanup finalizer that supports a
commitment, but the commitment remains governed by Brewva authority.

Use the distinction precisely:

- `EffectAuthorityManifest` decides whether an effectful tool invocation may
  commit.
- `@brewva/brewva-effect` coordinates in-memory execution mechanics beneath
  that decision.

## Non-Goals

- no kernel-owned planner or hidden stage machine
- no default-path adaptive ranking inside the commitment boundary
- no lossy summaries as authoritative state
- no cross-agent compensation model hidden behind delegation tools

## Where Details Live

- Authority surface: `docs/reference/runtime.md`
- Tool policy and receipts: `docs/reference/tools.md`
- Skill and capability split: `docs/reference/skill-routing.md`
- Proposal boundary: `docs/reference/proposal-boundary.md`
- Event families: `docs/reference/events/README.md`
- Decision provenance: `docs/research/decisions/README.md`
