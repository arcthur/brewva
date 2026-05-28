# Cognitive Product Architecture

This page is a product-facing companion. It describes how Brewva presents the
model, operator, kernel, and runtime physics boundaries without redefining
authority. If wording here conflicts with axioms, invariants, system
architecture, or reference docs, the narrower contract wins.

## Product Boundary

`Model sees workbench and options. Operator sees work cards. Kernel sees receipts.`

- The model sees stable instructions, active workbench entries, model-requested
  recall results, bounded attention options, tool affordances, and small
  physical-status nudges.
- The operator sees Work Cards, approvals, questions, task state, drill-down
  inspect views, memory operations, session posture, cache, cost, and
  diagnostics.
- The kernel records decisions, effects, verification, rollback, recovery, and
  replay truth.
- Runtime physics exposes limits and failure posture: context window, cache,
  cost, provider behavior, durability, and recovery constraints.

The product rule is `same evidence, different authority`: the same canonical
refs can appear in model, operator, channel, and embedder surfaces, but only the
owning runtime, kernel, capability, sandbox, adoption, or verification-gate
contract can make those refs authoritative.

## Default Product Loop

The default loop is:

`receive -> orient -> authorize -> act -> verify -> handoff`

This is the product grammar for shell, CLI, channels, and headless sessions. It
is not a planner ontology and not a session state machine. Each step reads or
renders existing facts:

- `receive`: user/channel/hosted ingress and current request refs
- `orient`: Work Card, bounded baseline context, and attention option cards
- `authorize`: capability receipts, operator asks, sandbox posture, and kernel
  proposal state
- `act`: single-tool-call kernel transactions and managed-tool execution
- `verify`: advisory verification evidence or explicit verification gate
  policy input
- `handoff`: replayable tape anchor, summary, and next steps

## Work Card Product

The Work Card is the default inspect projection. It covers goal, context,
options, authority, work, evidence, and handoff by aggregating existing runtime
inspect reports, context cockpit facts, operator safety posture, delegation
inspection, task ledger state, tape status, verification outcome, and handoff
anchors.

It is deliberately a product projection:

- opening it is read-only and side-effect free
- shell, CLI, channel, and embedder renderers should consume the same
  schema-tagged payload
- text renderers keep bounded line budgets and preserve canonical refs for
  drill-down
- raw replay, context, authority, skills, inbox, diff, and timeline details are
  drill-down views rather than the default surface
- it never replaces event tape, kernel receipts, workbench state, or capability
  records

## Workbench Product

The primary cognitive product is the workbench, not context injection.

The workbench is a model-authored notebook made of free-form notes and
evictions with source references, reasons, digests, and preserved quotes. The
model decides what deserves future attention. Brewva records that decision for
inspection and recovery without treating it as effect authority.

The workbench should remain deliberately small:

- `workbench_note` writes a memory entry.
- `workbench_evict` removes stale spans from active attention and may preserve
  replacement notes or exact quotes.
- `recall_search` is called on demand when the model needs previous evidence.
- `workbench_compact` creates a compact baseline when the model or hard context
  limit requires it.

No runtime service should rebuild a hidden thought path by preselecting recall
entries, task stages, or finish posture before the model asks. SkillCards are
the exception only in a narrow sense: Brewva may render a deterministic,
turn-scoped advisory shortlist from explicit mention, path glob, trigger,
name, or text match. That shortlist manages attention; it does not create
authority or persistent workflow state.

## Attention Options Product

Attention options are the product answer for unbounded or cross-session
evidence. They expose candidate cards from SkillCards, workbench entries,
surfaced recall, session tape evidence, and `docs/solutions/**` precedents
before returning large content.

The action split is part of the authority model:

- `attention_options` returns bounded cards only
- `attention_consume` reveals the selected content and records consumed refs
- `attention_pin` writes through the existing workbench pin path
- `attention_ignore` records session-scoped advisory suppression
- `attention_verify_plan` returns a recipe only, without filesystem, command,
  provider, or network effects

Consuming `session_tape_evidence` returns a redacted event summary, not raw tape
payload JSON.

Bounded baseline context still materializes directly when it is already part of
the ordinary request shape: current request, project guidance, target roots,
selected capability posture, current diff posture, latest handoff, and context
pressure. Those facts do not pay an options round trip.

## Context Product

Context composition is request materialization over runtime facts. Its default
shape is:

1. rendered `BrewvaSystemPromptDocument` blocks: stable contracts, tool
   policy, custom instructions, project instructions, capability receipt, and
   environment
2. hosted lifecycle additions such as a turn-scoped SkillCard shortlist or
   target-scoped project instructions
3. active workbench entries
4. explicitly requested details such as recall results or capability details
5. numeric context status and other small dynamic-tail facts

Context composition preserves provenance, cache posture, and hard-limit
instructions. It is not the product layer that decides salience.

## Operator Product

The CLI/TUI shell is an experience ring surface. It owns overlays, keybindings,
runtime cockpit rendering, model selection, provider connection flows, inbox,
approvals, memory-operation visibility, cache/cost summaries, and explicit
archive drill-down views. These surfaces render runtime claims and workbench
evidence; they do not create authority.

The first operator surface is the runtime cockpit: physics bar, Work Card,
decision lane, effect ledger, attention glance, recovery lane when active, and
composer policy. Transcript, raw event tape, receipt detail, context,
authority, skills, inbox, diff, and timeline views are explicit-pull drill-downs
from that shared product projection.

## Handoff Product

Handoff is a replayable continuation anchor, not an informal transcript note.
Shell and palette actions record the handoff through the tape handoff authority
path. Transcripts, export bundles, Work Cards, and channel inspect views show
the latest handoff anchor, summary, and next steps so another actor can resume
from the same evidence trail.

## Kernel Product

The kernel product is intentionally boring: effect gates, tool commitments,
approval requests, commit receipts, abort receipts, verification, rollback
receipts, Recovery WAL, and durable event families. If a feature needs durable
authority, it should enter through `runtime.kernel` or a capability-scoped
`ops.*` adapter, rather than through model-facing prompt shape.

## Explicit Non-Goals

- no prompt-only authority
- no hidden runtime planner inferred from product lanes
- no runtime-owned attention selector
- no model-writable durable control state
- no UI presentation object that changes replay truth

## Related Docs

- `docs/architecture/system-architecture.md`
- `docs/reference/hosted-dynamic-context.md`
- `docs/reference/runtime.md`
- `docs/reference/tools/memory-and-recall.md`
- `docs/reference/commands/interactive.md`
