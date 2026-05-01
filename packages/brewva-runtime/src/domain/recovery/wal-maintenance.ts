import type { BrewvaConfig } from "../../config/types.js";
import type { RecoveryWalRecoveryResult } from "../schedule/api.js";
import { RecoveryWalRecovery } from "./wal-recovery.js";

export interface RecoveryWalMaintenanceOptions {
  workspaceRoot: string;
  config: BrewvaConfig["infrastructure"]["recoveryWal"];
  recordEvent(input: { sessionId: string; type: string; payload?: object }): void;
}

export async function recoverRecoveryWal(
  options: RecoveryWalMaintenanceOptions,
): Promise<RecoveryWalRecoveryResult> {
  const recovery = new RecoveryWalRecovery({
    workspaceRoot: options.workspaceRoot,
    config: options.config,
    recordEvent: (input) => options.recordEvent(input),
  });
  return await recovery.recover();
}
