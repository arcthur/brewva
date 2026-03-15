# Reference: Addons

`@brewva/brewva-addons` is the public, operator-facing augmentation surface. Addons live outside the kernel and can only influence runtime behavior through persisted artifacts and proposal-bound context packets.

## Terminology

- Addon: an operator-installed control-plane module loaded from `.brewva/addons/**`
- Extension: a session-lifecycle hook stack wired into the gateway/Brewva session runtime
- Runtime plugin: one implementation file of an extension under `packages/brewva-gateway/src/runtime-plugins`

These are related but not interchangeable surfaces. Addons publish durable state
and packets; extensions consume runtime events and shape the live session.

## Scope

Addons can declare:

- config keys
- background jobs
- gateway panels
- artifact reads/writes
- context packet publication

Addons do not:

- mutate kernel state directly
- bypass `runtime.proposals.submit(...)`
- register arbitrary lifecycle hooks into the Brewva session runtime

## Package Surface

- SDK package: `packages/brewva-addons/src/index.ts`
- Gateway host: `packages/brewva-gateway/src/addons/host.ts`
- Session bootstrap integration: `packages/brewva-gateway/src/host/create-hosted-session.ts`

## Workspace Layout

Addons are discovered under:

```text
.brewva/addons/<addon-id>/index.js
.brewva/addons/<addon-id>/index.ts
```

Gateway-owned control-plane state is persisted under:

```text
.brewva/addons/<addon-id>/config.json
.brewva/addons/<addon-id>/artifacts/**
.brewva/addons/<addon-id>/context-packets.jsonl
```

## Minimal Definition

```ts
import { defineAddon } from "@brewva/brewva-addons";

export default defineAddon({
  id: "ops-status",
  jobs: [
    {
      id: "daily-summary",
      schedule: { cron: "0 9 * * *" },
      run: async (ctx) => {
        await ctx.artifacts.writeJson("status/today.json", { ok: true });
        await ctx.contextPackets.publish({
          scopeId: "team-main",
          packetKey: "daily-summary",
          profile: "status_summary",
          label: "Daily summary",
          content: "Status refreshed",
        });
      },
    },
  ],
});
```

`defineAddon(...)` is optional sugar. A plain default-exported object is also valid when the workspace does not install the SDK package directly.

## Runtime Contract

- Jobs run in the gateway control plane.
- Persisted context packets are replayed into a session as `context_packet` proposals during hosted-session bootstrap.
- Panels render structured data; gateway remains responsible for presentation.

This keeps addon output inspectable and replay-safe while leaving kernel authority boundaries intact.
