import { RecoveryWalRecovery as InternalRecoveryWalRecovery } from "./domain/recovery/api.js";
import { RecoveryWalStore as InternalRecoveryWalStore } from "./domain/recovery/api.js";
import { SchedulerService as InternalSchedulerService } from "./domain/schedule/api.js";
import { createBoundExtensionPort, type ExtensionPort } from "./runtime/runtime-extensions.js";

const RECOVERY_WAL_STORE_METHODS = [
  "getScope",
  "isWalEnabled",
  "getIntegrityIssues",
  "appendPending",
  "markInflight",
  "markDone",
  "markFailed",
  "markExpired",
  "listPending",
  "listCurrent",
  "getIngressHighWatermark",
  "compact",
] as const satisfies readonly (keyof InstanceType<typeof InternalRecoveryWalStore>)[];
const RECOVERY_WAL_RECOVERY_METHODS = [
  "recover",
  "recoverEffect",
] as const satisfies readonly (keyof InstanceType<typeof InternalRecoveryWalRecovery>)[];
const SCHEDULER_SERVICE_METHODS = [
  "getProjectionPath",
  "snapshot",
  "getStats",
  "stop",
  "syncExecutionState",
  "recover",
  "createIntent",
  "cancelIntent",
  "updateIntent",
  "listIntents",
] as const satisfies readonly (keyof InstanceType<typeof InternalSchedulerService>)[];

export type RecoveryWalStore = ExtensionPort<
  "recovery.wal-store",
  Pick<InstanceType<typeof InternalRecoveryWalStore>, (typeof RECOVERY_WAL_STORE_METHODS)[number]>
>;
export type RecoveryWalRecovery = ExtensionPort<
  "recovery.wal-recovery",
  Pick<
    InstanceType<typeof InternalRecoveryWalRecovery>,
    (typeof RECOVERY_WAL_RECOVERY_METHODS)[number]
  >
>;
export type SchedulerService = ExtensionPort<
  "recovery.scheduler-service",
  Pick<InstanceType<typeof InternalSchedulerService>, (typeof SCHEDULER_SERVICE_METHODS)[number]>
>;
export type {
  RecoveryWalAppendPendingOptions,
  RecoveryWalCompactResult,
  RecoveryWalStoreOptions,
} from "./domain/recovery/api.js";
export type {
  RecoveryWalRecoverHandler,
  RecoveryWalRecoverHandlerInput,
  RecoveryWalRecoveryError,
  RecoveryWalRecoveryOptions,
} from "./domain/recovery/api.js";
export type {
  SchedulerCatchUpSessionSummary,
  SchedulerCatchUpSummary,
  SchedulerRecoverResult,
  SchedulerRuntimePort,
  SchedulerServiceOptions,
  SchedulerStats,
  ScheduleIntentExecutionResult,
} from "./domain/schedule/api.js";

export function createRecoveryWalStore(
  options: ConstructorParameters<typeof InternalRecoveryWalStore>[0],
): RecoveryWalStore {
  return createBoundExtensionPort({
    name: "recovery.wal-store",
    instance: new InternalRecoveryWalStore(options),
    methods: RECOVERY_WAL_STORE_METHODS,
  });
}

export function createRecoveryWalRecovery(
  options: ConstructorParameters<typeof InternalRecoveryWalRecovery>[0],
): RecoveryWalRecovery {
  return createBoundExtensionPort({
    name: "recovery.wal-recovery",
    instance: new InternalRecoveryWalRecovery(options),
    methods: RECOVERY_WAL_RECOVERY_METHODS,
  });
}

export function createSchedulerService(
  options: ConstructorParameters<typeof InternalSchedulerService>[0],
): SchedulerService {
  return createBoundExtensionPort({
    name: "recovery.scheduler-service",
    instance: new InternalSchedulerService(options),
    methods: SCHEDULER_SERVICE_METHODS,
  });
}
