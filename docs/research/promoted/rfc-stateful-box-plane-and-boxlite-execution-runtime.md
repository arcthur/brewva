# Research: Stateful Box Plane And BoxLite Execution Runtime

## Document Metadata

- Status: `promoted`
- Owner: runtime, tools, and distribution maintainers
- Last reviewed: `2026-04-25`
- Promotion target:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events.md`
  - `docs/reference/exec-threat-model.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/solutions/security/exec-command-policy-and-readonly-shell.md`
  - `docs/research/promoted/rfc-action-policy-registry-and-least-privilege-governance.md`

## Problem Statement And Scope Boundaries

Brewva's current sandbox path treats isolated execution as a transient command
route. `exec` creates a fresh microsandbox instance, runs one shell command, and
then stops the sandbox. This gives each command a clean execution boundary, but
it does not match how coding agents actually make progress.

Long-running engineering work is stateful:

- dependencies are installed once and reused
- build caches accumulate value
- background processes and dev servers need stable process identity
- generated artifacts need to remain inspectable after the command that created
  them finishes
- recovery needs a concrete execution environment to reattach to, not only a
  transcript of commands
- risky changes benefit from snapshots and forks, not only host rollback

The current implementation already carries the cost of treating sandbox
availability as a distributed service problem:

- `packages/brewva-tools/src/exec.ts` owns microsandbox SDK loading, sandbox
  command construction, sandbox error classification, backoff, session pinning,
  host fallback, and fail-closed events
- `packages/brewva-runtime/src/contracts/config.ts` exposes
  `security.execution.backend = "host" | "sandbox" | "best_available"` and
  `security.execution.sandbox.{serverUrl, defaultImage, memory, cpus, timeout}`
- `packages/brewva-runtime/src/config/defaults.ts` defaults to
  `backend="sandbox"` and `defaultImage="microsandbox/node"`
- `security.credentials.sandboxApiKeyRef` exists only to reach the external
  microsandbox service
- the replacement live coverage is `test/live/box/boxlite-stateful.live.test.ts`,
  which validates stateful filesystem lifetime, reacquire behavior, and box
  lifecycle boundaries

This note proposes replacing that model with a stateful BoxLite execution plane.
The change is intentionally breaking. It does not preserve the old sandbox
configuration, event names, fallback model, or one-command lifecycle.

This note covers:

- the first-principles case for a stateful box plane
- the BoxLite-backed execution contract
- the package, configuration, governance, event, indexing, and distribution
  boundaries affected by the change
- promotion criteria for replacing the current microsandbox path

This note does not cover:

- preserving `security.execution.sandbox.*`
- preserving `backend="sandbox"` or `backend="best_available"`
- preserving microsandbox live tests or `MSB_SERVER_URL`
- treating BoxLite state as replay authority
- building a general container-orchestration abstraction
- supporting every existing binary target if BoxLite has no native runtime for
  that target

## First Principles

### 1. Execution Environments Are Not Commands

An agent does not merely execute commands. It inhabits an environment while it
investigates, edits, tests, and recovers from mistakes.

A command is a momentary action. A box is the durable execution workbench that
makes the sequence coherent. Brewva should model that workbench directly instead
of repeatedly reconstructing it as a side effect of `exec`.

### 2. Isolation Should Preserve Useful State

Isolation is often framed as deletion after execution. That is too narrow for
agentic engineering. The stronger primitive is a named, isolated environment
whose state can be inspected, snapshotted, forked, exported, and eventually
garbage-collected.

The useful safety boundary is not "forget everything after every command." It is
"make state explicit, scoped, and recoverable."

### 3. Authority And Execution State Must Stay Separate

Box state is operational state. It is not Brewva truth.

The event tape remains the authoritative source for runtime decisions,
receipts, proposals, verification posture, and recovery explanation. DuckDB
session indexes remain rebuildable query state. BoxLite's own box database is an
external execution substrate that Brewva can inspect and reconcile, but it must
not become replay authority.

### 4. Local Execution Should Not Depend On A Sandbox Daemon

The current microsandbox path has to reason about server URLs, API keys,
availability failures, backoff, and session pinning. Those concerns are not
central to Brewva's product model. They exist because the sandbox is an external
HTTP service.

BoxLite changes the primitive: a local embedded N-API runtime creates and
manages hardware-isolated boxes. The runtime can still fail, but the failure
mode is local runtime or platform capability failure, not remote service
availability.

### 5. Compatibility Is Not A Design Goal For This Change

The goal is not to hide BoxLite behind the old sandbox shape. The goal is to
make boxes first-class.

Retaining old names such as `sandbox`, `best_available`, `serverUrl`, or
`sandboxApiKeyRef` would preserve the wrong mental model and make stateful
behavior look like an implementation detail. The contract should change where
the concept changes.

## Current Architecture Diagnosis

The existing design has good safety properties, but those properties are bound
to a stateless execution model:

- `exec` can fail closed when sandbox creation fails
- host fallback is explicit and auditable
- command redaction, environment filtering, target-root checks, and timeout
  handling are centralized
- readonly exploration can use `virtual_readonly` without mutating the host
  workspace

Those properties should be retained where they are conceptual, but not where
they are artifacts of microsandbox:

- keep command admission, target-root validation, redaction, and receipts
- keep fail-closed behavior when the selected isolated backend cannot run
- keep explicit host execution as a high-risk operator policy
- remove service backoff and session pinning
- remove sandbox API key resolution
- remove the assumption that background execution is unsupported
- replace one-command sandbox lifecycle with scoped box lifecycle

The architectural smell in the current file is not merely size. It is mixed
responsibility. `packages/brewva-tools/src/exec.ts` simultaneously owns:

- shell policy routing
- virtual readonly materialization
- host process management
- microsandbox SDK loading
- sandbox lifecycle management
- sandbox outage memory
- audit event construction

The BoxLite replacement should use the larger change as a chance to separate the
execution substrate from the `exec` tool adapter.

## BoxLite Capability Fit

BoxLite is a better conceptual match for Brewva's long-running agent model
because it provides:

- embedded local runtime through `@boxlite-ai/boxlite`
- box identity through durable IDs and names
- repeated `box.exec(...)` calls against the same environment
- persistent filesystem state under a BoxLite home directory
- snapshot, clone, export, and import primitives
- network configuration and host access via BoxLite-specific mechanisms
- metrics and inventory APIs
- detach and reattach behavior through runtime lookup

The important shift is not "BoxLite is a better sandbox." The shift is "BoxLite
lets Brewva model execution state as a named local workbench."

The integration must still correct for BoxLite semantics that differ from
Brewva's safety posture:

- BoxLite network allowlist behavior must be wrapped so Brewva's empty allowlist
  means deny, not unrestricted outbound access.
- BoxLite non-zero command exits must be projected into Brewva execution failure
  results consistently.
- BoxLite state must be scoped and indexed by Brewva rather than discovered
  opportunistically.
- Platform support must be explicit in distribution metadata and tests.

## Decision Options

### Option A: Wrap BoxLite Behind The Existing Sandbox Contract

This option preserves `backend="sandbox"`, `security.execution.sandbox.*`, and
the existing `exec` routing shape while replacing `microsandbox` imports with
BoxLite calls.

Benefits:

- smaller public configuration change
- less documentation churn
- some contract tests can be adapted mechanically

Costs:

- hides stateful behavior behind stateless terminology
- keeps obsolete `serverUrl` and API-key-shaped concepts or requires awkward
  no-op fields
- encourages per-command box creation because the old contract has no lifecycle
  noun
- makes snapshots and reattach behavior look like bolt-ons
- preserves too much of the old failure model

Assessment:

- rejected

### Option B: Replace Microsandbox Inline Inside `exec.ts`

This option deletes the microsandbox path and implements stateful BoxLite
behavior directly inside `packages/brewva-tools/src/exec.ts`.

Benefits:

- fastest path to a working prototype
- avoids creating a new package too early
- keeps all `exec` behavior near the tool definition

Costs:

- repeats the current architectural problem with a different backend
- makes box lifecycle hard to share with future tools
- couples BoxLite inventory, snapshots, clone/export, and maintenance to one
  command tool
- makes testing the box plane harder because tests must enter through `exec`

Assessment:

- acceptable for a spike only
- not recommended as the promoted architecture

### Option C: Introduce A Dedicated `@brewva/brewva-box` Plane

This option creates a dedicated package for stateful box acquisition,
execution, snapshotting, inventory, and maintenance. `exec` becomes a consumer
of this plane rather than the owner of the lifecycle.

Benefits:

- expresses the new domain directly
- makes stateful lifecycle visible and testable
- keeps runtime kernel authority separate from concrete execution substrate
- allows future tools to use box inventory, snapshot, fork, reset, and release
  without reaching into `exec`
- gives distribution and platform support one integration point

Costs:

- larger first change
- new package boundary and import surface
- requires explicit configuration, event, and docs migration

Assessment:

- recommended

## Proposed Contract

### Package Boundary

Add a new workspace package named `@brewva/brewva-box` as the box execution
plane.

The package owns:

- BoxLite runtime construction
- box naming and scope resolution
- acquire and reattach behavior
- command execution inside a box
- snapshot, clone, export, import, and release operations
- inventory and metrics projection
- maintenance and garbage collection
- BoxLite-specific error normalization

The package must not own:

- runtime governance admission
- command-policy parsing
- operator approval
- event tape authority
- CLI presentation
- DuckDB session-index persistence

The initial public package surface should be narrow:

```ts
export interface BoxPlane {
  acquire(scope: BoxScope): Promise<BoxHandle>;
  inspect(filter?: BoxInspectFilter): Promise<BoxInventory>;
  maintain(policy?: BoxMaintenancePolicy): Promise<MaintenanceReport>;
}

export interface BoxHandle {
  readonly id: string;
  readonly scope: BoxScope;
  exec(spec: BoxExecSpec): Promise<BoxExecution>;
  snapshot(name: string): Promise<SnapshotRef>;
  fork(name: string): Promise<BoxHandle>;
  release(reason: ReleaseReason): Promise<void>;
}
```

`release(...)` does not mean destroy. By default, release detaches the handle and
keeps the box state available for later acquisition.

### Scope Model

`BoxScope` is the unit of state ownership:

```ts
export type BoxScope =
  | {
      kind: "session";
      id: string;
      workspaceRoot: string;
      image: string;
      capabilities: BoxCapabilitySet;
    }
  | {
      kind: "task";
      id: string;
      workspaceRoot: string;
      taskRoot: string;
      image: string;
      capabilities: BoxCapabilitySet;
    }
  | {
      kind: "ephemeral";
      id: string;
      workspaceRoot: string;
      image: string;
      capabilities: BoxCapabilitySet;
    };
```

Default `exec` scope is `session`. `task` is reserved for explicit task-target
isolation. `ephemeral` is the only scope kind allowed to destroy the box on
release by default.

### Scope Identity And Capability Fingerprints

Box acquisition must be deterministic.

The canonical box fingerprint is derived from:

- `kind`
- `id`
- `image`
- `workspaceRoot`
- `capabilitySetHash`

If the fingerprint is identical, `acquire(scope)` must return the same box
unless the box is missing, corrupted, or explicitly reset. That exception must
be visible in the `box.acquired` event payload.

Capability changes are resolved before a new box is created:

- identical capability sets reuse the existing box
- any capability-set change creates a new fingerprint and a new box with
  `box.acquired.acquisitionReason="capability_changed"`
- narrower requests do not reuse broader boxes because BoxLite capabilities are
  fixed at VM creation time
- requesting an incompatible capability set fails closed unless governance
  explicitly admits a new scope or fork

`BoxCapabilitySet` should stay small and typed:

```ts
export interface BoxCapabilitySet {
  network: {
    mode: "off" | "allowlist";
    allow: string[];
  };
  gpu: "none" | "required";
  extraVolumes: Array<{
    hostPath: string;
    guestPath: string;
    readOnly: boolean;
  }>;
  secrets: Array<{
    name: string;
    hosts: string[];
  }>;
  ports: Array<{
    guestPort: number;
    protocol: "tcp" | "udp";
  }>;
}
```

Downstream tools must not attach ad hoc fields to the capability set. New
capabilities require runtime contract changes and docs coverage.

### Workspace Root Immutability

`workspaceRoot` is fixed at box creation time.

The box plane must not hot-swap the host source mounted at
`box.workspaceGuestPath` for an existing box. If the workspace root changes, or
if a session is resumed from a different repository root, acquisition must
create a new box and record `box.acquired.reason="workspace_root_changed"`.

`taskRoot` may vary across task-scoped work, but it is interpreted relative to
the immutable `workspaceRoot` when possible. A task root outside the workspace
requires an explicit additional root mapping at box creation time; it cannot be
added silently after the box has started.

### Configuration Contract

Replace `security.execution` with a smaller execution selector and a BoxLite
configuration block:

```ts
security: {
  execution: {
    backend: "host" | "box";
    box: {
      home: string;
      image: string;
      cpus: number;
      memoryMib: number;
      diskGb: number;
      workspaceGuestPath: string;
      scopeDefault: "session" | "task" | "ephemeral";
      network: {
        mode: "off" | "allowlist";
        allow: string[];
      };
      detach: boolean;
      autoSnapshotOnRelease: boolean;
      perSessionLifetime: "session" | "forever";
      gc: {
        stoppedTtlMs: number;
        orphanedTtlMs: number;
        maxBoxes: number;
      };
    };
  };
  credentials: {
    boxSecretsRef?: string;
  };
}
```

Default values:

- `backend`: `"box"`
- `box.home`: `"~/.brewva/boxes"`
- `box.image`: `"ghcr.io/brewva/box-default:latest"`
- `box.cpus`: `2`
- `box.memoryMib`: `1024`
- `box.diskGb`: `8`
- `box.workspaceGuestPath`: `"/workspace"`
- `box.scopeDefault`: `"session"`
- `box.network.mode`: `"off"`
- `box.network.allow`: `[]`
- `box.detach`: `true`
- `box.autoSnapshotOnRelease`: `false`
- `box.perSessionLifetime`: `"session"`

The default image is maintained by Brewva as
`ghcr.io/brewva/box-default:latest`. It should set `WORKDIR /workspace` and
include the minimal agent execution prerequisites. Installing those
prerequisites during first acquire would lengthen cold start, require network
access on the default path, and conflict with `network.mode="off"`.

Removed configuration:

- `security.execution.backend = "sandbox" | "best_available"`
- `security.execution.sandbox.*`
- `security.credentials.sandboxApiKeyRef`
- `MSB_SERVER_URL`
- `MSB_API_KEY`
- `BREWVA_TEST_MSB`

Configuration normalization must fail fast when removed fields are present.
There should be no compatibility aliases.

### Network Semantics

Brewva's contract must be stricter than BoxLite's raw network API.

`network.mode="off"` maps to BoxLite disabled networking.

`network.mode="allowlist"` maps to enabled networking only when
`network.allow.length > 0`. An empty allowlist is deny-all. Brewva must not pass
an empty BoxLite allowlist through as unrestricted outbound access.

Access to `host.boxlite.internal` is a host effect. If Brewva allows it, the
target must be explicit in the allowlist and visible in audit payloads.

### Secret Semantics

BoxLite does not need a sandbox API key. Brewva should remove the sandbox token
path entirely.

`security.credentials.boxSecretsRef` is for guest-to-network secret
substitution. Resolved secrets must:

- never be written to event payloads
- be converted into BoxLite `secrets` entries with placeholders such as
  `<BOXLITE_SECRET:name>`
- require host allowlist metadata so the secret is injectable only for intended
  outbound hosts
- be reported in audit payloads by secret name and target host only

### Execution Lifecycle

The default `exec` lifecycle becomes:

1. Resolve target scope from runtime task target roots.
2. Classify command policy and boundary policy.
3. Resolve `BoxScope` from session id, task target, configured image, and
   network requirements.
4. Acquire the box:
   - record `box.bootstrap.started` before image pull, rootfs preparation, or
     VM boot work begins
   - emit `box.bootstrap.progress` for long-running bootstrap phases when the
     runtime can observe them
   - if an indexed box exists, reattach through BoxLite runtime lookup
   - otherwise create a new detached box
   - mount the workspace root at `box.workspaceGuestPath`
   - record `box.bootstrap.completed` with boot duration and phase timings when
     available
   - record `box.acquired`
5. Translate host cwd to guest cwd.
6. Execute `sh -c <command>` inside the box.
7. Stream stdout and stderr into the normal tool update path when available.
8. Wait, kill, or detach according to command options.
9. Record `box.exec.completed` or `box.exec.failed`. Detached executions return
   `(box_id, execution_id)` in the process receipt and remain observable through
   the process surface.
10. Release the handle without destroying the box unless scope or policy says
    otherwise.

`exec.background=true` is no longer blocked for isolated execution. It becomes a
detached box execution. The returned receipt must include enough identity to
reattach:

- box id
- execution id
- scope kind
- guest cwd
- command hash
- started time

Detached execution reattach is a required product contract, not merely a best
effort reference to a previous process handle.

If the BoxLite SDK exposes stable execution lookup, the box plane should map
`(box_id, execution_id)` to stdout, stderr, and exit status through that API. If
the SDK does not expose execution reattach, the box plane must install or invoke
a lightweight in-box supervisor that records:

- process id
- command hash
- stdout and stderr logs
- exit code or signal
- start and finish timestamps

In that fallback mode, reattach means `runtime.get(box_id)` plus supervisor log
and status inspection. The live test for detached execution must pass against
one of these concrete mechanisms before promotion.

### Host Path Mapping

Box execution must not assume that a host path exists inside the guest.

The box plane owns a deterministic mapping:

- workspace root -> `/workspace`
- task root -> `/workspace/<relative-task-root>` when inside the workspace
- explicit additional roots -> `/workspace-roots/<stable-index>`

`exec.workdir` is first validated against target roots on the host. Only after
that validation succeeds may it be translated to a guest path.

The audit payload should include:

- requested host cwd hash or redacted path category
- guest cwd
- workspace guest path
- root mapping identifiers

It should not leak more host path detail than current target-scope events
already expose.

### Snapshot And Fork Semantics

Snapshots are the BoxLite-native rollback primitive. They complement but do not
replace Brewva's tracked-patch rollback.

`ToolBoxPolicy.requiresSnapshotBefore=true` means the box plane creates a named
snapshot before executing the admitted action.

Snapshot names should be deterministic and readable:

```text
before-<action-class>-<session-turn>-<tool-call-id>
after-verification-<session-turn>
manual-<operator-label>
```

Fork creates a new box from the current box state. Forks are suitable for:

- risky experiments
- parallel verification
- package installation trials
- branch-specific workspaces

Forking must not reuse the parent scope identity. By default, `fork(name)`
creates a child box with `scope.kind="ephemeral"` and a fresh scope id.

The `box.fork.created` event payload must include:

- parent box id
- parent scope kind and id
- parent snapshot id
- child box id
- child scope kind and id

Promoting a fork into a `session` or `task` scope is a governance-controlled
adoption action. It must be explicit, operator-visible when policy requires it,
and recorded as a separate event rather than hidden inside `fork(...)`.

### Governance Contract

Rename sandbox governance to box governance:

- `ToolEffectClass = "sandbox_required"` becomes `"box_required"`
- `ToolSandboxPolicy` becomes `ToolBoxPolicy`

Proposed shape:

```ts
export interface ToolBoxPolicy {
  scopeKind: "session" | "task" | "ephemeral";
  imageOverride?: string;
  networkAllowlist?: string[];
  requiresSnapshotBefore?: boolean;
  allowDetachedExecution?: boolean;
}
```

Action policy remains runtime-owned. Tools should not invent box authority by
constructing BoxLite options directly. They request semantic box policy; the box
plane and runtime config derive concrete options.

### Event Model

Remove sandbox event names rather than aliasing them.

New event family:

- `exec.started`
- `exec.failed`
- `box.bootstrap.started`
- `box.bootstrap.progress`
- `box.bootstrap.completed`
- `box.bootstrap.failed`
- `box.acquired`
- `box.exec.started`
- `box.exec.completed`
- `box.exec.failed`
- `box.snapshot.created`
- `box.fork.created`
- `box.released`
- `box.maintenance.completed`

`exec.*` is reserved for host and virtual-readonly execution routing. `box.*`
is reserved for stateful box lifecycle and execution events carrying box
identity.

`box.released` is emitted for lifecycle-ending releases: `session_closed`,
`task_completed`, and `ephemeral_done`. The normal per-command detach path is a
handle checkpoint, not a lifecycle end, so it does not emit `box.released`.

Event payloads should include:

- session id
- tool call id when applicable
- box id
- scope kind and scope id
- image reference and resolved digest when available
- command hash and redacted command preview for exec events
- guest cwd
- network mode and redacted allowlist summary
- bootstrap phase, duration, and image pull/cache status for bootstrap events
- snapshot id or lineage when applicable
- exit code, duration, and timeout classification

Event payloads should not include:

- raw secrets
- raw environment values
- unredacted bearer tokens
- BoxLite internal database paths unless needed for operator diagnostics

### Persistence And Indexing

BoxLite's own home directory and database are external execution substrate
state. Brewva may read and reconcile them, but they are not authoritative.

Add a rebuildable session-index view:

```text
session_box(
  session_id,
  scope_kind,
  scope_id,
  box_id,
  image,
  created_at,
  last_exec_at,
  last_snapshot_id,
  status,
  source_event_id
)
```

The view is derived from Brewva event tape plus optional BoxLite inventory
reconciliation. If BoxLite state disappears, the session index should reflect a
missing box state rather than inventing successful recovery.

The event tape remains the source of truth for what Brewva attempted, admitted,
and reported.

### Threat Model Delta

Stateful boxes change the threat model.

The current short-lived sandbox model bounds many failures to one command. A
stateful session box expands the blast radius to the lifetime of the box:

- leaked files, credentials, package caches, shell history, and generated
  artifacts can persist across commands
- malicious or accidental changes to PATH, package managers, or build caches can
  poison later verification
- long-running background processes can keep serving stale or compromised state
- snapshots can preserve sensitive state if their creation policy is too broad
- network credentials injected through BoxLite secret substitution can remain
  indirectly reachable through logs or generated files if tools mishandle them

The compensating controls are different from the old model:

- scope fingerprints make box identity explicit
- capability changes create a new box instead of silently mutating or
  over-granting an existing box
- snapshot and fork events preserve lineage
- GC respects named snapshots
- box inventory exposes state that used to disappear after each command
- threat-model docs must describe box lifetime as the primary exposure window

The promotion update to `docs/reference/exec-threat-model.md` must therefore
replace "short-lived isolated command" assumptions with "stateful isolated
workbench" assumptions.

### Distribution Contract

Replace microsandbox dependencies with BoxLite dependencies:

- remove `microsandbox` from root and tool package dependency graphs
- add `@boxlite-ai/boxlite` in the box plane package
- stage BoxLite native packages in `script/build-binaries.ts`

The initial supported distribution targets should match BoxLite native support:

- `darwin-arm64`
- `linux-x64-gnu`
- `linux-arm64-gnu`

Targets without BoxLite native support must be explicit. There are two
acceptable policies:

1. Do not publish those runtime bundles while `backend="box"` is the default.
2. Publish them with box execution marked unsupported and fail closed when box
   backend is selected.

This RFC prefers policy 1 for official bundles because `box` is the new default
execution backend.

Linux support also requires KVM access. On Linux, `backend="box"` requires
`/dev/kvm` and usable virtualization permissions. Capability validation should
fail closed with an actionable error before normal execution begins when KVM is
missing. CI and local tests that require real boxes stay gated behind
`BREWVA_TEST_BOXLITE=1`; non-live contract tests should cover the fail-closed
diagnostic path without requiring KVM.

Official runtime bundles should initially use policy 1: publish only BoxLite
supported targets for the default box backend. Windows, musl, and other
unsupported targets can be reconsidered when BoxLite provides native support and
the distribution gate has live evidence.

### Maintenance And Garbage Collection

Box GC must be conservative.

`maintain(...)` may stop idle boxes and remove unreferenced ephemeral boxes, but
it must never delete a box that has named snapshot references unless the
maintenance policy explicitly includes snapshot deletion and records that
decision. A box with named snapshots may be stopped, exported, or marked for
manual review, but it should not be silently removed by `gc.maxBoxes` pressure.

`autoSnapshotOnRelease=true` creates a named snapshot before release. That
snapshot counts as a named reference for GC purposes.

## Implementation Shape

### Phase 1: Box Plane Package

Create the box plane workspace package with:

- `BoxPlane`
- `BoxHandle`
- `BoxScope`
- `BoxExecSpec`
- `BoxExecution`
- `BoxInventory`
- `BoxMaintenancePolicy`
- BoxLite adapter
- in-memory test fake

Contract tests should cover acquire, exec, snapshot, fork, release, inventory,
and error normalization without entering the `exec` tool.

The acquire tests must prove:

- identical scope fingerprints reuse the same box
- capability changes create a new box and record `capability_changed`
- workspace root changes create a new box and record `workspace_root_changed`

### Phase 2: Config And Governance Break

Change runtime contracts:

- replace execution backend union with `"host" | "box"`
- replace sandbox config with box config
- remove sandbox API key config
- rename sandbox governance types to box governance types
- add typed `BoxCapabilitySet` normalization
- fail fast on removed config fields

Regenerate config schema.

### Phase 3: Exec Tool Recomposition

Rewrite `packages/brewva-tools/src/exec.ts` around four lanes:

- virtual readonly lane for safe exploration
- host lane for explicit host execution
- box lane for isolated stateful execution
- process follow-up lane for detached/background receipts

The box lane should delegate lifecycle and command execution to
`@brewva/brewva-box`.

Detached execution must use either BoxLite execution reattach or the in-box
supervisor fallback described above. Returning an opaque id that cannot be used
to recover stdout, stderr, and exit status is not sufficient.

Remove:

- `loadMicrosandboxSdk`
- `NodeSandbox.create`
- sandbox backoff maps
- sandbox session pinning
- sandbox API key injection
- background unsupported error

Keep:

- command normalization
- environment key validation
- command redaction
- command-policy summaries
- target-root validation
- fail-closed behavior when selected backend cannot execute

### Phase 4: Events, Session Index, And Docs

Add box event types, projection, and docs.

Update session-index derivation to expose `session_box`.

Rewrite reference docs so `box` is the primary term and `sandbox` appears only
in historical notes when necessary.

Update `docs/reference/exec-threat-model.md` around stateful box lifetime,
snapshot persistence, capability changes, and detached process exposure.

### Phase 5: Live And Distribution Gates

Add BoxLite live tests:

- package install or file creation persists across stop and reacquire
- snapshot and restore return filesystem to the expected point
- fork creates an independent child box
- fork defaults to an ephemeral child and records parent lineage
- detached/background process can be reattached or inspected
- detached/background fallback supervisor preserves stdout, stderr, and exit
  status when SDK reattach is unavailable
- network allowlist denies unauthorized outbound targets
- empty allowlist is deny-all
- non-zero exit code is reported as execution failure
- timeout kills the execution and leaves the box recoverable
- missing `/dev/kvm` produces the documented fail-closed diagnostic on Linux

Update binary packaging:

- stage BoxLite native bindings
- restrict or mark unsupported targets
- run distribution smoke on supported host targets

## Source Anchors

Current implementation:

- `packages/brewva-tools/src/exec.ts`
- `packages/brewva-runtime/src/contracts/config.ts`
- `packages/brewva-runtime/src/config/defaults.ts`
- `packages/brewva-runtime/src/contracts/governance.ts`
- `packages/brewva-tools/package.json`
- `package.json`
- `test/live/box/boxlite-stateful.live.test.ts`
- `test/contract/tools/tools-exec-process.helpers.ts`

Current documentation:

- `docs/reference/configuration.md`
- `docs/reference/exec-threat-model.md`
- `docs/reference/tools.md`
- `docs/solutions/security/exec-command-policy-and-readonly-shell.md`
- `docs/research/promoted/rfc-action-policy-registry-and-least-privilege-governance.md`

Project invariants:

- `skills/project/shared/critical-rules.md`
- `skills/project/shared/package-boundaries.md`
- `skills/project/shared/workflow-gates.md`

External reference:

- BoxLite documentation and `@boxlite-ai/boxlite` Node SDK
- BoxLite security and networking documentation

## Surface Budget

This RFC is surface-affecting. It deliberately replaces the old sandbox surface
with a stateful box surface.

Numeric proposal budget:

| Surface                               | Before | After | Delta |
| ------------------------------------- | -----: | ----: | ----: |
| Required authored fields              |      0 |     0 |     0 |
| Optional authored fields              |      9 |    17 |    +8 |
| Author-facing concepts                |      6 |    10 |    +4 |
| Inspect surfaces                      |      0 |     3 |    +3 |
| Routing/control-plane decision points |      3 |     5 |    +2 |

Before counts include:

- optional fields:
  `backend`, `enforceIsolation`, `fallbackToHost`,
  `sandbox.serverUrl`, `sandbox.defaultImage`, `sandbox.memory`,
  `sandbox.cpus`, `sandbox.timeout`, and `sandboxApiKeyRef`
- author-facing concepts:
  `host`, `sandbox`, `best_available`, `fallbackToHost`, sandbox server, and
  sandbox API key
- routing/control-plane decision points:
  backend selection, enforce-isolation override, and host fallback

After counts include:

- optional fields:
  `backend`, `box.home`, `box.image`, `box.cpus`, `box.memoryMib`,
  `box.diskGb`, `box.workspaceGuestPath`, `box.scopeDefault`,
  `box.network.mode`, `box.network.allow`, `box.detach`,
  `box.autoSnapshotOnRelease`, `box.perSessionLifetime`,
  `box.gc.stoppedTtlMs`, `box.gc.orphanedTtlMs`, `box.gc.maxBoxes`, and
  `boxSecretsRef`
- author-facing concepts:
  `host`, `box`, box scope, box capability set, detached execution, snapshot,
  fork, box secret, box bootstrap, and Brewva box base image
- inspect surfaces:
  box inventory, session box projection, and detached execution status/log
  inspection
- routing/control-plane decision points:
  backend selection, box scope selection, network policy selection, capability
  widening, and platform capability support

The positive optional-field and inspect-surface deltas are intentional. The old
surface hid lifecycle behind a one-command sandbox. The new model needs named
lifecycle controls because state is the product primitive. Runtime maintainers
own the debt and should re-evaluate the field count before promotion, no later
than `2026-05-15`.

## Validation Signals

Promotion requires:

- `bun run check`
- `bun test`
- BoxLite live test suite with `BREWVA_TEST_BOXLITE=1`
- `bun run test:docs`
- `bun run format:docs:check`
- `bun run test:dist`
- `bun run build:binaries` for supported BoxLite targets
- built binary smoke test for at least one supported host target

Contract-specific validation:

- removed sandbox config fields fail fast
- removed sandbox event names are not emitted
- `backend="best_available"` is invalid
- `backend="sandbox"` is invalid
- `security.credentials.sandboxApiKeyRef` is invalid
- empty box network allowlist denies outbound network access
- identical box scope fingerprints reuse the same box
- capability changes create a new box and record `capability_changed`
- workspace root changes create a new box and record `workspace_root_changed`
- `ToolBoxPolicy.requiresSnapshotBefore` creates a snapshot before execution
- detached execution returns reattachable identity
- detached execution exposes stdout, stderr, and exit status after reattach or
  supervisor inspection
- forks default to ephemeral child scope and preserve parent lineage
- Linux box backend fails closed with an actionable `/dev/kvm` diagnostic when
  KVM is unavailable
- session-index `session_box` is rebuildable from events

## Promotion Review Notes

The implementation now satisfies the promoted v1 contract.

Accepted implementation details:

- BoxLite is isolated behind `@brewva/brewva-box`; runtime contracts and tools
  do not import the native SDK.
- Box scope reuse is keyed by `(kind, id, image, workspaceRoot,
capabilitySetHash)`. Capability changes and workspace-root changes create new
  boxes with explicit acquire reasons.
- Box snapshots are native BoxLite snapshots. The adapter stops the box before
  snapshot creation because the current SDK returns a snapshot for running boxes
  without guaranteeing later restore rollback.
- Box forks call native `cloneBox(...)`, create an ephemeral child scope, and
  preserve parent box and snapshot lineage.
- Detached execution uses Brewva's in-box supervisor fallback. The process
  surface can observe `(box_id, execution_id)` after the launcher process exits,
  including stdout, stderr, and exit status.
- Maintenance is conservative: named snapshots protect boxes from deletion;
  ephemeral boxes without snapshots are removable; session and task boxes are
  retained and may be stopped when stale.
- `autoSnapshotOnRelease` creates named native snapshots before release.
- A default box image definition lives under
  `distribution/box-default/Containerfile` and sets `WORKDIR /workspace`.

Capabilities that remain deliberately fail-closed in promoted v1:

- Domain network allowlists are not passed through unless the adapter can prove
  the SDK enforces them. `network.mode="off"` and an empty allowlist map to the
  isolated network mode; a non-empty allowlist raises
  `box_capability_unsupported`.
- Direct BoxLite secret injection is reserved until the SDK shape can carry
  secret name and host metadata without leaking values into events.
- Bootstrap `started`, `completed`, and `failed` events are emitted. Fine-grained
  bootstrap progress remains opportunistic until BoxLite exposes observable
  image pull, rootfs preparation, or VM boot phases.

## Promotion Criteria

This RFC is promoted because:

- BoxLite is the default isolated execution backend
- microsandbox is removed from dependencies and tests
- `exec` uses scoped boxes for isolated execution
- session-scoped boxes preserve state across repeated exec calls
- background execution is supported through detached box executions
- box snapshots and forks have event receipts
- scope fingerprint, workspace-root immutability, and capability-change
  semantics are covered by contract tests
- bootstrap events make first-acquire latency visible
- Brewva maintains a default box image with `WORKDIR /workspace`
- reference docs describe stateful box lifecycle directly
- distribution targets are aligned with BoxLite native support
- DuckDB session index remains rebuildable and non-authoritative

## Follow-On Questions

These are post-promotion product questions, not blockers for the accepted v1
runtime contract.

1. Should session boxes stop automatically when Brewva marks a session closed,
   or should `perSessionLifetime="forever"` become the product default?
2. Should snapshot creation be tied only to action policy, or should the model
   have an explicit `box_snapshot` managed tool?
