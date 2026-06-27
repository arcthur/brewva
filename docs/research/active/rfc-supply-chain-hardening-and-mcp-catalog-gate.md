# RFC: Supply-Chain Hardening And An MCP Catalog Review Gate

## Metadata

- Status: active
- Owner: Tooling/CI, MCP-adapter, and runtime-security maintainers
- Last reviewed: `2026-06-26`
- Depends on:
  - [RFC: Checked Invariants And Disciplined Peer Borrowing](./rfc-checked-invariants-and-disciplined-borrowing.md)
- Promotion target:
  - `docs/reference/mcp-integration.md`
  - `docs/reference/exec-threat-model.md`

## Problem Statement

Brewva's CI has strong _internal_ hygiene — `check:security-patterns` scans runtime
boundary files for payload leaks and command concatenation, the
tooling-dependency-hygiene fitness pins knip's config, and `bun install
--frozen-lockfile` enforces the lockfile. But it has **no dependency vulnerability
scanning, no malicious-package-pattern detection, and no trust gate on MCP
servers**. The MCP adapter passes a user-configured `command` (stdio) or `url`
(HTTP) straight to the transport and dynamically adopts whatever tool list the
server advertises, with `includeToolNames` an _optional_ allowlist that defaults
to "expose everything."

The peer agent (`hermes`) hardened exactly this surface after a real PyPI worm
incident: exact pins, a high-signal supply-chain scanner (`.pth` files, base64+exec,
install hooks), OSV scanning, and an MCP-catalog review gate. The capability is
residue here; one piece (4c) is **partially** adjacent to the checked-invariants
RFC's `capability x plugin` matrix, but that matrix guards _internal runtime
plugin_ capabilities — it is orthogonal to _external MCP server_ trust. The
framing line:

> An MCP server is untrusted code the operator invited in. Its self-declared tools
> describe a view; they must never auto-derive an authority (axiom 18).

This is a repository-governance and operator-trust concern, adjacent to the kernel
(axiom 13). It adds CI gates and one config-trust rule; it changes no runtime
admission authority — a gated MCP tool still passes the same kernel admission a
non-MCP tool does.

## Scope Boundaries

In scope:

- **(a) OSV scanning** of `bun.lock` in CI: a non-blocking weekly + per-PR
  `osv-scanner` job whose findings land in the security tab, plus `bun audit` on PRs
- **(b) a high-signal supply-chain diff scanner**: a `check:supply-chain` script
  that, on the PR diff only, flags the narrow set of true attack indicators —
  added `package.json` lifecycle scripts (`postinstall`/`preinstall`/`prepare`),
  `base64`-decode-then-`eval`/`Function` combos, and edits to install-hook files —
  with an allow-comment escape hatch, mirroring `check:security-patterns`
- **(c) an MCP catalog review gate**: a fitness asserting every configured MCP
  server carries a non-wildcard `includeToolNames` allowlist and a transport from a
  known set, plus a CI label gate (`mcp-catalog-reviewed`) required to merge changes
  to MCP server config/fixtures
- tightening the ~11 ranged dev-dependencies in root `package.json` to exact pins,
  matching the exact-pin posture the existing pinned tools already use

Out of scope (owned elsewhere; this RFC must not re-open):

- the internal runtime `capability x plugin` matrix and the no-context-source
  allowlist → owned by the checked-invariants RFC; this RFC guards external MCP
  trust, a different surface
- MCP _tool-call_ runtime admission (action class, surface, approval) → already
  owned by `toolPolicies` and kernel admission; this RFC gates _which servers/tools
  are adopted at all_, not how an adopted call is authorized
- a vendored allowlist of "known safe" transitive versions / SBOM attestation →
  heavier supply-chain machinery; OSV detection is the v1 floor, attestation is a
  later option
- signing/verifying MCP server binaries → out of reach for arbitrary user-configured
  commands; the gate is allowlist + review, not cryptographic attestation

## Peer Lens: What `hermes`'s Supply-Chain Posture Gets Right

Verdict vocabulary: **COVERED**, **REJECT**, **BORROW**, **OUT OF SCOPE**.

| `hermes` mechanism                                                                      | Verdict          | Rationale / where it lands                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exact-pin every direct dep; ranges only with written justification                      | BORROW (partial) | Brewva pins some dev tools and commits `bun.lock`; tighten the remaining ranged dev-deps. Lockfile already blocks transitive drift.                                  |
| OSV-Scanner on lockfiles, weekly + per-PR, detection-only                               | BORROW           | Direct port to `bun.lock`. Non-blocking so patching stays a deliberate schedule, not a merge-time scramble.                                                          |
| high-signal scanner: `.pth`, base64+exec, install-hook edits; low-SNR rules **removed** | **BORROW**       | The discipline matters as much as the rules: only true indicators, so reviewers never learn to ignore the scanner. TS analogs: lifecycle scripts, `eval(atob(...))`. |
| MCP catalog change requires an explicit review label + checklist                        | **BORROW**       | Brewva has no MCP trust gate; an MCP server is operator-invited untrusted code. Allowlist + label is the residue.                                                    |
| lazy-install allowlist isolating provider-specific deps                                 | OUT OF SCOPE     | Brewva is a Bun monorepo with one lockfile; the per-feature lazy-install blast-radius pattern is a packaging concern, not CI.                                        |
| `defusedxml` for untrusted XML; per-platform constraint files                           | OUT OF SCOPE     | Adapter-specific dependency choices; adopt per-need, not as a CI rule.                                                                                               |
| dependency _bounds_ check (require `<next-major` ceiling)                               | COVERED (mostly) | The committed `bun.lock` + frozen-install already prevents the auto-upgrade this guards; exact-pinning dev-deps closes the rest.                                     |

The honest residue: **OSV on `bun.lock`**, a **high-signal diff scanner**, an
**MCP catalog allowlist + review gate**, and **exact-pinning the ranged dev-deps**.

## Decision Options

### A. OSV + audit job (chosen: additive CI job, non-blocking)

Add an `osv-scanner` job to `ci.yml` scanning `bun.lock`, on PRs touching the
lockfile and on a weekly schedule, `fail-on-vuln: false` so it reports without
blocking; add `bun audit` to the PR quality job as advisory output. Findings are
evidence for a deliberate patch schedule, not a merge gate (matches the peer's
detection-only posture and avoids training reviewers to bypass a noisy gate).

### B. High-signal diff scanner (chosen: extend the existing pattern-scan idiom)

A new `check:supply-chain` script (a sibling to `check:security-patterns`), run in
`check`, that scans the **PR diff's added lines only** for the narrow indicator set, reusing the
`check:security-patterns` allow-comment mechanism (`// supply-chain-allow [rule]:
reason`). Rules, deliberately few: a new `package.json` lifecycle script; a
`base64`/`atob` decode feeding `eval`/`new Function`; an edit to a known install-hook
file. The discipline is the rule _count_: any rule that fires on normal PRs is
removed, not tuned, so the scanner stays trusted.

### C. MCP catalog gate (chosen: fitness allowlist + CI label)

Two layers:

1. a fitness test asserting every MCP server in committed config/fixtures has a
   **non-empty, non-wildcard** `includeToolNames` and a transport `type` in the
   known set (`stdio` with `inheritEnv: false` + an `envAllowlist`, or
   `streamable_http`) — so an adopted server can never silently expose its full,
   mutable tool list (axiom 18: the server's self-declared catalog derives a view,
   never an unbounded authority);
2. a CI label gate requiring `mcp-catalog-reviewed` on any PR touching MCP server
   config or fixtures, with a reviewer checklist (command/args expected, env
   allowlist minimal, no exfil URL, tool list bounded).

### D. Exact-pin dev-deps (chosen)

Convert the ranged dev-dependencies in root `package.json` to exact pins, matching
the already-pinned tools, and add a one-line fitness (or extend
tooling-dependency-hygiene) asserting no caret/tilde ranges in the root manifest's
direct deps. `bun.lock` already prevents drift; exact pins make a version change a
reviewed edit, shrinking the blast radius of a compromised release.

## Landing Plan

Four independent changes, all implemented (2026-06-27), each verified against a green
`bun run check` and the affected suites. A disciplined read corrected two premises before
coding (noted inline):

1. **OSV + `bun audit`.** (Done.) OSV is its own `.github/workflows/osv-scanner.yml`
   (per-PR on `bun.lock` + weekly + dispatch, `fail-on-vuln: false`, SARIF → security tab)
   rather than bloating `ci.yml`'s triggers; `bun audit` runs as a `continue-on-error`
   advisory step in the `ci.yml` quality job (it already surfaces real transitive
   advisories, so it must stay advisory).
2. **`check:supply-chain`.** (Done.) `script/check-supply-chain.ts` mirrors
   `check-security-patterns`, wired into `check`. Three rules: an unreviewed `package.json`
   lifecycle script (JSON cannot carry an allow-comment, so an explicit allowlist is the
   escape — the two intentional scripts are listed), a base64-decode→eval combo in
   first-party `src` (inline `supply-chain-allow`), and the install-time code — the git
   hooks plus the npm-distribution `postinstall` the lifecycle allowlist hands off to,
   scanned for both base64→eval and remote-exec. **Deviation:** a full-tree content scan,
   not a diff scan — the repo starts clean
   of every indicator, so full-tree ≈ "flag new indicators" without git-diff base-ref
   fragility and runs deterministically in `check`; `test/` is excluded so the scanner's
   own fixtures cannot self-flag.
3. **MCP catalog gate.** (Done — scope corrected.) The disciplined read found the RFC's
   "expose everything by default" premise FALSE for Brewva: `normalizeMcpServerConfig`
   already validates the transport set, defaults `includeToolNames` to `[]` (expose none),
   and forces `inheritEnv: false`; the gateway always receives a bounded array, so the
   expose-all path is unreachable. The genuine residue is the `["*"]` footgun (reads as
   wildcard-allow but exposes none, since `toolPolicies` uses `"*"` as its default-all
   key). Built: a config-load rejection of a `"*"` `includeToolNames` (axiom 18 made
   explicit) + a contract test; a `docs/` fitness asserting the documented example models a
   bounded, non-wildcard, known-transport catalog; and the `mcp-catalog-reviewed` label
   gate as its own `.github/workflows/mcp-catalog-gate.yml` (paths-filtered to the adapter,
   the gateway `includeToolNames` enforcement point, and the example doc, re-runs on
   `labeled`). The redundant "scan committed configs for
   transport/presence" fitness was dropped — normalize already enforces both.
4. **Exact-pin dev-deps.** (Done.) The 12 ranged dev-deps pinned to their locked versions
   (resolved versions unchanged; only the lock's specifier strings moved);
   `tooling-dependency-hygiene` flips its knip assertion to exact and adds a no-caret/tilde
   guard over both manifest dependency sections.

## Source Anchors

- Existing high-signal scanner to mirror (idiom + allow-comment):
  `script/check-security-patterns.ts`
- Existing tooling-invariant fitness to extend: `test/fitness/tooling-dependency-hygiene.fitness.test.ts`,
  `knip.json`
- CI to extend: `.github/workflows/ci.yml` (quality job, `bun install --frozen-lockfile`)
- MCP transport/config and the optional-today allowlist: `McpTransportConfig`,
  `includeToolNames`, `toolPolicies` in `packages/brewva-mcp-adapter/src/index.ts`
  and `BrewvaMcpServerConfigBase` in `packages/brewva-runtime/src/config/types.ts`
- MCP tool adoption (the dynamic-refresh path the gate bounds):
  `createHostedMcpToolBundle` and `mcp__<server>__<tool>` naming in the MCP adapter
- Committed lockfile and dev-dep pinning posture: root `package.json`, `bun.lock`
- Peer precedent (read-only, external repo): `hermes`'s supply-chain-audit and
  osv-scanner CI workflows, and its `tools/lazy_deps.py` allowlist regex

## Validation Signals

- OSV: a PR introducing a `bun.lock` entry with a known advisory surfaces a finding
  in the security tab without failing the merge; the weekly run posts against main.
- Scanner: a fixture PR adding a `postinstall` script or an `eval(atob(...))` is
  flagged; a normal PR with neither is clean; an allow-comment with a reason
  suppresses a reviewed instance.
- MCP gate: a config with `includeToolNames: ["*"]` or a missing allowlist fails the
  fitness; a config with a bounded allowlist + known transport passes; a PR editing
  MCP config without the `mcp-catalog-reviewed` label is blocked.
- Pinning: a caret/tilde range reintroduced into a root direct dep fails the
  no-ranges fitness.

## Surface Budget

Counts are for the CI/security and MCP-trust surface only; before → after.

- Required authored (model-facing) fields: 0 → 0. Entirely operator/CI surface.
- Optional authored fields: MCP `includeToolNames` becomes effectively required
  (the gate rejects wildcard/absent) — a tightening of an existing field, not a new
  one.
- Author-facing concepts: +1 operator concept (a "reviewed MCP catalog entry").
- Inspect surfaces: +0 (CI findings live in the security tab / CI logs, not a
  runtime projection).
- Routing / control-plane decision points: +0 runtime decision points. The MCP gate
  is a _config-admission_ check at build/load time; a gated tool still passes the
  unchanged kernel admission at call time.
- Config keys: +0 new keys; the change makes `includeToolNames` mandatory-non-wildcard.
- Public CLI surfaces: +0 (a `check:supply-chain` script, not a user command).
- Persisted formats: +0.
- net required authored fields: 0. debt owner: tooling/CI + MCP-adapter maintainers.
  re-evaluation trigger: a move to SBOM attestation or signed MCP servers (heavier
  machinery warranting its own decision).

This RFC adds gates and evidence at the repository and config boundary (axiom 13,
adjacent to the kernel) and changes zero runtime admission authority. A gated MCP
tool is governed by the same kernel admission as any other tool.

## Promotion Criteria And Destination Docs

Promote each change when its validation signal passes against a green
`bun run check` and the full suite.

- MCP catalog allowlist requirement and transport set → `docs/reference/configuration.md`.
- The supply-chain CI posture (OSV, scanner, pinning, MCP review label) →
  `docs/reference/exec-threat-model.md`.

On acceptance, convert this note to a single-decision record under
`docs/research/decisions/` citing axioms 13, 18, and 11.

## Open Questions

- OSV on `bun.lock`: confirm OSV-Scanner's current Bun lockfile support depth; if a
  parser gap exists, fall back to scanning a generated SBOM or `bun audit` JSON.
- Scanner rule set: are three indicators enough, or is a `git`/network-call-in-a-new-
  dependency-entry rule worth the false-positive risk? Default: start at three,
  add only on a real miss.
- MCP env allowlist: should the gate also bound the `envAllowlist` size or content
  (e.g. forbid forwarding broad secrets), or is presence enough for v1?
- Label-gate enforcement: a required-label check needs a small CI step; confirm it
  composes with the existing concurrency/cancellation config.

## Related Work

- Adjacent internal-plugin allowlist (distinct surface): the checked-invariants RFC's
  `capability x plugin` matrix.
- Repository-governance-adjacent placement: axiom 13 (`Repository governance stays
adjacent to the kernel`).
- Self-declared catalog never derives authority: axiom 18.
- Existing scanner idiom reused: `script/check-security-patterns.ts`.
