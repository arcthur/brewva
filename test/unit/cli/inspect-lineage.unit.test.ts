import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  SUBAGENT_COMPLETED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  buildContextCockpitReport,
  buildInspectReport,
  buildTaskWorkCardProjection,
  formatInspectDiagnosticText,
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
    const text = formatInspectDiagnosticText(report);
    const workCardText = formatInspectText(report);

    expect(text).toContain("Lineage: root=lineage:main current=lineage:review nodes=2 edges=1");
    expect(text).toContain("Lineage: selected=cli:lineage:review");
    expect(workCardText).toContain("Work Card: schema=brewva.task-work-card.projection.v1");
    expect(workCardText).not.toContain("Lineage: root=");
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
    const text = formatInspectDiagnosticText(report);
    const workCard = buildTaskWorkCardProjection(report);
    const workCardText = formatInspectText(report);
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
    expect(workCard.schema).toBe("brewva.task-work-card.projection.v1");
    expect(workCard.context.workbenchEntryCount).toBe(1);
    expect(workCard.context.skillInvocationRefs).toEqual(["skill-selection-1:architecture"]);
    expect(workCard.context.recallResultRefs).toEqual(["precedent:docs/solutions/runtime.md"]);
    expect(workCardText).toContain("Context: pressure=");
    expect(workCardText).toContain("workbench=1");
    expect(workCardText).toContain("skills=1");
    expect(workCardText).toContain("recall=1");
    expect(text).toContain("Context cockpit: policy=inspect_projection_only");
    expect(text).toContain("Context cockpit skills: invocations=architecture");
    expect(text).toContain("Context cockpit resources: refs=reference:references/design.md");
    expect(text).toContain("Context cockpit capabilities: receipts=capability-selection-1");
    expect(text).toContain("Context cockpit recall: results=precedent:docs/solutions/runtime.md");
    expect(text).toContain(
      "Context cockpit compaction: baseline=compact-1 provenance=brewva.compaction.input-provenance.v1:hiddenRecallSearch=false:attention=0/0/0/0",
    );
    expect(text).toContain("Context cockpit cache: status=warm read=42 write=0");
  });

  test("prints delegation workboard, timeline, and recovery preview", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-delegation-")),
    });
    const sessionId = "inspect-delegation-session";
    runtime.ops.delegation.lifecycle.completed({
      sessionId,
      timestamp: 1_000,
      payload: {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        runId: "worker-inspect-1",
        agent: "worker",
        targetName: "worker",
        delegate: "worker",
        taskName: "Implement inspect",
        taskPath: "/inspect",
        nickname: "Implement inspect",
        depth: 1,
        forkTurns: "none",
        gateReason: "implement_isolated",
        modelCategory: "isolated-execution",
        executionPrimitive: "named",
        visibility: "public",
        isolationStrategy: "snapshot",
        adoption: { decision: "patch_apply" },
        status: "completed",
        lifecycleReason: "none",
        retention: "live",
        createdAt: 900,
        updatedAt: 1_000,
        kind: "patch",
        summary: "Worker produced a patch.",
      },
      type: SUBAGENT_COMPLETED_EVENT_TYPE,
    });

    const text = formatInspectDiagnosticText(buildInspectReport(runtime, sessionId));

    expect(text).toContain("Delegation workboard: workerPatches=1");
    expect(text).toContain(
      "Delegation run: worker worker-inspect-1 lifecycle=completed disposition=pending_apply",
    );
    expect(text).toContain("Delegation timeline: groups=1");
    expect(text).toContain("Recovery preview: nextReceiptOwner=parent");
  });

  test("summarizes operator safety decisions without unrelated receipt ids", async () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-safety-")),
    });
    const sessionId = "inspect-safety-session";
    const unrelated = runtime.ops.task.items.add(sessionId, {
      id: "task-unrelated",
      text: "unrelated task event",
      timestamp: 1,
    });
    expect(unrelated.ok).toBe(true);
    if (!unrelated.ok) {
      throw new Error("expected_unrelated_task_item");
    }

    await runtime.runtime.kernel.beginToolCall({
      sessionId,
      toolCallId: "call-read",
      toolName: "read",
      args: { path: "README.md" },
    });
    const deferred = await runtime.runtime.kernel.beginToolCall({
      sessionId,
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
    });
    expect(deferred).toMatchObject({
      kind: "defer",
      request: { id: "approval:inspect-safety-session:call-exec" },
    });
    runtime.ops.proposals.requests.decide(sessionId, "approval:inspect-safety-session:call-exec", {
      decision: "cancel",
      actor: "arthur",
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.operatorSafety.pendingAsks).toBe(0);
    expect(report.operatorSafety.recentDecisions).toMatchObject([
      {
        decision: "allow",
        toolName: "read",
        actionClass: "workspace_read",
        requestId: null,
      },
      {
        decision: "ask",
        toolName: "exec",
        actionClass: "local_exec_effectful",
        requestId: "approval:inspect-safety-session:call-exec",
      },
      {
        decision: "deny",
        toolName: "exec",
        actionClass: "local_exec_effectful",
        requestId: "approval:inspect-safety-session:call-exec",
        reason: "approval_cancelled",
      },
    ]);
    expect(report.operatorSafety.receiptIds).toHaveLength(3);
    expect(report.operatorSafety.receiptIds).not.toContain(unrelated.itemId);
  });

  test("projects latest handoff anchor into the default work card", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-handoff-")),
    });
    const sessionId = "inspect-handoff-session";
    const handoff = runtime.ops.tape.handoff.record(sessionId, {
      name: "Implementation handoff",
      summary: "Work card cutover is ready for follow-up.",
      nextSteps: "Run focused inspect tests.",
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) {
      throw new Error("expected_handoff_recorded");
    }
    const anchorId = handoff.eventId;
    if (!anchorId) {
      throw new Error("expected_handoff_anchor_id");
    }

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);
    const text = formatInspectText(report);

    expect(workCard.handoff.anchorId).toBe(anchorId);
    expect(workCard.handoff.name).toBe("Implementation handoff");
    expect(workCard.handoff.summary).toBe("Work card cutover is ready for follow-up.");
    expect(workCard.handoff.nextSteps).toBe("Run focused inspect tests.");
    expect(text).toContain(`Handoff: anchor=${anchorId}`);
    expect(text).toContain("summary=Work card cutover is ready for follow-up.");
  });
});
