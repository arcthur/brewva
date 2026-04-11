import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATCH_RECORDED_EVENT_TYPE,
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { buildReadPathDiscoveryObservationPayload } from "../../../packages/brewva-tools/src/read-path-discovery.js";
import {
  attachSearchIntentPreviewCandidates,
  buildDelimiterInsensitivePattern,
  buildSearchAdvisorSnapshot,
  registerSearchIntent,
  resetSearchAdvisorStateForTests,
} from "../../../packages/brewva-tools/src/search-advisor.js";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";

describe("SearchAdvisor", () => {
  test("builds one delimiter-insensitive regex pattern for fallback retries", () => {
    expect(buildDelimiterInsensitivePattern("brewva-runtime")).toBe(
      "b[-_./:\\s]*r[-_./:\\s]*e[-_./:\\s]*w[-_./:\\s]*v[-_./:\\s]*a[-_./:\\s]*r[-_./:\\s]*u[-_./:\\s]*n[-_./:\\s]*t[-_./:\\s]*i[-_./:\\s]*m[-_./:\\s]*e",
    );
    expect(buildDelimiterInsensitivePattern("ab")).toBeNull();
  });

  test("does not confirm query combos from unrelated non-preview reads", () => {
    resetSearchAdvisorStateForTests();
    const workspace = mkdtempSync(join(tmpdir(), "brewva-search-advisor-unrelated-"));
    const runtime = createRuntimeFixture();
    const bundledRuntime = createBundledToolRuntime(runtime);
    const sessionId = "advisor-unrelated-session";
    const baseNow = 1_000_000;

    registerSearchIntent({
      runtime: bundledRuntime,
      sessionId,
      toolName: "grep",
      query: "config",
      requestedPaths: ["src"],
      now: baseNow,
    });
    attachSearchIntentPreviewCandidates({
      sessionId,
      toolName: "grep",
      query: "config",
      candidatePaths: ["src/defaults.ts"],
      now: baseNow + 10,
    });

    const unrelatedPayload = buildReadPathDiscoveryObservationPayload({
      baseCwd: workspace,
      toolName: "read_spans",
      evidenceKind: "direct_file_access",
      observedPaths: ["unrelated/elsewhere.ts"],
    });
    bundledRuntime.internal?.recordEvent?.({
      sessionId,
      type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
      timestamp: baseNow + 20,
      payload: unrelatedPayload ?? undefined,
    });

    const snapshot = buildSearchAdvisorSnapshot({
      runtime: bundledRuntime,
      sessionId,
      now: baseNow + 30,
    });
    expect(
      snapshot.getComboMatch({
        toolName: "grep",
        query: "config",
      }),
    ).toBeUndefined();
    expect(
      snapshot.scoreFile({
        toolName: "grep",
        query: "config",
        filePath: "unrelated/elsewhere.ts",
      }).comboBias,
    ).toBe(0);
  });

  test("ignores search-origin observations for combo memory and promotes confirmed follow-through", () => {
    resetSearchAdvisorStateForTests();
    const workspace = mkdtempSync(join(tmpdir(), "brewva-search-advisor-"));
    const runtime = createRuntimeFixture();
    const bundledRuntime = createBundledToolRuntime(runtime);
    const sessionId = "advisor-combo-session";
    const baseNow = Date.now();

    registerSearchIntent({
      runtime: bundledRuntime,
      sessionId,
      toolName: "grep",
      query: "config",
      requestedPaths: ["src"],
      now: baseNow,
    });
    attachSearchIntentPreviewCandidates({
      sessionId,
      toolName: "grep",
      query: "config",
      candidatePaths: ["src/defaults.ts", "src/other.ts"],
      now: baseNow + 10,
    });

    const searchPayload = buildReadPathDiscoveryObservationPayload({
      baseCwd: workspace,
      toolName: "grep",
      evidenceKind: "search_match",
      observedPaths: ["src/defaults.ts"],
    });
    bundledRuntime.internal?.recordEvent?.({
      sessionId,
      type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
      timestamp: baseNow + 20,
      payload: searchPayload ?? undefined,
    });

    const searchOnlySnapshot = buildSearchAdvisorSnapshot({
      runtime: bundledRuntime,
      sessionId,
      now: baseNow + 30,
    });
    expect(
      searchOnlySnapshot.scoreFile({
        toolName: "grep",
        query: "config",
        filePath: "src/defaults.ts",
      }).comboBias,
    ).toBe(0);

    for (let index = 0; index < 3; index += 1) {
      const issuedAt = baseNow + 6_000 + index * 6_000;
      registerSearchIntent({
        runtime: bundledRuntime,
        sessionId,
        toolName: "grep",
        query: "config",
        requestedPaths: ["src"],
        now: issuedAt,
      });
      attachSearchIntentPreviewCandidates({
        sessionId,
        toolName: "grep",
        query: "config",
        candidatePaths: ["src/defaults.ts", "src/other.ts"],
        now: issuedAt + 10,
      });

      const followthroughPayload = buildReadPathDiscoveryObservationPayload({
        baseCwd: workspace,
        toolName: "read_spans",
        evidenceKind: "direct_file_access",
        observedPaths: ["src/defaults.ts"],
      });
      bundledRuntime.internal?.recordEvent?.({
        sessionId,
        type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
        timestamp: issuedAt + 40,
        payload: followthroughPayload ?? undefined,
      });
    }

    const snapshot = buildSearchAdvisorSnapshot({
      runtime: bundledRuntime,
      sessionId,
      now: 10_000,
    });
    const score = snapshot.scoreFile({
      toolName: "grep",
      query: "config",
      filePath: "src/defaults.ts",
    });

    expect(snapshot.signalFiles).toBeGreaterThan(0);
    expect(score.comboHits).toBe(3);
    expect(score.comboThresholdHit).toBe(true);
    expect(score.comboBias).toBeGreaterThan(290);
  });

  test("decays combo ranking strength over time instead of keeping full threshold bias", () => {
    resetSearchAdvisorStateForTests();
    const workspace = mkdtempSync(join(tmpdir(), "brewva-search-advisor-decay-"));
    const runtime = createRuntimeFixture();
    const bundledRuntime = createBundledToolRuntime(runtime);
    const sessionId = "advisor-decay-session";
    const baseNow = 1_000_000;

    for (let index = 0; index < 3; index += 1) {
      const issuedAt = baseNow + index * 6_000;
      registerSearchIntent({
        runtime: bundledRuntime,
        sessionId,
        toolName: "grep",
        query: "config",
        requestedPaths: ["src"],
        now: issuedAt,
      });
      attachSearchIntentPreviewCandidates({
        sessionId,
        toolName: "grep",
        query: "config",
        candidatePaths: ["src/defaults.ts"],
        now: issuedAt + 10,
      });

      const followthroughPayload = buildReadPathDiscoveryObservationPayload({
        baseCwd: workspace,
        toolName: "read_spans",
        evidenceKind: "direct_file_access",
        observedPaths: ["src/defaults.ts"],
      });
      bundledRuntime.internal?.recordEvent?.({
        sessionId,
        type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
        timestamp: issuedAt + 40,
        payload: followthroughPayload ?? undefined,
      });
    }

    const nearSnapshot = buildSearchAdvisorSnapshot({
      runtime: bundledRuntime,
      sessionId,
      now: baseNow + 20_000,
    });
    const farSnapshot = buildSearchAdvisorSnapshot({
      runtime: bundledRuntime,
      sessionId,
      now: baseNow + 3 * 60 * 60 * 1_000,
    });
    const nearScore = nearSnapshot.scoreFile({
      toolName: "grep",
      query: "config",
      filePath: "src/defaults.ts",
    });
    const farScore = farSnapshot.scoreFile({
      toolName: "grep",
      query: "config",
      filePath: "src/defaults.ts",
    });

    expect(nearScore.comboThresholdHit).toBe(true);
    expect(nearScore.comboBias).toBeGreaterThan(200);
    expect(farScore.comboBias).toBeLessThan(10);
    expect(farScore.comboThresholdHit).toBe(true);
  });

  test("folds patch signals and clears all state on session reset across future-dated events", () => {
    resetSearchAdvisorStateForTests();
    const runtime = createRuntimeFixture();
    const bundledRuntime = createBundledToolRuntime(runtime);
    const sessionId = "advisor-clear-session";
    const now = Date.now() + 10_000;

    bundledRuntime.internal?.recordEvent?.({
      sessionId,
      type: PATCH_RECORDED_EVENT_TYPE,
      timestamp: now,
      payload: {
        toolName: "write",
        applyStatus: "applied",
        changes: [{ path: "src/defaults.ts", action: "modify" }],
        failedPaths: [],
      },
    });

    const beforeClear = buildSearchAdvisorSnapshot({
      runtime: bundledRuntime,
      sessionId,
      now: now + 100,
    });
    expect(beforeClear.signalFiles).toBeGreaterThan(0);
    expect(
      beforeClear.scoreFile({
        toolName: "grep",
        query: "defaults",
        filePath: "src/defaults.ts",
      }).pathScore,
    ).toBeGreaterThan(0);

    runtime.maintain.session.clearState(sessionId);

    const afterClear = buildSearchAdvisorSnapshot({
      runtime: bundledRuntime,
      sessionId,
      now: now + 200,
    });
    expect(afterClear.signalFiles).toBe(0);
    expect(
      afterClear.scoreFile({
        toolName: "grep",
        query: "defaults",
        filePath: "src/defaults.ts",
      }).pathScore,
    ).toBe(0);
  });
});
