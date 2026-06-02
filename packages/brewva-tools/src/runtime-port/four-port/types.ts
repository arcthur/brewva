import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  BrewvaEventRecord,
  BrewvaStructuredEvent,
  ProtocolRecord,
} from "@brewva/brewva-vocabulary/events";
import { RUNTIME_OPS_EVENT_NAMESPACE } from "@brewva/brewva-vocabulary/events";

export type FourPortRuntimeEventRecord = BrewvaStructuredEvent & BrewvaEventRecord & ProtocolRecord;
export type FourPortRuntimeEventListener = (event: FourPortRuntimeEventRecord) => void;

export interface FourPortRuntimeCapabilityContext {
  readonly runtime: BrewvaRuntime;
  readonly listSessionIds?: () => readonly string[];
  readonly listRuntimeEventSessionIds?: () => readonly string[];
  subscribeEvents?(listener: FourPortRuntimeEventListener): () => boolean;
  publishEvent?(event: FourPortRuntimeEventRecord): void;
  rememberSessionId?(sessionId: string): void;
}

export const FOUR_PORT_RUNTIME_OPS_EVENT_NAMESPACES = [RUNTIME_OPS_EVENT_NAMESPACE] as const;
