---
strength: workflow_gate
scope: workflow-gates
convention_kind: workflow_rule
retirement_sensitivity: review_only
---

# Brewva Workflow Gates

Use the union of gates when a change touches multiple surfaces.

## Helper Workflows

- `$implementation-strategy`: record compatibility boundary, migration or rollback posture, affected public or persisted surfaces, and validation scope before editing.
- `$exec-plan`: keep a short milestone plan with statuses for multi-step, cross-package, refactor-heavy, or long-running work.
- `$code-change-verification`: run `bun run check && bun test`.
- `$docs-verification`: run `bun run test:docs`; add `bun run format:docs:check` when Markdown formatting changed.
- `$dist-safety-gate`: run `bun run test:dist`.
- `$binary-packaging-verification`: run `bun run build:binaries` plus a built `brewva --help` smoke test.
- `$pi-docs-sync`: read relevant Pi docs and linked references first.

## Mandatory Triggers

- Runtime public APIs, exported package surfaces, config schema/default semantics, persisted formats, WAL recovery semantics, wire protocols, or user-facing CLI behavior require `$implementation-strategy`.
- Multi-step, cross-package, refactor-heavy, or long-running work requires `$exec-plan`.
- Changes under `packages/**`, `test/**`, `script/**`, `package.json`, `tsconfig*.json`, `bunfig.toml`, or `.github/workflows/**` require `$code-change-verification`.
- Changes under `docs/**`, `README.md`, or `test/docs/**` require `$docs-verification`.
- Export, CLI, and distribution-surface changes require `$dist-safety-gate`.
- Launcher or binary packaging behavior changes require `$binary-packaging-verification`.
- Pi-specific tasks covering SDK, extensions, themes, skills, prompt templates, TUI, keybindings, providers, models, or packages require `$pi-docs-sync`.
- Pure meta-guidance edits such as `AGENTS.md` or skill docs with no code, config, or runtime impact may skip code and docs verification unless explicitly requested.

## Baseline Verification

- Default quality stack: `bun run check` and `bun test`.
- Docs stack: `bun run test:docs`; add `bun run format:docs:check` for Markdown formatting changes.
- Dist safety gate: `bun run test:dist`.
- Binary packaging verification: `bun run build:binaries` and `./distribution/brewva-linux-x64/bin/brewva --help | head -n 1`.
