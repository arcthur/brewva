# Commands: Credentials, Inspect, Insights

This page covers root helper subcommands that are not the interactive shell or
gateway daemon.

## Credentials

`brewva credentials` manages the encrypted credential vault.

Common operations:

- list vault refs
- add a ref from a literal value
- add a ref from an environment variable
- remove a ref
- discover provider credential candidates

The interactive shell's `/model` flow is the primary provider-auth experience;
the credentials subcommand is the lower-level operational surface.

## Inspect

`brewva inspect` is the canonical replay-first operator view for a persisted
session. Its default output is a schema-tagged Work Card that renders goal,
context, options, authority, active work, evidence, and latest handoff from
runtime tape plus nearby artifact diagnostics. Context cockpit, authority,
skills, inbox, diff, timeline, and raw replay details are explicit drill-downs
or diagnostic modes rather than the default product shape.

`brewva --replay` prints raw replay records for scripts that depend on event
payloads. `brewva --replay-timeline` prints the redacted timeline projection with
canonical event refs.

Directory-scoped inspect requests should remain deterministic and should not
create new runtime authority.

## Insights

`brewva insights` aggregates across recent sessions for a workspace or
directory scope. It should surface friction hotspots, verification posture,
notable sessions, and repeated delivery patterns without hiding provenance.

## Onboard

`brewva onboard` is a convenience wrapper around gateway daemon install and
uninstall. Shared onboard flags mirror gateway install/uninstall behavior.
