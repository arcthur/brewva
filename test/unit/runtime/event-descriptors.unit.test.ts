import { describe, expect, test } from "bun:test";
import {
  asBrewvaToolCallId,
  asBrewvaToolName,
  CURRENT_DELEGATION_CONTRACT_VERSION,
} from "@brewva/brewva-runtime";
import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  readDelegationLifecycleEventPayload,
  readEffectCommitmentApprovalRequestedEventPayload,
  readEffectCommitmentApprovalResolutionEventPayload,
  readEffectCommitmentDecisionReceiptRecordedEventPayload,
  readSkillActivatedEventPayload,
  readSkillCompletedEventPayload,
  readSkillCompletionFailureEventPayload,
  readSessionTurnTransitionEventPayload,
  readSessionUncleanShutdownDiagnosticEventPayload,
  readSessionRewindCompletedEventPayload,
  readTaskStallAdjudicatedEventPayload,
  readTaskStuckDetectedEventPayload,
  readToolCallBlockedEventPayload,
  readToolLifecycleEventPayload,
  readToolOutputDistilledEventPayload,
  readToolResultRecordedEventPayload,
  readReasoningRevertEventPayload,
  REASONING_REVERT_EVENT_TYPE,
  SKILL_ACTIVATED_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SKILL_COMPLETION_REJECTED_EVENT_TYPE,
  readVerificationOutcomeRecordedEventPayload,
  readVerificationWriteMarkedEventPayload,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  readWorkerResultsAppliedEventPayload,
} from "@brewva/brewva-runtime/events";

describe("runtime event descriptors", () => {
  test("reads canonical session turn transition payloads", () => {
    expect(
      readSessionTurnTransitionEventPayload({
        type: SESSION_TURN_TRANSITION_EVENT_TYPE,
        payload: {
          reason: "wal_recovery_resume",
          status: "entered",
          sequence: 3,
          family: "recovery",
          attempt: null,
          sourceEventId: "ev-tool-start-1",
          sourceEventType: "tool_execution_start",
          error: null,
          breakerOpen: false,
          model: "gpt-5.5",
        },
      }),
    ).toEqual({
      reason: "wal_recovery_resume",
      status: "entered",
      sequence: 3,
      family: "recovery",
      attempt: null,
      sourceEventId: "ev-tool-start-1",
      sourceEventType: "tool_execution_start",
      error: null,
      breakerOpen: false,
      model: "gpt-5.5",
    });
  });

  test("rejects malformed session turn transition payloads", () => {
    expect(
      readSessionTurnTransitionEventPayload({
        type: SESSION_TURN_TRANSITION_EVENT_TYPE,
        payload: {
          reason: "wal_recovery_resume",
          status: "entered",
          family: "recovery",
        },
      }),
    ).toBeNull();
  });

  test("reads tool lifecycle payloads from execution events", () => {
    expect(
      readToolLifecycleEventPayload({
        type: TOOL_EXECUTION_END_EVENT_TYPE,
        payload: {
          toolCallId: "tc-1",
          toolName: "read",
          attempt: 2,
          isError: true,
          terminalReason: "failed",
        },
      }),
    ).toEqual({
      toolCallId: "tc-1",
      toolName: "read",
      attempt: 2,
      isError: true,
      terminalReason: "failed",
    });
  });

  test("reads shared tool result recorded payloads", () => {
    expect(
      readToolResultRecordedEventPayload({
        type: TOOL_RESULT_RECORDED_EVENT_TYPE,
        payload: {
          toolName: "exec",
          toolCallId: "tc-1",
          verdict: "fail",
          channelSuccess: false,
          ledgerId: "ledger-1",
          effectCommitmentRequestId: "approval-1",
          failureClass: "execution",
          failureContext: {
            args: {
              command: "cat missing.txt",
            },
            outputText: "No such file or directory",
            failureClass: "execution",
            turn: 7,
          },
          truthProjection: {
            toolName: "exec",
            args: {
              command: "cat missing.txt",
            },
          },
          verificationProjection: {
            schema: "brewva.verification.tool_result_projection.v1",
            checkRun: {
              checkName: "lint",
              run: {
                timestamp: 12,
                ok: false,
                command: "bun run lint",
                exitCode: 1,
                durationMs: 20,
              },
            },
          },
        },
      }),
    ).toEqual({
      toolName: asBrewvaToolName("exec"),
      toolCallId: asBrewvaToolCallId("tc-1"),
      verdict: "fail",
      channelSuccess: false,
      ledgerId: "ledger-1",
      effectCommitmentRequestId: "approval-1",
      outputObservation: null,
      outputArtifact: null,
      outputDistillation: null,
      failureClass: "execution",
      failureContext: {
        args: {
          command: "cat missing.txt",
        },
        outputText: "No such file or directory",
        failureClass: "execution",
        turn: 7,
      },
      truthProjection: {
        toolName: "exec",
        args: {
          command: "cat missing.txt",
        },
      },
      verificationProjection: {
        schema: "brewva.verification.tool_result_projection.v1",
        checkRun: {
          checkName: "lint",
          run: {
            timestamp: 12,
            ok: false,
            command: "bun run lint",
            exitCode: 1,
            durationMs: 20,
          },
        },
      },
    });
  });

  test("reads canonical shared tool output distilled payloads", () => {
    expect(
      readToolOutputDistilledEventPayload({
        type: TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
        payload: {
          toolCallId: "tc-2",
          toolName: "exec",
          isError: false,
          verdict: "pass",
          strategy: "exec_heuristic",
          rawChars: 240,
          rawBytes: 240,
          rawTokens: 80,
          summaryChars: 80,
          summaryBytes: 80,
          summaryTokens: 24,
          compressionRatio: 0.3,
          truncated: true,
          summaryText: "Compiled output summary",
          artifactRef: "artifacts/tool-output.txt",
        },
      }),
    ).toEqual({
      toolCallId: asBrewvaToolCallId("tc-2"),
      toolName: asBrewvaToolName("exec"),
      isError: false,
      verdict: "pass",
      strategy: "exec_heuristic",
      rawChars: 240,
      rawBytes: 240,
      rawTokens: 80,
      summaryChars: 80,
      summaryBytes: 80,
      summaryTokens: 24,
      compressionRatio: 0.3,
      truncated: true,
      summaryText: "Compiled output summary",
      artifactRef: "artifacts/tool-output.txt",
    });
  });

  test("rejects non-canonical tool output distilled payloads", () => {
    expect(
      readToolOutputDistilledEventPayload({
        type: TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
        payload: {
          toolCallId: " tc-2 ",
          toolName: " Exec ",
          isError: false,
          verdict: "pass",
          strategy: " exec_heuristic ",
          rawChars: 240.1,
          rawBytes: 240,
          rawTokens: 80,
          summaryChars: 80,
          summaryBytes: 80,
          summaryTokens: 24,
          compressionRatio: 1.4,
          truncated: true,
          summaryText: "Compiled output summary",
          artifactRef: " artifacts/tool-output.txt ",
        },
      }),
    ).toBeNull();
  });

  test("reads reasoning revert and session rewind completed payloads", () => {
    expect(
      readReasoningRevertEventPayload({
        type: REASONING_REVERT_EVENT_TYPE,
        payload: {
          schema: "brewva.reasoning.revert.v1",
          revertId: "revert-1",
          revertSequence: 4,
          toCheckpointId: "checkpoint-1",
          fromCheckpointId: "checkpoint-2",
          fromBranchId: "branch-main",
          newBranchId: "branch-restored",
          newBranchSequence: 9,
          trigger: "operator_request",
          continuityPacket: {
            schema: "brewva.reasoning.continuity.v1",
            text: "Continue from the restored branch.",
          },
          linkedRollbackReceiptIds: ["rollback-1"],
          targetLeafEntryId: "leaf-restore-1",
          createdAt: 12,
        },
      }),
    ).toEqual({
      schema: "brewva.reasoning.revert.v1",
      revertId: "revert-1",
      revertSequence: 4,
      toCheckpointId: "checkpoint-1",
      fromCheckpointId: "checkpoint-2",
      fromBranchId: "branch-main",
      newBranchId: "branch-restored",
      newBranchSequence: 9,
      trigger: "operator_request",
      continuityPacket: {
        schema: "brewva.reasoning.continuity.v1",
        text: "Continue from the restored branch.",
      },
      linkedRollbackReceiptIds: ["rollback-1"],
      targetLeafEntryId: "leaf-restore-1",
      createdAt: 12,
    });

    expect(
      readSessionRewindCompletedEventPayload({
        type: SESSION_REWIND_COMPLETED_EVENT_TYPE,
        payload: {
          schema: "brewva.session.rewind.v1",
          ok: true,
          checkpointId: "checkpoint-1",
          trigger: "undo",
          mode: "conversation",
          summary: "none",
          reasoningRevertId: "revert-1",
          reasoningRevertEventId: "event-revert-1",
          divergenceNote: {
            kind: "workspace_ahead",
            text: "Workspace divergence: 1 patch remains ahead.",
            patchSetCount: 1,
            parentLeafEntryId: "leaf-parent-1",
          },
          abandonedCheckpointIds: ["checkpoint-2"],
          patchSetIds: ["patch-1"],
          rollbackResults: [],
          returnLeafEntryId: "leaf-restore-1",
        },
      }),
    ).toEqual({
      schema: "brewva.session.rewind.v1",
      ok: true,
      checkpointId: "checkpoint-1",
      trigger: "undo",
      mode: "conversation",
      summary: "none",
      reasoningRevertId: "revert-1",
      reasoningRevertEventId: "event-revert-1",
      divergenceNote: {
        kind: "workspace_ahead",
        text: "Workspace divergence: 1 patch remains ahead.",
        patchSetCount: 1,
        parentLeafEntryId: "leaf-parent-1",
      },
      abandonedCheckpointIds: ["checkpoint-2"],
      patchSetIds: ["patch-1"],
      rollbackResults: [],
      returnLeafEntryId: "leaf-restore-1",
    });
  });

  test("reads shared verification payloads", () => {
    expect(
      readVerificationWriteMarkedEventPayload({
        type: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
        payload: {
          schema: "brewva.verification.write_marked.v1",
          toolName: "exec",
        },
      }),
    ).toEqual({
      schema: "brewva.verification.write_marked.v1",
      toolName: "exec",
    });

    expect(
      readVerificationOutcomeRecordedEventPayload({
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        payload: {
          schema: "brewva.verification.outcome.v1",
          level: "standard",
          outcome: "fail",
          lessonKey: "verification:standard:plan:tests",
          pattern: "verification:standard:plan",
          rootCause: "failed checks: tests",
          recommendation: "rerun tests",
          taskGoal: "Ship the refactor",
          strategy: "verification_level=standard; checks=tests:fail",
          failedChecks: ["tests"],
          missingChecks: [],
          missingEvidence: [],
          skipped: false,
          reason: "checks_failed",
          evidence: "tests: 1 failing assertion",
          evidenceIds: ["ledger-1"],
          checkResults: [
            {
              name: "tests",
              status: "fail",
              evidence: "1 failing assertion",
            },
          ],
          provenanceVersion: "v2",
          activeSkill: "implementation",
          referenceWriteAt: 42,
          evidenceFreshness: "fresh",
          commandsExecuted: ["tests"],
          commandsFresh: ["tests"],
          commandsStale: [],
          commandsMissing: [],
          checkProvenance: [
            {
              check: "tests",
              status: "fail",
              command: "bun test",
              hasRun: true,
              freshSinceWrite: true,
              runTimestamp: 44,
              ledgerId: "ledger-1",
            },
          ],
        },
      }),
    ).toEqual({
      schema: "brewva.verification.outcome.v1",
      level: "standard",
      outcome: "fail",
      lessonKey: "verification:standard:plan:tests",
      pattern: "verification:standard:plan",
      rootCause: "failed checks: tests",
      recommendation: "rerun tests",
      taskGoal: "Ship the refactor",
      strategy: "verification_level=standard; checks=tests:fail",
      failedChecks: ["tests"],
      missingChecks: [],
      missingEvidence: [],
      skipped: false,
      reason: "checks_failed",
      evidence: "tests: 1 failing assertion",
      evidenceIds: ["ledger-1"],
      checkResults: [
        {
          name: "tests",
          status: "fail",
          evidence: "1 failing assertion",
        },
      ],
      provenanceVersion: "v2",
      activeSkill: "implementation",
      referenceWriteAt: 42,
      evidenceFreshness: "fresh",
      commandsExecuted: ["tests"],
      commandsFresh: ["tests"],
      commandsStale: [],
      commandsMissing: [],
      checkProvenance: [
        {
          check: "tests",
          status: "fail",
          command: "bun test",
          hasRun: true,
          freshSinceWrite: true,
          runTimestamp: 44,
          ledgerId: "ledger-1",
        },
      ],
    });
  });

  test("reads shared task watchdog payloads", () => {
    expect(
      readTaskStuckDetectedEventPayload({
        type: TASK_STUCK_DETECTED_EVENT_TYPE,
        payload: {
          schema: "brewva.task-watchdog.v1",
          thresholdMs: 300000,
          baselineProgressAt: 100,
          detectedAt: 400,
          idleMs: 300,
          openItemCount: 2,
        },
      }),
    ).toEqual({
      schema: "brewva.task-watchdog.v1",
      thresholdMs: 300000,
      baselineProgressAt: 100,
      detectedAt: 400,
      idleMs: 300,
      openItemCount: 2,
    });

    expect(
      readTaskStallAdjudicatedEventPayload({
        type: TASK_STALL_ADJUDICATED_EVENT_TYPE,
        payload: {
          schema: "brewva.task-stall-adjudication.v1",
          detectedAt: 400,
          baselineProgressAt: 100,
          adjudicatedAt: 450,
          decision: "steer",
          source: "heuristic",
          rationale: "Verification failed and the session is stuck.",
          signalSummary: ["verification_failed=tests"],
          tapePressure: "medium",
          blockerCount: 1,
          blockedToolCount: 0,
          failureCount: 1,
          pendingWorkerResults: 0,
          verificationLastOutcome: "fail",
          verificationPassed: false,
          verificationSkipped: false,
        },
      }),
    ).toEqual({
      schema: "brewva.task-stall-adjudication.v1",
      detectedAt: 400,
      baselineProgressAt: 100,
      adjudicatedAt: 450,
      decision: "steer",
      source: "heuristic",
      rationale: "Verification failed and the session is stuck.",
      signalSummary: ["verification_failed=tests"],
      tapePressure: "medium",
      blockerCount: 1,
      blockedToolCount: 0,
      failureCount: 1,
      pendingWorkerResults: 0,
      verificationLastOutcome: "fail",
      verificationPassed: false,
      verificationSkipped: false,
    });
  });

  test("reads effect commitment proposal and approval payloads", () => {
    expect(
      readEffectCommitmentDecisionReceiptRecordedEventPayload({
        type: DECISION_RECEIPT_RECORDED_EVENT_TYPE,
        payload: {
          proposal: {
            id: "proposal-1",
            kind: "effect_commitment",
            issuer: "gateway",
            subject: "run command",
            payload: {
              toolName: "exec",
              toolCallId: "tc-1",
              boundary: "effectful",
              effects: ["local_exec"],
              argsDigest: "sha256:abc",
              argsSummary: "echo hello",
            },
            evidenceRefs: [
              {
                id: "evidence-1",
                sourceType: "tool_result",
                locator: "ledger:1",
                createdAt: 12,
              },
            ],
            createdAt: 12,
          },
          receipt: {
            proposalId: "proposal-1",
            decision: "defer",
            policyBasis: ["operator_desk"],
            reasons: ["awaiting_approval"],
            committedEffects: [],
            evidenceRefs: [
              {
                id: "evidence-1",
                sourceType: "tool_result",
                locator: "ledger:1",
                createdAt: 12,
              },
            ],
            turn: 3,
            timestamp: 12,
          },
        },
      }),
    ).toMatchObject({
      proposal: {
        id: "proposal-1",
        payload: {
          toolName: "exec",
          toolCallId: "tc-1",
          effects: ["local_exec"],
        },
      },
      receipt: {
        proposalId: "proposal-1",
        decision: "defer",
      },
    });

    expect(
      readEffectCommitmentApprovalRequestedEventPayload({
        type: EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
        payload: {
          requestId: "approval-1",
          proposalId: "proposal-1",
          toolName: "exec",
          toolCallId: "tc-1",
          subject: "run command",
          effects: ["local_exec"],
          argsSummary: "echo hello",
        },
      }),
    ).toEqual({
      requestId: "approval-1",
      proposalId: "proposal-1",
      toolName: asBrewvaToolName("exec"),
      toolCallId: asBrewvaToolCallId("tc-1"),
      subject: "run command",
      boundary: "effectful",
      effects: ["local_exec"],
      argsSummary: "echo hello",
    });

    expect(
      readEffectCommitmentApprovalResolutionEventPayload({
        type: EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
        payload: {
          requestId: "approval-1",
          proposalId: "proposal-1",
          toolName: "exec",
          toolCallId: "tc-1",
          decision: "reject",
          actor: "operator",
          reason: "unsafe",
        },
      }),
    ).toEqual({
      requestId: "approval-1",
      proposalId: "proposal-1",
      toolName: asBrewvaToolName("exec"),
      toolCallId: asBrewvaToolCallId("tc-1"),
      decision: "reject",
      actor: "operator",
      reason: "unsafe",
    });

    expect(
      readEffectCommitmentApprovalResolutionEventPayload({
        type: EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
        payload: {
          requestId: "approval-1",
          ledgerId: "ledger-1",
          verdict: "pass",
        },
      }),
    ).toEqual({
      requestId: "approval-1",
      decision: "accept",
      ledgerId: "ledger-1",
      verdict: "pass",
    });
  });

  test("reads shared skill lifecycle payloads", () => {
    expect(
      readSkillActivatedEventPayload({
        type: SKILL_ACTIVATED_EVENT_TYPE,
        payload: {
          skillName: "plan",
        },
      }),
    ).toEqual({
      skillName: "plan",
    });

    expect(
      readSkillCompletedEventPayload({
        type: SKILL_COMPLETED_EVENT_TYPE,
        payload: {
          skillName: "plan",
          outputKeys: ["planning_posture"],
          outputs: {
            planning_posture: "complex",
          },
          completedAt: 123,
          semanticBindings: {
            planning_posture: "planning.execution_plan.v2",
          },
        },
      }),
    ).toEqual({
      skillName: "plan",
      outputKeys: ["planning_posture"],
      outputs: {
        planning_posture: "complex",
      },
      completedAt: 123,
      semanticBindings: {
        planning_posture: "planning.execution_plan.v2",
      },
    });
  });

  test("rejects skill_completed payloads when canonical fields are omitted", () => {
    expect(
      readSkillCompletedEventPayload({
        type: SKILL_COMPLETED_EVENT_TYPE,
        timestamp: 456,
        payload: {
          skillName: "plan",
          outputs: {
            planning_posture: "complex",
            open_questions: ["What remains unknown?"],
          },
        },
      }),
    ).toBeNull();
  });

  test("rejects skill_completed payloads when outputKeys drift from outputs", () => {
    expect(
      readSkillCompletedEventPayload({
        type: SKILL_COMPLETED_EVENT_TYPE,
        payload: {
          skillName: "plan",
          outputKeys: ["open_questions"],
          outputs: {
            planning_posture: "complex",
            open_questions: ["Should we wait for CI?"],
          },
          completedAt: 123,
        },
      }),
    ).toBeNull();
  });

  test("reads shared skill completion failures", () => {
    expect(
      readSkillCompletionFailureEventPayload({
        type: SKILL_COMPLETION_REJECTED_EVENT_TYPE,
        payload: {
          skillName: "plan",
          occurredAt: 123,
          phase: "repair_required",
          outputKeys: ["planning_posture"],
          missing: [],
          invalid: [
            {
              name: "planning_posture",
              reason: "missing_value",
            },
          ],
          expectedOutputs: {
            planning_posture: {
              kind: "enum",
            },
          },
          repairGuidance: {
            unresolvedFields: ["planning_posture"],
            minimumContractState: "Provide planning_posture.",
          },
          repairBudget: {
            maxAttempts: 3,
            usedAttempts: 1,
            remainingAttempts: 2,
            maxToolCalls: 6,
            usedToolCalls: 0,
            remainingToolCalls: 6,
            tokenBudget: 12000,
          },
        },
      }),
    ).toEqual({
      skillName: "plan",
      occurredAt: 123,
      phase: "repair_required",
      outputKeys: ["planning_posture"],
      missing: [],
      invalid: [
        {
          name: "planning_posture",
          reason: "missing_value",
        },
      ],
      expectedOutputs: {
        planning_posture: {
          kind: "enum",
        },
      },
      repairGuidance: {
        unresolvedFields: ["planning_posture"],
        minimumContractState: "Provide planning_posture.",
      },
      repairBudget: {
        maxAttempts: 3,
        usedAttempts: 1,
        remainingAttempts: 2,
        maxToolCalls: 6,
        usedToolCalls: 0,
        remainingToolCalls: 6,
        tokenBudget: 12000,
      },
    });
  });

  test("reads blocked tool-call payloads with optional governance metadata", () => {
    expect(
      readToolCallBlockedEventPayload({
        type: TOOL_CALL_BLOCKED_EVENT_TYPE,
        payload: {
          schema: "brewva.tool_call_blocked.v1",
          toolName: "exec",
          reason: "tool blocked",
          decision: null,
          proposalId: null,
          requestId: "req-1",
          manifestBasis: null,
          skill: "plan",
          resolution: "hint",
        },
      }),
    ).toEqual({
      schema: "brewva.tool_call_blocked.v1",
      toolName: "exec",
      reason: "tool blocked",
      decision: null,
      proposalId: null,
      requestId: "req-1",
      manifestBasis: null,
      skill: "plan",
      resolution: "hint",
    });
  });

  test("reads unclean shutdown diagnostics through the shared registry", () => {
    expect(
      readSessionUncleanShutdownDiagnosticEventPayload({
        type: SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
        payload: {
          detectedAt: 42,
          reasons: ["open_tool_calls_without_terminal_receipt"],
          openToolCalls: [
            {
              toolCallId: "tc-1",
              toolName: "read",
              openedAt: 10,
              turn: 2,
              attempt: 1,
              eventId: "ev-tool-1",
            },
          ],
          openTurns: [
            {
              turn: 2,
              startedAt: 8,
              eventId: "ev-turn-1",
            },
          ],
          latestEventType: "tool_execution_start",
          latestEventAt: 10,
        },
      }),
    ).toEqual({
      detectedAt: 42,
      reasons: ["open_tool_calls_without_terminal_receipt"],
      openToolCalls: [
        {
          toolCallId: asBrewvaToolCallId("tc-1"),
          toolName: asBrewvaToolName("read"),
          openedAt: 10,
          turn: 2,
          attempt: 1,
          eventId: "ev-tool-1",
        },
      ],
      openTurns: [
        {
          turn: 2,
          startedAt: 8,
          eventId: "ev-turn-1",
        },
      ],
      latestEventType: "tool_execution_start",
      latestEventAt: 10,
    });
  });

  test("reads delegation lifecycle and worker merge payloads", () => {
    expect(
      readDelegationLifecycleEventPayload({
        type: "subagent_completed",
        payload: {
          contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
          runId: "run-1",
          delegate: "advisor",
          executionPrimitive: "named",
          visibility: "public",
          isolationStrategy: "shared",
          adoption: {
            contractId: "delegation.test",
            decision: "require_human",
            reason: "Parent must review the outcome.",
          },
          kind: "review",
          skillName: "debugging",
          status: "completed",
          summary: "Investigation finished.",
          deliveryMode: "text_only",
          deliveryHandoffState: "pending_parent_turn",
          deliveryReadyAt: 44,
          deliveryUpdatedAt: 45,
        },
      }),
    ).toEqual({
      contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
      runId: "run-1",
      delegate: "advisor",
      executionPrimitive: "named",
      visibility: "public",
      isolationStrategy: "shared",
      adoption: {
        contractId: "delegation.test",
        decision: "require_human",
        reason: "Parent must review the outcome.",
      },
      kind: "consult",
      consultKind: "review",
      skillName: "debugging",
      status: "completed",
      summary: "Investigation finished.",
      delivery: {
        mode: "text_only",
        handoffState: "pending_parent_turn",
        readyAt: 44,
        updatedAt: 45,
      },
    });

    expect(
      readWorkerResultsAppliedEventPayload({
        type: WORKER_RESULTS_APPLIED_EVENT_TYPE,
        payload: {
          workerId: "worker-1",
          workerIds: ["worker-1", "worker-2"],
          patchSetId: "patch-1",
          appliedPaths: ["a.ts", "b.ts"],
        },
      }),
    ).toEqual({
      workerIds: ["worker-1", "worker-2"],
      workerId: "worker-1",
      patchSetId: "patch-1",
      appliedPaths: ["a.ts", "b.ts"],
    });
  });
});
