import type {
  BrewvaConfig,
  TaskState,
  VerificationLevel,
  VerificationReport,
} from "../contracts/index.js";
import { resolveVerificationPlan, type VerificationPlan } from "./profile.js";
import { VerificationStateStore } from "./state.js";

export interface VerificationGateOptions {
  requireCommands?: boolean;
}

export interface VerificationGateBinding {
  cwd: string;
  workspaceRoot: string;
  getTaskState(sessionId: string): TaskState;
  getTargetRoots(sessionId: string): string[];
}

function isFresh(timestamp: number | undefined, lastWriteAt: number | undefined): boolean {
  if (timestamp === undefined) {
    return false;
  }
  if (!lastWriteAt) {
    return true;
  }
  return timestamp >= lastWriteAt;
}

export class VerificationGate {
  private readonly config: BrewvaConfig;
  private readonly store: VerificationStateStore;
  private binding?: VerificationGateBinding;

  constructor(
    config: BrewvaConfig,
    options: {
      store?: VerificationStateStore;
    } = {},
  ) {
    this.config = config;
    this.store = options.store ?? new VerificationStateStore();
  }

  bindSessionIntrospection(binding: VerificationGateBinding): void {
    this.binding = binding;
  }

  get stateStore(): VerificationStateStore {
    return this.store;
  }

  resolvePlan(
    sessionId: string,
    level: VerificationLevel = this.config.verification.defaultLevel,
  ): VerificationPlan {
    return resolveVerificationPlan({
      config: this.config,
      level,
      taskState: this.binding?.getTaskState(sessionId),
      targetRoots: this.binding?.getTargetRoots(sessionId) ?? [
        this.binding?.cwd ?? this.binding?.workspaceRoot ?? process.cwd(),
      ],
    });
  }

  resolvePreferredLevel(
    sessionId: string,
    fallback: VerificationLevel = this.config.verification.defaultLevel,
  ): VerificationLevel {
    const state = this.store.get(sessionId);
    if (
      state.lastOutcomeLevel &&
      state.lastOutcomeReferenceWriteAt !== undefined &&
      state.lastOutcomeReferenceWriteAt === state.lastWriteAt
    ) {
      return state.lastOutcomeLevel;
    }
    return fallback;
  }

  evaluate(
    sessionId: string,
    level: VerificationLevel = this.resolvePreferredLevel(sessionId),
    options: VerificationGateOptions = {},
  ): VerificationReport {
    const requireCommands = options.requireCommands === true;
    const state = this.store.get(sessionId);
    const hasWrite = Boolean(state.lastWriteAt);
    const lastWriteAt = state.lastWriteAt ?? 0;
    const plan = this.resolvePlan(sessionId, level);

    const checks = plan.checks.map((check) => {
      if (!hasWrite) {
        return {
          name: check.name,
          status: "skip",
        } as const;
      }

      const checkRun = state.checkRuns[check.name];
      const freshRun = checkRun && isFresh(checkRun.timestamp, lastWriteAt) ? checkRun : undefined;

      if (!check.command.trim()) {
        return {
          name: check.name,
          status: "missing",
          evidence: `verification command not configured: ${check.name}`,
        } as const;
      }

      if (!checkRun) {
        return {
          name: check.name,
          status: "missing",
          evidence: requireCommands
            ? `missing command run: ${check.command}`
            : `verification command has not been run since the latest write: ${check.command}`,
        } as const;
      }

      if (!freshRun) {
        return {
          name: check.name,
          status: "missing",
          evidence: `verification command result is stale since the latest write: ${check.command}`,
        } as const;
      }

      return {
        name: check.name,
        status: freshRun.ok ? "pass" : "fail",
        evidence: `${freshRun.ok ? "pass" : "fail"} (${freshRun.exitCode ?? "null"}) ${freshRun.command}`,
      } as const;
    });

    const failedChecks = hasWrite
      ? checks.filter((check) => check.status === "fail").map((check) => check.name)
      : [];
    const missingChecks = hasWrite
      ? checks.filter((check) => check.status === "missing").map((check) => check.name)
      : [];
    const missingEvidence = hasWrite
      ? checks
          .filter((check) => check.status === "missing")
          .map((check) => {
            if (requireCommands) {
              return check.name;
            }
            return (
              plan.checks.find((entry) => entry.name === check.name)?.missingLabel ?? check.name
            );
          })
      : [];

    const passed = failedChecks.length === 0 && missingChecks.length === 0;
    if (passed) {
      this.store.resetDenials(sessionId);
    } else {
      this.store.bumpDenials(sessionId);
    }

    return {
      passed,
      readOnly: !hasWrite,
      skipped: !hasWrite,
      reason: !hasWrite ? "read_only" : undefined,
      level,
      failedChecks,
      missingChecks,
      missingEvidence,
      checks,
    };
  }
}
