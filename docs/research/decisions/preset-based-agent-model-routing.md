# Decision: Preset-Based Agent Model Routing

## Metadata

- Decision: Presets are hosted settings, not kernel `BrewvaConfig`. Hosted settings accept `modelPresets` and `defaultModelPreset`; malformed preset names, preset objects, model strings, subagent model maps, and auxiliary model maps fail settings validation instead of being silently normalized away.
- Date: `2026-04-30`
- Status: accepted
- Stable docs:
  - `docs/reference/configuration.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
  - `docs/guide/cli.md`
  - `docs/guide/orchestration.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/session/settings/model-presets.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/settings/hosted-settings-backend.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/hosted-session-backend-local.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `packages/brewva-gateway/src/delegation/model-routing.ts`
  - `packages/brewva-gateway/src/delegation/catalog/registry.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts`
  - `packages/brewva-runtime/src/delegation/types.ts`

## Decision Summary

- Presets are hosted settings, not kernel `BrewvaConfig`. Hosted settings accept `modelPresets` and `defaultModelPreset`; malformed preset names, preset objects, model strings, subagent model maps, and auxiliary model maps fail settings validation instead of being silently normalized away.
- Main-session routing resolves in this order: explicit launch override, active preset `mainModel`, restored session model, provider/catalog fallback.
- Auxiliary title generation resolves in this order: active preset `auxiliaryModels.title`, active preset `mainModel`, current session model.
- Delegated subagent routing resolves in this order: replayed/preselected route, active preset `delegationModels[modelCategory]`, active preset `mainModel` inheritance, policy route, parent/default fallback. Diagnostic delegation may still inspect routing behavior, but public tools do not accept raw model names.
- Replay owns active preset state. `model_preset_select` events carry the active preset snapshot. Current settings may add future switch targets, but they do not rewrite historical replay decisions. Sessions with no preset-selection events inspect and route as synthetic `Default`.
- Preset thinking suffixes are session-local. Selecting a preset with a suffix such as `openai/gpt-5.5:xhigh` applies that thinking level to the current session without rewriting `defaultThinkingLevel`.

## Superseded by

- None.
