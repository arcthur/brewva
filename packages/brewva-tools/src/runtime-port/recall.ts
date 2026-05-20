import type { RecallBrokerRuntime } from "@brewva/brewva-recall/broker";
import type { BrewvaToolRuntime } from "../contracts/index.js";

const recallRuntimeBySource = new WeakMap<object, RecallBrokerRuntime>();

export function resolveRecallBrokerRuntime(runtime: BrewvaToolRuntime): RecallBrokerRuntime {
  const cached = recallRuntimeBySource.get(runtime);
  if (cached) {
    return cached;
  }
  const records = runtime.capabilities.events.records;
  const resolved: RecallBrokerRuntime = {
    identity: runtime.identity,
    events: {
      records: {
        listSessionIds: () => records.listSessionIds(),
        list: (sessionId, query) => records.list(sessionId, query),
        subscribe: (listener) => records.subscribe(listener),
      },
    },
    task: runtime.capabilities.task,
    skills: runtime.capabilities.skills,
    cacheKey: runtime,
  };
  recallRuntimeBySource.set(runtime, resolved);
  return resolved;
}
