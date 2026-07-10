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
a disposable copy-on-write fork of the workspace (a trial world) under a
single trial-run owner: one trial-rooted runtime whose identity (cwd,
workspace root, task descriptor roots, tool allowed roots) is the fork, whose
prompt-derived external writable roots are sealed (`descriptor_only` — a
replayed prompt citing the operator's real workspace cannot re-grant it), and
whose tape is the only writer for the target session. Filesystem tool effects
land in the fork while the fork's durable tape/ledger evidence stays in the
operator store under the target session; the operator settings tree copied
into the fork (`.brewva/agent`) is fingerprinted as `trialSettingsHash`.
Forking copies and hashes the tracked tree — large workspaces pay real IO,
oversized trees fail closed — and forks from a linked git worktree are
git-less (reported as `trialWorldSource: "walk"`). A loaded
`--candidate-manifest` is reduced to a candidate patch — its normalized
editable delta, with derived hashes and provenance stripped — and admitted
only through materialization of that patch: every patch field must flow
through an execution seam (today exactly `provider.model`, applied as the
trial session's model and verified before and after the run); anything else —
including removing the model — refuses with the blocked fields named before
any provider or tool call, and the base manifest must still describe the
current runtime. Execution honesty is read back, never asserted: the report's
`executedManifestId` is the manifest the target tape actually recorded (null
when the run recorded none), and every materialized delta field is verified
against it (`deltaVerifiedFields`); a mismatch is recorded as a rejecting
`execution_candidate_delta_not_executed:<field>` regression.

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

Every compare report mints a stable `candidateId` by hashing the candidate's
normalized field delta — the sorted (field, target value) edits, with
derived/provenance fields stripped — so the same edit evaluated against
different base sessions (held-in and held-out) stays ONE candidate.
Execution-backed compares (fixture/real) append an `evaluated` evaluation
receipt to the workspace candidate ledger (`.brewva/harness/candidates.jsonl`,
see `docs/reference/artifacts-and-paths.md`) binding the run's evidence:
`evaluationId` (candidate × source × divergence × target × mode), the
tape-derived `executedManifestId`, and the trial-world basis. Manifest-only
diffing appends nothing — an `evaluated` row always points at a run. A compare
whose receipt append fails still prints its report and exits `3` (partial
failure), so the receipt can be retried without re-running the compare.

The lifecycle verbs record a decision receipt with a required reason. They
refuse ids that are not candidate ids — a patrol `patternId` is a report
artifact, not a decidable candidate — while a well-formed id the local ledger
has never seen warns but still records, since candidates span checkouts. The
recorded `actor` is `cli_invocation`: factual provenance of the door the
record came through, not a trust claim. No runtime path reads the ledger for
authority — promotion remains explicit governance.

## Related Docs

- `docs/reference/events/harness.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/working-projection.md`
