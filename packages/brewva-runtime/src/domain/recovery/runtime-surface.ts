import type { RecoveryPostureSnapshot, RecoveryWorkingSetSnapshot } from "../context/api.js";
import type { RecoveryWalRecoveryResult } from "../schedule/api.js";
import type { RecoveryWalStore } from "./wal-store.js";

export interface RecoverySurfaceDependencies {
  recoveryWalStore: RecoveryWalStore;
  getRecoveryPosture(sessionId: string): RecoveryPostureSnapshot;
  getRecoveryWorkingSet(sessionId: string): RecoveryWorkingSetSnapshot | undefined;
  recoverRecoveryWal(): Promise<RecoveryWalRecoveryResult>;
}

export function createRecoverySurfaceMethods(deps: RecoverySurfaceDependencies) {
  return {
    listPending: () => deps.recoveryWalStore.listPending(),
    getPosture: (sessionId: string) => deps.getRecoveryPosture(sessionId),
    getWorkingSet: (sessionId: string) => deps.getRecoveryWorkingSet(sessionId),
    recover: () => deps.recoverRecoveryWal(),
    compact: () => deps.recoveryWalStore.compact(),
  };
}

export type RuntimeRecoverySurfaceMethods = ReturnType<typeof createRecoverySurfaceMethods>;

export function createRecoveryInspectSurface(deps: RecoverySurfaceDependencies) {
  const methods = createRecoverySurfaceMethods(deps);
  return {
    listPending: methods.listPending,
    getPosture: methods.getPosture,
    getWorkingSet: methods.getWorkingSet,
  };
}

export function createRecoveryOperatorSurface(deps: RecoverySurfaceDependencies) {
  const methods = createRecoverySurfaceMethods(deps);
  return {
    recover: methods.recover,
    compact: methods.compact,
  };
}
