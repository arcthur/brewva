export const HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO = 0.3;

export function resolveReservedBudgetFromRatio(
  ratio: number | undefined,
  totalTokenBudget: number,
): number | null {
  if (ratio === undefined) {
    return null;
  }
  const total = Math.max(0, Math.floor(totalTokenBudget));
  if (total <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(total * ratio));
}
