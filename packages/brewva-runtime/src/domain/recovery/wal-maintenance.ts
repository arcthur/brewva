import { BrewvaEffect, runPromiseAtBoundary } from "@brewva/brewva-effect";
import type { BrewvaConfig } from "../../config/types.js";
import type { RecoveryWalRecoveryResult } from "../schedule/api.js";
import { RecoveryWalRecovery, type RecoveryWalRecoveryError } from "./wal-recovery.js";

export interface RecoveryWalMaintenanceOptions {
  workspaceRoot: string;
  config: BrewvaConfig["infrastructure"]["recoveryWal"];
  recordEvent(input: { sessionId: string; type: string; payload?: object }): void;
}

export async function recoverRecoveryWal(
  options: RecoveryWalMaintenanceOptions,
): Promise<RecoveryWalRecoveryResult> {
  return await runPromiseAtBoundary(recoverRecoveryWalEffect(options));
}

export function recoverRecoveryWalEffect(
  options: RecoveryWalMaintenanceOptions,
): BrewvaEffect.Effect<RecoveryWalRecoveryResult, RecoveryWalRecoveryError> {
  const recovery = new RecoveryWalRecovery({
    workspaceRoot: options.workspaceRoot,
    config: options.config,
    recordEvent: (input) => options.recordEvent(input),
  });
  return recovery.recoverEffect();
}
