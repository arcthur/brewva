# Decision: Agent Runtime Ergonomics Control Plane

## Metadata

- Decision: `exec` ergonomics, multi-source slash commands, and hosted model routing resilience are implemented as control-plane extensions over existing execution, shell, and gateway provider seams instead of new authority paths.
- Date: `2026-05-24`
- Status: accepted
- Stable docs:
  - `docs/reference/tools/execution.md`
  - `docs/reference/exec-threat-model.md`
  - `docs/reference/provider-streaming.md`
  - `docs/reference/commands/interactive.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events/session.md`
  - `docs/research/decisions/preset-based-agent-model-routing.md`
  - `docs/solutions/execution/output-minimization-with-raw-recovery.md`
  - `docs/solutions/gateway/model-fallback-replay-visible.md`
  - `docs/solutions/cli/multi-source-slash-command-precedence.md`
- Code anchors:
  - `packages/brewva-tools/src/families/execution/exec.ts`
  - `packages/brewva-tools/src/families/execution/exec/preflight.ts`
  - `packages/brewva-tools/src/families/execution/exec/box-lane.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/tools/tool-result-distiller.ts`
  - `packages/brewva-cli/src/shell/commands/command-provider.ts`
  - `packages/brewva-cli/src/shell/commands/file-command-provider.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/settings/model-presets.ts`
  - `packages/brewva-gateway/src/policy/model-routing/fallback.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/settings/hosted-auth-store.ts`

## Decision Summary

- `exec` now has a typed preflight layer after argument normalization and before execution. It writes `details.executionPreflight`, may block high-confidence shell-as-tool misuse, and may advise better tools, but it cannot authorize commands that boundary/action policy rejects.
- Host and box foreground commands auto-background through the existing managed process registry after `security.execution.autoBackground.foregroundWaitMs`, defaulting to `10000` milliseconds. Virtual-readonly output remains exploration evidence.
- Hosted output minimization stays on the existing distiller/evidence path: raw output is preserved first, display summaries carry `details.outputDistillation`, and raw artifacts remain recoverable.
- File-backed slash commands extend `ShellCommandProvider`. Precedence is built-in Brewva, project/user Brewva, project/user Claude, project/user Codex, then project/user OpenCode. Built-ins cannot be shadowed; lower-priority duplicates remain visible as shadowed diagnostics with provider/path provenance.
- Markdown slash commands use the documented `description` plus `arguments` frontmatter subset. The body expands to ordinary operator-authored prompt text. Command files that ask for authority, tools, permissions, MCP, or capabilities fail closed.
- Hosted model presets use one model-facing role map: `default`, `smol`, `slow`, `plan`, `commit`, and `task`. Removed preset fields fail validation instead of being normalized.
- Delegation categories remain internal/admin taxonomy and map to role aliases only at the hosted gateway boundary. `verification` and `knowledge` do not become public role aliases.
- Provider fallback is gateway-hosted, selects the active role chain before the default chain, and only happens before the first provider frame. Fallback metadata records attempted route, selected route, reason, revert policy, and `cache_invalidated: true` when cache identity changes.
- Credential rotation uses provider credential slots within the same provider/account policy scope. The only durable event is the redacted `provider_credential_rotated` payload `{ providerId, credentialSlot, reason, cooldownMs }`.
- The runtime kernel remains free of model role/fallback business semantics; security/action policy remains the only authority source for execution.

## Superseded by

- None.
