import { BrewvaEventStore as InternalBrewvaEventStore } from "./events/store.js";
import { createBoundExtensionPort, type ExtensionPort } from "./runtime/runtime-extensions.js";

const BREWVA_EVENT_STORE_METHODS = [
  "append",
  "appendAnchor",
  "appendCheckpoint",
  "list",
  "listAnchors",
  "listCheckpoints",
  "latest",
  "clearSessionCache",
  "getIntegrityIssues",
  "listSessionIds",
  "getLogPath",
] as const satisfies readonly (keyof InstanceType<typeof InternalBrewvaEventStore>)[];

export {
  appendBrewvaEventRecordToLog,
  appendBrewvaEventRecordToLogIfMissing,
  readBrewvaEventRecordsFromLogPath,
  resolveBrewvaEventLogPath,
} from "./events/store.js";
export { querySessionWireFramesFromEventLog } from "./domain/sessions/api.js";

export type BrewvaEventStore = ExtensionPort<
  "event-log.store",
  "event-log",
  Pick<InstanceType<typeof InternalBrewvaEventStore>, (typeof BREWVA_EVENT_STORE_METHODS)[number]>
>;

export function createBrewvaEventStore(
  ...args: ConstructorParameters<typeof InternalBrewvaEventStore>
): BrewvaEventStore {
  return createBoundExtensionPort({
    name: "event-log.store",
    authority: "event-log",
    capabilityPrefix: "subpath.event-log.store",
    instance: new InternalBrewvaEventStore(...args),
    methods: BREWVA_EVENT_STORE_METHODS,
  });
}
