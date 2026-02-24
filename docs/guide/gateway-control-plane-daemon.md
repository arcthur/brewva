# Guide: Gateway Control Plane Daemon

## Purpose and Scope

`brewva gateway` is the local control plane daemon. It exposes a typed WebSocket API that can be consumed by CLI, macOS app, Web UI, and automation components.

This is a different path from `--channel` (for example, Telegram ingress/egress):

- `--channel` handles external channel message transport.
- `brewva gateway` handles local control plane session orchestration and process isolation.

## Security Boundaries

- Bind only to loopback (`127.0.0.1`, `::1`, or `localhost`).
- Never expose the control plane port directly to the public internet.
- For remote access, use VPN or Tailscale and keep gateway bound to loopback.
- Authentication is challenge-response: receive `connect.challenge`, then call `connect` with token and nonce.

## Quick Start

```bash
brewva gateway start
brewva gateway install
brewva gateway status --deep
brewva gateway rotate-token
brewva gateway logs --tail 200
brewva gateway stop
```

Detached mode:

```bash
brewva gateway start --detach
```

Install as always-on service:

```bash
brewva gateway install
brewva gateway install --systemd
brewva gateway uninstall
```

For scripting and automation, use `--json`:

```bash
brewva gateway status --deep --json
brewva gateway heartbeat-reload --json
brewva gateway rotate-token --json
```

## Lifecycle and Operational Commands

- `start` (`run` alias): start daemon (foreground by default, use `--detach` for background).
- `status`: health probe and deep status (`--deep`, `--json` supported).
- `stop`: graceful stop; use `--force` as fallback.
- `install`: install OS supervisor service (macOS `launchd`, Linux `systemd --user`).
- `uninstall`: remove installed OS supervisor service.
- `heartbeat-reload`: hot-reload `HEARTBEAT.md` policy.
- `rotate-token`: rotate token and immediately revoke authenticated connections using the previous token.
- `logs`: read daemon logs (`--tail` and `--json` supported).

Supervisor defaults:

- macOS: `~/Library/LaunchAgents/com.brewva.gateway.plist` (`KeepAlive=true`, `RunAtLoad=true`).
- Linux: `~/.config/systemd/user/brewva-gateway.service` (`Restart=always`).
- Use `--no-start` to write files without enabling/startup.
- Use `--dry-run` to preview generated service content.
- One-shot wrapper: `brewva onboard --install-daemon`.

For full flag-level contract (per subcommand), see:

- `docs/reference/commands.md` ("Gateway Subcommand Flags")

## State Directory and Artifacts

Default state directory is `<global brewva root>/agent/gateway`, resolved from `resolveBrewvaAgentDir()`.
Common default is `~/.config/brewva/agent/gateway` (or under `XDG_CONFIG_HOME` when set).

Key files:

- `gateway.pid.json`: daemon PID and listening metadata.
- `gateway.log`: structured logs (with rotation).
- `gateway.token`: control plane auth token.
- `HEARTBEAT.md`: externalized heartbeat policy file.
- `children.json`: child-process registry used for orphan cleanup during restart.

Optional HTTP probe endpoint:

- `--health-http-port <port>` enables loopback HTTP probe server.
- `--health-http-path <path>` customizes probe path (default `/healthz`).
- Response schema: `brewva.gateway.health-http.v1`.

## Latest-Only Protocol Semantics

To reduce ambiguity and long-term compatibility complexity, the control plane uses latest-only semantics:

- `connect` accepts a single `protocol` field and requires exact version match.
- `sessions.send` is stream-first only; `stream=false` sync mode is not supported.
- `gateway.rotate-token` does not support grace windows; old token is invalid immediately.

Primary implementation surfaces:

- `packages/brewva-gateway/src/protocol/schema.ts`
- `packages/brewva-gateway/src/client.ts`
- `packages/brewva-gateway/src/daemon/gateway-daemon.ts`

## Further Reading

- Protocol and method details: `docs/reference/gateway-control-plane-protocol.md`
- Main CLI subcommand entry: `packages/brewva-cli/src/index.ts`
- Gateway CLI implementation: `packages/brewva-gateway/src/cli.ts`
