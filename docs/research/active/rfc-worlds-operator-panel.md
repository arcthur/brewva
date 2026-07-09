# RFC: The `/worlds` Operator Panel — A git-like TUI Over The World/Rewind Substrate

## Metadata

- Status: active
- Kind: RFC (a TUI increment over shipped substrate, not a new plane)
- Owner: CLI / TUI and rewind maintainers
- Last reviewed: `2026-07-09`
- Depends on:
  - [RFC: Coupled World Rewind, Delegation Changeset Physics, Reversibility Tiers, And The Supervision Surface](./rfc-coupled-world-rewind-delegation-changesets-and-reversibility-tiers.md)
    (the world substrate this makes visible: content-addressed worlds, the
    world-restore rewind lane, basis-anchored delegation changesets)
  - [RFC: Inspect, Replay, And Recovery Optimization](./rfc-inspect-replay-and-recovery-optimization.md)
    (the rewind/redo transaction engine and the shared inspect host this reuses)
  - [Design Axioms](../../architecture/design-axioms.md) (axiom 1 `Attention belongs
to the model`, axiom 3 `Subtraction beats switches`, axiom 6 `Views rebuild from
receipts`, axiom 12 `Product loops are projections`, axiom 17 `Platform growth is
opt-in`, axiom 18 `Descriptive metadata derives views, never authority`)
- Promotion target:
  - `docs/research/decisions/` (an ADR once the panel is dogfooded and the
    read-only cost on a large repo is measured)
  - `docs/reference/commands.md` (the `/worlds` command + keymap, once landed)

## Problem Statement

The coupled-world-rewind RFC shipped a content-addressed **world substrate**: every
rewind checkpoint captures a workspace world (manifest hash = world id, blobs shared
across worlds), a world-restore lane rewinds by materializing a world, and effectful
delegation forks seal a basis-anchored changeset. The substrate is real and enabled
by default — and **invisible**.

Today's TUI renders only the **conversation axis**. `TreeOverlay` and `LineageOverlay`
show turns, prompt previews, and branch lineage; the **environment axis** the world
substrate added — the world DAG (dedup snapshots, blob sharing), world↔world diffs,
delegation-fork settlement outcomes, and per-checkpoint world-lane readiness — is
surfaced nowhere. Rewind itself hides behind `/rewind`: no keyboard shortcut, not in
the suggested command set, gated only by a blocking `ui.select` picker with no diff
preview.

So a user cannot answer, from any surface: _what workspace state does this checkpoint
name? what changed between these two worlds? is this checkpoint's world still
restorable, or was its material GC'd? what did that delegation fork actually settle
into the parent?_ The substrate's value is stranded — captured but unrealized as an
operable, legible surface. This RFC gives the environment axis a first-class,
git-like operator panel.

## The Design: `/worlds`, an operator panel on the environment axis

An independent `OverlaySurface` overlay, opened by `/worlds` or `leader v`,
**operate-tier** (the jujutsu `jj op log` + `jj undo` mental model: an operation
history you can navigate and reverse), with three switchable views and a confirm-gated
rewind. It reuses the shipped rewind projections and effects wholesale; the only new
code is three small pure pieces plus the overlay wiring.

### View 1 — Timeline (default): conversation axis + world chip

The primary view is the session's checkpoint timeline (`session.rewind.listTargets`

- `getState`), each row annotated with its **world-lane readiness chip** — the
  conversation axis and the environment axis fused on one line:

```
┌ worlds · session a1b2c3 ────────────────────────────────────────────────────┐
│ ‹ Timeline › Diff   Forks                                    ⌂ working tree   │
│ ●  t12  2m   "add census reviewedSubGrade"      +3 ~2 -0   ✓ 4f2e·  ← HEAD    │
│ ○  t11  8m   "wire coverageAttributionMiss"     +1 ~4 -1   ✓ 9a1c·           │
│▐○  t10  15m  "fix static-guard attribution"     +0 ~1 -0   ⚠ 3b7d·  missing  ▐│
│ ⊘  t9   22m  "planning map phase 2"             +6 ~2 -3   ✓ c4e8·  abandoned │
│ ○  t8   31m  "…"                                +2 ~0 -0   · ----   uncaptured│
├───────────────────────────────────────────────────────────────────────────┤
│ world 3b7d· · 2546 files · ⚠ missing_artifacts     diff vs ⌂ working tree:    │
│   ~ packages/brewva-tools/…/static-guard/predicates.ts                        │
│   + test/unit/tools/coverage-attribution-miss.unit.test.ts                    │
│   › Enter: open blob diff in pager                                            │
├───────────────────────────────────────────────────────────────────────────┤
│ Enter diff · r rewind · u undo · R redo · m mode(code|both) · / find · esc    │
└───────────────────────────────────────────────────────────────────────────┘
```

Row = a checkpoint: lineage glyph (`●` current / `○` active / `⊘` abandoned, from
`getState`) · turn · relative time · prompt preview · `fileSummary` (+~-) · **world
chip** (`✓` available / `⚠` missing_artifacts / `✗` capture_failed / `·` not_captured,
from `workspaceReadiness` / `projectWorldAvailability`) · short world id. The lower
pane shows the selected world's metadata and its file-level diff versus the working
tree.

### View 2 — Diff: world↔world / world↔working-tree

Full-screen the diff: left a file list, right the blob diff. `m` cycles the reference
(working tree / previous world / a `space`-marked world), so any two worlds compare
directly — content addressing makes this a pure manifest comparison. `Enter` on a file
opens the blob diff in a `PagerOverlay`, rendered through the **existing redaction
layer** (a world's blobs are raw file bytes and may carry secrets — see Invariants).

### View 3 — Forks: delegation changeset settlement lanes

One lane per delegation fork, drawn from the tape's settlement receipts:
`basis 4f2e· → result 8c91·` with a settlement badge (`ff` fast-forward / `no-op` /
`⚡ parent_diverged`). This draws the fork sub-axis — the basis-anchored changeset
physics the substrate added — for the first time. Note the fork's own world store is
ephemeral (it dies with the tmpdir), so this view shows the **settled history rebuilt
from receipts** (axiom 6), not a live fork's working diff (see Open Questions).

### Destructive action: rewind through a confirm gate

`r` opens a `ConfirmDialogOverlay` — which IS the gate. Rewind carries no policy gate
today (`/rewind` is gated only by the human running it); the confirm dialog preserves
exactly that contract, with the mode as an in-dialog single-select:

```
┌ Rewind to t10 · 15m ago ──────────────────────────┐
│ mode:  ‹● code ›   ○ both   ○ conversation    ←/→  │
│        code = workspace only, keeps conversation   │
│ restores: wrote ~5 · deleted 1 · spared 2          │
│ world 4f2e· → 3b7d·   fresh "where-we-were" first  │
│              Enter confirm      esc cancel         │
└─────────────────────────────────────────────────────┘
```

`restores` numbers come from `previewWorkspaceRewind(mode)` (read-only) and update as
`mode` toggles; `conversation` shows "workspace untouched". Confirm dispatches the
existing `session.rewind` effect. `u`/`R` map to `session.undo`/`session.redo`
(`getState.latestRewindable` / `redoStack`). The world line names the `from → to`
edge, making the substrate's "a restore captures a fresh world first, never rewrites
history" property legible.

### Data flow — mostly existing projections, three small new pure pieces

| View element                                                           | Source                                                                                                                                       | New?           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Timeline rows (lineage/turn/prompt/fileSummary)                        | `session.rewind.listTargets` + `getState`                                                                                                    | no             |
| World chip                                                             | `workspaceReadiness` / `projectWorldAvailability`                                                                                            | no             |
| File-level world diff (+~-)                                            | **`projectWorldDiff(manifestA, manifestB)`** — pure compare of two manifests' `files[]` (blob differs = modified, one-sided = added/deleted) | **new**        |
| Blob diff (in Pager)                                                   | `readBlob(a)` / `readBlob(b)` + existing `diffStyle`, through redaction                                                                      | small wiring   |
| "vs working tree" reference manifest                                   | **read-only enumerate + hash** (reuse `listGitScopedPaths`, never the write-bearing `capture`)                                               | **new (thin)** |
| Forks lane                                                             | delegation settlement receipts on the tape                                                                                                   | projection     |
| Rewind preview numbers                                                 | `previewWorkspaceRewind(mode)` (read-only)                                                                                                   | no             |
| World-store reads (`readManifest`/`readBlob`/`listRefs`/`verifyWorld`) | **new read-only `worlds` runtime-ops face** (no capture/materialize/sweep)                                                                   | **new (thin)** |

### Graceful degradation — world-chip driven

- `missing_artifacts` / `capture_failed`: the diff pane explains the material is gone;
  `r` falls to the **patch-lane rewind fallback** (`executeRewind` already does this),
  and disables the confirm with a reason when neither lane can restore.
- `not_captured`: no world diff; rewind still runs via the patch lane.
- **`worlds.enabled = false`**: the environment axis degrades wholesale — the timeline
  (conversation axis) stays, all chips read `·`, Diff/Forks show "worlds disabled
  (config)", and `/worlds` still opens read-only.
- Rewind failure: `executeRewind` fails closed (`restore_io_error` does not fall back);
  a toast reports it and the timeline is unchanged (no misleading partial state).
- A stream in flight: `r` aborts first (existing `session-handler` behavior). A
  working-tree enumerate that fails degrades the diff pane to "snapshot unavailable"
  without blocking the timeline.

### Interaction & keymap

`Tab` / `1 2 3` switch views; `↑↓` `Ctrl+p/n` `PgUp/PgDn` navigate (inherited free from
the overlay keymap layer). Single-letter actions (`r`/`u`/`R`/`m`/`space`/`Enter`)
arrive as `overlay.input` and dispatch in `lifecycle.handleShortcut` — they carry no
keymap binding, so no build-time collision. The entry chord is `leader v` (`v` is free;
`leader w` is taken by cockpit attention), verified against the strict
`normalizeDefinitions` duplicate guard.

## Shared Projection Discipline — Compliance And Narrower Invariants

This panel is a projection-bearing inspect surface, so it inherits the directory's
shared discipline and adds three narrower invariants:

1. **Opening `/worlds` is strictly read-only.** It must never trigger `capture`,
   `materialize`, `sweep`, recall, capability selection, provider routing, or workbench
   mutation. The "vs working tree" reference is a non-persisting enumerate+hash, NOT a
   `capture` (which writes blobs/refs). The only mutation the panel can cause is an
   explicit, confirmed `r`/`u`/`R`.
2. **Blob diffs render through the existing redaction layer.** A world's blobs are raw
   file bytes and can carry credentials/secrets; the blob viewer reuses the same
   redaction the transcript/inspect surfaces use and never widens raw secret-bearing
   text. `projectWorldDiff` at the manifest level exposes only paths/sizes/blob hashes
   (already non-secret); redaction applies at the byte-viewing seam.
3. **Explicit-pull, never model-visible.** `/worlds` is an operator surface opened by a
   human; it auto-pushes nothing into model context (axioms 1, 12). It reuses the
   shared inspect host's navigation/redaction and offers cross-view linking (the
   `/inspect` Rewind section can deep-link into `/worlds`) rather than becoming a second
   inspect truth.

Projection failure fails closed to an inspectable degraded pane (per the shared
discipline), never to a broader-authority silent render.

## Axiom Alignment

- **Axiom 1 / 12 (attention; loops are projections).** The panel is an explicit-pull
  projection over receipts; it never injects into model context and never auto-acts.
- **Axiom 3 (subtraction beats switches).** No new config, no new rewind primitive, no
  new approval machinery. It reuses the shipped `session.rewind/undo/redo` effects, the
  `ConfirmDialogOverlay`, and the overlay pipeline. It even subtracts the awkward
  blocking `ui.select` picker in favor of a navigable timeline.
- **Axiom 6 (views rebuild from receipts).** Every view re-derives from the tape and
  the world store; nothing becomes replay truth, and the Forks view is explicitly a
  tape-rebuilt settlement history.
- **Axiom 17 (opt-in).** A new operator surface behind a command and a chord; it grows
  the platform without changing any default path. `worlds.enabled=false` degrades it
  gracefully rather than erroring.
- **Axiom 18 (descriptive metadata derives views, never authority).** World chips,
  diffs, and settlement badges are descriptive projections; the sole state-changing
  path is the confirmed rewind, which routes through the same authority the existing
  `/rewind` already holds.

## Decision Options

### Option A — read-only world inspector (rejected)

A view-only overlay of the world DAG/diff/readiness with no operations. Rejected: the
rewind operators already exist, so read-only is strictly weaker than the shipped
surface and fails the user's stated need to "operate", not just look.

### Option B — operate-tier `/worlds` panel, `ui.confirm` gate (recommended, chosen)

Timeline + Diff + Forks with confirm-gated rewind/undo/redo. Matches the substrate's
`jj`-like semantics, realizes the environment axis, and keeps the destructive gate
exactly as strong as it is today (the human at the confirm). Smallest operable design
that is axiom-clean.

### Option C — operate-tier + receipt approval (rejected)

Option B but routing rewind through the effectful-tool approval mechanism (a
`PendingEffectCommitmentRequest` → `waiting_approval` → `decideApproval`, footer
`△ N approval`). Rejected as YAGNI (axiom 3): rewind carries no policy gate by design
("the human running the command is the gate"), and this would require adding an
approval-ask emission to the rewind engine that does not exist today, plus turn-
lifecycle changes — real cost for governance no one has asked for. Revisit only if
rewind is ever brought under unified effect governance.

### Carrier — standalone `/worlds` panel (chosen) vs extend `/inspect`

Chosen: a standalone overlay, so the environment axis has an independent identity
(DAG / diff / fork lanes) rather than remaining a subordinate section of the
conversation-axis `/inspect` Rewind view. It still reuses `/inspect`'s data model,
rewind wiring, and the shared inspect host's redaction/navigation, and cross-links with
it — independent identity, shared infrastructure.

## Landing Plan (phased)

### Phase 1 — read-only environment axis (zero-write, zero-risk)

The `/worlds` overlay skeleton + Timeline view: `listTargets` + `getState` + world
chips, and the read-only `worlds` runtime-ops face (`readManifest`/`listRefs`/
`verifyWorld`). No diffs yet, no operations. Delivers the substrate's first visibility
with no destructive surface. This is the promotion-independent MVP.

### Phase 2 — operate tier

The Diff view (`projectWorldDiff` + read-only working-tree enumerate + redacted blob
viewer) and confirm-gated `rewind`/`undo`/`redo` (the `ConfirmDialogOverlay` with the
`mode` single-select, dispatching the existing `session.rewind` effects). This is the
core of the recommended design.

### Phase 3 — Forks lane

The delegation-changeset settlement view (tape-rebuilt basis→result lanes with
`ff`/`no-op`/`parent_diverged` badges). Depends on the settlement receipts being
sufficient to rebuild the lane; may surface a small persistence gap (Open Questions).

## Implementation state (2026-07-09)

Phase 1 landed (`883072f`): the `/worlds` overlay + Timeline view, world readiness chips
from a pure checkpoint-block projection, all eight pipeline seams. Phase 2 landed
(`b20be6f`, refined by its review round): the file-level Diff view (press `2`) and
confirm-gated rewind (press `r`, `mode` single-select), over a read-only
`rewind.worldDiff` op that diffs the selected world against the previous one (git-log
style — no working-tree enumerate, per Open Question 1). Each phase carried an
adversarial review round; Phase 2's caught a diff-list truncation (files capped at the
checkpoint count, not the viewport) and a Diff-view cursor drift (`r` could rewind an
off-screen selection) — both fixed, plus scroll wiring for large changesets and an honest
"previous world unavailable" signal (never a fabricated all-added diff).

Phase 3 landed: the Forks settlement lane (press `3`) — a read-only `rewind.worldForks`
op that folds the tape's `worker.results.applied` / `apply_failed` / `rejected` receipts
into per-adoption lanes (worker ids, applied-path count, conflict paths, and a settlement
badge — no-op / parent-diverged), in tape order, tolerating malformed payloads. This
answers Open Question 2 conservatively: the settlement receipts already on the tape ARE
sufficient to draw per-outcome lanes, so the lane rebuilds purely from events with no
seal-step persistence change. The world-level `basis → result` fork graph is not
tape-derivable and stays deferred (Open Question 2).

Phase 3's adversarial review caught a CRITICAL emit/projection key drift: the projection
read `appliedPaths` and `conflicts[].path`, but the emit sites recorded neither
(`appliedPaths` was never written; conflicts were written flat as `failedPaths`), so every
lane's path count was structurally 0 and its conflicts always empty — and a phantom-fixture
unit test hid it (green while broken). The root fix is a single shared
`buildWorkerResultsSettlementPayload` builder in `@brewva/brewva-vocabulary`: the emit sites
and the projection now declare the payload keys in ONE exact-typed place (a stray key is a
compile error), the emit side records `appliedPaths` for real, and the unit fixtures build
through that same builder so they can never drift from the recorded shape again. The review
also gated `r` out of the non-actionable Forks view (whose footer already omitted it) and
restored the tape-derivable no-op / parent-diverged reason badges the first cut had dropped.

Deferred to a Phase 2 follow-up — listed honestly, not silently dropped:

- **Redacted blob-line viewer** — `Enter` on a diff file to see its byte-level diff
  through the redaction layer. File-level diff already delivers the environment-axis diff;
  this needs a `readBlob` exposure plus redaction integration, so it is the labeled stretch.
- **undo / redo** (`u` / `R` → `session.undo` / `session.redo`) — the rewind actuator
  shipped; the inverse pair is a small follow-up on the same lifecycle path.
- **Rewind preview numbers** — the confirm dialog names the target turn but does not yet
  render `previewWorkspaceRewind(mode)`'s wrote/deleted/spared counts updating as `mode`
  toggles. Read-only and cheap; the natural first follow-up.

## Source Anchors

- World store: `packages/brewva-tools/src/world-store/store.ts` — `readManifest` (:794),
  `readBlob` (:781), `listRefs`, `verifyWorld` (:811); `types.ts` `WorldManifest`.
- Rewind engine: `packages/brewva-gateway/src/hosted/internal/session/recovery/rewind-engine.ts`
  — `executeRewind` (:468), `previewWorkspaceRewind` (:684, read-only),
  `projectWorldAvailability` (:73), the world-restore lane (:308).
- Rewind projections: `packages/brewva-vocabulary/src/internal/types/session-rewind.ts`
  — `SessionRewindTargetView` (:185), `SessionRewindState` (:199); runtime ops
  `runtime-ops-builders/session.ts` (:186).
- TUI shell: `packages/brewva-cli/runtime/shell/fullscreen-app.tsx` `BrewvaFullScreenShell`
  (:88); `runtime/shell/overlays/data-overlays.tsx` `TreeOverlay` (:828) / `LineageOverlay`
  (:896) / `PagerOverlay` (:54); `runtime/shell/overlays/frame.tsx` `OverlaySurface` (:132)
  / `SelectionList` (:210); `runtime/shell/overlays/modal-overlay.tsx` (:53).
- Overlay pipeline: `src/shell/domain/overlays/payloads.ts`; `src/shell/domain/effects.ts`;
  `src/shell/controller/effect-dispatcher.ts`; `src/shell/overlays/lifecycle.ts`;
  `runtime/shell/utils.ts` `cloneOverlayPayload`.
- Command / keymap: `src/shell/commands/shell-command-registry.ts` (`/rewind` :190,
  `/inspect` :66); `src/shell/keymap/keymap-bindings.ts`; `src/shell/domain/reducer.ts`.
- Confirm gate: `ui-adapter.ts` `ConfirmDialog` (:63); rewind entry `session-handler.ts`
  (:506, stream-abort at :507).

## Validation Signals

- **Read-only integrity:** opening `/worlds`, switching views, and computing diffs
  produce ZERO world-store writes (no `capture`/`materialize`/`sweep`, no new
  blobs/manifests/refs) — asserted directly.
- **Redaction:** a world whose blob carries a secret renders redacted in the blob
  viewer, identical to the transcript surface.
- **Operation equivalence:** a rewind confirmed in `/worlds` produces the same
  `executeRewind` receipts as the same `/rewind` command — the panel is a selector, not
  a second rewind path.
- **Graceful degradation:** `missing_artifacts` / `capture_failed` / `not_captured` /
  `worlds.enabled=false` each render without error and route rewind correctly.
- **Determinism:** `buildWorldsOverlayPayload` and `projectWorldDiff` are byte-stable
  for fixed inputs (pure, no I/O, order-independent).

## Promotion Criteria

Promote to `docs/research/decisions/` (and document the command in
`docs/reference/commands.md`) when:

- the panel is dogfooded through at least one real rewind and one real world-diff;
- the read-only working-tree enumerate cost is measured on a large repo and is
  acceptable (or a lazy/cached strategy is chosen — see Open Questions);
- the read-only-open invariant holds under a fitness test (no world-store mutation on
  open), matching the "opening a projection must not materialize" shared discipline.

## Open Questions

1. **Working-tree diff cost.** The "vs working tree" reference needs a read-only
   enumerate+hash of the tracked tree; on a large repo (the coupled-world-rewind RFC
   measured a cold capture at ~2.5s) this may need laziness (compute on demand per
   file), a short-lived cache, or a "diff vs previous world" default that avoids
   touching the working tree at all.
2. **Forks data sufficiency.** _Resolved for outcomes (Phase 3):_ the tape's
   `worker.results.*` settlement receipts are sufficient to draw the per-outcome Forks
   lanes (applied / apply*failed / rejected, with worker ids, applied-path count, conflict
   paths, and a no-op / parent-diverged reason badge), so that lane rebuilds purely from
   events. \_Still open for lineage:* the world-level `basis → result` per-path graph needs
   the ephemeral fork world store's manifests, which the seal step does not persist — a
   small durable fork-lineage summary is the prerequisite, deferred.
3. **Cross-view linking direction.** Should the `/inspect` Rewind section deep-link INTO
   `/worlds` (and shrink to a summary), or should both coexist? The shared-inspect-host
   discipline argues for one host with cross-view links; the exact split is a Phase-2
   detail.

## Related Work

- [RFC: Coupled World Rewind, Delegation Changeset Physics, Reversibility Tiers, And The Supervision Surface](./rfc-coupled-world-rewind-delegation-changesets-and-reversibility-tiers.md)
- [RFC: Inspect, Replay, And Recovery Optimization](./rfc-inspect-replay-and-recovery-optimization.md)
- jujutsu's `jj op log` + `jj undo` — the operation-history-as-reversible-timeline
  precedent this panel adapts to brewva's world/checkpoint model.
