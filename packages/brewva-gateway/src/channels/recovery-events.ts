import {
  RECOVERY_WAL_APPENDED_EVENT_TYPE,
  RECOVERY_WAL_COMPACTED_EVENT_TYPE,
  RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE,
  RECOVERY_WAL_STATUS_CHANGED_EVENT_TYPE,
} from "@brewva/brewva-runtime/protocol";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";

export interface ChannelRecoveryWalEvent {
  sessionId: string;
  type: string;
  payload?: object;
}

export function recordChannelRecoveryWalEvent(
  runtime: HostedRuntimeAdapterPort,
  event: ChannelRecoveryWalEvent,
): void {
  const payload = event.payload ?? {};
  switch (event.type) {
    case RECOVERY_WAL_APPENDED_EVENT_TYPE:
      runtime.ops.channel.recovery.walAppended({ sessionId: event.sessionId, payload });
      return;
    case RECOVERY_WAL_STATUS_CHANGED_EVENT_TYPE:
      runtime.ops.channel.recovery.walStatusChanged({ sessionId: event.sessionId, payload });
      return;
    case RECOVERY_WAL_COMPACTED_EVENT_TYPE:
      runtime.ops.channel.recovery.walCompacted({ sessionId: event.sessionId, payload });
      return;
    case RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE:
      runtime.ops.channel.recovery.walRecoveryCompleted({ sessionId: event.sessionId, payload });
      return;
    default:
      return;
  }
}
