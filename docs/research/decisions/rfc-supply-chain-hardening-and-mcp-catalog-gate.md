# Decision: Supply-Chain Hardening And An MCP Catalog Review Gate

## Metadata

- Decision: Brewva adds dependency-trust and MCP-catalog-trust gates at the repository and config-load boundary — OSV detection on `bun.lock`, a high-signal supply-chain content scanner, exact-pinned direct dependencies, a config-load rejection of a `"*"` `includeToolNames`, and an `mcp-catalog-reviewed` CI label gate. All are repository-governance-adjacent (axiom 13): they add gates and evidence but change zero runtime admission authority, and an MCP server's self-declared tool catalog never auto-derives authority (axiom 18). A gated MCP tool still passes the same kernel admission as any other tool.
- Date: `2026-06-28`
- Status: accepted
- Stable docs:
  - `docs/reference/mcp-integration.md`
  - `docs/reference/exec-threat-model.md`
- Code anchors:
  - `script/check-supply-chain.ts`
  - `.github/workflows/osv-scanner.yml`
  - `.github/workflows/mcp-catalog-gate.yml`
  - `packages/brewva-runtime/src/config/normalize-integrations.ts`
  - `test/fitness/tooling-dependency-hygiene.fitness.test.ts`
  - `test/fitness/docs/mcp-catalog-example.fitness.test.ts`

## Decision Summary

- OSV scanning is detection-only: its own `.github/workflows/osv-scanner.yml` runs per-PR when `bun.lock` changes, weekly, and on dispatch with `fail-on-vuln: false` (SARIF to the security tab), and `bun audit` is a `continue-on-error` advisory step in `ci.yml`. Findings are evidence for a deliberate patch schedule, never a merge gate — a noisy blocking gate trains reviewers to bypass it.
- `script/check-supply-chain.ts` mirrors `check-security-patterns` and is wired into `check`. Three deliberately few rules: an unreviewed `package.json` lifecycle script (an explicit `ALLOWED_LIFECYCLE_SCRIPTS` allowlist is the escape, since JSON cannot carry an allow-comment), a base64-decode feeding `eval`/`Function` in first-party `src` (inline `supply-chain-allow`), and the install-time code (git hooks plus the npm-distribution `postinstall`) scanned for both. It is a full-tree content scan, not a diff scan: the tree starts clean, so full-tree approximates "flag new indicators" without git base-ref fragility, and `test/` is excluded so fixtures cannot self-flag.
- The "expose everything by default" premise was found false: `normalizeMcpServerConfig` already validates the transport set, defaults `includeToolNames` to `[]`, and forces `inheritEnv: false`. The genuine residue is the `["*"]` footgun (reads as wildcard-allow but exposes only a tool literally named `"*"`), so config load now rejects a `"*"` `includeToolNames` outright. A `docs/` fitness asserts the documented example stays a bounded, non-wildcard, known-transport catalog.
- The `mcp-catalog-reviewed` label gate is its own `.github/workflows/mcp-catalog-gate.yml`, paths-filtered to the adapter, the gateway enforcement point, the config normalizer/types, and the example doc, re-running on `labeled`. Its checklist: command/args expected, env allowlist minimal, no exfil URL, tool list bounded and non-wildcard.
- The roughly twelve ranged direct dev-dependencies were pinned to their already-locked versions (resolved versions unchanged); `tooling-dependency-hygiene` asserts no caret/tilde range survives in either manifest dependency section. `bun.lock` blocks transitive drift, and exact pins make a direct version change a reviewed edit.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- Obeys `Repository governance stays adjacent to the kernel` (axiom 13): the OSV scan, the content scanner, the pinning fitness, and the label gate are merge/release-trust controls owned by repository governance; the runtime emits and consumes their evidence but does not absorb the policy into kernel admission authority.
- Obeys `Descriptive metadata derives views, never authority` (axiom 18): an MCP server's self-declared tool catalog is descriptive; it derives a bounded view through `includeToolNames`, never an unbypassable authority, so a `"*"` that would read as wildcard-allow is rejected at config load.
- Obeys `Same evidence is not shared authority` (axiom 11): a gated MCP tool is adopted under the catalog gate, but each of its calls still passes the unchanged kernel admission and effect governance — adoption-time trust is not call-time authorization.

## Open follow-ups

- OSV `bun.lock` parser depth: osv-scanner v2 recognizes `bun.lock` by name; if a parser gap appears, fall back to scanning a generated SBOM or `bun audit` JSON.
- Scanner rule count: three indicators today; a network-call-in-a-new-dependency-entry rule is added only on a real miss, never speculatively, so the scanner stays trusted.
- MCP env allowlist: the gate requires `envAllowlist` presence but does not yet bound its size or content (for example forbidding broad secret forwarding); a size/content bound is a v2 question.
- Label-gate composition: the required-label step composes with the existing concurrency/cancellation config; revisit if a future MCP-config path needs a different trigger set.
