# Commands: Harness

`brewva harness` is the explicit-pull operator surface for trace-driven Harness
improvement. It reads rebuildable session-index projections and gateway Harness
analysis APIs. It does not mutate prompts, skills, provider routing, recall
ranking, or tool policy.

## Snapshots

```text
brewva harness snapshots [--session <id>] [--limit <n>] [--json]
```

Lists `HarnessTraceSnapshot` rows. Each row points back to a manifest id,
source event ids, provider identity, tool/cache/context summaries, and detected
signals.

## Patrol

```text
brewva harness patrol [--limit <n>] [--min-occurrences <n>] [--json]
```

Clusters recent snapshots deterministically into pattern candidates. The
candidate is a report artifact only. Promotion remains explicit governance.

## Compare

```text
brewva harness compare --source-session <id> --diverge-at <event-id> [--mode manifest|fixture|real] [--target-session <id>] [--candidate-manifest <path>] [--json]
```

Default `manifest` mode compares recorded base Harness identity with a current
runtime identity without provider or tool execution. `--candidate-manifest`
points to a manifest-compatible JSON object and compares that explicit
candidate instead; Brewva recomputes the candidate manifest id from the file
contents. `fixture` mode forks the recorded source prefix into a target session
using `replay-then-real`, then continues with a fixture provider and no-op
tools. If `--target-session` is omitted in fixture mode, Brewva creates a
deterministic Harness fixture target id for the source/divergence pair; the
target must be empty, so repeated runs should pass an explicit fresh
`--target-session`.
`real` mode uses hosted provider/tool/authority ports, requires a target
session, and refuses to run against the source session.

Replay-backed compare modes choose a continuation prompt from the first source
turn after the divergence event, then the divergence turn itself, then a
synthetic fallback. Reports include `promptSource` so operators can distinguish
source-turn replay from synthetic comparison prompts.

When a source session has multiple Harness snapshots, `--diverge-at` must match
an event id in the intended snapshot evidence. This prevents compare from
silently using the wrong base manifest.

## Related Docs

- `docs/reference/events/harness.md`
- `docs/reference/working-projection.md`
