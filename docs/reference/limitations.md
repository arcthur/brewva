# Reference: Known Limitations

This page captures current, intentional, or temporary limitations that are easy
to miss when reading individual module docs.

Normative key shapes and command surfaces remain in
`docs/reference/configuration.md` and `docs/reference/commands.md`. This page
only collects caveats and intentionally narrow behavior.

## Runtime Surface

- `HostedRuntimeAdapterPort.ops.events.records.subscribe(...)` is in-process and
  ephemeral.

## Event Pipeline

- Event level filtering (`infrastructure.events.level`) gates advisory
  read-model rows at write time. Filtered rows are not mirrored into canonical
  tape as `custom` records and cannot be replayed later.

## Configuration Boundary

- Startup UI config currently exposes `ui.quietStartup` only.
- Parallel per-session total-start cap is configurable via
  `parallel.maxTotalPerSession` (default `10`).
- Context compaction recency window used by gate logic is internal and not
  configurable.

## CLI / Backend Boundary

- `--backend gateway` is currently limited to one-shot text mode.
- `--backend gateway` does not support interactive mode, JSON mode,
  `--undo`/`--replay`, `--daemon`, `--channel`, or TaskSpec (`--task`, `--task-file`).
- `--managed-tools direct` does not disable hosted lifecycle ports; it only
  switches managed Brewva tools from hosted registration to direct host
  provisioning.

## Schedule Runtime

- Daemon mode requires both `schedule.enabled=true` and
  `infrastructure.events.enabled=true` so schedule read-model observations are
  mirrored into canonical tape.
- Startup catch-up is bounded by `schedule.maxRecoveryCatchUps`; overflow runs are
  deferred instead of executed immediately.
