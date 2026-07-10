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
tools; it refuses `--candidate-manifest` (scripted frames cannot execute a
candidate delta). If `--target-session` is omitted in fixture mode, Brewva
creates a deterministic Harness fixture target id for the source/divergence
pair; the target must be empty, so repeated runs should pass an explicit fresh
`--target-session`.

`real` mode uses hosted provider/tool/authority ports, requires a target
session, and refuses to run against the source session. It always executes in
a disposable copy-on-write fork of the workspace (a trial world): filesystem
tool effects land in the fork while the fork's durable tape/ledger evidence
stays in the operator store under the target session. Forking copies and
hashes the tracked tree — large workspaces pay real IO, oversized trees fail
closed — and forks from a linked git worktree are git-less (reported as
`trialWorldSource: "walk"`). A loaded `--candidate-manifest` is admitted only
through materialization: every changed field must flow through an execution
seam (today exactly `provider.model`, applied as the trial session's model and
verified before and after the run) or be a hash the run recomputes; anything
else — including removing the model — refuses with the blocked fields named,
and the base manifest must still describe the current runtime. The report's
`executedManifestId` must equal its `candidateManifestId` for the report to be
candidate evidence; any mismatch or unmaterializable field is recorded as a
rejecting regression.

Replay-backed compare modes choose a continuation prompt from the first source
turn after the divergence event, then the divergence turn itself, then a
synthetic fallback. Reports include `promptSource` so operators can distinguish
source-turn replay from synthetic comparison prompts.

When a source session has multiple Harness snapshots, `--diverge-at` must match
an event id in the intended snapshot evidence. This prevents compare from
silently using the wrong base manifest.

## Candidate Lifecycle

```text
brewva harness candidate accept|reject|archive --candidate <candidateId> --reason <text> [--json]
```

Every compare report mints a stable `candidateId` from its (base, candidate)
manifest-id pair and appends an `evaluated` receipt to the workspace candidate
ledger (`.brewva/harness/candidates.jsonl`, see
`docs/reference/artifacts-and-paths.md`). The lifecycle verbs record the
operator's accountable decision with a required reason; an id the local ledger
has never seen warns but still records, since candidates span checkouts. No
runtime path reads the ledger for authority — promotion remains explicit
governance.

## Related Docs

- `docs/reference/events/harness.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/working-projection.md`
