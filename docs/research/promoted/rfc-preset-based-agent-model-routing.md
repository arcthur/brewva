# Research: Preset-Based Agent Model Routing

## Document Metadata

- Status: `promoted`
- Owner: gateway and CLI maintainers
- Last reviewed: `2026-04-30`
- Promotion target:
  - `docs/reference/configuration.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`
  - `docs/guide/cli.md`
  - `docs/guide/orchestration.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- hosted session model defaults are configured through named model presets
- a preset is a named `(mainModel, subagentModels)` tuple selected per session
- `Default` always exists; when not authored it is synthetic and contributes no
  routing value
- active preset selection is replay-visible through `model_preset_select`
- delegated child runs record denormalized preset provenance in
  `modelRoute.presetName`
- the TUI exposes `Shift-Tab` as the preset-cycling shortcut and queues preset
  switches for the next user turn while streaming
- legacy hosted `defaultProvider` / `defaultModel` settings and delegated
  target or agent-spec model pins are rejected; use `modelPresets` instead

## Stable References

- `docs/reference/configuration.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`
- `docs/guide/cli.md`
- `docs/guide/orchestration.md`

## Stable Contract Summary

1. Presets are hosted settings, not kernel `BrewvaConfig`.
   Hosted settings accept `modelPresets` and `defaultModelPreset`; malformed
   preset names, preset objects, model strings, and subagent model maps fail
   settings validation instead of being silently normalized away.
2. Main-session routing resolves in this order:
   explicit launch override, active preset `mainModel`, restored session model,
   provider/catalog fallback.
3. Delegated subagent routing resolves in this order:
   replayed/preselected route, diagnostic explicit route, active preset
   `subagentModels[resolvedAgentSpec]`, active preset `mainModel` inheritance,
   policy route, parent/default fallback.
4. Replay owns active preset state.
   `model_preset_select` events carry the active preset snapshot. Current
   settings may add future switch targets, but they do not rewrite historical
   replay decisions. Sessions with no preset-selection events inspect and route
   as synthetic `Default`.
5. Preset thinking suffixes are session-local.
   Selecting a preset with a suffix such as `openai/gpt-5.5:xhigh` applies that
   thinking level to the current session without rewriting
   `defaultThinkingLevel`.
6. `/model` remains a session-local main-model override.
   It does not rewrite preset definitions. Switching to a preset with
   `mainModel` clears the override; switching to a preset without `mainModel`
   preserves the current effective main model.
7. TUI preset switching is an operator command.
   `agent.preset.next` is bound to `Shift-Tab`; when the session is streaming,
   the selected preset is queued for the next user turn and rendered as
   `current -> next` in status.

## Validation Status

Promotion is backed by:

- hosted-session coverage for preset normalization, synthetic `Default`,
  replay-vs-settings authority, session-local thinking suffixes, and removed
  legacy default setting rejection
- managed-session coverage for queued preset application before hosted
  interactive prompt dispatch
- subagent-routing coverage for preset subagent matches, preset main-model
  inheritance, policy fallback, and diagnostic explicit-route precedence
- subagent catalog coverage rejecting envelope and agent-spec model pins
- runtime projection and session-bundle coverage for `model_preset_select`
  ingest, replay, and historical import
- CLI shell coverage for `Shift-Tab`, single-preset no-op, streaming pending
  preset advancement, and status rendering
- inspect coverage for active preset reporting and unmatched
  `subagentModels` diagnostics
- stable-doc updates in configuration, tools, events, CLI, and orchestration
  docs
- repository verification:
  - `bun run check`
  - `bun test`
  - `bun run format:docs:check`
  - `bun run test:docs`
  - `bun run test:dist`

## Source Anchors

- `packages/brewva-gateway/src/host/model-presets.ts`
- `packages/brewva-gateway/src/host/hosted-settings-backend.ts`
- `packages/brewva-gateway/src/host/hosted-session-backend-local.ts`
- `packages/brewva-gateway/src/host/managed-agent-session.ts`
- `packages/brewva-gateway/src/subagents/model-routing.ts`
- `packages/brewva-gateway/src/subagents/catalog.ts`
- `packages/brewva-gateway/src/host/runtime-projection-session-store.ts`
- `packages/brewva-runtime/src/contracts/delegation.ts`
- `packages/brewva-runtime/src/events/event-types.ts`
- `packages/brewva-substrate/src/session/managed-session-store.ts`
- `packages/brewva-substrate/src/session/prompt-session.ts`
- `packages/brewva-substrate/src/persistence/session-bundle.ts`
- `packages/brewva-cli/src/shell/adapters/ports.ts`
- `packages/brewva-cli/src/shell/commands/shell-command-registry.ts`
- `packages/brewva-cli/src/shell/runtime.ts`
- `packages/brewva-cli/src/inspect.ts`

## Remaining Backlog

The following ideas are intentionally outside the promoted contract:

- editing preset definitions from the TUI
- extending preset policy to channel-agent sessions and deciding how it should
  interact with any channel-owned model pins
- adding richer spec-to-preset lookup diagnostics beyond current inspect
  unmatched-key reporting
- adding timeline or insights aggregation for preset switching frequency
- adding a persisted operator preference that makes a preset switch the next
  global default

If future work reopens those directions, start a new focused RFC rather than
expanding this promoted pointer back into a proposal.

## Historical Notes

- The active RFC carried priority tables, option analysis, and review feedback
  while the implementation was still moving.
- After promotion, stable docs and tests became the contract; this file now
  preserves accepted boundaries, validation evidence, and deferred non-goals.
