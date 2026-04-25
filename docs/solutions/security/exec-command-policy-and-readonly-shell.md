---
id: sol-2026-04-21-exec-command-policy-and-readonly-shell
title: Exec command policy and readonly shell governance
status: active
problem_kind: architecture
module: brewva-runtime
boundaries:
  - runtime.security.command_policy
  - runtime.security.boundary_policy
  - tools.exec
  - governance.action_policy
source_artifacts:
  - implementation_plan
  - verification_evidence
tags:
  - exec
  - command-policy
  - box
  - audit
updated_at: 2026-04-21
---

# Exec Command Policy And Readonly Shell Governance

## Context

Brewva used to classify `exec` command risk primarily through command-token
heuristics in boundary policy and a short-lived execution router. That made the
deployment boundary responsible for shell semantics and made backend downgrade
policy too easy to blur.

The `just-bash` comparison highlighted the stronger pattern: parse shell intent
before execution, keep read-only exploration isolated, and make unsafe shell
features prove themselves through adversarial fixtures before admission changes.

## Guidance

Keep shell semantics in `packages/brewva-runtime/src/security/command-policy.ts`.
Boundary policy should consume its verdict, not rebuild shell token heuristics.

Treat `local_exec_readonly` as a narrow class:

- accepted commands are read/search/data commands only
- pipelines are allowed, but shell functions, aliases, command substitution,
  process substitution, redirection, unknown commands, and unsafe options fail
  closed
- explicit URLs become network targets and remove readonly eligibility
- readonly output routes through `virtual_readonly` and is exploration evidence
  only
- `virtual_readonly` must have a physical write barrier. The current v1 barrier
  is a materialized temporary workspace subset, not a full OverlayFS: only
  explicit relative path arguments are copied, unsafe path materialization is
  rejected, and the temp directory is discarded after execution.
- add static limits before admitting readonly execution. At minimum cover
  command length, argument count, argument length, pipeline width, explicit URL
  count, materialized byte count, materialized entry count, timeout, and output
  bytes.
- treat user-controlled object keys as hostile. Environment overlays, audit
  payload helpers, and future JSON/header maps should use null-prototype
  records or `Map` plus dangerous-key filtering.

Treat real execution as effectful:

- `exec` remains approval-bound through action policy
- `box` is the default backend
- `host` is explicit policy, never an automatic fallback
- box execution records `box.*` lifecycle events and keeps state across
  release/reacquire by scope

## Why This Matters

Shell strings are not a stable security boundary. A command such as `cat` can
hide writes or execution through substitutions, redirections, or option
smuggling. Separating command semantics from deployment policy keeps the
architecture reviewable:

- command policy answers "what does this shell shape mean?"
- boundary policy answers "is this deployment allowed to touch that root or
  host?"
- action policy answers "what receipt and admission does this effect require?"
- the exec adapter answers "which backend actually ran?"

The long-term target remains a dedicated COW/OverlayFS service. Until that
exists, documentation and events must describe the v1 backend precisely as a
materialized workspace subset so exploration evidence is not overclaimed.

## When To Apply

Use this precedent whenever changing:

- `packages/brewva-runtime/src/security/command-policy.ts`
- `packages/brewva-runtime/src/security/boundary-policy.ts`
- `packages/brewva-tools/src/exec.ts`
- `security.execution.*` defaults or box lifecycle behavior
- `local_exec_readonly` action policy admission
- `box.*` event payloads or command audit behavior

## References

- `docs/reference/exec-threat-model.md`
- `docs/reference/configuration.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`
- `packages/brewva-runtime/src/security/command-policy.ts`
- `packages/brewva-tools/src/exec.ts`
- `test/unit/runtime/command-policy.unit.test.ts`
- `test/contract/tools/exec-command-policy.contract.test.ts`
