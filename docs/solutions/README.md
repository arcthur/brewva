# Repository-Native Solutions

`docs/solutions/**` is Brewva's canonical repository-native compound knowledge
plane. It stores engineering precedents that later planning, debugging, review,
and capture flows can retrieve explicitly through `knowledge_search`.

This directory is not runtime authority and it is not hidden memory. It is the
cold knowledge layer for reusable repository-specific experience.

## Source Authority And Contradiction Resolution

Use this precedence order when repository knowledge sources disagree:

1. current code, tests, runtime receipts, and verification evidence
2. promoted architecture or reference documentation
3. active solution records under `docs/solutions/**`
4. promotion candidates and draft protocol updates
5. deliberation-memory hints

Conflict rules:

- if runtime evidence or current code contradicts a solution record, the code
  path wins and the solution record should be refreshed
- if a promoted architecture or reference document contradicts a solution
  record, the stable document is normative and the solution record should be
  marked `stale` or `superseded`
- solution records may preserve contradictions in the body, but they must not
  silently flatten them into false certainty

## Document Role

Solution records capture repository-specific engineering precedents:

- what problem class appeared
- what failed
- what ultimately worked
- why the final repair was correct
- what later planners or reviewers should preserve

They are not replacements for:

- `docs/architecture/**`: stable invariants and implemented design
- `docs/reference/**`: public contracts and normative technical surfaces
- `skill_promotion`: agent behavior or protocol improvements

One event may produce both a solution record and a promotion candidate, but the
artifacts should cross-reference each other explicitly.

## Path Convention

Recommended location pattern:

`docs/solutions/<problem-family>/<slug>.md`

Examples:

- `docs/solutions/<problem-family>/<slug>.md`
- `docs/solutions/<boundary-family>/<slug>.md`
- `docs/solutions/<operational-family>/<slug>.md`

Choose the narrowest family that keeps related precedents discoverable without
creating a giant flat directory.

## Frontmatter Contract

Keep frontmatter small and retrieval-oriented:

```yaml
---
id: sol-2026-03-31-wal-recovery-race
title: WAL recovery race during replay
status: active
problem_kind: bugfix
module: brewva-runtime
boundaries:
  - runtime.turnWal
  - runtime.tools
source_artifacts:
  - investigation_record
  - review_findings
  - retro_findings
tags:
  - wal
  - recovery
  - concurrency
updated_at: 2026-03-31
---
```

Preferred keys:

- `id`
- `title`
- `status`
- `problem_kind`
- `module`
- `boundaries`
- `source_artifacts`
- `tags`
- `updated_at`

Do not move the real engineering narrative into frontmatter. Use the body for
substance.

## Body Sections

Recommended bug-fix or incident sections:

- `Problem`
- `Symptoms`
- `Failed Attempts`
- `Solution`
- `Why This Works`
- `Prevention`
- `References`

Recommended design or feature lesson sections:

- `Context`
- `Guidance`
- `Why This Matters`
- `When to Apply`
- `Examples`
- `References`

## Capture Rules

- bug-fix and incident capture require an `investigation_record`
- design and feature lessons should start from `design_spec`, `review_report`,
  `retro_findings`, and `verification_evidence`
- transcript material is supplemental, not primary authority
- update an existing active record instead of creating a duplicate when the
  problem class is materially the same
- use `status: stale` or `status: superseded` when later stable docs or current
  code invalidate an older precedent

## Retrieval And Discoverability

For non-trivial planning, debugging, or review:

- query this layer explicitly with `knowledge_search`
- use `precedent_audit` when checking whether a stable doc or successor
  precedent displaced an older record
- use `precedent_sweep` only when you intentionally want a repository-wide
  maintenance pass across many solution records
- preserve proof of consult through `precedent_refs`,
  `precedent_query_summary`, or an explicit no-match result
- treat `source_type`, `authority_rank`, and `freshness` as decision context,
  not as automatic truth

`docs/solutions/**` only compounds if later skills can find and reuse it. If a
planner or reviewer cannot discover this directory, the knowledge plane is not
working in practice.

## Materialization

Use `knowledge_capture` to write or update canonical solution records.

- the tool materializes deterministic frontmatter and body structure
- `bugfix` and `incident` records require `investigation_record` authority and
  a `Failed Attempts` section
- `stale` or `superseded` records must carry derivative links to a stable doc
  or successor precedent that displaced them; promotion candidates alone are
  not sufficient displacement routing
- promotion-candidate derivative links should point into
  `.brewva/skill-broker/**` so warm-memory follow-up remains inspectable
- `precedent_audit` is the read-only maintenance surface for stale routing,
  higher-authority overlap, and explicit contradiction review before or after a
  capture
- `precedent_sweep` is the read-only broad maintenance surface; it exists for
  explicit cleanup passes, not as a default hosted sweep
