import { describe, expect, test } from "bun:test";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  ATTENTION_METRIC_EVENT_TYPE,
  buildCompactionInputProvenance,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/compaction-input-provenance.js";
import { createHostedCompactionController } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-context-telemetry.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

describe("compaction input provenance", () => {
  test("collects only active context artifacts without hidden recall search", () => {
    const provenance = buildCompactionInputProvenance({
      workbenchEntries: [
        {
          id: "workbench-1",
          digest: "digest-1",
          reason: "important context",
          sourceRefs: ["precedent:docs/solutions/runtime.md"],
        },
      ],
      skillSelection: {
        selectionId: "skill-selection-1",
        skillInvocationRecords: [
          {
            invocationId: "skill-selection-1:architecture",
            skillName: "architecture",
            category: "core",
            sourcePath: "/skills/architecture/SKILL.md",
            sourcePackage: null,
            selectionTrigger: "explicit_command",
            invocationMode: "prompt_visible",
            resourceRefs: [{ kind: "reference", path: "references/design.md" }],
            estimatedTokens: 24,
            tokenEncoding: "o200k_base",
            tokenEstimateMethod: "gpt_bpe_approximation",
            tokenEstimateApproximation: true,
            capabilityRefs: [],
            requestedOutputArtifacts: ["design_report"],
            argumentHints: [],
          },
        ],
      },
      capabilitySelection: {
        selectionId: "capability-selection-1",
        selectedCapabilities: ["shell.exec"],
      },
      recallEvents: [
        {
          type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
          payload: {
            results: [
              {
                stableId: "precedent:docs/solutions/runtime.md",
                sourceFamily: "repository_precedent",
                sessionScope: "cross_workspace",
                rootRef: "/repo",
              },
            ],
          },
        },
      ],
      compactBaseline: {
        compactId: "compact-previous",
        summaryDigest: "summary-digest",
      },
      recallTokenBudget: 1200,
    });

    expect(provenance).toEqual({
      schema: "brewva.compaction.input-provenance.v1",
      hiddenRecallSearch: false,
      activeWorkbenchEntryIds: ["workbench-1"],
      selectedSkillInvocationIds: ["skill-selection-1:architecture"],
      surfacedResourceRefs: [{ kind: "reference", path: "references/design.md" }],
      capabilityReceiptRefs: ["capability-selection-1"],
      recallResultRefs: [
        {
          stableId: "precedent:docs/solutions/runtime.md",
          sourceFamily: "repository_precedent",
          sessionScope: "cross_workspace",
          rootRef: "/repo",
        },
      ],
      compactBaseline: {
        compactId: "compact-previous",
        summaryDigest: "summary-digest",
      },
      usedRecallSelection: {
        maxResults: 3,
        selectedStableIds: ["precedent:docs/solutions/runtime.md"],
      },
      attention: {
        generationIds: [],
        consumedRefs: [],
        pinnedRefs: [],
        ignoredRefs: [],
        verifyPlanRefs: [],
      },
    });
  });

  test("keeps used recall refs bounded by latest usage instead of preserving every surfaced result", () => {
    const provenance = buildCompactionInputProvenance({
      workbenchEntries: [
        {
          id: "workbench-missing-provenance",
          digest: "digest-missing-provenance",
          reason: "manual note",
          sourceRefs: ["precedent:docs/solutions/missing-provenance.md"],
        },
      ],
      skillSelection: undefined,
      capabilitySelection: undefined,
      recallEvents: [
        {
          type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
          payload: {
            results: [
              {
                stableId: "precedent:docs/solutions/old.md",
                sourceFamily: "repository_precedent",
                sessionScope: "cross_workspace",
                rootRef: "/repo",
              },
              {
                stableId: "precedent:docs/solutions/latest.md",
                sourceFamily: "repository_precedent",
                sessionScope: "cross_workspace",
                rootRef: "/repo",
              },
              {
                stableId: "precedent:docs/solutions/unused.md",
                sourceFamily: "repository_precedent",
                sessionScope: "cross_workspace",
                rootRef: "/repo",
              },
              {
                stableId: "precedent:docs/solutions/global.md",
                sourceFamily: "global_memory",
                sessionScope: "cross_workspace",
                rootRef: "/repo",
              },
            ],
          },
        },
      ],
      usageEvents: [
        {
          type: "tool.invocation.started",
          payload: { result: { stableId: "precedent:docs/solutions/old.md" } },
        },
        {
          type: "tool.result.recorded",
          payload: { sourceRefs: ["precedent:docs/solutions/old.md"] },
        },
        {
          type: "tool.result.recorded",
          payload: {
            content: "false positive precedent:docs/solutions/unused.md",
            sourceRefs: ["precedent:docs/solutions/latest.md"],
          },
        },
        {
          type: "recall.curation.recorded",
          payload: { stableIds: ["precedent:docs/solutions/unused.md"] },
        },
      ],
      compactBaseline: null,
      recallTokenBudget: 400,
    });

    expect(provenance.recallResultRefs).toEqual([
      {
        stableId: "precedent:docs/solutions/latest.md",
        sourceFamily: "repository_precedent",
        sessionScope: "cross_workspace",
        rootRef: "/repo",
      },
    ]);
    expect(provenance.usedRecallSelection).toEqual({
      maxResults: 1,
      selectedStableIds: ["precedent:docs/solutions/latest.md"],
    });
    expect(provenance.attention).toEqual({
      generationIds: [],
      consumedRefs: [],
      pinnedRefs: [],
      ignoredRefs: [],
      verifyPlanRefs: [],
    });
  });

  test("records attention consumed, pinned, and ignored refs as compaction provenance", () => {
    const provenance = buildCompactionInputProvenance({
      workbenchEntries: [
        {
          id: "attention-pin-1",
          digest: "digest-attention-pin",
          reason: "attention_pin",
          sourceRefs: ["skill:runtime-orientation"],
          retentionHint: "attention_pin",
        },
      ],
      skillSelection: undefined,
      capabilitySelection: undefined,
      recallEvents: [],
      attentionEvents: [
        {
          type: ATTENTION_METRIC_EVENT_TYPE,
          payload: {
            metricKey: "attention.consume",
            optionId: "skill:runtime-orientation",
          },
        },
        {
          type: ATTENTION_METRIC_EVENT_TYPE,
          payload: {
            metricKey: "attention.ignore",
            evidenceRefs: ["precedent:docs/solutions/stale.md"],
          },
        },
        {
          type: ATTENTION_METRIC_EVENT_TYPE,
          payload: {
            metricKey: "attention.verify_plan",
            optionId: "skill:runtime-orientation",
          },
        },
      ],
      compactBaseline: null,
      recallTokenBudget: 400,
    });

    expect(provenance.attention).toEqual({
      generationIds: [],
      consumedRefs: ["skill:runtime-orientation"],
      pinnedRefs: ["skill:runtime-orientation"],
      ignoredRefs: ["precedent:docs/solutions/stale.md"],
      verifyPlanRefs: ["skill:runtime-orientation"],
    });
  });

  test("attaches active-set provenance to committed session compaction receipts", async () => {
    const runtime = createRuntimeInstanceFixture();
    const sessionId = "compact-provenance-session";
    const controller = createHostedCompactionController(
      runtime,
      createHostedContextTelemetry(runtime),
    );
    runtime.ops.workbench.note(sessionId, {
      content: "Keep the design note.",
      sourceRefs: ["precedent:docs/solutions/runtime.md"],
      reason: "operator_pin",
    });
    runtime.ops.skills.selection.record(sessionId, {
      selectionId: "skill-selection-1",
      skillInvocationRecords: [
        {
          invocationId: "skill-selection-1:architecture",
          skillName: "architecture",
          category: "core",
          sourcePath: "/skills/architecture/SKILL.md",
          sourcePackage: null,
          selectionTrigger: "explicit_command",
          invocationMode: "prompt_visible",
          resourceRefs: [{ kind: "reference", path: "references/design.md" }],
          estimatedTokens: 24,
          tokenEncoding: "o200k_base",
          tokenEstimateMethod: "gpt_bpe_approximation",
          tokenEstimateApproximation: true,
          capabilityRefs: [],
          requestedOutputArtifacts: ["design_report"],
          argumentHints: [],
        },
      ],
    });
    runtime.ops.tools.capabilitySelection.record(sessionId, {
      selectionId: "capability-selection-1",
    });
    runtime.ops.tools.recall.resultsSurfaced({
      sessionId,
      payload: {
        results: [
          {
            stableId: "precedent:docs/solutions/runtime.md",
            sourceFamily: "repository_precedent",
            sessionScope: "cross_workspace",
            rootRef: runtime.identity.workspaceRoot,
          },
        ],
      },
    });

    await controller.sessionCompact({
      sessionId,
      compactionEntry: {
        id: "compact-1",
        summary: "summary",
        firstKeptEntryId: "entry-1",
      },
      usage: { tokens: 800, contextWindow: 2_000, percent: null },
    });

    const committed = runtime.ops.events.records
      .query(sessionId, { type: "session.compaction.committed" })
      .at(-1)?.payload;

    expect(committed).toMatchObject({
      compactId: "compact-1",
      inputProvenance: {
        schema: "brewva.compaction.input-provenance.v1",
        hiddenRecallSearch: false,
        selectedSkillInvocationIds: ["skill-selection-1:architecture"],
        surfacedResourceRefs: [{ kind: "reference", path: "references/design.md" }],
        capabilityReceiptRefs: ["capability-selection-1"],
        recallResultRefs: [
          {
            stableId: "precedent:docs/solutions/runtime.md",
            sourceFamily: "repository_precedent",
            sessionScope: "cross_workspace",
            rootRef: runtime.identity.workspaceRoot,
          },
        ],
      },
    });
  });
});
