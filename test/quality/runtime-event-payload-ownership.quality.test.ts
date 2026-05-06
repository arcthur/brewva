import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("runtime event payload ownership", () => {
  test("gateway turn transitions consume runtime-owned contracts instead of redeclaring them", () => {
    const gatewaySource = readRepoFile("packages/brewva-gateway/src/session/turn-transition.ts");
    const runtimeContracts = readRepoFile("packages/brewva-runtime/src/events/types.ts");
    const sessionWireContracts = readRepoFile(
      "packages/brewva-runtime/src/domain/sessions/wire.ts",
    );

    expect(gatewaySource).toContain("readSessionTurnTransitionEventPayload");
    expect(gatewaySource).toContain("type SessionTurnTransitionPayload");
    expect(gatewaySource).not.toContain("interface SessionTurnTransitionPayload");
    expect(gatewaySource).not.toContain("type HostedTransitionStatus =");
    expect(gatewaySource).not.toContain("type HostedTransitionFamily =");
    expect(runtimeContracts).toContain('from "../domain/sessions/wire.js"');
    expect(runtimeContracts).not.toContain("export interface SessionTurnTransitionPayload");
    expect(sessionWireContracts).toContain("export interface SessionTurnTransitionPayload");
  });

  test("skill lifecycle consumers use shared runtime readers instead of local payload parsers", () => {
    const hydrationFold = readRepoFile(
      "packages/brewva-runtime/src/domain/sessions/hydration/fold-skill.ts",
    );
    const workflowStatus = readRepoFile(
      "packages/brewva-runtime/src/domain/workflow/status-derivation.ts",
    );
    const scheduleRunner = readRepoFile("packages/brewva-gateway/src/daemon/schedule-runner.ts");
    const operatorQuestions = readRepoFile("packages/brewva-gateway/src/operator-questions.ts");
    const inspectCli = readRepoFile("packages/brewva-cli/src/inspect.ts");
    const planningNormalization = readRepoFile(
      "packages/brewva-runtime/src/domain/skills/planning-normalization.ts",
    );
    const workflowArtifacts = readRepoFile(
      "packages/brewva-runtime/src/domain/workflow/artifact-derivation.ts",
    );

    expect(hydrationFold).toContain("readSkillCompletedEventPayload");
    expect(hydrationFold).toContain("readSkillCompletionFailureEventPayload");
    expect(hydrationFold).not.toContain("function readCompletionFailure(");

    expect(workflowStatus).toContain("readSkillCompletedEventPayload");
    expect(workflowStatus).not.toContain("event.payload as { outputs?:");

    expect(scheduleRunner).toContain("readSkillActivatedEventPayload");
    expect(scheduleRunner).toContain("readSkillCompletionFailureEventPayload");
    expect(scheduleRunner).not.toContain("function readEventPayloadSkillName(");

    expect(operatorQuestions).toContain("readSkillCompletedEventPayload");
    expect(operatorQuestions).not.toContain(
      "const payload = isRecord(event.payload) ? event.payload : null;",
    );

    expect(inspectCli).toContain("readSkillActivatedEventPayload");
    expect(inspectCli).toContain("readSkillCompletedEventPayload");
    expect(inspectCli).not.toContain('typeof payload?.skillName === "string"');

    expect(existsSync(resolve(repoRoot, "packages/brewva-recall/src/session-digests.ts"))).toBe(
      false,
    );

    expect(planningNormalization).toContain("readSkillCompletedEventPayload");
    expect(planningNormalization).not.toContain("isRecord(event.payload)");

    expect(workflowArtifacts).toContain("readSkillCompletedEventPayload");
    expect(workflowArtifacts).not.toContain(
      "const outputs = isRecord(payload.outputs) ? payload.outputs : undefined;",
    );
  });

  test("effect commitment consumers use shared runtime readers instead of re-parsing approval payloads", () => {
    const effectCommitmentDesk = readRepoFile(
      "packages/brewva-runtime/src/domain/proposals/effect-commitment-desk.ts",
    );
    const proposalAdmission = readRepoFile(
      "packages/brewva-runtime/src/domain/proposals/proposal-admission.ts",
    );

    expect(effectCommitmentDesk).toContain("readEffectCommitmentApprovalRequestedEventPayload");
    expect(effectCommitmentDesk).toContain("readEffectCommitmentApprovalResolutionEventPayload");
    expect(effectCommitmentDesk).toContain(
      "readEffectCommitmentDecisionReceiptRecordedEventPayload",
    );
    expect(effectCommitmentDesk).toContain("readToolResultRecordedEventPayload");
    expect(effectCommitmentDesk).not.toContain("private readDecisionEventPayload(");
    expect(effectCommitmentDesk).not.toContain("private readEffectCommitmentProposalFromEvent(");
    expect(effectCommitmentDesk).not.toContain("private readToolOutcomePayload(");

    expect(proposalAdmission).toContain("readEffectCommitmentDecisionReceiptRecordedEventPayload");
    expect(proposalAdmission).not.toContain("private readEffectCommitmentRecord(");
  });

  test("delegation consumers use shared runtime readers instead of local subagent payload parsers", () => {
    const delegationStore = readRepoFile(
      "packages/brewva-gateway/src/subagents/delegation-store.ts",
    );
    const backgroundController = readRepoFile(
      "packages/brewva-gateway/src/subagents/background-controller.ts",
    );
    const turnTransition = readRepoFile("packages/brewva-gateway/src/session/turn-transition.ts");
    const sessionWire = readRepoFile("packages/brewva-runtime/src/domain/sessions/session-wire.ts");
    const parallelState = readRepoFile("packages/brewva-runtime/src/domain/parallel/state.ts");
    const parallelService = readRepoFile("packages/brewva-runtime/src/domain/parallel/parallel.ts");
    const operatorQuestions = readRepoFile("packages/brewva-gateway/src/operator-questions.ts");
    const workflowArtifacts = readRepoFile(
      "packages/brewva-runtime/src/domain/workflow/artifact-derivation.ts",
    );

    expect(delegationStore).toContain("readDelegationLifecycleEventPayload");
    expect(delegationStore).toContain("readWorkerResultsAppliedEventPayload");
    expect(delegationStore).not.toContain("function readDelegationConsultKind(");
    expect(delegationStore).not.toContain("function readRunMetadata(");

    expect(backgroundController).toContain("readWorkerResultsAppliedEventPayload");
    expect(backgroundController).not.toContain("payload.workerIds");
    expect(backgroundController).not.toContain("payload.workerId");

    expect(turnTransition).toContain("readDelegationLifecycleEventPayload");
    expect(turnTransition).not.toContain("deliveryHandoffState?: unknown");

    expect(sessionWire).toContain("readDelegationLifecycleEventPayload");
    expect(sessionWire).not.toContain("const runId = readString(payload?.runId);");
    expect(sessionWire).not.toContain("const delegate = readString(payload?.delegate);");

    expect(parallelState).toContain("readDelegationLifecycleEventPayload");
    expect(parallelState).toContain("readWorkerResultsAppliedEventPayload");
    expect(parallelState).not.toContain("const runId = readString(payload?.runId);");

    expect(parallelService).toContain("readDelegationLifecycleEventPayload");
    expect(parallelService).toContain("readWorkerResultsAppliedEventPayload");
    expect(parallelService).not.toContain("const workerId = readString(payload?.runId);");

    expect(operatorQuestions).toContain("readDelegationLifecycleEventPayload");
    expect(operatorQuestions).not.toContain("const runId = readString(payload?.runId);");

    expect(workflowArtifacts).toContain("readDelegationLifecycleEventPayload");
    expect(workflowArtifacts).not.toContain('if (readString(payload.kind) !== "patch") return [];');
    expect(workflowArtifacts).not.toContain('if (readString(payload.kind) !== "qa") return [];');
  });

  test("session wire approval frames use shared runtime readers instead of local approval payload parsers", () => {
    const sessionWire = readRepoFile("packages/brewva-runtime/src/domain/sessions/session-wire.ts");

    expect(sessionWire).toContain("readEffectCommitmentApprovalRequestedEventPayload");
    expect(sessionWire).toContain("readEffectCommitmentApprovalResolutionEventPayload");
    expect(sessionWire).not.toContain("const requestId = readString(payload?.requestId);");
    expect(sessionWire).not.toContain("toolName: asBrewvaToolName(toolName)");
    expect(sessionWire).not.toContain("toolCallId: asBrewvaToolCallId(toolCallId)");
  });

  test("tool result consumers use the shared runtime reader instead of re-parsing top-level tool_result payloads", () => {
    const effectCommitmentDesk = readRepoFile(
      "packages/brewva-runtime/src/domain/proposals/effect-commitment-desk.ts",
    );
    const readPathRecovery = readRepoFile(
      "packages/brewva-gateway/src/runtime-plugins/read-path-recovery.ts",
    );
    const taskStallAdjudication = readRepoFile(
      "packages/brewva-gateway/src/session/task-stall-adjudication.ts",
    );
    const truthProjector = readRepoFile(
      "packages/brewva-runtime/src/domain/truth/truth-projector.ts",
    );
    const verificationHydrationFold = readRepoFile(
      "packages/brewva-runtime/src/domain/sessions/hydration/fold-verification.ts",
    );
    const verificationProjector = readRepoFile(
      "packages/brewva-runtime/src/domain/verification/verification-projector.ts",
    );
    const replayEngine = readRepoFile("packages/brewva-runtime/src/domain/tape/replay-engine.ts");
    const inspectAnalysis = readRepoFile("packages/brewva-cli/src/inspect-analysis.ts");

    expect(effectCommitmentDesk).toContain("readToolResultRecordedEventPayload");

    expect(readPathRecovery).toContain("readToolResultRecordedEventPayload");
    expect(readPathRecovery).not.toContain("normalizeOptionalString(payload.toolName)");
    expect(readPathRecovery).not.toContain("isRecord(payload.failureContext)");

    expect(taskStallAdjudication).toContain("readToolResultRecordedEventPayload");
    expect(taskStallAdjudication).not.toContain('typeof payload?.toolName === "string"');
    expect(taskStallAdjudication).not.toContain('typeof payload?.failureClass === "string"');

    expect(truthProjector).toContain("readToolResultRecordedEventPayload");
    expect(truthProjector).not.toContain("isRecord(event.payload) ? event.payload : null");

    expect(verificationHydrationFold).toContain("readToolResultRecordedEventPayload");

    expect(verificationProjector).toContain("readToolResultRecordedEventPayload");

    expect(replayEngine).toContain("readToolResultRecordedEventPayload");

    expect(inspectAnalysis).toContain("readToolResultRecordedEventPayload");
    expect(inspectAnalysis).not.toContain("event.payload?.failureClass");
    expect(inspectAnalysis).not.toContain("event.payload?.ledgerId");

    expect(existsSync(resolve(repoRoot, "packages/brewva-recall/src/session-digests.ts"))).toBe(
      false,
    );
  });

  test("tool output distillation consumers use the shared runtime reader instead of re-parsing distillation payloads", () => {
    const runtimeSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/runtime-facade-state.ts",
    );
    const eventPipeline = readRepoFile(
      "packages/brewva-runtime/src/domain/sessions/event-pipeline.ts",
    );
    const runtimeContracts = readRepoFile("packages/brewva-runtime/src/events/types.ts");
    const toolsContracts = readRepoFile("packages/brewva-runtime/src/domain/tools/types.ts");

    expect(runtimeSource).toContain("readToolOutputDistilledEventPayload");
    expect(runtimeSource).not.toContain("const toolNameRaw = payload.toolName");
    expect(runtimeSource).not.toContain('typeof payload.summaryTokens === "number"');
    expect(runtimeSource).not.toContain("normalizeToolResultVerdict(payload.verdict)");

    expect(eventPipeline).toContain("BREWVA_TYPED_EVENT_DESCRIPTORS");
    expect(eventPipeline).toContain("readBrewvaEventPayload");
    expect(eventPipeline).toContain("invalid_recorded_event_payload");
    expect(eventPipeline).toContain("TOOL_OUTPUT_DISTILLED_EVENT_TYPE");

    expect(runtimeContracts).toContain('from "../domain/tools/types.js"');
    expect(runtimeContracts).not.toContain("export interface ToolOutputDistilledEventPayload");
    expect(toolsContracts).toContain("export interface ToolOutputDistilledEventPayload");
  });

  test("rewind and reasoning revert consumers use shared runtime readers instead of gateway-local payload parsers", () => {
    const hostedStore = readRepoFile(
      "packages/brewva-gateway/src/host/runtime-projection-session-store.ts",
    );
    const reasoningRevertRecovery = readRepoFile(
      "packages/brewva-gateway/src/session/reasoning-revert-recovery.ts",
    );

    expect(hostedStore).toContain("readReasoningRevertEventPayload");
    expect(hostedStore).toContain("readSessionRewindCompletedEventPayload");
    expect(hostedStore).not.toContain("function readReasoningRevertPayload(");
    expect(hostedStore).not.toContain("../session/rewind-event-payloads.js");

    expect(reasoningRevertRecovery).toContain("readSessionRewindCompletedEventPayload");
    expect(reasoningRevertRecovery).not.toContain("readSessionRewindCompletedPayload");
    expect(reasoningRevertRecovery).not.toContain("./rewind-event-payloads.js");

    expect(
      existsSync(resolve(repoRoot, "packages/brewva-gateway/src/session/rewind-event-payloads.ts")),
    ).toBe(false);
  });

  test("verification consumers use shared runtime readers instead of re-parsing verification payloads", () => {
    const verificationProjector = readRepoFile(
      "packages/brewva-runtime/src/domain/verification/verification-projector.ts",
    );
    const verificationHydrationFold = readRepoFile(
      "packages/brewva-runtime/src/domain/sessions/hydration/fold-verification.ts",
    );
    const workflowArtifacts = readRepoFile(
      "packages/brewva-runtime/src/domain/workflow/artifact-derivation.ts",
    );
    const skillValidationEvidence = readRepoFile(
      "packages/brewva-runtime/src/domain/skills/validation/evidence.ts",
    );
    const taskStallAdjudication = readRepoFile(
      "packages/brewva-gateway/src/session/task-stall-adjudication.ts",
    );
    const inspectCli = readRepoFile("packages/brewva-cli/src/inspect.ts");
    const runtimeSource = readRepoFile(
      "packages/brewva-runtime/src/runtime/runtime-facade-state.ts",
    );

    expect(verificationProjector).toContain("readVerificationOutcomeRecordedEventPayload");
    expect(verificationProjector).toContain("readVerificationWriteMarkedEventPayload");
    expect(verificationProjector).not.toContain("coerceVerificationWriteMarkedPayload(");
    expect(verificationProjector).not.toContain("coerceCheckProvenanceEntry(");
    expect(verificationProjector).not.toContain("Array.isArray(payload.checkProvenance)");

    expect(verificationHydrationFold).toContain("readVerificationOutcomeRecordedEventPayload");
    expect(verificationHydrationFold).toContain("readVerificationWriteMarkedEventPayload");
    expect(verificationHydrationFold).not.toContain("coerceVerificationWriteMarkedPayload(");
    expect(verificationHydrationFold).not.toContain('payload.level === "quick"');

    expect(workflowArtifacts).toContain("readVerificationOutcomeRecordedEventPayload");
    expect(workflowArtifacts).toContain("readVerificationWriteMarkedEventPayload");
    expect(workflowArtifacts).not.toContain("readString(payload.outcome)");
    expect(workflowArtifacts).not.toContain("readStringArray(payload.failedChecks)");

    expect(skillValidationEvidence).toContain("readVerificationOutcomeRecordedEventPayload");
    expect(skillValidationEvidence).not.toContain("const rawFreshness =");
    expect(skillValidationEvidence).not.toContain(".trim().toLowerCase()");

    expect(taskStallAdjudication).toContain("readVerificationOutcomeRecordedEventPayload");
    expect(taskStallAdjudication).not.toContain('typeof payload?.level === "string"');
    expect(taskStallAdjudication).not.toContain('typeof payload?.evidenceFreshness === "string"');

    expect(inspectCli).toContain("readVerificationOutcomeRecordedEventPayload");
    expect(inspectCli).not.toContain("latest.payload.failedChecks");
    expect(inspectCli).not.toContain('typeof latest.payload.outcome === "string"');

    expect(runtimeSource).toContain("readVerificationOutcomeRecordedEventPayload");
    expect(runtimeSource).not.toContain("Array.isArray(payload.commandsFresh)");
    expect(runtimeSource).not.toContain("Array.isArray(payload.failedChecks)");
  });
});
