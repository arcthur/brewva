# Research: Boundary Policy, Credential Vault, and Exact-Call Loop Guard

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-28`
- Promotion target:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/configuration.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/commands.md`

This note is now a rationale and promotion record.
The stable contract and operator-facing behavior live in the architecture,
configuration, runtime, events, commands, and CLI reference docs listed above.

## Direct Conclusion

Brewva should address three real gaps:

1. deployment-scoped filesystem and network boundaries for high-risk tools
2. encrypted secret storage with operator-managed bindings
3. a cheap exact-call loop guard in front of the existing effect gate

The previous proposal overreached. The correct path is not a new
`runtime.security.*` public domain, not a monolithic `SecurityKernelService`,
and not a global `ToolExecutionIntent` contract.

The implementation should stay aligned with Brewva's current invariants:

- keep `runtime.tools.start(...) -> ToolGateService.authorizeToolCall(...)` as
  the single shared authorization entrypoint
- keep `ToolGovernanceDescriptor` focused on effect classification, not
  deployment-specific host/path rules
- add boundary checks only for tools that need parameter-level inspection
- keep secrets out of model-visible arguments, ledger rows, events, and tape
- keep loop detection as a small runtime guard, not a new framework

## Problem Statement

The current runtime has three concrete gaps.

### 1. Boundary policy is incomplete

`exec` has a routed execution policy and a best-effort command deny-list, but it
does not enforce deployment-specific filesystem and network allow/deny rules.
Browser tools enforce workspace-root artifact paths, but they do not share a
single runtime-owned outbound network policy.

### 2. Secret handling is runtime-redacted but not runtime-managed

The runtime redacts known secret patterns when writing evidence and events, but
gateway auth tokens are still stored as plain text files and tool execution
lacks a first-class secret vault with opaque references and controlled env
injection.

### 3. Loop protection lacks a cheap syntactic fast path

The runtime already has budget limits and durable iteration-fact inspection, but
it does not block the simplest failure mode: the same tool called with the same
arguments repeatedly in a tight loop.

## Confirmed Findings

The following repo facts constrain the design.

### Shared authorization entrypoint already exists

Gateway runtime plugins already depend on the current shared spine:

- `quality-gate.ts` calls `runtime.tools.start(...)`
- `ledger-writer.ts` calls `runtime.tools.finish(...)`
- `context-composer-support.ts` calls `runtime.tools.explainAccess(...)`

That means adding a second public authorization entrypoint would violate the
current "shared invocation spine first" invariant.

### Guard inspection already exists

The runtime already exposes:

- `runtime.events.recordGuardResult(...)`
- `runtime.events.listGuardResults(...)`

The `iteration_fact` tool already uses that API to record and inspect durable
guard results. No new public guard-query domain is required for the first
version of loop protection.

### Tool wrappers are intentionally thin today

`defineBrewvaTool(...)` currently handles canonical metadata and parameter
normalization, but it does not impose a global safety wrapper or require
per-tool execution intent metadata.

That makes a mandatory `intentResolver` contract a breaking change for all local
tools and a poor fit for external tool surfaces.

### Configuration is JSON-first today

`loadBrewvaConfig(...)` reads JSON only, validates against the config schema, and
merges global and project config. Introducing YAML as the primary config surface
would add another parser and another source of precedence complexity without
solving the core policy problem.

### Gateway token storage is plain text today

`FileGatewayStateStore.writeToken(...)` writes the gateway auth token directly to
disk with mode `0600`. This is a real secret-management gap and should be
closed by the vault work rather than treated as a separate one-off exception.

### Exec policy has real blast radius

`exec.ts` has a large `ResolvedExecutionPolicy` path that already depends on:

- `security.execution.backend`
- `security.execution.fallbackToHost`
- `security.execution.commandDenyList`
- `security.execution.sandbox.serverUrl`
- `security.execution.sandbox.apiKey`

That was the primary reason the earlier proposal suggested staging. The runtime
now has a config migration tool, so duplicate execution-security fields can be
deleted from the active contract and any active-config appearance can fail
closed.

## Decision Summary

### 1. Do not add `runtime.security.*`

No new public runtime domain is introduced in the first implementation.

Instead:

- `runtime.tools.explainAccess(...)` is extended to surface resolved boundary
  policy decisions for tool calls that support parameter-level inspection
- guard inspection continues to use `runtime.events.listGuardResults(...)`
- credential management remains an internal runtime service plus CLI/operator
  commands until a real public runtime API is justified

This preserves the existing shared invocation spine and avoids a second public
authorization surface.

### 2. Do not create a monolithic `SecurityKernelService`

The three concerns have different lifecycles and storage models:

- boundary policy: config-scoped, hot-path, stateless
- credential vault: bootstrap-scoped, persistent, not hot-path except binding
  resolution
- exact-call guard: session-scoped, hot-path, session-state-backed

They should remain separate:

- boundary policy lives inside `ToolGateService` and related helpers
- credential storage lives in a dedicated `CredentialVaultService`
- exact-call deduplication stays as a focused private guard inside
  `ToolGateService`

### 3. Do not add global `ToolExecutionIntent`

Most tools do not need parameter-level safety classification.

Instead, introduce opt-in capability classifiers for the small number of
high-risk tools that need argument-aware policy checks:

- `exec`
- browser tool family
- future network-heavy tools such as `web_fetch`, if they appear

Classifier output should stay narrow and tool-specific, for example:

```ts
type ToolCapabilityClassification = {
  detectedCommands?: string[];
  requestedPaths?: string[];
  requestedCwd?: string;
  targetHosts?: string[];
  credentialRefs?: string[];
};
```

`ToolGateService` consumes this only when a tool supplies it. All other tools
continue on the existing effect-based path.

## Proposed Design

### Boundary policy

Add a new `security.boundaryPolicy` section to the config contract and keep the
file format JSON.

Baseline structure:

```ts
type BoundaryPolicyConfig = {
  commandDenyList: string[];
  filesystem: {
    readAllow: string[];
    writeAllow: string[];
    writeDeny: string[];
  };
  network: {
    mode: "inherit" | "deny" | "allowlist";
    allowLoopback: boolean;
    outbound: Array<{
      host: string;
      ports?: number[];
    }>;
  };
};
```

Rules:

- `security.mode` continues to seed permissive/standard/restricted baselines
- `security.boundaryPolicy` overrides the baseline
- `commandDenyList` moves conceptually under boundary policy because it is part
  of command dispatch narrowing, not backend routing
- YAML is intentionally not introduced in v1
- `network.mode: "inherit"` must resolve explicitly from `security.mode`
  rather than remain implicit:
  - `permissive` -> no outbound restriction
  - `standard` -> `allowlist` with `allowLoopback: true`
  - `strict` -> `deny` with `allowLoopback: true`

Integration model:

- keep effect authorization and effect commitment unchanged
- for tools with a classifier, run boundary-policy checks inside
  `ToolGateService.authorizeToolCall(...)` before `evaluateEffectGate(...)`
- `exec.ts` and browser tools provide classifier helpers rather than inventing
  a new global wrapper protocol
- `runtime.tools.explainAccess(...)` includes boundary-policy explanation when a
  classifier is available

### Credential vault

Add a standalone `CredentialVaultService` assembled in `runtime-assembler.ts`.

Core rules:

- storage is encrypted with `node:crypto` `aes-256-gcm`
- the vault stores named secret records and returns opaque refs
- tools and gateway code receive refs or binding names, not raw secret values
- raw values are resolved only at the execution boundary immediately before env
  injection or gateway auth use
- evidence, events, and tape store only refs, binding names, and resolution
  status

Initial bootstrap:

- primary key source: `BREWVA_VAULT_KEY`
- fallback: if supported for headless use, the derivation algorithm must be
  fixed and version-stable:

```ts
sha256("brewva:" + hostname + ":" + homedir);
```

- this mirrors fastclaw's hostname-plus-home derivation shape while keeping a
  Brewva-specific prefix
- fallback use must emit an explicit warning because it is weaker than an
  operator-set key

Initial scope:

- gateway auth token
- sandbox API key
- future provider credentials imported through CLI

Initial management surface:

- `brewva credentials list`
- `brewva credentials add`
- `brewva credentials remove`
- `brewva credentials discover`

Discovery is advisory only. Ambient environment variables do not become durable
authority until they are explicitly imported into the vault.

### Exact-call loop guard

Implement the first guard as a small private method inside `ToolGateService`,
backed by `RuntimeSessionStateCell`.

Suggested session state shape:

```ts
type ConsecutiveToolCallState = {
  toolName: string;
  hash: string;
  count: number;
};
```

State model:

- track a single `ConsecutiveToolCallState` per session, not a per-tool map
- when the normalized tool name changes, reset the counter
- when the argument hash changes, reset the counter

Suggested logic:

- normalize tool name
- skip `alwaysAllowedTools`
- hash `toolName + stableJsonStringify(args ?? {})`
- compare against the single most recent session call state
- if the same call crosses the configured threshold, record a guard result and
  return a blocked decision

Guard recording should reuse the existing durable guard pipeline rather than add
an ad hoc event family. The recommended shape is:

- `guardKey`: `exact_call_loop`
- `source`: `runtime.tool_gate`
- `details`: normalized tool name, threshold, count, hash prefix

Configuration should stay narrow:

```ts
type ExactCallLoopGuardConfig = {
  enabled: boolean;
  threshold: number;
  mode: "warn" | "block";
  exemptTools: string[];
};
```

This is enough to cover the real failure mode without creating a general
"guard framework" abstraction.

## Contract Cutover

The active contract should cut over directly once the migration tooling exists.

- add `security.boundaryPolicy`
- add `CredentialVaultService`
- add exact-call loop guard
- reject `security.execution.commandDenyList` in active config
- reject `security.execution.sandbox.apiKey` in active config
- expose `brewva config migrate` only as an explicit migration tool for invalid
  config files
- move hosted and CI examples to the new fields

## Rejected Directions

The following directions are intentionally rejected for this iteration.

### Reject: `runtime.security.*` as a new public domain

Reason:

- it duplicates the existing shared authorization surface
- it weakens the single-entrypoint mental model
- existing guard inspection already works through `runtime.events.*`

### Reject: monolithic `SecurityKernelService`

Reason:

- it bundles config-scoped, bootstrap-scoped, and session-scoped concerns into
  one lifecycle
- it creates unnecessary failure coupling and test coupling

### Reject: global `ToolExecutionIntent`

Reason:

- only a few tools need argument-aware classification
- it would create broad breaking changes across managed and external tools

### Reject: YAML as the primary policy contract

Reason:

- the repo is JSON-config-first today
- YAML does not resolve the actual policy-model problem
- workspace-local policy files create avoidable self-modification ambiguity

### Reject: carrying duplicate execution-security fields as aliases

Reason:

- keeping duplicate execution-security fields would preserve split contract
  semantics and hidden config branches
- once explicit rewrite tooling exists, the cleaner contract is to reject the
  old fields rather than carry aliases

## Source Anchors

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/runtime-assembler.ts`
- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/session-state.ts`
- `packages/brewva-runtime/src/iteration/facts.ts`
- `packages/brewva-runtime/src/config/loader.ts`
- `packages/brewva-gateway/src/runtime-plugins/quality-gate.ts`
- `packages/brewva-gateway/src/runtime-plugins/ledger-writer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer-support.ts`
- `packages/brewva-gateway/src/state-store.ts`
- `packages/brewva-tools/src/exec.ts`
- `packages/brewva-tools/src/utils/tool.ts`
- `packages/brewva-tools/src/iteration-fact.ts`

## Validation Signals

Implementation should not be promoted unless the following are true:

- `exec` and browser tools enforce the new boundary policy without bypassing the
  shared `runtime.tools.start(...)` path
- gateway tokens can be migrated into the vault without changing the external
  control-plane protocol
- loop-guard hits appear in `runtime.events.listGuardResults(...)`
- exact-call guard resets correctly when tool name or arguments change, so
  alternating calls do not produce false positives
- no raw secret values appear in evidence rows, runtime events, or tape entries
- invalid execution fields are only accepted by the config migration command, not
  by normal runtime or CLI load paths

## Promotion Criteria

Promote this note only after:

1. `security.boundaryPolicy` is part of the stable config schema and docs
2. credential CLI flows exist and gateway token storage is no longer plain text
   by default
3. exact-call guard behavior is documented in the runtime/events reference
4. hosted and local execution paths have regression coverage for the new policy
   and config migration behavior
