import type {
  BrewvaConfig,
  TaskState,
  VerificationLevel,
  VerificationReport,
} from "../contracts/index.js";
import {
  matchesVerificationEvidence,
  resolveVerificationPlan,
  type VerificationPlan,
} from "./profile.js";
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

  evaluate(
    sessionId: string,
    level: VerificationLevel = this.config.verification.defaultLevel,
    options: VerificationGateOptions = {},
  ): VerificationReport {
    const requireCommands = options.requireCommands === true && level !== "quick";
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

      if (requireCommands && check.command) {
        return {
          name: check.name,
          status: freshRun?.ok ? "pass" : "fail",
          evidence: freshRun
            ? `${freshRun.ok ? "pass" : "fail"} (${freshRun.exitCode ?? "null"}) ${freshRun.command}`
            : `missing command run: ${check.command}`,
        } as const;
      }

      const freshEvidence = state.evidence.find(
        (entry) =>
          isFresh(entry.timestamp, lastWriteAt) && matchesVerificationEvidence(entry, check),
      );
      const passed = Boolean((freshRun && freshRun.ok) || freshEvidence);
      return {
        name: check.name,
        status: passed ? "pass" : "fail",
        evidence: freshRun?.command ?? freshEvidence?.detail,
      } as const;
    });

    const missingEvidence = hasWrite
      ? checks
          .filter((check) => check.status === "fail")
          .map((check) => {
            if (requireCommands) {
              return check.name;
            }
            return (
              plan.checks.find((entry) => entry.name === check.name)?.missingLabel ?? check.name
            );
          })
      : [];

    const passed = missingEvidence.length === 0;
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
      missingEvidence,
      checks,
    };
  }
}
