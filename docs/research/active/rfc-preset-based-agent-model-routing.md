# Research: Preset-Based Agent Model Routing

## Document Metadata

- Status: `proposed`
- Owner: gateway and CLI maintainers
- Last reviewed: `2026-04-30`
- Promotion target:
  - `docs/reference/configuration.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`
  - `docs/guide/cli.md`
  - `docs/journeys/operator/interactive-session.md`

## Concept Summary

A preset is a named `(mainModel, subagentModels)` tuple selectable per session,
with `Default` as a synthetic no-op preset.

```text
+-------------------- Preset --------------------+
| name:           "Claude Lead"                  |
| mainModel:      anthropic/claude-main          |
| subagentModels: { advisor, qa, patch-worker }  |
+-----------+-----------------------+------------+
            | session main          | delegated children
            v                       v
        /model picker           resolver-selected modelRoute
        session-local override  preset, policy, or diagnostic override
```

The diagram shows the override surfaces beside the preset outputs:
`/model` can still override the session main model. Public delegation callers
do not pass delegated model overrides; the resolver records the selected child
route. Maintainer diagnostics may still probe explicit low-level model routing
through the diagnostic delegation tool.

## Problem Statement And Scope Boundaries

Operators need a named way to switch between coherent model stacks for a
session. The current shell can switch the main model through `/model`, and
delegated child runs can already carry explicit or policy-selected model route
metadata, but there is no first-class profile that says "run the main session
on this model, and run these subagents on these other models."

The missing contract creates three problems:

- operators must remember several model choices instead of selecting one named
  working posture
- subagent model inheritance is implicit rather than visible as a session-level
  choice
- the TUI has no quick keyboard path for switching between preconfigured model
  stacks

This RFC covers:

- hosted model-preset settings
- active-preset selection for interactive sessions
- delegated subagent model inheritance and override precedence
- replay-visible and inspectable preset route metadata
- TUI preset switching through `Shift-Tab`

This RFC does not cover:

- provider registry configuration or provider authentication
- replacing `/model` as the direct main-model picker
- changing delegation result schemas, delivery modes, or worker isolation
- making runtime kernel configuration responsible for hosted provider policy
- editing preset definitions from the TUI in v1
- changing existing channel-agent model pins, except where a later RFC extends
  the same preset contract to channel sessions

## Working Hypotheses

- A model preset should be a hosted model-control setting, not a new
  `BrewvaConfig` kernel concern. Model defaults, provider cache settings, and
  provider availability already live in the hosted session layer.
- `Default` should always exist as the default preset. If no settings file
  authors presets, the gateway exposes a synthetic `Default` preset that
  contributes no model routing value.
- Selecting synthetic `Default` is a routing no-op. Main-session resolution falls
  through to restored/catalog behavior, and delegated routing falls through to
  policy and parent/default behavior.
- A preset should be named by its settings key. This avoids adding a required
  `name` field while still giving the TUI a stable display label.
- If an active preset has only `mainModel`, every public delegated run should
  inherit that main model unless a maintainer diagnostic invocation explicitly
  probes a lower-level model route.
- If an active preset has `subagentModels`, a matching subagent entry should
  override main-model inheritance for that delegated worker.
- Preset decisions must remain visible in route receipts. A child run should not
  silently appear to have been selected by policy when it was selected by the
  active preset.

## Proposed Contract

### Hosted Settings Shape

Preset definitions belong beside hosted model defaults in the hosted settings
files. Model strings use hosted provider/model text plus an optional
thinking-level suffix.

The following values are illustrative model identifiers. This example authors a
concrete `Default`; if `Default` is omitted, normalization creates a synthetic
no-op `Default` instead.

```json
{
  "modelPresets": {
    "Default": {
      "mainModel": "openai/gpt-main:high"
    },
    "Claude Lead": {
      "mainModel": "anthropic/claude-main",
      "subagentModels": {
        "advisor": "anthropic/claude-main",
        "qa": "openai/gpt-review:medium",
        "patch-worker": "openai/gpt-coder:high"
      }
    }
  },
  "defaultModelPreset": "Default"
}
```

Normalized settings:

- `modelPresets` is optional.
- `defaultModelPreset` is optional and defaults to `Default`.
- `Default` is always present after normalization. If it is not authored, it is
  synthetic and has no `mainModel` or `subagentModels`.
- Authored preset names are non-empty trimmed strings, used verbatim as TUI
  labels.
- `mainModel`, `subagentModels` keys, and `subagentModels` values must also be
  non-empty trimmed strings. Malformed preset objects fail settings validation
  instead of being silently dropped.
- `subagentModels` keys match resolved delegated agent-spec identities such as
  `advisor`, `qa`, `patch-worker`, and workspace-defined agent specs.
- Unknown subagent keys are allowed at settings load time because workspace
  agent specs may be loaded later. Inspect surfaces unmatched keys that are not
  known built-ins and have not appeared as session agent specs, rather than
  silently dropping them.
- `defaultModelPreset` must reference an authored or synthetic preset. Unknown
  default names fail settings validation with a diagnostic.

### Routing Precedence

The effective model contract is the two precedence columns below.

| Rank | Main session                                  | Delegated subagent                                |
| ---- | --------------------------------------------- | ------------------------------------------------- |
| 1    | explicit launch or constructor model override | replayed or preselected `modelRoute`              |
| 2    | active preset `mainModel`                     | diagnostic explicit model route                   |
| 3    | restored session model when resuming          | active preset `subagentModels[resolvedAgentSpec]` |
| 4    | provider-default and catalog fallback         | active preset `mainModel` inheritance             |
| 5    | none                                          | policy-backed auto route                          |
| 6    | none                                          | existing parent/default fallback                  |

The key facts are:

- preset `mainModel` is rank 2 for the main session path
- preset-backed delegated routing is ranks 3 and 4 for child runs
- maintainer diagnostic explicit model routes still outrank preset routing
- synthetic `Default` contributes no rank 2, 3, or 4 value, so it falls through
  to restored/catalog and policy fallback behavior
- hosted `defaultProvider`/`defaultModel` and delegated target/envelope `model`
  pins are removed as model-default surfaces; use `modelPresets` instead

Route records should add preset provenance without creating a second truth
surface:

- add `preset` to `DelegationModelRouteSource`
- keep `mode=explicit` for both direct subagent preset matches and main-model
  inheritance
- add optional `presetName` to `DelegationModelRouteRecord`
- use `requestedModel` for the authored preset model text before catalog
  normalization
- use `reason` values that distinguish `subagentModels` matches from inherited
  `mainModel` routes

### Main Model Override State

`/model` remains a direct model picker and does not mutate preset definitions.
The interaction between `/model` and preset switches should be explicit:

- `/model` sets a session-local main-model override and leaves the active preset
  unchanged.
- switching to a preset with `mainModel` clears any `/model` override and
  applies the preset main model through the same guarded path used by `/model`
- switching to a preset without `mainModel` preserves the current effective main
  model, whether it came from `/model`, a restored session, catalog fallback, or
  a previously selected preset
- if a preset switch changes the active preset but the effective provider,
  model, and thinking level are unchanged, emit the preset-selection event but
  do not emit a `model_select` event or append a `model_change` projection entry

This makes synthetic `Default` a true no-op on model routing while still keeping
the active preset label replay-visible.

### TUI Behavior

The interactive shell should register a command such as `agent.preset.next` with
`Shift-Tab` as its keybinding.

Expected behavior:

- `Shift-Tab` cycles through normalized presets.
- normalized order is `Default` first, followed by remaining authored preset
  object entries in the order returned by `JSON.parse`; do not add an explicit
  order field in v1 unless editor or tool rewrites make entry order unstable
- the status bar shows the active preset name near the current model and
  thinking posture
- when only one preset exists, `Shift-Tab` is a no-op with a short notification
- when multiple presets exist, cycling back to a previously selected preset is a
  normal preset switch because the active label changed from the immediately
  previous preset
- while a turn is streaming, switching presets updates the next-turn selection
  and must not alter in-flight provider requests or already-created child runs
- preset switches append replay-visible selection events and pair with existing
  model-change recording when the effective main model changes

The exact command name is intentionally not stable until implementation, but
the operator-facing shortcut is part of this RFC.

### Replay Authority

Active preset at any replay tick is reconstructable from `model_preset_select`
events alone. That event stream is the single source of truth for active preset
state.

Delegated `modelRoute.presetName` is a denormalized provenance copy taken at
child-launch time. It is useful for inspect output, task views, session indexes,
and operator diagnostics, but it must not be consulted during replay decisioning.

Preset selection should be inspectable without adding another authority source:

- append a session event such as `model_preset_select` with `presetName`,
  `previousPresetName`, `source`, and the effective preset snapshot
  (`mainModel` and `subagentModels`) when available
- keep existing `model_select` and projection `model_change` behavior for
  effective main-model changes
- include `presetName` and `source=preset` on delegated run `modelRoute`
  records
- show active preset name in inspect output and the TUI status bar

DuckDB projections and inspect artifacts may cache the active preset and child
route provenance, but they remain rebuildable from the event tape and delegation
records. Historical sessions with no `model_preset_select` events inspect and
route as synthetic `Default` with legacy model route behavior.

## Decision Options

### Option A: Hosted Model Presets

Add `modelPresets` and `defaultModelPreset` to hosted settings, then thread the
active preset through hosted session creation, TUI state, and delegated model
routing.

Pros:

- matches where current hosted model defaults live
- keeps runtime kernel configuration narrower
- supports project and global preset settings
- gives the TUI a small, explicit surface for cycling presets

Cons:

- adds a hosted settings schema surface
- requires route precedence changes in the gateway
- needs new session event and inspect rendering

### Option B: Agent-Level Model Pins Only

Continue using per-agent model pins on delegated worker definitions and let
operators switch the main model through `/model`.

Pros:

- smallest immediate implementation
- reuses existing target model route source

Cons:

- does not satisfy named whole-stack switching
- cannot guarantee "only main model configured means all subagents inherit the
  main model"
- makes TUI switching a collection of side effects rather than one preset
  selection

### Option C: Runtime `BrewvaConfig` Presets

Add presets as top-level runtime configuration.

Pros:

- centralizes configuration in one typed runtime object
- easier to document in the existing `BrewvaConfig` key list

Cons:

- widens kernel configuration for a hosted provider concern
- conflicts with the existing pattern that provider cache policy and model
  defaults are hosted settings, not runtime authority
- risks making model presets look like replay authority instead of hosted
  control-plane selection

Recommended path: Option A.

## Source Anchors

- Hosted settings data and model defaults:
  `packages/brewva-gateway/src/host/hosted-settings-backend.ts`
- Hosted session model resolution:
  `packages/brewva-gateway/src/host/hosted-session-backend-local.ts`
- Hosted orchestration and delegation wiring:
  `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`
- Direct session model changes:
  `packages/brewva-gateway/src/host/managed-agent-session.ts`
- Delegated model route precedence:
  `packages/brewva-gateway/src/subagents/model-routing.ts`
- Delegated route contract:
  `packages/brewva-runtime/src/contracts/delegation.ts`
- Diagnostic subagent execution shape:
  `packages/brewva-tools/src/subagent-run.ts`
- Subagent reference documentation:
  `docs/reference/tools.md`
- TUI command registry and keybinding shape:
  `packages/brewva-cli/src/shell/commands/shell-command-registry.ts`
- TUI model-picker and shortcut documentation:
  `docs/guide/cli.md`
- Configuration reference and hosted settings policy:
  `docs/reference/configuration.md`
- OpenCode prior art for subagent model inheritance:
  `/Users/bytedance/new_py/opencode/packages/opencode/src/tool/task.ts`
- OpenCode prior art for agent model fields:
  `/Users/bytedance/new_py/opencode/packages/opencode/src/config/agent.ts`
- OpenCode user-facing inheritance documentation:
  `/Users/bytedance/new_py/opencode/packages/web/src/content/docs/agents.mdx`

## Validation Signals

Implementation should add or update tests that prove:

- settings normalization always exposes a `Default` preset
- `defaultModelPreset` rejects unknown preset names
- preset model strings resolve through the hosted model catalog path
- a preset with only `mainModel` routes `advisor`, `qa`, and `patch-worker` to
  that main model
- a preset `subagentModels` entry overrides main-model inheritance for the
  matching resolved agent spec
- diagnostic explicit model routes still outrank preset routing
- policy-backed routes still work when the active preset does not configure a
  main model
- target/envelope/agent-spec model pins are rejected and must move to
  `modelPresets`
- delegated run records include `source=preset` and `presetName`
- historical delegated run records without preset metadata remain readable
- `Shift-Tab` cycles presets, updates status-bar state, and no-ops with one
  preset
- preset switching during an in-flight turn affects only future turns and child
  runs
- synthetic `Default` performs no routing mutation
- preset switches that leave the effective main model unchanged do not append a
  model-change projection entry

Documentation verification:

- `bun run test:docs`
- `bun run format:docs:check`

Implementation verification:

- `bun run check`
- `bun test`
- targeted gateway tests for hosted settings and delegated model routing
- targeted CLI/TUI tests for the new preset command and status rendering

## Promotion Criteria

- Stable configuration docs describe hosted `modelPresets`,
  `defaultModelPreset`, normalization, and failure behavior.
- Stable tool docs describe preset-backed delegated model routes and precedence.
- Stable event docs describe preset selection events and delegated
  `modelRoute.presetName`.
- TUI docs list `Shift-Tab` as the preset switch shortcut and explain status-bar
  rendering.
- Inspect output exposes active preset and delegated preset routes without
  creating a second replay authority.
- Tests cover the validation signals above.
- The note is either promoted into stable docs or archived after the contract is
  superseded.

## Surface Budget

Proposed delta:

- required authored fields: `0 -> 0`
- optional authored settings fields: `0 -> 4`
  - `modelPresets`
  - `defaultModelPreset`
  - `modelPresets.<preset>.mainModel`
  - `modelPresets.<preset>.subagentModels`
- persisted and event fields: `0 -> 3`
  - `model_preset_select`
  - `DelegationModelRouteRecord.presetName`
  - `DelegationModelRouteSource=preset`
- operator-facing TUI surfaces: `0 -> 3`
  - `Shift-Tab` preset cycling
  - status-bar preset label
  - command-registry entry for preset cycling
- author-facing concepts: `2 -> 3`
  - before: main model selection, delegated model routing
  - after: main model selection, delegated model routing, model preset
- inspect surfaces: `1 -> 3`
  - before: delegated `modelRoute`
  - after: delegated `modelRoute`, active model preset, delegated preset
    provenance on `modelRoute`
- routing/control-plane decision branches: `9 -> 12`
  - main session path: `4 -> 5`
  - delegated subagent path: `5 -> 7`

Positive deltas are unavoidable because the requested feature is explicitly a
new named model-stack selection surface. Each delta carries direct value:
settings make the stack authorable, events preserve replay authority, TUI
surfaces make the stack switchable, inspect surfaces make the choice
diagnosable, and routing branches make inheritance deterministic.

The debt owner is gateway and CLI maintainers. Re-evaluate the surface count by
`2026-06-30` after implementation validation; if preset usage does not
materially reduce operator model-selection work, remove or collapse the surface
before promotion.

## Risks And Mitigations

### Risk: Presets Become Hidden Routing Policy

Mitigation:

- record preset provenance on session events and delegated `modelRoute`
- show the active preset in the TUI and inspect output
- keep policy auto routes distinct from preset routes

### Risk: Presets Widen Runtime Kernel Configuration

Mitigation:

- keep preset definitions in hosted settings
- pass active preset information into gateway routing as a session control-plane
  input
- keep `BrewvaConfig` focused on runtime semantic configuration

### Risk: Existing Target Pins Break

Mitigation:

- document the breaking configuration change explicitly
- fail loudly when workspace subagent configs declare envelope/target `model`
  pins
- keep diagnostic explicit model routing available for maintainer probes while
  keeping it out of the public delegation interface

### Risk: TUI Shortcut Conflicts With Terminal Input

Mitigation:

- bind through the shell command registry instead of ad hoc key handling
- verify terminal input emits a distinct shifted tab key event in supported
  environments
- keep `/model` and command-palette access as fallbacks

## Open Questions

- Should preset switching persist as the next global default, or stay
  session-local in v1?
- If channel-agent sessions adopt presets later, should channel-agent model pins
  outrank active presets, or should active presets override those pins for the
  same "whole stack" guarantee?
- Should registered workspace agent specs expose reverse diagnostics showing
  which presets configure them, or is preset-to-spec lookup enough?
- Should preset switches and per-run preset usage appear in session timeline or
  `/insights` statistics?
