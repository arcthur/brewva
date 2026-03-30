import type { PatchSet } from "../contracts/index.js";
import type { ResolvedToolAuthority } from "../governance/tool-governance.js";
import type { FileChangeService } from "./file-change.js";
import type { LedgerService } from "./ledger.js";
import type { ReversibleMutationService } from "./reversible-mutation.js";
import type {
  FinishToolCallInput,
  StartToolCallInput,
  ToolAccessDecision,
  ToolGateService,
} from "./tool-gate.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPatchSetOverride(metadata: Record<string, unknown> | undefined): PatchSet | undefined {
  const details = isRecord(metadata?.details) ? metadata.details : undefined;
  const patchSet = isRecord(details?.patchSet) ? details.patchSet : undefined;
  if (!patchSet) {
    return undefined;
  }
  if (typeof patchSet.id !== "string" || typeof patchSet.createdAt !== "number") {
    return undefined;
  }
  if (!Array.isArray(patchSet.changes)) {
    return undefined;
  }

  const changes: PatchSet["changes"] = [];
  for (const change of patchSet.changes) {
    if (!isRecord(change)) {
      continue;
    }
    if (typeof change.path !== "string") {
      continue;
    }
    if (change.action !== "add" && change.action !== "modify" && change.action !== "delete") {
      continue;
    }
    changes.push({
      path: change.path,
      action: change.action,
      beforeHash: typeof change.beforeHash === "string" ? change.beforeHash : undefined,
      afterHash: typeof change.afterHash === "string" ? change.afterHash : undefined,
      diffText: typeof change.diffText === "string" ? change.diffText : undefined,
      artifactRef: typeof change.artifactRef === "string" ? change.artifactRef : undefined,
    });
  }

  return {
    id: patchSet.id,
    createdAt: patchSet.createdAt,
    summary: typeof patchSet.summary === "string" ? patchSet.summary : undefined,
    changes,
  };
}

export interface RecordToolResultInput {
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  channelSuccess: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
  metadata?: Record<string, unknown>;
  effectCommitmentRequestId?: string;
}

export interface ToolInvocationSpineOptions {
  toolGateService: Pick<
    ToolGateService,
    "authorizeToolCall" | "clearEffectCommitmentState" | "resolveToolCompletion"
  >;
  fileChangeService: Pick<
    FileChangeService,
    "markToolCall" | "trackToolCallStart" | "trackToolCallEnd"
  >;
  ledgerService: Pick<LedgerService, "recordToolResult">;
  reversibleMutationService: Pick<ReversibleMutationService, "prepare" | "record">;
}

type CompletionContext = {
  authority: ResolvedToolAuthority;
  verdict: "pass" | "fail" | "inconclusive";
  effectCommitmentRequestId?: string;
};

export class ToolInvocationSpine {
  private readonly authorizeToolCall: ToolGateService["authorizeToolCall"];
  private readonly clearEffectCommitmentState: ToolGateService["clearEffectCommitmentState"];
  private readonly resolveToolCompletion: ToolGateService["resolveToolCompletion"];
  private readonly markToolCall: FileChangeService["markToolCall"];
  private readonly trackToolCallStart: FileChangeService["trackToolCallStart"];
  private readonly trackToolCallEnd: FileChangeService["trackToolCallEnd"];
  private readonly recordToolResult: LedgerService["recordToolResult"];
  private readonly prepareMutation: ReversibleMutationService["prepare"];
  private readonly recordMutation: ReversibleMutationService["record"];

  constructor(options: ToolInvocationSpineOptions) {
    this.authorizeToolCall = (input) => options.toolGateService.authorizeToolCall(input);
    this.clearEffectCommitmentState = (input) =>
      options.toolGateService.clearEffectCommitmentState(input);
    this.resolveToolCompletion = (input) => options.toolGateService.resolveToolCompletion(input);
    this.markToolCall = (sessionId, toolName) =>
      options.fileChangeService.markToolCall(sessionId, toolName);
    this.trackToolCallStart = (input) => options.fileChangeService.trackToolCallStart(input);
    this.trackToolCallEnd = (input) => options.fileChangeService.trackToolCallEnd(input);
    this.recordToolResult = (input) => options.ledgerService.recordToolResult(input);
    this.prepareMutation = (input) => options.reversibleMutationService.prepare(input);
    this.recordMutation = (input) => options.reversibleMutationService.record(input);
  }

  begin(input: StartToolCallInput): ToolAccessDecision {
    const decision = this.authorizeToolCall(input);
    if (!decision.allowed) {
      return decision;
    }

    try {
      this.markToolCall(input.sessionId, input.toolName);
      this.trackToolCallStart({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: input.args,
      });
      const mutationReceipt = decision.authority.rollbackable
        ? this.prepareMutation({
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
          })
        : undefined;
      return {
        allowed: true,
        advisory: decision.advisory,
        boundary: decision.boundary,
        commitmentReceipt: decision.commitmentReceipt,
        effectCommitmentRequestId: decision.effectCommitmentRequestId,
        mutationReceipt,
      };
    } catch (error) {
      this.clearEffectCommitmentState({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        effectCommitmentRequestId: decision.effectCommitmentRequestId,
      });
      throw error;
    }
  }

  complete(input: FinishToolCallInput): string {
    const completion = this.resolveToolCompletion(input);
    const ledgerId = this.recordToolResult({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      outputText: input.outputText,
      channelSuccess: input.channelSuccess,
      verdict: completion.verdict,
      metadata: input.metadata,
      effectCommitmentRequestId: completion.effectCommitmentRequestId,
    });
    this.clearEffectCommitmentState({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      effectCommitmentRequestId: completion.effectCommitmentRequestId,
    });
    const patchSet =
      readPatchSetOverride(input.metadata) ??
      this.trackToolCallEnd({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        channelSuccess: input.channelSuccess,
      });
    this.recordRollbackableMutation(input, completion, patchSet);
    return ledgerId;
  }

  recordResult(input: RecordToolResultInput): string {
    const completion = this.resolveToolCompletion(input);
    const ledgerId = this.recordToolResult({
      ...input,
      verdict: completion.verdict,
      effectCommitmentRequestId: completion.effectCommitmentRequestId,
    });
    this.clearEffectCommitmentState({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      effectCommitmentRequestId: completion.effectCommitmentRequestId,
    });
    return ledgerId;
  }

  private recordRollbackableMutation(
    input: FinishToolCallInput,
    completion: CompletionContext,
    patchSet: PatchSet | undefined,
  ): void {
    if (!completion.authority.rollbackable) {
      return;
    }
    this.recordMutation({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      channelSuccess: input.channelSuccess,
      verdict: completion.verdict,
      patchSet,
      metadata: input.metadata,
    });
  }
}
