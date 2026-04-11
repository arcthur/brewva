# Installation

This guide covers local operator setup and command availability. For the exact
CLI/config contract, use the reference docs.

## Prerequisites

- Bun `1.3.11`
- Node `^20.19.0 || >=22.12.0` for CLI execution and tooling
- Model/provider setup supported by the bundled agent engine

Build and test with Bun, not npm or yarn.

## Local Setup

```bash
bun install
bun run build
bun run start -- --help
```

## Install `brewva` Command Locally (macOS/Linux)

The repository includes a local installer that symlinks the platform binary to
`~/.local/bin/brewva` by default.

```bash
bun run install:local
brewva --help
```

Useful installer options:

```bash
# Preview actions only
bash script/install-local.sh --dry-run

# Install to a custom bin directory
bash script/install-local.sh --bin-dir /usr/local/bin

# Remove the local installation
bun run uninstall:local
```

If the current platform binary is missing, the installer runs `bun run build:binaries`
automatically (disable with `--no-build`).

## Onboard Daemon Service

After `brewva` is available on `PATH`, use onboard helpers:

```bash
brewva onboard --install-daemon
brewva onboard --uninstall-daemon
```

For service lifecycle and control-plane details, see
`docs/guide/gateway-control-plane-daemon.md`.

## Validation Commands

```bash
bun run check
bun test
bun run test:docs
```

## Key Configuration Paths

- Root scripts: `package.json`
- Workspace TS project graph: `tsconfig.json`
- Runtime defaults: `packages/brewva-runtime/src/config/defaults.ts`
- Command surface reference: `docs/reference/commands.md`

## Related Docs

- Documentation map: `docs/index.md`
- Repository orientation: `docs/guide/overview.md`
- CLI usage: `docs/guide/cli.md`
- Gateway daemon lifecycle: `docs/guide/gateway-control-plane-daemon.md`
- Command and config contracts: `docs/reference/commands.md`,
  `docs/reference/configuration.md`
