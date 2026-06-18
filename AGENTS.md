# Brewva Agent Guide

## Purpose

- This file is the short repository map for agents working in `brewva/`.
- Keep it current and action-oriented. Long-form project rules live in `skills/project/shared/*.md`; design detail lives in `docs/**`; code and tests remain authoritative.
- Priority order: hard invariants, workflow gates, verification, then lookup.

## Repo At A Glance

- `Brewva` is a Bun + TypeScript monorepo for an AI-native coding-agent runtime.
- Workspace packages live under `packages/*`; primary surfaces include `acp-adapter`, `capabilities`, `channels-telegram`, `cli`, `effect`, `gateway`, `ingress-telegram`, `mcp-adapter`, `provider-core`, `recall`, `runtime`, `search`, `session-index`, `std`, `substrate`, `token-estimation`, `tools`, and `vocabulary`.
- Release artifacts live under `distribution/brewva`, `distribution/brewva-*`, and `distribution/worker`.
- Support roots: `script/` for build and verification, `docs/` for design/reference material, `test/` for workspace coverage, and `docs/solutions/**` for repository-native precedent.
- Project guidance is authored in `skills/project/shared/*.md` with metadata-only `strength` and `scope` frontmatter. It is context/provenance metadata, not runtime authority.

## Hard Invariants

- Preserve the user-facing `brewva` command, help surface, launcher metadata, and distribution smoke checks.
- Keep the public runtime root four-port based: `identity`, `config`, `tape`, `kernel`, `model`, `start`, `turn`, and `close`.
- `createBrewvaRuntime(...)` requires `physics: { mode: ... }`; do not introduce default-mode fallbacks, implicit providers, or `EMPTY_PROVIDER` turn paths.
- Do not reintroduce `root`, `hosted`, `tool`, `operator`, `authority`, or `inspect` on `createBrewvaRuntime(...)`.
- Do not add private runtime construction, Tape commit, or Effect semantic service seams; new code must target the four-port runtime or a package-owned control-plane adapter.
- Runtime tests that still need historical hosted/operator fixtures must import them from `../../helpers/runtime.js`, not from a runtime package subpath.
- Keep workspace imports on package entrypoints; do not reintroduce local alias schemes or cross-package relative imports.
- Keep public root exports narrow. Repo-owned implementation seams stay under documented internal entrypoints.
- Keep managed tools capability-scoped and fail-closed when a runtime capability is undeclared.
- Keep runtime execution receipt-based, replay-first, and recoverable through existing WAL/event/proposal boundaries.
- Keep DuckDB session index state rebuildable and non-authoritative; event tape remains replay authority.
- Keep search tokenization centralized in `@brewva/brewva-search`; do not add package-local tokenizers or silent Chinese-tokenizer fallbacks.
- Use Bun for build and test. Baseline: Bun `1.3.12`, Node `^20.19.0 || >=22.13.0`, ESM, strict TypeScript.
- Detailed invariant context is in `skills/project/shared/critical-rules.md`, `skills/project/shared/package-boundaries.md`, and `skills/project/shared/anti-patterns.md`.

## Workflow Trigger Index

- Public runtime APIs, exported package surfaces, config schema/default semantics, persisted formats, WAL recovery, wire protocols, or user-facing CLI behavior: use `$implementation-strategy`.
- Multi-step, cross-package, refactor-heavy, or long-running work: use `$exec-plan`.
- Changes under `packages/**`, `test/**`, `script/**`, `package.json`, `tsconfig*.json`, `bunfig.toml`, or `.github/workflows/**`: run `$code-change-verification`.
- Changes under `docs/**`, `README.md`, or `test/docs/**`: run `$docs-verification`.
- Export, CLI, or distribution-surface changes: run `$dist-safety-gate`.
- Launcher or binary packaging behavior changes: run `$binary-packaging-verification`.
- Pi-specific tasks covering SDK, extensions, themes, skills, prompt templates, TUI, keybindings, providers, models, or packages: run `$pi-docs-sync`.
- Detailed workflow gate definitions and commands are in `skills/project/shared/workflow-gates.md`.

## Verification

- Default quality stack: `bun run check` and `bun test`.
- Property tests run inside `test:unit` and `test:contract` by filename; use `bun run test:property` for a focused property-only run and `bun run test:property:fuzz` for expanded runs.
- Docs stack: `bun run test:docs`; add `bun run format:docs:check` when Markdown formatting changed.
- Dist safety gate: `bun run test:dist`.
- Binary packaging verification: `bun run build:binaries` and `./distribution/brewva-linux-x64/bin/brewva --help | head -n 1`.

## Where To Look

- Runtime API and public entry surface: `packages/brewva-runtime/src/runtime/runtime.ts`, `packages/brewva-runtime/src/public/index.ts`.
- Runtime model attention: `packages/brewva-runtime/src/runtime/model/impl.ts`.
- Session query plane: `packages/brewva-session-index/src/index.ts`, consumed by `packages/brewva-recall/src/broker/broker.ts` and `packages/brewva-cli/src/operator/insights.ts`.
- Gateway hosted context and plugins: `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`, `packages/brewva-gateway/src/hosted/internal/compaction/model-downshift-policy.ts`, `packages/brewva-gateway/src/extensions/api.ts`, `packages/brewva-gateway/src/hosted/internal/turn-adapter/lifecycle/local-hook-port.ts`.
- Managed tool capabilities: `packages/brewva-tools/src/registry/managed-metadata.ts`, `packages/brewva-tools/src/registry/runtime-bound-tool.ts`.
- Expanded lookup map: `skills/project/shared/source-map.md`.
