import { expect } from "bun:test";
import { buildRcrReference } from "@brewva/brewva-vocabulary/rcr";
import {
  ATTENTION_PIN_RETENTION_HINT,
  isAttentionPinnedWorkbenchEntry,
} from "@brewva/brewva-vocabulary/workbench";
import fc from "fast-check";
import { selectStaleAwareWorkbenchEntries } from "../../../packages/brewva-gateway/src/hosted/internal/context/workbench-staleness.js";
import { propertyTest } from "../../helpers/property.js";

interface EntrySpec {
  readonly id: string;
  readonly retentionHint?: string;
  readonly broken: boolean;
}

const entryArbitrary: fc.Arbitrary<Omit<EntrySpec, "id">> = fc.record({
  retentionHint: fc.option(
    fc.oneof(
      fc.constant(ATTENTION_PIN_RETENTION_HINT),
      fc.constant("session"),
      fc.string({ minLength: 1, maxLength: 16 }),
    ),
    { nil: undefined },
  ),
  broken: fc.boolean(),
});

// RFC R2a survival property: whatever the entry mix, cap, and staleness verdicts,
// the render/compaction candidate selection never drops an `attention_pin` entry,
// never invents entries, and keeps the original order.
propertyTest("attention_pin entries always survive stale-aware selection", {
  propertyId: "workbench.retention.attention-pin-survival",
  layer: "unit",
  arbitraries: [
    fc.array(entryArbitrary, { minLength: 0, maxLength: 24 }),
    fc.integer({ min: 0, max: 12 }),
  ],
  predicate: (specs, max) => {
    const entries = specs.map((spec, index) => ({
      id: `entry-${index}`,
      ...(spec.retentionHint === undefined ? {} : { retentionHint: spec.retentionHint }),
      ...(spec.broken
        ? {
            rcr: [
              buildRcrReference({
                eventRef: { sessionId: "s", eventId: `missing-${index}` },
                contentPath: "content",
                content: "gone",
              }),
            ],
          }
        : {}),
    }));
    const selected = selectStaleAwareWorkbenchEntries(entries, () => undefined, max);
    const selectedIds = selected.map((item) => item.entry.id);

    const pinnedIds = entries
      .filter((entry) => isAttentionPinnedWorkbenchEntry(entry))
      .map((entry) => entry.id);
    for (const id of pinnedIds) {
      expect(selectedIds).toContain(id);
    }

    // The other half of the contract: pins consume the budget first, and the
    // unpinned remainder never exceeds what is left of `max`.
    expect(selectedIds.length).toBeLessThanOrEqual(Math.max(max, pinnedIds.length));
    const unpinnedSelected = selectedIds.filter((id) => !pinnedIds.includes(id)).length;
    const unpinnedTotal = entries.length - pinnedIds.length;
    const expectedUnpinned =
      entries.length <= max
        ? unpinnedTotal
        : Math.min(unpinnedTotal, Math.max(0, max - pinnedIds.length));
    expect(unpinnedSelected).toBe(expectedUnpinned);

    const knownIds = new Set(entries.map((entry) => entry.id));
    for (const id of selectedIds) {
      expect(knownIds.has(id)).toBe(true);
    }
    expect(new Set(selectedIds).size).toBe(selectedIds.length);

    const orderIndex = new Map(entries.map((entry, index) => [entry.id, index]));
    const positions = selectedIds.map((id) => orderIndex.get(id) ?? -1);
    expect([...positions].toSorted((left, right) => left - right)).toEqual(positions);
  },
});
