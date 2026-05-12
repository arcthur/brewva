import { readToolResultRecordedEventPayload } from "../../events/descriptors.js";
import { TOOL_RESULT_RECORDED_EVENT_TYPE } from "../../events/registry.js";
import type { BrewvaStructuredEvent } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import type { EventPipelineService } from "../sessions/api.js";
import type { TaskService } from "../task/api.js";
import type { ClaimService } from "./claim.js";
import { projectClaimsFromToolResult } from "./tool-result-projector.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceClaimProjectionInput(value: unknown): {
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  verdict: "pass" | "fail" | "inconclusive";
  ledgerRow: {
    id: string;
    outputHash: string;
    argsSummary: string;
    outputSummary: string;
  };
  metadata?: Record<string, unknown>;
} | null {
  if (!isRecord(value)) return null;
  const toolName = typeof value.toolName === "string" ? value.toolName.trim() : "";
  const outputText = typeof value.outputText === "string" ? value.outputText : "";
  const verdict = value.verdict;
  const args = isRecord(value.args) ? value.args : {};
  const ledgerRow = isRecord(value.ledgerRow) ? value.ledgerRow : null;
  if (
    !toolName ||
    !ledgerRow ||
    typeof ledgerRow.id !== "string" ||
    typeof ledgerRow.outputHash !== "string" ||
    typeof ledgerRow.argsSummary !== "string" ||
    typeof ledgerRow.outputSummary !== "string"
  ) {
    return null;
  }
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return null;
  }

  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  return {
    toolName,
    args,
    outputText,
    verdict,
    ledgerRow: {
      id: ledgerRow.id,
      outputHash: ledgerRow.outputHash,
      argsSummary: ledgerRow.argsSummary,
      outputSummary: ledgerRow.outputSummary,
    },
    metadata,
  };
}

export interface ClaimProjectorServiceOptions {
  cwd: RuntimeKernelContext["cwd"];
  getTaskState: RuntimeKernelContext["getTaskState"];
  getClaimState: RuntimeKernelContext["getClaimState"];
  eventPipeline: Pick<EventPipelineService, "subscribeEvents">;
  taskService: Pick<TaskService, "recordTaskBlocker" | "resolveTaskBlocker">;
  claimService: Pick<ClaimService, "upsert" | "resolve">;
}

export class ClaimProjectorService {
  constructor(options: ClaimProjectorServiceOptions) {
    options.eventPipeline.subscribeEvents((event) => {
      this.handleEvent(options, event);
    });
  }

  private handleEvent(options: ClaimProjectorServiceOptions, event: BrewvaStructuredEvent): void {
    if (event.type !== TOOL_RESULT_RECORDED_EVENT_TYPE) {
      return;
    }
    const payload = readToolResultRecordedEventPayload(event);
    const projection = coerceClaimProjectionInput(payload?.claimProjection);
    if (!projection) {
      return;
    }

    projectClaimsFromToolResult(
      {
        cwd: options.cwd,
        getTaskState: (sessionId) => options.getTaskState(sessionId),
        getClaimState: (sessionId) => options.getClaimState(sessionId),
        upsert: (sessionId, input) => options.claimService.upsert(sessionId, input),
        resolve: (sessionId, claimId) => options.claimService.resolve(sessionId, claimId),
        recordTaskBlocker: (sessionId, input) =>
          options.taskService.recordTaskBlocker(sessionId, input),
        resolveTaskBlocker: (sessionId, blockerId) =>
          options.taskService.resolveTaskBlocker(sessionId, blockerId),
      },
      {
        sessionId: event.sessionId,
        toolName: projection.toolName,
        args: projection.args,
        outputText: projection.outputText,
        verdict: projection.verdict,
        ledgerRow: projection.ledgerRow,
        metadata: projection.metadata,
      },
    );
  }
}
