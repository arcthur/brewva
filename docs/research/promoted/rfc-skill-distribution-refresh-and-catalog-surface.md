# Research: Skill Distribution, Refresh Semantics, and Catalog Surface

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-04-04`
- Promotion target:
  - `docs/reference/skills.md`
  - `docs/reference/runtime.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/events.md`
  - `docs/reference/configuration.md`

## Promotion Summary

This note is now a short status pointer.

The decision has been promoted: Brewva makes bundled skill distribution
explicit and runtime-owned, upgrades `runtime.skills.refresh(...)` into a
structured rebuild surface, and keeps `SKILL.md` as the only runtime-authority
file.

Stable implementation now includes:

- bundled built-in skills installed by runtime into `<globalRoot>/skills/.system`
  with fingerprinted marker metadata
- skill root discovery narrowed to `system_root`, `global_root`,
  `project_root`, and `config_root`
- workspace-root semantics for project skill discovery, project config loading,
  and `.brewva/skills_index.json`
- `runtime.skills.refresh(input?)` returning structured rebuild results and
  optionally recording `skill_refresh_recorded`
- `skills_index.json` promoted to a versioned inspect artifact with lightweight
  provenance, including `source`, `rootDir`, and optional `overlayOrigins`
- removal of ancestor-based built-in discovery and rejection of
  `SKILL.catalog.yaml`, `skills_catalog.json`, or any other authored display
  catalog plane
- authoring helpers aligned with runtime root semantics, so scaffold and fork
  flows now resolve nested cwd launches against the workspace root

Stable references:

- `docs/reference/skills.md`
- `docs/reference/runtime.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/events.md`
- `docs/reference/configuration.md`

## Stable Contract Summary

The promoted contract is:

1. Built-in skill availability is owned by runtime installation, not by source
   checkout topology.
   Bundled defaults are installed into a dedicated system root and loaded as
   `source=system_root`.
2. Project skill state is workspace-root scoped.
   Nested cwd launches share the same project config root, project skill root,
   and generated `skills_index.json`.
3. Skill refresh is explicit and rebuildable.
   `runtime.skills.refresh(input?)` installs or validates bundled system skills,
   reloads the registry, rewrites the inspect artifact, and can emit an
   ops-level refresh receipt when a session id is provided.
4. `skills_index.json` is inspection output, not durable truth.
   Runtime may rebuild it deterministically from authoritative skill sources.
5. `SKILL.md` remains the only runtime-authoritative authored file.
   Behavior, selection policy, outputs, effect policy, resource ceilings, and
   execution hints do not move to a separate catalog file.

## Validation Status

Promotion is backed by:

- runtime-owned bundled system skill installation and legacy global-seed cleanup
- registry and inspect-artifact upgrades for versioned provenance
- structured `runtime.skills.refresh(...)` result and `skill_refresh_recorded`
  event support
- distribution bootstrap narrowing so postinstall no longer seeds global skills
- authoring-script alignment with workspace-root project semantics and explicit
  project-overlay activity checks
- repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`

## Source Anchors

- `packages/brewva-runtime/src/config/paths.ts`
- `packages/brewva-runtime/src/contracts/skill.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/skills/system-install.ts`
- `distribution/brewva/postinstall.mjs`
- `script/build-binaries.ts`
- `script/verify-dist.ts`
- `skills/meta/skill-authoring/scripts/skill_roots.py`
- `skills/meta/skill-authoring/scripts/init_skill.py`
- `skills/meta/skill-authoring/scripts/fork_skill.py`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- restoring ancestor-based built-in skill discovery for development fallback
- compatibility reads or dual-write support for the old `skills_index.json`
  shape
- reintroducing postinstall-managed global skill seeding
- adding `SKILL.catalog.yaml`, `skills_catalog.json`, or any other authored
  display metadata plane before a real product consumer exists

If a future operator UI or marketplace needs a separate display catalog, that
should begin with a new focused RFC rather than reopening this promoted note.

## Historical Notes

- Historical option analysis and rollout detail were removed from this file
  after promotion.
- The stable contract now lives in reference docs, implementation, and the
  regression suite rather than in `docs/research/`.
