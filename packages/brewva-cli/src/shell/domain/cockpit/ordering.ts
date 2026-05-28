import type {
  ShellCockpitConsequenceCategory,
  ShellCockpitDecisionItem,
  ShellCockpitEffectLedgerItem,
} from "./types.js";

const LEDGER_CATEGORY_RANK: Record<ShellCockpitConsequenceCategory, number> = {
  answer: 0,
  failed_effect: 1,
  failed_observation: 2,
  active_effect: 3,
  active_observation: 4,
  effect_receipt: 5,
  ordinary_receipt: 6,
  unknown_receipt: 7,
};

const DECISION_KIND_RANK: Record<ShellCockpitDecisionItem["kind"], number> = {
  recovery_confirm: 0,
  approval: 1,
  question: 2,
  cost_gate: 3,
  manual_gate: 4,
  adoption: 5,
};

function compareBySourcePosition(
  left: Pick<ShellCockpitEffectLedgerItem, "ref" | "stateChangedAt">,
  right: Pick<ShellCockpitEffectLedgerItem, "ref" | "stateChangedAt">,
): number {
  if (left.stateChangedAt !== right.stateChangedAt) {
    return left.stateChangedAt - right.stateChangedAt;
  }
  return left.ref.localeCompare(right.ref);
}

export function orderCockpitLedgerItems(
  items: readonly ShellCockpitEffectLedgerItem[],
): ShellCockpitEffectLedgerItem[] {
  return items.toSorted((left, right) => {
    const categoryDelta =
      LEDGER_CATEGORY_RANK[left.consequence] - LEDGER_CATEGORY_RANK[right.consequence];
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    return compareBySourcePosition(left, right);
  });
}

export function orderCockpitDecisionItems(
  items: readonly ShellCockpitDecisionItem[],
): ShellCockpitDecisionItem[] {
  return items.toSorted((left, right) => {
    const kindDelta = DECISION_KIND_RANK[left.kind] - DECISION_KIND_RANK[right.kind];
    if (kindDelta !== 0) {
      return kindDelta;
    }
    if (left.stateChangedAt !== right.stateChangedAt) {
      return left.stateChangedAt - right.stateChangedAt;
    }
    return left.ref.localeCompare(right.ref);
  });
}
