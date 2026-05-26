import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  buildInspectReport,
  buildContextCockpitReport,
  formatInspectText,
} from "../../../packages/brewva-cli/src/operator/inspect.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

describe("cli inspect lineage reporting", () => {
  test("prints lineage topology and selected channels", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-lineage-")),
    });
    const sessionId = "inspect-lineage-session";
    runtime.ops.session.lineage.createNode(sessionId, {
      lineageNodeId: "lineage:main",
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
    });
    runtime.ops.session.lineage.createNode(sessionId, {
      lineageNodeId: "lineage:review",
      parentLineageNodeId: "lineage:main",
      kind: "review",
      forkPoint: { kind: "turn", turnId: "turn-review" },
      title: "Review branch",
    });
    runtime.ops.session.lineage.recordSelection(sessionId, {
      selectionId: "selection-cli",
      channelId: "cli",
      lineageNodeId: "lineage:review",
    });

    const report = buildInspectReport(runtime, sessionId);
    const text = formatInspectText(report);

    expect(text).toContain("Lineage: root=lineage:main current=lineage:review nodes=2 edges=1");
    expect(text).toContain("Lineage: selected=cli:lineage:review");
  });

  test("prints read-only context cockpit without recording events", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-cockpit-")),
    });
    const sessionId = "inspect-context-cockpit-session";
    runtime.ops.workbench.note(sessionId, {
      content: "Keep the active RFC constraints visible.",
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
      selectedCapabilities: ["shell.exec"],
    });
    runtime.ops.tools.recall.resultsSurfaced({
      sessionId,
      type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
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
    runtime.ops.context.evidence.append(sessionId, {
      kind: "prompt_stability",
      turn: 1,
      timestamp: 10,
      payload: {
        scopeKey: `${sessionId}::root`,
        stablePrefixHash: "attention-prefix",
        dynamicTailHash: "attention-tail",
        stablePrefix: true,
        stableTail: true,
      },
    });
    runtime.ops.context.evidence.append(sessionId, {
      kind: "provider_cache_observation",
      payload: {
        status: "warm",
        bucketKey: "openai:gpt-5.4",
        stablePrefixHash: "stable-prefix",
        dynamicTailHash: "dynamic-tail",
        cacheReadTokens: 42,
        cacheWriteTokens: 0,
      },
    });
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "compact-1",
      summaryDigest: "summary-digest",
      inputProvenance: {
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
            rootRef: runtime.identity.workspaceRoot,
          },
        ],
        compactBaseline: null,
        usedRecallSelection: {
          maxResults: 1,
          selectedStableIds: ["precedent:docs/solutions/runtime.md"],
        },
      },
    });

    const beforeEventCount = runtime.ops.events.records.query(sessionId).length;
    const beforeAttentionHash = runtime.ops.context.evidence.latest(
      sessionId,
      "prompt_stability",
    )?.payload;
    const cockpit = buildContextCockpitReport(runtime, sessionId);
    const report = buildInspectReport(runtime, sessionId);
    const text = formatInspectText(report);
    const afterEventCount = runtime.ops.events.records.query(sessionId).length;
    const afterAttentionHash = runtime.ops.context.evidence.latest(
      sessionId,
      "prompt_stability",
    )?.payload;

    expect(afterEventCount).toBe(beforeEventCount);
    expect(afterAttentionHash).toEqual(beforeAttentionHash);
    expect(cockpit.sideEffectPolicy).toBe("inspect_projection_only");
    expect(cockpit.workbench.activeCount).toBe(1);
    expect(cockpit.skills.invocationRecords[0]?.skillName).toBe("architecture");
    expect(cockpit.recall.results[0]?.sourceFamily).toBe("repository_precedent");
    expect(cockpit.cachePosture.status).toBe("warm");
    expect(text).toContain("Context cockpit: policy=inspect_projection_only");
    expect(text).toContain("Context cockpit skills: invocations=architecture");
    expect(text).toContain("Context cockpit resources: refs=reference:references/design.md");
    expect(text).toContain("Context cockpit capabilities: receipts=capability-selection-1");
    expect(text).toContain("Context cockpit recall: results=precedent:docs/solutions/runtime.md");
    expect(text).toContain(
      "Context cockpit compaction: baseline=compact-1 provenance=brewva.compaction.input-provenance.v1:hiddenRecallSearch=false",
    );
    expect(text).toContain("Context cockpit cache: status=warm read=42 write=0");
  });
});
