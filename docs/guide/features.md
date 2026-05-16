# Features

This guide is the capability map for Brewva. It explains the shape of the
system and where to inspect exact inventories without repeating code-derived
catalogs.

For generated inventories, use:

- tools: `docs/reference/tools.md`
- skills: `docs/reference/skills.md`
- runtime surface: `docs/reference/runtime.md`
- events: `docs/reference/events/README.md`
- CLI flags: `docs/reference/commands.md`

## Runtime Capabilities

Brewva is organized around replay-visible runtime capabilities:

- advisory SkillCards, ProducerContracts, and capability selection receipts
- tool access policy, effect boundaries, and budget gates
- evidence ledger recording and replay-visible governance receipts
- task and truth state through event-sourced replay
- verification gates and command-backed verification reports
- receipt-bearing rollback and approval surfaces for reversible mutations
- context budget tracking, pressure reporting, and compaction signaling
- event-first persistence, replay, and deterministic recovery
- cost observability and budget alerts
- derived workflow artifacts and advisory workflow inspection
- typed planning and delegated-worker handoff artifacts
- durable stall adjudication through explicit inspection
- iteration-fact persistence for bounded optimization loops
- narrative, deliberation, recall, and precedent surfaces with provenance

## Operator Surfaces

Operators interact with those capabilities through:

- the interactive shell and one-shot CLI modes
- `brewva inspect` for replay-first session inspection
- `brewva insights` for multi-session workspace analysis
- the gateway daemon for local hosted-session orchestration
- scheduler daemon mode for intent execution
- Telegram channel mode and webhook ingress
- multi-agent channel orchestration when enabled

These surfaces are product/host layers over runtime receipts. They do not
create a second authority model.

## Managed Tool Families

Managed tools are grouped by behavior rather than listed in this guide:

- navigation and read-only repository inspection
- command, browser, verification, mutation, and rollback execution
- memory, recall, precedent, output search, and observability
- producer-contract, subagent, worker-result, and task delegation
- workflow, scheduling, leases, tape, and resource coordination

Channel-specific A2A tools are registered by channel extensions when
orchestration is enabled. They are not part of the default bundle.

## Skill And Delegation Model

Skills are readable semantic guidance documents. Delegated workers define
execution envelopes. The parent session owns task truth, effect receipts,
verification evidence, and patch adoption; it no longer owns an active skill
slot or skill completion state.

Structured workflow artifacts come from `skills/producers/<name>.yaml`, not
from `SKILL.md` frontmatter. External authority comes from capability manifests
and deterministic selection receipts, not from a skill name appearing in model
context.

Skill taxonomy is split by role:

- `core` and `domain` carry most public routable territory
- `operator` and `meta` skills are loaded and inspectable, but usually hidden
  from default routing scopes
- project overlays tighten behavior for this repository
- shared project guidance adds repo-local context and provenance

Delegated public specialist roles remain narrow: `navigator`, `explorer`,
`worker`, `verifier`, and `librarian`. Internal review lanes remain control-plane
implementation detail behind `explorer`.

## Where To Inspect Exact State

- Run `bun run docs:inventory` after code-derived inventory changes.
- Read generated blocks in reference docs for exact names.
- Use `brewva inspect` for persisted session truth.
- Use `docs/guide/category-and-skills.md` for skill category orientation.
- Use `docs/reference/skill-routing.md` for skill routing deletion,
  capability-selection priority, and handoff semantics.

## Related Docs

- `docs/guide/cli.md`
- `docs/guide/category-and-skills.md`
- `docs/guide/understanding-runtime-system.md`
- `docs/guide/orchestration.md`
- `docs/reference/tools.md`
- `docs/reference/skills.md`
