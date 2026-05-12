import {
  BrewvaEffect,
  fromAbortableBoundaryPromise,
  runEdgeOperation,
  type BrewvaBoundaryError,
} from "@brewva/brewva-effect";
import type { RunChannelModeOptions } from "./types.js";
import { runChannelModeOperation } from "./wiring.js";

export type { RunChannelModeOptions } from "./types.js";
export type { RunChannelModeDependencies } from "./ports.js";

export function runChannelModeEffect(
  options: RunChannelModeOptions,
): BrewvaEffect.Effect<void, BrewvaBoundaryError> {
  return fromAbortableBoundaryPromise(() => runChannelModeOperation(options));
}

export async function runChannelMode(options: RunChannelModeOptions): Promise<void> {
  return runEdgeOperation("brewva.channel.mode", runChannelModeEffect(options), {
    fields: {
      channel: options.channel,
      agentId: options.agentId,
    },
  });
}
