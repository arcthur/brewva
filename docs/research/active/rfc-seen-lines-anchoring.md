# RFC: Seen-Lines Anchoring — Moving Edit Seen-Proof From The Wire Into Harness State

## Metadata

- Status: active
- Kind: implementation RFC (edit-tool anchor format + persisted snapshot payload)
- Owner: Tools and runtime maintainers
- Last reviewed: `2026-07-11`
- Depends on:
  - oh-my-pi `~/new_py/oh-my-pi/packages/hashline/src/patcher.ts` (the borrowed
    seen-lines enforcement + reveal-on-reject shape)
  - oh-my-pi `~/new_py/oh-my-pi/packages/coding-agent/src/edit/file-snapshot-store.ts`
    (harness-side seen-lines capture and merge)
  - `packages/brewva-tools/src/families/navigation/source-patch.ts` (the anchor
    economy this evolves; single mutation gate)
  - `packages/brewva-vocabulary/src/internal/types/source-patch.ts` (the snapshot
    and anchor type contract)
  - `packages/brewva-vocabulary/src/internal/workbench.ts` (the five source-patch
    tape event constants)
  - [Design Axioms](../../architecture/design-axioms.md) (axiom 1 model owns
    attention / runtime owns physics — the seen set is harness-derived state, never
    model-authored; axiom 18 a receipt derives no authority)
- Promotion target:
  - `packages/brewva-tools/src/families/navigation/source-patch.ts` (carries the
    anchor + seen-line contract)
  - `packages/brewva-vocabulary/src/internal/types/source-patch.ts` (the snapshot
    payload contract)
  - `docs/research/decisions/` once landed and benchmarked

## Problem Statement And Scope Boundaries

Every `source_read` stamps a per-line anchor `L<line>@<6hex>|<text>` on each
displayed line, and every `source_patch_prepare` intent echoes the anchor string
verbatim (`startAnchor`/`endAnchor` on `SourcePatchIntent`). The 6-hex token is
`shortSha256Hex("<line>:<hash>", 6)`; the prefix is `9 + line-digits` bytes
(10 B at line 1-9, 12 B at line 100-999). A 400-line read (the
`MAX_SOURCE_READ_LINES` cap) therefore spends ~4.8 KB on anchor prefixes alone,
and the model re-spends output tokens reproducing those anchors on prepare — the
tax is paid on both the read and the prepare, in both directions.

The token does two jobs, and it is important to state them honestly:

1. **Seen-proof.** To cite `L42@a1b2c3` the model must reproduce the exact 6-hex
   token, which `formatSourceRead` emits _only_ for displayed lines. Fabricating
   an anchor for an unshown line is a 1-in-16M guess against the snapshot. So
   brewva **already has** seen-proof — it is not missing. It is priced as an
   O(lines) wire token instead of held as harness state.
2. **Drift detection.** `resolveCurrentAnchor` re-hashes the current line and
   rejects if it changed; `findRecoveredAnchor` relocates by unique full-`hash`
   match. This is _per-line_ drift: line 42 may be edited if line 42 is unchanged,
   even if other lines moved.

oh-my-pi does the same two jobs at O(1) wire cost: one whole-file content tag in
the read header (drift), a harness-side `seenLines` set (seen-proof), and plain
`NN:` line numbers. Its published benchmark motivation is large — weak-model edit
pass rate 6.7% -> 68.3% (Grok Code Fast), output tokens -61% (Grok 4 Fast) — when
the per-line hash tax is removed. Those are oh-my-pi's numbers on oh-my-pi's
harness; brewva must re-measure on its own tape before promotion.

**The honest value proposition** is therefore not "close a hole." Safety is
_equivalent_. The wins are (a) token economy — the line prefix drops from
`~9 + digits` to `digits + 1`, and the prepare intent from a full anchor string
to a line number; (b) a reveal-on-reject self-heal affordance the per-line token
cannot offer — today a bad anchor just fails, whereas a seen-miss can reveal the
unseen line and merge it so a straight retry lands without a re-read; (c) a
simpler, self-teaching model-facing format (`NN:` is obvious; `L42@a1b2c3|` is
not).

In scope: replace the per-line anchor with (whole-file tag + line numbers +
seen-lines accounting) across `source_read` / `source_patch_prepare` /
`source_patch_apply`, preserving brewva's stronger two-phase skeleton (prepare
never mutates, apply is the single write gate, rollback artifact, preflight
re-check, tape snapshots, stale recovery). Out of scope: the LSP write-after
diagnostics path (already landed, orthogonal), the source-intelligence summary
block (keeps its own format), and a benchmark _harness_ (reuse the existing
headless tape recipe, not a new fixture).

## The Two Anchor Economies

| Property                 | brewva today (per-line token)                   | oh-my-pi (seen-lines)                    | This RFC                                                  |
| ------------------------ | ----------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| Seen-proof               | per-line 6-hex token, must be shown to be cited | harness `seenLines` set                  | harness `seenLines` set                                   |
| Drift detection          | per-line content hash (surgical)                | whole-file tag + 3-way recovery          | per-line text (surgical) — retained, `hash` field dropped |
| Read prefix / line       | `L<n>@<6hex>\|` = 9 + digits B                  | `NN:` = digits + 1 B                     | `NN:` = digits + 1 B                                      |
| Prepare intent reference | full anchor string echoed                       | line number                              | `{snapshot_id, line}`                                     |
| Reject affordance        | "anchor invalid", no reveal                     | reveal unseen line, merge on full reveal | same, at prepare time                                     |
| Recovery key             | full `hash` unique relocation                   | whole-file 3-way merge                   | unique `text` match — same relocation, no cached hash     |

The reframing: the per-line token is a _substitute_ for keeping seen-state —
brewva pays wire tokens to avoid holding the set; oh-my-pi holds the set to save
the tokens. The borrow is "keep the state, drop the per-line token," and it is
consistent with axiom 1 (the seen set is physics the runtime owns, not attention
the model manages).

**One correction the implementation forced (recorded here for honesty).** The
first draft proposed importing oh-my-pi's _whole-file tag + 3-way merge_ drift
model. Reading the code shows that is unnecessary machinery: drift detection is
harness-side in either scheme, so it costs zero wire tokens either way — the token
economy comes entirely from dropping the per-line token and citing line numbers.
The whole-file tag would only trade brewva's _surgical_ per-line drift (edit line
42 if line 42 is unchanged) for oh-my-pi's _whole-file_ strictness (reject on any
change) plus a merge engine — a behavioral change with no economy benefit. So this
RFC keeps brewva's per-line-text drift and recovery exactly as they are (relocating
by unique `text` match, which is what the cached `hash` already encoded), and moves
_only_ the seen-proof off the wire. `contentHash` and `snapshot_id` already give
the whole-file identity the intent reference needs; no new tag is introduced.

## Decision Options

- **Option A (chosen): clean cutover to the seen-lines model.** `NN:` line
  numbers + harness `seenLines` + reveal-on-reject, replacing the per-line token
  outright — no transitional flag, no format coexistence. The per-line-text drift
  and recovery stay as they are. Chosen because the value is already decided (this
  is not a "should we?" that a flag needs to gate) and a permanent dual-format
  toggle is exactly the backward-compat cruft brewva's architecture rejects. The
  A/B economy measurement is done as a git-revision comparison on the headless
  tape (before-commit vs after-commit), not a runtime switch.
- **Option B (rejected): flagged rollout, benchmark-then-cutover.** The disciplined
  hedge — carry both formats behind `edit.anchorFormat` until a benchmark decides.
  Rejected here because it violates the "no backward compat / no redundancy"
  constraint and adds a config key, a schema/docs/inventory obligation, and a
  format discriminator that a clean cutover does not need. The measurement it exists
  to enable is achievable without the runtime flag (revision A/B).
- **Option C (rejected): keep the per-line token, stop echoing it on prepare.**
  Resolve line-only intents against the snapshot. Halves the tax (prepare side)
  but keeps the O(lines) read-side prefix and adds no reveal affordance. A
  half-measure that leaves the larger read-side mass in place.
- **Option D (rejected): drop the token, keep line numbers, no seen set.** Cheap
  and simple, but removes the seen-proof that the token was carrying — the model
  could anchor a line it never read. Trades an equivalence for a regression; fails
  axiom 1 (attention leaking into an unaccounted edit surface).

## Module Contract

The change lives entirely inside `families/navigation` (per the domain-slicing
fitness) and reuses the existing `capabilities.tools.sourcePatch.*` port. No new
tool, no new event type, no new config key.

**Type contract (`packages/brewva-vocabulary/src/internal/types/source-patch.ts`).**
`SourceLineAnchor` drops `token` and `hash`, becoming `{ line, text }` — a
numbered line, not a hash-bearing anchor. `SourceSnapshot` gains
`seenLines: readonly number[]`. `SourcePatchIntent` replaces its `startAnchor` /
`endAnchor` / `anchor` string fields with `startLine` / `endLine` / `line`
numbers (the `snapshotId` field stays), and the line-bearing kinds are renamed
for honesty: `replace_lines`, `insert_before_line`, `insert_after_line`,
`delete_lines` (the `create_file` / `delete_file` / `rename_file` kinds are
unchanged). Because `recordSnapshot` emits the whole `SourceSnapshot` as the
`source_snapshot_recorded` payload, `seenLines` persists with no producer change
and `event-contract-liveness` sees no new literal.

**Read (`source_read`, `formatSourceRead`).** Emit `NN:<text>` (plain 1-based
line number, no token). No whole-file tag is added to the header: `snapshot_id`
already names a specific content version (`contentHash` is on the snapshot), and
the intent cites `snapshot_id`, so the identity the reference needs already
exists. Capture the displayed line set as `seenLines` on the `SourceSnapshot`; in
summary mode capture only the boundary lines actually printed. This forces one
ordering change — the read currently records the snapshot _before_ it formats, so
the flow is reordered to compute the displayed set first, then record the snapshot
carrying `seenLines`.

**Prepare (`source_patch_prepare`).** Intents reference `{snapshot_id, line}` (a
range for multi-line kinds) instead of `L<n>@<token>` strings. Resolution, per
intent line, keeps brewva's existing surgical model with one gate added in front:

1. **Seen check (new).** Is `line` in the snapshot's seen set (the persisted
   `seenLines` seed plus any in-session reveal merges)? If not, do not resolve —
   return a reveal (see Invariants) inside the prepare result.
2. **Drift check (unchanged).** Does `currentLines[line - 1]` still equal the
   snapshot's `text` for that line? If yes, resolve at `line` directly.
3. **Recovery (unchanged, re-keyed).** On a per-line mismatch, relocate by unique
   `text` match against the current file (this is exactly what `findRecoveredAnchor`
   did via the cached `hash`, now comparing `text` directly), emitting the existing
   `source_patch_stale_recovered` event. A non-unique match fails closed with
   re-read guidance, as today. For a multi-line range, the two relocated endpoints
   must still span the same length (`last - first === span.end - span.start`), else
   recovery fails closed (`range_relocation_conflict`) rather than splice a range
   the seen-gate never vetted — see Invariants.

**Apply (`source_patch_apply`).** Fully unchanged: preflight re-reads and compares
whole-file `before`-content, the rollback artifact is written, and the gateway ops
builder emits `source_patch_applied`. The two-phase drift model is preserved
exactly (surgical per-line at prepare, whole-file `before`-compare at apply); only
the seen-proof moved off the wire.

## Invariants (narrower than the shared projection discipline)

- No intent resolves against a line absent from its minting read's `seenLines`.
  The seen set is derived from what `source_read` actually printed; it is never
  model-authored and confers no edit authority by itself (axiom 18).
- Reveal-on-reject inlines at most a reveal cap (40) of unseen lines, each
  clipped at a column cap (512). A **complete** reveal — every unseen line shown
  in full width — merges those lines into the seen set so a straight re-prepare
  succeeds without a re-read. A truncated or column-clipped reveal merges nothing.
  The per-reveal cap alone only bounds one message, so the seen set also carries a
  **cumulative reveal-merge budget**: a snapshot may absorb at most 40 lines total
  via reveal-merge across all prepares (`seen.size - seenLines.length` is what has
  already merged; the seed `seenLines` never counts against it). Once the budget is
  spent, further reveals stop merging — so the model cannot piecewise-reveal a wide
  blind region in `<=`cap slices across separate prepares; it must run the required
  range re-read. (oh-my-pi bounds only the single reveal; the cumulative budget is
  brewva's strengthening, without which the anti-piecewise property is per-message,
  not per-snapshot.) The reveal text comes from the snapshot's own stored line
  `text`, so a reveal shows what the read would have shown, never the model's guess.
- The reveal merge augments an in-session seen set only; it is not re-persisted.
  Across a resume the augmentation is lost and the model re-reveals (cheap) rather
  than re-reads — the persisted `seenLines` seed covers the common case.
- The stale-recovery invariant the property test pins (a line survives an unrelated
  leading-line insertion, prepare stays gated, apply then lands) is preserved with
  its mechanism intact — unique-`text` relocation, formerly keyed on the cached
  `hash`. Dropping `hash` changes nothing here because `hash` was only `sha256(text)`.
- A multi-line replace/delete relocates each endpoint independently, then splices
  `min..max` of the two. If drift moved the endpoints to an **inconsistent** span
  (a reorder, or an interior insertion that grew the range), the recovered span no
  longer equals the seen span the model authored, and the `min..max` splice would
  rewrite interior current lines the seen-gate never vetted. So recovery fails
  closed (`range_relocation_conflict`) unless `last - first === span.end - span.start`;
  a whole-range shift keeps that equality, so legitimate leading-insertion recovery
  is untouched.

## Migration

A clean break, with no discriminator and no coexistence, because there is nothing
for two formats to coexist _for_:

- **No per-model dispatch, no live coexistence.** The scheme is global and
  hardcoded; a single cutover covers every model. Because the old and new formats
  never run at once, no `anchorFormat` discriminator is needed — the earlier draft
  added one only for the flagged-coexistence world this RFC rejected.
- **Old tapes fail closed, then self-heal.** A session resumed across the change
  may rehydrate a pre-cutover `source_snapshot_recorded` payload that lacks
  `seenLines`. The rehydration guard requires `seenLines`, so such a payload is
  simply not rehydrated: the model's next intent gets `snapshot_not_found` and
  re-reads, re-minting a new-format snapshot. No migration shim, no old-format
  reader — the absence of `seenLines` _is_ the fail-closed signal. This is the same
  clean-break posture brewva took removing `skills.routing` (no compat shim).
- **In-flight plans.** A plan prepared just before the cutover and applied just
  after is caught by the apply preflight's whole-file `before`-compare, which fails
  closed on any mismatch — the existing backstop needs no format awareness.

The economy is measured as a **git-revision A/B** on the headless tape (the commit
before this change vs after), not a runtime flag: line-prefix bytes, prepare output
tokens, edit success rate, and retry round-trips, on a weak and a strong model.

## Source Anchors

- `packages/brewva-tools/src/families/navigation/source-patch.ts` — the read
  emit line, `buildAnchors`, `resolveCurrentLine` / `findRecoveredAnchor` (drift +
  the `range_relocation_conflict` guard), `revealUnseenLines` / `unseenLinesMessage`
  and the reveal-merge budget in `applyLineIntent`, snapshot/plan rehydration, and
  the single apply gate.
- `packages/brewva-vocabulary/src/internal/types/source-patch.ts` —
  `SourceLineAnchor` / `SourceSnapshot` / `SourcePatchPlan` (`SourceLineAnchor`
  drops `token`/`hash` to `{ line, text }`; `SourceSnapshot` gains `seenLines`).
- `packages/brewva-vocabulary/src/internal/workbench.ts` — the five source-patch
  event constants (all non-canonical; `seenLines` rides the existing snapshot
  event so no new literal is added).
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/tools.ts`
  — the gateway emit site for `source_patch_applied` and the durable snapshot /
  prepared / stale / read events.
- oh-my-pi `~/new_py/oh-my-pi/packages/hashline/src/patcher.ts` — `#assertSeenLines`,
  the reveal caps, and the complete-reveal-only merge rule.
- oh-my-pi `~/new_py/oh-my-pi/packages/coding-agent/src/edit/file-snapshot-store.ts`
  — `recordFileSnapshot` / `parseSeenLinesFromHashlineBody` / `recordSeenLines`.

## Implementation State (2026-07-11)

Landed in the `seen-lines-anchoring-rfc` worktree (not yet on `main`). The clean
cutover is complete: `SourceLineAnchor` is `{ line, text }`, `SourceSnapshot`
carries `seenLines`, intents are line-numbered (`replace_lines` /
`insert_before_line` / `insert_after_line` / `delete_lines`), `source_read` emits
`NN:text`, and reveal-on-reject with the complete-only merge is in place. The three
programmatic callers were migrated (`lsp`/`worker-results` full-file replaces
default to all-lines-seen; `grep` marks only shown match lines). An adversarial
review found no seen-proof holes; its one P2 — a reveal-merged plan flipping to
`unseen_lines` on apply after a restart, because replay re-ran the ephemeral
seen-check — is fixed by a `trustSeen` flag that skips the seen-gate when replaying
a tape-attested `prepared` plan (file-state re-checks still run), with a regression
test.

A second review round hardened two gaps the first missed. (1) The anti-piecewise
property was only per-message: the per-reveal cap bounded one reveal, but the
merged lines were written to a per-snapshot seen set that persisted across
prepares, so a model could walk a wide blind region in `<=`cap complete slices and
never re-read. Fixed by the **cumulative reveal-merge budget** — a snapshot merges
at most `SEEN_LINE_REVEAL_CAP` lines total via reveal across all prepares
(`seen.size - seenLines.length`), then stops, forcing the re-read. This makes the
guarantee per-snapshot, matching the claim; it is a strengthening past oh-my-pi,
which bounds only the single reveal. (2) A pre-existing hazard the seen-gate had
masked: a multi-line replace/delete relocated its two endpoints independently and
spliced `min..max`, so a drift that reordered or interior-inserted between the
endpoints would rewrite current lines the gate never vetted. Fixed by the
**`range_relocation_conflict`** guard — recovery fails closed unless the relocated
span keeps its length (`last - first === span.end - span.start`), leaving legitimate
whole-range shifts (leading-insertion recovery) untouched. Both have unit tests
proven to fail on the pre-fix commit.

`bun run check` and the unit / contract / system / fitness suites are green.
Remaining before promotion: the git-revision A/B economy benchmark.

## Validation Signals

Three existing tests locked the old format and were rewritten for the new scheme
(not deleted — the invariants they assert survive, the surface changed):

- `test/contract/tools/tools-source-patch.contract.test.ts` — pins the read
  output regex `L1@[A-Za-z0-9_-]{6}\|...` and the manual token/hash derivation;
  becomes an `NN:<text>` assertion, keeping the prepare->apply sole-mutation,
  rollback, preview-fidelity, BOM, generated-file-rejection, and
  conflict-no-partial cases unchanged.
- `test/contract/runtime/source-patch-protocol.contract.test.ts` — `satisfies`
  the anchor/snapshot/plan structs and the five event literals; updated for the
  `{ line, text }` anchor, the `seenLines` field, and the line-based intent kinds,
  with the event literals unchanged.
- `test/unit/tools/source-patch-anchor.property.test.ts` — the stale-recovery
  invariant; kept as-is in behavior (unique-`text` relocation across an unrelated
  insertion), re-expressed with line-number intents.

New coverage landed as `test/unit/tools/source-patch-seen-lines.unit.test.ts`:
unseen-line rejection with reveal, complete-reveal-then-retry, the
column-truncated and past-cap single-reveal non-merge cases, out-of-range
fail-closed, the **cumulative reveal-merge budget** (a wide blind region walked in
`<=`cap slices across separate prepares stays rejected once the budget is spent —
the real anti-piecewise case), and the **`range_relocation_conflict`** guard (a
drift that relocates a range's endpoints inconsistently fails closed instead of
clobbering the interior) — no weak matchers. The `trustSeen` replay fix has a
contract regression test (a `prepared` plan editing a line outside persisted
`seenLines` applies via tape replay). The real promotion signal remains the
headless A/B benchmark, not a static assertion — the token-economy and
edit-success deltas cannot be unit-asserted.

## Promotion Criteria And Destination

Promote to `docs/research/decisions/` when:

- the clean cutover lands (no toggle — Option A), the three contract/property
  tests are rewritten green, and the reveal-merge rule (including the cumulative
  budget) has its own test;
  - gate: `bun test test/contract/tools/tools-source-patch.contract.test.ts`
  - gate: `bun test test/contract/runtime/source-patch-protocol.contract.test.ts`
  - gate: `bun test test/unit/tools/source-patch-anchor.property.test.ts`
- the git-revision A/B benchmark shows a token reduction and a non-regressing edit
  success rate on both a weak and a strong model (recorded as the calibration
  evidence, per the account-then-calibrate discipline).

The cutover itself lands in one change (no toggle, no coexistence); promotion to a
decision record is gated only on the measured evidence above. Destination contract:
the `source-patch.ts` anchor economy and the `types/source-patch.ts` snapshot payload.

## Surface Budget

A clean cutover with zero authored surface. It replaces a model-facing wire format
1:1, and the persisted snapshot payload gets _lighter_ net: `seenLines` is added
(one small integer array per read), while each anchor loses its `token` and 64-hex
`hash` — a large per-line reduction on the `source_snapshot_recorded` event.

- required authored fields: 0 -> 0
- optional authored fields: 0 -> 0 (no config key — the clean cutover needs none)
- author-facing concepts: 0 -> 0 (operators never author anchors; the format is
  model-facing and self-teaching)
- inspect surfaces: 0 -> 0 (no new tape event; `seenLines` is an additive field on
  the existing `source_snapshot_recorded` payload, whose per-anchor mass shrinks)
- routing/control-plane decision points: 0 -> 0 (the single apply gate is
  unchanged; drift/seen resolution is tool-internal, not a new control plane)

The net end state is a _smaller_ model-facing wire (plain line numbers replacing
per-line tokens on both read and prepare) **and** a smaller durable snapshot event,
at zero authored surface.

## Open Questions

The three original design questions resolved on contact with the code and are
recorded closed: recovery stays brewva's per-line unique-`text` relocation (no
3-way merge); the reveal merge is in-session only (no re-persist); and there is no
whole-file tag to size (`snapshot_id` + `contentHash` already carry identity).

What remains genuinely open:

- Reveal caps: oh-my-pi uses 40 lines / 512 columns. brewva reads are already
  capped at `MAX_SOURCE_READ_LINES` (400); the reveal cap should sit well below a
  full re-read so reveal never substitutes for reading. 40 is a reasonable start;
  the benchmark can tune it. The same constant now doubles as the per-snapshot
  cumulative reveal-merge budget (see Invariants); if the benchmark splits them, the
  budget is the one that must stay well below a full re-read.
- Seen granularity in summary mode: which boundary lines a summary read counts as
  seen. Too generous re-opens the blind-edit surface; too strict forces a spans
  re-read before any edit. Start strict (only lines actually printed).
- The economy itself: the git-revision A/B is the real gate and has not yet run.

Under the line `The per-line token pays wire tokens to avoid holding state; keep
the state, drop the token — safety equivalent, economy better, and a reject can
finally reveal.`
