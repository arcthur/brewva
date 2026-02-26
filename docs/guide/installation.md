# Installation

## Prerequisites

- Bun `1.3.9+`
- Node `^20.19.0 || >=22.12.0` for CLI execution and tooling
- Model/provider setup supported by `@mariozechner/pi-coding-agent`

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

## Validation Commands

```bash
bun run typecheck
bun test
bun run test:docs
```

## Key Configuration Paths

- Root scripts: `package.json`
- Workspace TS project graph: `tsconfig.json`
- Runtime defaults: `packages/brewva-runtime/src/config/defaults.ts`
