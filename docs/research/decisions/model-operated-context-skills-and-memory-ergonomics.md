# Decision: Model-Operated Context, Skills, And Memory Ergonomics

## Metadata

- Decision: skill, cockpit, recall, workbench, and compact-baseline ergonomics improve visibility without reintroducing hidden attention admission.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/reference/skills.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/events/skills-and-memory.md`
  - `docs/architecture/cognitive-product-architecture.md`
- Code anchors:
  - `packages/brewva-cli/src/operator/inspect/context-cockpit.ts`
  - `packages/brewva-tools/src/families/memory/workbench.ts`
  - `packages/brewva-tools/src/families/memory/recall.ts`
  - `packages/brewva-tools/src/families/memory/attention-options.ts`
  - `packages/brewva-tools/src/families/memory/solution-record.ts`
  - `packages/brewva-recall/src/broker/source-mappers.ts`
  - `packages/brewva-token-estimation/src/index.ts`

## Decision Summary

- SkillCards stay advisory catalog cards. They may expose discovery, examples, argument hints, and resource refs, but they do not grant tools, accounts, budgets, model routes, or completion gates.
- Context cockpit is a read-only inspect projection over workbench, recall, compaction, baseline, context pressure, cache posture, and capability evidence.
- Opening catalog, cockpit, or recall inspect views does not mutate event tape, trigger recall, select capabilities, route providers, update workbench, or change the next model attention input.
- Durable repository memory uses `docs/solutions/**`; warm session memory uses workbench entries; recall source families stay limited to owned constants.
- Compaction input provenance preserves explicit active evidence and forbids hidden compact-time recall search.

## Superseded by

- None.
