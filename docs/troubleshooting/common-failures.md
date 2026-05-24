# Troubleshooting: Common Failures

Start with `brewva inspect` for any persisted-session issue. It rebuilds the
authoritative replay state first, then reports which derived layer is stale or
inconsistent.
This page is incident-first operator guidance, not the full command, event, or
runtime contract.

## Verification Or Acceptance Is Blocked

- Cause: missing verification evidence, stale evidence after a write boundary,
  or an effect receipt that has not reached an accepted task state.
- Check: `brewva inspect --session <id>` for latest verification outcome,
  task state, workbench baseline, and effect receipts.
- Action: run the required verification checks, record the evidence, and update
  task/workbench state if the model's working memory is stale.

## `tool_call` Is Blocked

- Cause: denied effects, effect-authorization enforcement, token/tool-call
  budget enforcement, or cost budget violation.
- Check: `brewva inspect --session <id>` for cost summary, latest
  verification/task state, and recent tool denial receipts.
- Action: use an allowed tool path, adjust `security.mode`
  (`permissive`/`standard`/`strict`) to change effective enforcement strategy,
  request a bounded resource lease, or resolve budget policy constraints.

## `--replay` Returns No Session

- Cause: no persisted event file for any session.
- Check: `brewva inspect` to confirm whether any replayable session exists for the current workspace.
- Action: run at least one normal session to generate event artifacts.

## `--undo` Has No Recoverable Patch

- Cause: no tracked mutation exists in the target session.
- Check: `brewva inspect --session <id>` for rollback snapshot availability and recent mutation history.
- Action: ensure edits occur through tracked tool paths and retry.

## Workspace Scan Is Slow Or Incomplete

- Cause: parallel read scans are forced to sequential mode, scan includes too many files, or files are intermittently unreadable.
- Check:
  - `packages/brewva-tools/src/runtime-port/parallel-read.ts`
  - `packages/brewva-tools/src/families/navigation/lsp.ts`
  - `packages/brewva-tools/src/families/navigation/source-patch.ts`
  - `docs/reference/events/README.md` (`tool_parallel_read`)
- Action:
  - Start with `brewva inspect --session <id>` to confirm tape/projection health, then inspect session events for `tool_parallel_read` payloads.
  - If `mode=sequential` with `reason=parallel_disabled`, enable runtime `parallel.enabled`.
  - If `failedFiles` is consistently high, verify file permissions and path stability.
  - If `durationMs` and `batches` are high for large scans, tune `parallel.maxConcurrent`.
  - Note: per-session total parallel starts are capped by `parallel.maxTotalPerSession` (default `10`).

## Related Docs

- CLI and operator entrypoints: `docs/guide/cli.md`
- Inspect / replay / recovery walkthrough: `docs/journeys/operator/inspect-replay-and-recovery.md`
- Runtime event contract: `docs/reference/events/README.md`
- Session lifecycle and artifacts: `docs/reference/session-lifecycle.md`,
  `docs/reference/artifacts-and-paths.md`
