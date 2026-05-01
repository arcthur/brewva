# Decision: Skill Distribution, Refresh Semantics, and Catalog Surface

## Metadata

- Decision: Built-in skill availability is owned by runtime installation, not by source checkout topology. Bundled defaults are installed into a dedicated system root and loaded as `source=system_root`.
- Date: `2026-04-04`
- Status: accepted
- Stable docs:
  - `docs/reference/skills.md`
  - `docs/reference/runtime.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/events/README.md`
  - `docs/reference/configuration.md`
- Code anchors:
  - `packages/brewva-runtime/src/config/paths.ts`
  - `packages/brewva-runtime/src/domain/skills/types.ts`
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/domain/skills/registry.ts`
  - `packages/brewva-runtime/src/domain/skills/system-install.ts`
  - `distribution/brewva/postinstall.mjs`
  - `script/build-binaries.ts`
  - `script/verify-dist.ts`

## Decision Summary

- Built-in skill availability is owned by runtime installation, not by source checkout topology. Bundled defaults are installed into a dedicated system root and loaded as `source=system_root`.
- Project skill state is workspace-root scoped. Nested cwd launches share the same project config root, project skill root, and generated `skills_index.json`.
- Skill refresh is explicit and rebuildable. `runtime.skills.refresh(input?)` installs or validates bundled system skills, reloads the registry, rewrites the inspect artifact, and can emit an ops-level refresh receipt when a session id is provided.
- `skills_index.json` is inspection output, not durable truth. Runtime may rebuild it deterministically from authoritative skill sources.
- `SKILL.md` remains the only runtime-authoritative authored file. Behavior, selection policy, outputs, effect policy, resource ceilings, and execution hints do not move to a separate catalog file.

## Superseded by

- None.
