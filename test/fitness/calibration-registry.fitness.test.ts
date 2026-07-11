import { describe, expect, test } from "bun:test";
import { CALIBRATION_PARAMETER_REGISTRY, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { FAILURE_RECURRENCE_THRESHOLD } from "../../packages/brewva-gateway/src/hosted/internal/context/failure-recurrence.js";
import { MIN_CONSECUTIVE_MISSING_PATH_FAILURES } from "../../packages/brewva-gateway/src/hosted/internal/context/read-path-recovery.js";
import { MIN_COMPRESSION_GAIN } from "../../packages/brewva-gateway/src/hosted/internal/session/tools/tool-output-distiller.js";
import { STALL_RECENT_TOOL_FAILURES_THRESHOLD } from "../../packages/brewva-gateway/src/hosted/internal/session/watchdog/task-stall-adjudication.js";
import {
  RECALL_TAPE_AGING_MAX_DAYS,
  RECALL_TAPE_FRESH_MAX_DAYS,
} from "../../packages/brewva-recall/src/broker/text.js";
import {
  KNOWLEDGE_AGING_MAX_DAYS,
  KNOWLEDGE_FRESH_MAX_DAYS,
} from "../../packages/brewva-recall/src/knowledge/search.js";
import { RECALL_CURATION_HALFLIFE_DAYS } from "../../packages/brewva-recall/src/types.js";

// Every registry `value` is a literal mirror of a live source. Each of the 12
// parameters is now a NAMED constant (Phase-3 review named the previously inline
// freshness cutoffs and stall threshold, and exported the module-private
// distiller / read-path constants), so every mirror is import-checked here — no
// entry can silently drift from its source.
const budget = DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget;
const LIVE_VALUE_BY_PATH: Record<string, number | readonly number[]> = {
  "infrastructure.contextBudget.thresholds.advisoryRatio": budget.thresholds.advisoryRatio,
  "infrastructure.contextBudget.thresholds.hardRatio": budget.thresholds.hardRatio,
  "infrastructure.contextBudget.predictedTurnGrowthRatio": budget.predictedTurnGrowthRatio,
  "infrastructure.contextBudget.compaction.tailProtectRatio": budget.compaction.tailProtectRatio,
  "infrastructure.contextBudget.dynamicTailTokens": budget.dynamicTailTokens,
  "RECALL_TAPE_FRESH_MAX_DAYS / RECALL_TAPE_AGING_MAX_DAYS": [
    RECALL_TAPE_FRESH_MAX_DAYS,
    RECALL_TAPE_AGING_MAX_DAYS,
  ],
  "KNOWLEDGE_FRESH_MAX_DAYS / KNOWLEDGE_AGING_MAX_DAYS": [
    KNOWLEDGE_FRESH_MAX_DAYS,
    KNOWLEDGE_AGING_MAX_DAYS,
  ],
  RECALL_CURATION_HALFLIFE_DAYS,
  "distiller MIN_COMPRESSION_GAIN": MIN_COMPRESSION_GAIN,
  FAILURE_RECURRENCE_THRESHOLD,
  "read-path-recovery MIN_CONSECUTIVE_MISSING_PATH_FAILURES": MIN_CONSECUTIVE_MISSING_PATH_FAILURES,
  STALL_RECENT_TOOL_FAILURES_THRESHOLD,
};

describe("calibration parameter registry", () => {
  test("every entry is well-formed with a recognized status", () => {
    for (const entry of CALIBRATION_PARAMETER_REGISTRY) {
      expect(entry.path.length).toBeGreaterThan(0);
      expect(entry.source.length).toBeGreaterThan(0);
      expect(entry.evidenceSource.length).toBeGreaterThan(0);
      expect(["asserted", "calibrated", "contested"]).toContain(entry.status);
    }
  });

  test("carries the audit's initial membership with unique paths", () => {
    const paths = CALIBRATION_PARAMETER_REGISTRY.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(CALIBRATION_PARAMETER_REGISTRY.length).toBeGreaterThanOrEqual(12);
  });

  test("every registry parameter is parity-covered — none unguarded", () => {
    const covered = new Set(Object.keys(LIVE_VALUE_BY_PATH));
    const uncovered = CALIBRATION_PARAMETER_REGISTRY.map((entry) => entry.path).filter(
      (path) => !covered.has(path),
    );
    expect(uncovered).toEqual([]);
  });

  test("literal mirrors match their live source (no silent drift)", () => {
    const valueByPath = new Map(
      CALIBRATION_PARAMETER_REGISTRY.map((entry) => [entry.path, entry.value]),
    );
    for (const [path, live] of Object.entries(LIVE_VALUE_BY_PATH)) {
      expect(valueByPath.get(path)).toEqual(live);
    }
  });
});
