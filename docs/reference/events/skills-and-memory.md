# Skill And Memory Event Families

This page covers skill lifecycle, budget, routing, recall, narrative memory,
deliberation memory, semantic extraction, and iteration-fact events.

## Skill Lifecycle

Skill lifecycle events record activation, completion, rejected completion,
contract failure, refresh, diagnosis derivation, and promotion review
surfaces. The parent runtime owns active skill state and completion authority;
delegated children may return skill-shaped outputs, but the parent decides
whether those outputs become authoritative lifecycle state.

## Skill Budget

Budget warning and parallel warning events explain why a skill is approaching
or crossing a declared resource boundary. They do not mutate the skill catalog
or routing taxonomy by themselves.

## Recall And Narrative Memory

Recall and narrative memory events expose semantic memory as inspectable
evidence:

- recall curation records operator or runtime curation actions
- recall utility observations describe usefulness signals
- recall surfaced events connect query intent to returned evidence
- narrative memory events track record, review, promotion, archive, and forget
  transitions

Narrative memory is advisory unless a downstream runtime surface explicitly
uses it as evidence.

## Deliberation And Semantic Extraction

Deliberation and semantic extraction events explain why a summarization,
rerank, or extraction path ran. They are inspection support, not hidden planner
state.

## Iteration Facts

Iteration metric and guard events persist bounded optimization evidence. They
are lineage-aware facts for repeated improvement loops, not a replacement for
task/truth state or verification reports.

## Implementation Anchors

- `packages/brewva-runtime/src/domain/skills/skill-lifecycle.ts`
- `packages/brewva-runtime/src/domain/skills/registry.ts`
- `packages/brewva-runtime/src/domain/iteration/facts.ts`
- `packages/brewva-recall/src/broker.ts`
