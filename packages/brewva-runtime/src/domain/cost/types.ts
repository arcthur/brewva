export interface SessionCostTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface SessionCostSummary extends SessionCostTotals {
  models: Record<string, SessionCostTotals>;
  skills: Record<
    string,
    SessionCostTotals & {
      usageCount: number;
      turns: number;
    }
  >;
  tools: Record<
    string,
    {
      callCount: number;
      allocatedTokens: number;
      allocatedCostUsd: number;
    }
  >;
  alerts: Array<{
    timestamp: number;
    kind: "session_threshold" | "session_cap";
    scope: "session";
    costUsd: number;
    thresholdUsd: number;
  }>;
  budget: {
    action: "warn" | "block_tools";
    sessionExceeded: boolean;
    blocked: boolean;
  };
}
