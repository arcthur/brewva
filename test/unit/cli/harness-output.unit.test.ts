import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessManifest } from "@brewva/brewva-vocabulary/harness";
import {
  buildCurrentHarnessCandidateManifest,
  diffHarnessManifestFields,
  formatHarnessCandidatesText,
  formatHarnessComparisonText,
  formatHarnessSnapshotsText,
  loadHarnessCandidateManifestFromPath,
  selectHarnessCompareBaseSnapshot,
} from "../../../packages/brewva-cli/src/operator/harness.js";

describe("harness cli output", () => {
  test("formats snapshots, patrol candidates, and manifest comparisons as stable text", () => {
    const snapshots = formatHarnessSnapshotsText([
      {
        schema: "brewva.harness.trace_snapshot.v1",
        snapshotId: "snapshot-1",
        sessionId: "session-1",
        turn: 2,
        attempt: 1,
        manifestId: "manifest-1",
        eventIds: ["event-1"],
        provider: {
          provider: "faux",
          api: "faux",
          model: "faux-model",
          attempts: 1,
          failures: 0,
          fallbackActive: false,
        },
        context: { usageRatio: null, gateRequired: false },
        cache: { status: null, unexpectedBreak: false, changedFields: [] },
        skills: { selectionId: "skill-selection-1", selectedSkillIds: [], omittedCount: 0 },
        tools: {
          activeToolNames: ["exec"],
          requestedUnknownToolNames: [],
          committed: 0,
          errors: 0,
          inconclusive: 0,
        },
        verification: { weakEvidence: false },
        outcome: { status: "ok" },
        signals: [
          {
            kind: "provider_failure",
            severity: "high",
            reason: "provider_failure:detected",
            eventIds: ["event-1"],
          },
        ],
      },
    ]);
    const patrol = formatHarnessCandidatesText([
      {
        schema: "brewva.harness.pattern_candidate.v1",
        candidateId: "candidate-1",
        kind: "provider_failure",
        sourceSnapshotIds: ["snapshot-1"],
        sourceEventIds: ["event-1"],
        manifestIds: ["manifest-1"],
        occurrenceCount: 1,
        severity: "high",
        confidence: "medium",
        reasons: ["provider_failure:detected"],
        promotionPath: "governed_harness_candidate",
      },
    ]);
    const compare = formatHarnessComparisonText({
      schema: "brewva.harness.eval_report.v1",
      mode: "manifest",
      sourceSessionId: "source-session",
      targetSessionId: "target-session",
      divergeAt: "event-diverge",
      baseManifestId: "manifest-base",
      candidateManifestId: "manifest-candidate",
      changedFields: ["prompt.systemPromptHash"],
      sideEffectPolicy: "no_provider_or_tool_execution",
      metrics: { changedFieldCount: 1, regressions: [] },
      promotion: {
        recommendation: "review_required",
        reason: "manifest_comparison_requires_explicit_governance",
      },
    });

    expect(snapshots).toContain("snapshot=snapshot-1");
    expect(patrol).toContain("kind=provider_failure");
    expect(compare).toContain("sideEffectPolicy=no_provider_or_tool_execution");
  });

  test("compares recorded manifest identity against the current runtime identity", () => {
    const base = buildHarnessManifest({
      sessionId: "source-session",
      turn: 1,
      attempt: 1,
      runtime: {
        configHash: "runtime_config:old",
        runtimeIdentityHash: "runtime_identity:old",
      },
      provider: {
        provider: "faux",
        api: "faux",
        model: "faux-model",
      },
    });
    const candidate = buildCurrentHarnessCandidateManifest({
      baseManifest: base,
      currentRuntime: {
        configHash: "runtime_config:new",
        runtimeIdentityHash: "runtime_identity:new",
      },
    });

    expect(candidate.manifestId).not.toBe(base.manifestId);
    expect(diffHarnessManifestFields(base, candidate)).toEqual([
      "runtime.configHash",
      "runtime.runtimeIdentityHash",
    ]);
  });

  test("loads an external candidate manifest and recomputes its identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brewva-harness-candidate-"));
    const base = buildHarnessManifest({
      sessionId: "source-session",
      turn: 1,
      attempt: 1,
      runtime: {
        configHash: "runtime_config:old",
      },
    });
    writeFileSync(
      join(dir, "candidate.json"),
      JSON.stringify({
        ...base,
        runtime: {
          configHash: "runtime_config:candidate",
        },
      }),
    );

    const candidate = await loadHarnessCandidateManifestFromPath({
      cwd: dir,
      path: "candidate.json",
    });

    expect(candidate.manifestId).not.toBe(base.manifestId);
    expect(diffHarnessManifestFields(base, candidate)).toEqual(["runtime.configHash"]);
  });

  test("selects compare base snapshot by divergence evidence", () => {
    const first = {
      schema: "brewva.harness.trace_snapshot.v1" as const,
      snapshotId: "snapshot-1",
      sessionId: "source-session",
      attempt: 1,
      manifestId: "manifest-1",
      eventIds: ["event-a"],
      provider: { attempts: 1, failures: 0, fallbackActive: false },
      context: { usageRatio: null, gateRequired: false },
      cache: { status: null, unexpectedBreak: false, changedFields: [] },
      skills: { selectionId: null, selectedSkillIds: [], omittedCount: 0 },
      tools: {
        activeToolNames: [],
        requestedUnknownToolNames: [],
        committed: 0,
        errors: 0,
        inconclusive: 0,
      },
      verification: { weakEvidence: false },
      outcome: { status: null },
      signals: [],
    };
    const second = {
      ...first,
      snapshotId: "snapshot-2",
      manifestId: "manifest-2",
      eventIds: ["event-b"],
    };

    expect(selectHarnessCompareBaseSnapshot([first, second], "event-b")).toMatchObject({
      status: "selected",
      snapshot: { snapshotId: "snapshot-2" },
    });
    expect(selectHarnessCompareBaseSnapshot([first, second], "event-missing")).toMatchObject({
      status: "error",
    });
  });
});
