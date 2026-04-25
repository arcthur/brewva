import { BoxLiteBoxPlane } from "./boxlite/plane.js";
import type { BoxPlane, BoxPlaneOptions } from "./contract.js";
import { InMemoryBoxPlane } from "./plane/in-memory.js";

export type {
  BoxAcquisitionReason,
  BoxCapabilitySet,
  BoxCreateReason,
  BoxExec,
  BoxExecResult,
  BoxExecSpec,
  BoxExecutionObservation,
  BoxExecutionObserveOptions,
  BoxHandle,
  BoxInventory,
  BoxInventoryEntry,
  BoxNetworkCapability,
  BoxPlane,
  BoxPlaneOptions,
  BoxPortCapability,
  BoxScope,
  BoxScopeKind,
  BoxVolumeCapability,
  MaintenanceReport,
  ReleaseReason,
  SnapshotRef,
} from "./contract.js";
export { BoxPlaneError } from "./errors.js";
export { fingerprintBoxScope, normalizeBoxCapabilitySet, normalizeBoxScope } from "./scope.js";

export function createInMemoryBoxPlane(): BoxPlane {
  return new InMemoryBoxPlane();
}

export function createBoxPlane(options: BoxPlaneOptions): BoxPlane {
  return new BoxLiteBoxPlane(options);
}
