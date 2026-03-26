import { ContextBudgetManager } from "../context/budget.js";
import type {
  BrewvaConfig,
  BrewvaEventRecord,
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextPressureLevel,
  ContextPressureStatus,
} from "../contracts/index.js";
import { resolveContextUsageRatio } from "../utils/token.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { RuntimeCallback } from "./callback.js";

interface ContextPressureServiceOptions {
  config: BrewvaConfig;
  contextBudget: ContextBudgetManager;
  alwaysAllowedTools?: string[];
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    BrewvaEventRecord | undefined
  >;
}

export class ContextPressureService {
  private readonly config: BrewvaConfig;
  private readonly contextBudget: ContextBudgetManager;
  private readonly alwaysAllowedToolSet: Set<string>;
  private readonly getCurrentTurn: ContextPressureServiceOptions["getCurrentTurn"];
  private readonly recordEvent: ContextPressureServiceOptions["recordEvent"];

  constructor(options: ContextPressureServiceOptions) {
    this.config = options.config;
    this.contextBudget = options.contextBudget;
    this.alwaysAllowedToolSet = new Set(
      (options.alwaysAllowedTools ?? [])
        .map((toolName) => normalizeToolName(toolName))
        .filter((toolName) => toolName.length > 0),
    );
    this.getCurrentTurn = options.getCurrentTurn;
    this.recordEvent = options.recordEvent;
  }

  observeContextUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void {
    this.contextBudget.observeUsage(sessionId, usage);
    if (!usage) return;
    this.recordEvent({
      sessionId,
      type: "context_usage",
      payload: {
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: this.getContextUsageRatio(usage),
      },
    });
  }

  getContextUsage(sessionId: string): ContextBudgetUsage | undefined {
    const usage = this.contextBudget.getLastContextUsage(sessionId);
    if (!usage) return undefined;
    return {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    };
  }

  getContextUsageRatio(usage: ContextBudgetUsage | undefined): number | null {
    return resolveContextUsageRatio(usage);
  }

  getContextHardLimitRatio(sessionId: string, usage?: ContextBudgetUsage): number {
    return Math.max(
      0,
      Math.min(1, this.contextBudget.getEffectiveHardLimitPercent(sessionId, usage)),
    );
  }

  getContextCompactionThresholdRatio(sessionId: string, usage?: ContextBudgetUsage): number {
    return Math.max(
      0,
      Math.min(1, this.contextBudget.getEffectiveCompactionThresholdPercent(sessionId, usage)),
    );
  }

  getContextPressureStatus(sessionId: string, usage?: ContextBudgetUsage): ContextPressureStatus {
    const effectiveUsage = usage ?? this.getContextUsage(sessionId);
    const usageRatio = this.getContextUsageRatio(effectiveUsage);
    if (usageRatio === null) {
      return {
        level: "unknown",
        usageRatio: null,
        hardLimitRatio: this.getContextHardLimitRatio(sessionId, effectiveUsage),
        compactionThresholdRatio: this.getContextCompactionThresholdRatio(
          sessionId,
          effectiveUsage,
        ),
      };
    }

    const hardLimitRatio = this.getContextHardLimitRatio(sessionId, effectiveUsage);
    const compactionThresholdRatio = this.getContextCompactionThresholdRatio(
      sessionId,
      effectiveUsage,
    );

    let level: ContextPressureLevel = "none";
    if (usageRatio >= hardLimitRatio) {
      level = "critical";
    } else if (usageRatio >= compactionThresholdRatio) {
      level = "high";
    } else {
      // Keep medium/low bands proportional to compaction pressure so signals scale with user-configured thresholds.
      const mediumThreshold = Math.max(0.5, compactionThresholdRatio * 0.75);
      if (usageRatio >= mediumThreshold) {
        level = "medium";
      } else {
        const lowThreshold = Math.max(0.25, compactionThresholdRatio * 0.5);
        if (usageRatio >= lowThreshold) {
          level = "low";
        }
      }
    }

    return {
      level,
      usageRatio,
      hardLimitRatio,
      compactionThresholdRatio,
    };
  }

  getContextPressureLevel(sessionId: string, usage?: ContextBudgetUsage): ContextPressureLevel {
    return this.getContextPressureStatus(sessionId, usage).level;
  }

  getRecentCompactionWindowTurns(): number {
    return Math.max(1, this.config.infrastructure.contextBudget.compaction.minTurnsBetween);
  }

  getContextCompactionGateStatus(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionGateStatus {
    const pressure = this.getContextPressureStatus(sessionId, usage);
    const windowTurns = this.getRecentCompactionWindowTurns();

    const lastCompactionTurn = this.contextBudget.getLastCompactionTurn(sessionId);
    const turnsSinceCompaction =
      lastCompactionTurn === null
        ? null
        : Math.max(0, this.getCurrentTurn(sessionId) - lastCompactionTurn);
    const recentCompaction =
      turnsSinceCompaction !== null && Number.isFinite(turnsSinceCompaction)
        ? turnsSinceCompaction < windowTurns
        : false;
    const pendingReason = this.getPendingCompactionReason(sessionId);
    const required =
      this.config.infrastructure.contextBudget.enabled &&
      pressure.level === "critical" &&
      !recentCompaction;
    const reason: ContextCompactionReason | null = required
      ? (pendingReason ?? (pressure.level === "critical" ? "hard_limit" : "usage_threshold"))
      : null;

    return {
      required,
      reason,
      pressure,
      recentCompaction,
      windowTurns,
      lastCompactionTurn,
      turnsSinceCompaction,
    };
  }

  checkContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string } {
    return this.evaluateContextCompactionGate(sessionId, toolName, usage, { emitEvent: true });
  }

  explainContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string } {
    return this.evaluateContextCompactionGate(sessionId, toolName, usage, { emitEvent: false });
  }

  private evaluateContextCompactionGate(
    sessionId: string,
    toolName: string,
    usage: ContextBudgetUsage | undefined,
    options: {
      emitEvent: boolean;
    },
  ): { allowed: boolean; reason?: string } {
    const normalizedToolName = normalizeToolName(toolName);
    if (normalizedToolName === "session_compact") {
      return { allowed: true };
    }
    if (this.alwaysAllowedToolSet.has(normalizedToolName)) {
      return { allowed: true };
    }

    const gate = this.getContextCompactionGateStatus(sessionId, usage);
    if (!gate.required) {
      return { allowed: true };
    }

    const usageRatio =
      typeof gate.pressure.usageRatio === "number"
        ? gate.pressure.usageRatio
        : gate.pressure.hardLimitRatio;
    const usagePercent = Math.max(0, Math.min(1, usageRatio)) * 100;
    const hardLimitPercent = Math.max(0, Math.min(1, gate.pressure.hardLimitRatio)) * 100;
    const allowedTools = [
      "session_compact",
      ...[...this.alwaysAllowedToolSet].toSorted((a, b) => a.localeCompare(b)),
    ];
    const reason = `Context usage is critical (${usagePercent.toFixed(1)}% >= hard limit ${hardLimitPercent.toFixed(1)}%). Call tool 'session_compact' first, then continue with other tools. Allowed during gate: ${allowedTools.join(", ")}.`;
    if (options.emitEvent) {
      this.recordEvent({
        sessionId,
        type: "context_compaction_gate_blocked_tool",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          blockedTool: toolName,
          reason: "critical_context_pressure_without_compaction",
          usagePercent: gate.pressure.usageRatio,
          hardLimitPercent: gate.pressure.hardLimitRatio,
        },
      });
    }
    return { allowed: false, reason };
  }

  checkAndRequestCompaction(sessionId: string, usage: ContextBudgetUsage | undefined): boolean {
    const decision = this.contextBudget.shouldRequestCompaction(sessionId, usage);
    if (!decision.shouldCompact) return false;
    this.requestCompaction(sessionId, decision.reason ?? "usage_threshold", decision.usage);
    return true;
  }

  requestCompaction(
    sessionId: string,
    reason: ContextCompactionReason,
    usage?: ContextBudgetUsage,
  ): void {
    const pendingReason = this.contextBudget.getPendingCompactionReason(sessionId);
    if (pendingReason === reason) {
      return;
    }
    this.contextBudget.requestCompaction(sessionId, reason);
    this.recordEvent({
      sessionId,
      type: "context_compaction_requested",
      payload: {
        reason,
        usagePercent: this.getContextUsageRatio(usage),
        tokens: usage?.tokens ?? null,
      },
    });
  }

  getPendingCompactionReason(sessionId: string): ContextCompactionReason | null {
    return this.contextBudget.getPendingCompactionReason(sessionId);
  }

  getCompactionInstructions(): string {
    return this.contextBudget.getCompactionInstructions();
  }

  markCompacted(sessionId: string): void {
    this.contextBudget.markCompacted(sessionId);
  }
}
