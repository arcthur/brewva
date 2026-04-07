---
name: repository-analysis
intent:
  outputs:
    - repository_snapshot
    - impact_map
    - unknowns
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 60
    max_tokens: 120000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - glob
    - lsp_symbols
    - lsp_find_references
    - ledger_query
    - skill_complete
references:
  - skills/project/shared/package-boundaries.md
consumes: []
requires: []
---

# Brewva Repository Analysis Overlay

## Intent

Tighten repository analysis around Brewva package boundaries and governance-critical paths.

## Trigger

Use this overlay when repository analysis is running inside the Brewva monorepo.

## Overlay Scripts

No new base scripts. Bias to Brewva package boundaries and governance-critical paths when running base repository-analysis workflow.

## Workflow

### Step 1: Bias to package boundaries

Start from runtime, tools, extensions, CLI, gateway, and distribution boundaries.

### Step 2: Highlight governance-critical paths

Prioritize routing, verification, context, replay, and artifact persistence paths.

## Overlay Questions

- Which Brewva package boundary would have to move if this request is real?
- Which governance-critical path is most likely to hide blast radius?

## Stop Conditions

- the target change is clearly local and does not cross package boundaries
- the repo state is too incomplete to identify the main package owner

## Common Rationalizations

| Excuse                                                     | Reality                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| "Standard TypeScript analysis is enough"                   | Brewva has governance-critical paths that generic analysis will miss entirely.                       |
| "Package boundaries are obvious from the folder structure" | Ownership boundaries diverge from folder layout. Check runtime, tools, gateway, and CLI explicitly.  |
| "This change is clearly local"                             | Cross-boundary blast radius hides in transitive imports and shared contracts. Verify, do not assume. |
| "Export maps are self-documenting"                         | Export map changes silently break dist verification. Always cross-check with `test:dist`.            |

## Anti-Patterns

- treating Brewva as an undifferentiated TypeScript repo
- ignoring runtime-vs-control-plane boundaries

## Example

Input: "Map which packages own routing, cascade, and skill catalog persistence."
