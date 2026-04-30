# Commands: Gateway

`brewva gateway` manages the local control-plane daemon for hosted sessions,
process isolation, and local clients.

## Subcommands

The generated inventory in `docs/reference/commands.md` is the exact
subcommand and flag list. Semantically, gateway commands fall into these
groups:

- lifecycle: start, stop, status, logs
- service install: install, uninstall
- scheduler control: pause and resume
- token and heartbeat maintenance

## Gateway Versus Channel

`brewva gateway` and `--channel` are different execution paths:

- gateway runs the local hosted-session control plane
- channel mode runs external ingress/egress orchestration such as Telegram

Gateway operations are not a distributed transaction coordinator. They do not
define cross-agent saga semantics, generalized compensation, or automatic
partial-failure repair.

## Operational Posture

Gateway commands should expose daemon state, pid/log/token paths, health,
deep diagnostics, and timeout behavior as inspectable operator output. They
should fail closed when config loading, token access, or loopback binding is
invalid.

## Related Docs

- `docs/guide/gateway-control-plane-daemon.md`
- `docs/reference/gateway-control-plane-protocol.md`
