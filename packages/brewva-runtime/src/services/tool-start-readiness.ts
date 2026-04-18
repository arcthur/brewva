import type { ContextBudgetUsage } from "../contracts/index.js";
import type { ContextService } from "./context.js";
import type { ToolAccessDecision } from "./tool-access-policy.js";

export interface ToolStartReadinessServiceOptions {
  contextService: Pick<
    ContextService,
    "checkContextCompactionGate" | "observeContextUsage" | "explainContextCompactionGate"
  >;
}

export class ToolStartReadinessService {
  private readonly checkContextCompactionGate: ContextService["checkContextCompactionGate"];
  private readonly explainContextCompactionGate: ContextService["explainContextCompactionGate"];
  private readonly observeContextUsage: ContextService["observeContextUsage"];

  constructor(options: ToolStartReadinessServiceOptions) {
    this.checkContextCompactionGate = (sessionId, toolName, usage) =>
      options.contextService.checkContextCompactionGate(sessionId, toolName, usage);
    this.explainContextCompactionGate = (sessionId, toolName, usage) =>
      options.contextService.explainContextCompactionGate(sessionId, toolName, usage);
    this.observeContextUsage = (sessionId, usage) =>
      options.contextService.observeContextUsage(sessionId, usage);
  }

  checkToolStartReadiness(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): ToolAccessDecision {
    if (usage) {
      this.observeContextUsage(sessionId, usage);
    }
    return this.checkContextCompactionGate(sessionId, toolName, usage);
  }

  explainToolStartReadiness(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): ToolAccessDecision {
    return this.explainContextCompactionGate(sessionId, toolName, usage);
  }
}
