import type { BrewvaEventRecord } from "@brewva/brewva-runtime/protocol";
import {
  SEARCH_THROTTLE_BLOCK_AFTER,
  SEARCH_THROTTLE_REDUCE_AFTER,
  SEARCH_THROTTLE_WINDOW_MS,
} from "./constants.js";
import type { SearchThrottleState } from "./types.js";

export function computeSearchThrottle(input: {
  events: BrewvaEventRecord[];
  queryCount: number;
  requestedLimit: number;
  now?: number;
}): SearchThrottleState {
  if (input.queryCount !== 1) {
    return {
      level: "normal",
      effectiveLimit: input.requestedLimit,
      recentSingleQueryCalls: 0,
    };
  }

  const now = input.now ?? Date.now();
  let recentSingleQueryCalls = 0;

  for (const event of input.events) {
    if (!event) continue;
    if (now - event.timestamp > SEARCH_THROTTLE_WINDOW_MS) continue;

    const payload = event.payload ?? {};
    const previousQueryCount =
      typeof payload.queryCount === "number" && Number.isFinite(payload.queryCount)
        ? Math.max(0, Math.floor(payload.queryCount))
        : 0;
    if (previousQueryCount === 1) {
      recentSingleQueryCalls += 1;
    }
  }

  const projectedSingleQueryCalls = recentSingleQueryCalls + 1;
  if (projectedSingleQueryCalls > SEARCH_THROTTLE_BLOCK_AFTER) {
    return {
      level: "blocked",
      effectiveLimit: 0,
      recentSingleQueryCalls,
    };
  }

  if (projectedSingleQueryCalls > SEARCH_THROTTLE_REDUCE_AFTER) {
    return {
      level: "limited",
      effectiveLimit: Math.min(input.requestedLimit, 1),
      recentSingleQueryCalls,
    };
  }

  return {
    level: "normal",
    effectiveLimit: input.requestedLimit,
    recentSingleQueryCalls,
  };
}
