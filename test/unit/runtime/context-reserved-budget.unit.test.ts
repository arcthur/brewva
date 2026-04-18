import { describe, expect, test } from "bun:test";
import {
  HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
  resolveReservedBudgetFromRatio,
} from "../../../packages/brewva-runtime/src/context/reserved-budget.js";

describe("context reserved budget helpers", () => {
  test("exports the canonical history-view baseline reserved budget ratio", () => {
    expect(HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO).toBe(0.3);
  });

  test("returns null when no ratio is provided", () => {
    expect(resolveReservedBudgetFromRatio(undefined, 200)).toBeNull();
  });

  test("clamps empty or negative budgets to zero", () => {
    expect(resolveReservedBudgetFromRatio(0.3, 0)).toBe(0);
    expect(resolveReservedBudgetFromRatio(0.3, -42)).toBe(0);
  });

  test("reserves at least one token for positive budgets", () => {
    expect(resolveReservedBudgetFromRatio(0.01, 20)).toBe(1);
  });

  test("uses the floored product for positive budgets", () => {
    expect(resolveReservedBudgetFromRatio(0.3, 200)).toBe(60);
    expect(resolveReservedBudgetFromRatio(0.3, 201.9)).toBe(60);
  });
});
