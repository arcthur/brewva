# Reference: Commands (CLI Surface)

`pi-roaster` does not expose a slash-command registry. Its command surface is the CLI flag set.

Implementation source: `packages/roaster-cli/src/index.ts`.

## Mode Commands

- Interactive mode (default)
- Print text mode (`--print`)
- Print JSON mode (`--mode json`, `--json`)
- Undo mode (`--undo`)
- Replay mode (`--replay`)

## Flags

- `--cwd`
- `--config`
- `--model`
- `--no-extensions`
- `--print`
- `--interactive`
- `--mode`
- `--json`
- `--undo`
- `--replay`
- `--session`
- `--verbose`
- `--help`

## Startup Defaults

- Interactive mode defaults to quiet startup (reducing banner/changelog/version-check output).
- Use `--verbose` to explicitly enable detailed startup output.
- To temporarily restore version-check notifications, run: `PI_SKIP_VERSION_CHECK= bun run start`.
