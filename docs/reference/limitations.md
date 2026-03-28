# Reference: Known Limitations

This page captures current, intentional, or temporary limitations that are easy
to miss when reading individual module docs.

## Runtime Surface

- `runtime.events.subscribe(...)` is in-process and ephemeral.

## Event Pipeline

- Event level filtering (`infrastructure.events.level`) happens at write time.
  Events filtered out by level are not persisted and cannot be replayed later.

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
  switches managed Brewva tools from runtime-plugin registration to direct host
  provisioning.

## Schedule Runtime

- Daemon mode requires both `schedule.enabled=true` and
  `infrastructure.events.enabled=true`.
- Startup catch-up is bounded by `schedule.maxRecoveryCatchUps`; overflow runs are
  deferred instead of executed immediately.
