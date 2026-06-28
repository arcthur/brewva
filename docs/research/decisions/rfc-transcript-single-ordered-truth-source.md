# Decision: Transcript As A Single Ordered Truth Source

## Metadata

- Decision: The CLI live transcript is projected from one ordered truth source — wire-fold's `snapshot.transcriptMessages` — so `refreshFromWireFold` degrades from per-message-type splicing to `replaceMessages(snapshot)` plus a CLI-only rewind overlay, and custom messages enter that snapshot as a gateway-origin `custom.message` wire frame.
- Date: `2026-06-28`
- Status: accepted
- Stable docs:
  - `docs/reference/working-projection.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/wire.ts`
  - `packages/brewva-cli/src/shell/domain/cockpit/wire-fold.ts`
  - `packages/brewva-cli/src/shell/projectors/transcript-projector.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-adapter.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn/session-mux/runtime-frame-projection.ts`

## Decision Summary

- Wire-fold owns all turn-scoped ordering. `refreshFromWireFold` is a wholesale `replaceMessages([...snapshot.transcriptMessages, ...rewindMarker])`; the two-segment `[non-wire] + [wire]` concatenation and its false "non-wire precedes wire" invariant are deleted.
- Custom messages become a `custom.message` `SessionWireFrame` emitted at the gateway origin from `runHostedRuntimeTurnAdapter` right after the prelude returns ready, the single seam both the legacy `session.prompt` and wireFold flows funnel through. The CLI-edge `message_end` alternative was rejected for keeping custom on two streams with a `turn.input` arrival-order race.
- The frame is display-only: it never carries provider-context payload, custom keeps `excludeFromContext: true`, and the durable `custom_message` entry plus seed rebuild stay the persistence authority.
- Free-floating messages are pure optimistic placeholders (user on submit) reconciled by wholesale replacement; the retired projector patches `#customTurnIdById`, `snapshotProvidesUser`, the interleave loop, `currentWireTurnId`, and `#fallbackEntrySequence` are removed, not replaced.
- A malformed or turn-less `custom.message` frame fails closed: the row is omitted from the ordered snapshot rather than hoisted to an arbitrary position, so no unrelated turn is silently reordered.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- Obeys `Subtraction beats switches` (axiom 3): collapsing onto one source is a net deletion of per-type splicing, not a new branch per injected message kind.
- Obeys `Product loops are projections, not runtime state machines` (axiom 12): the transcript is a rebuildable view over the ordered wire-frame stream and never becomes replay or storage truth.
- Obeys `Graceful degradation beats hidden cleverness` (axiom 8): an unorderable custom frame is omitted and the optimistic placeholder remains, instead of a silent reorder.

## Open follow-ups

- Real-TUI dogfood of custom display timing (several turns with skill triggers and a rewind, confirming order and that instant feedback never flickers position) is the one remaining human-in-loop check; both automated gates (`bun run check` + full `bun test`) are green.
