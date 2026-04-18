import type { BrewvaConfig } from "../contracts/index.js";
import {
  isRecord,
  normalizeBoolean,
  normalizePositiveInteger,
  normalizeStringArray,
  type AnyRecord,
} from "./normalization-shared.js";

const VALID_CHANNEL_SCOPE_STRATEGIES = new Set(["chat", "thread"]);
const VALID_CHANNEL_ACL_MODES = new Set(["open", "closed"]);

export function normalizeChannelsConfig(
  channelsInput: AnyRecord,
  defaults: BrewvaConfig["channels"],
): BrewvaConfig["channels"] {
  const channelsOrchestrationInput = isRecord(channelsInput.orchestration)
    ? channelsInput.orchestration
    : {};
  const channelsOwnersInput = isRecord(channelsOrchestrationInput.owners)
    ? channelsOrchestrationInput.owners
    : {};
  const channelsLimitsInput = isRecord(channelsOrchestrationInput.limits)
    ? channelsOrchestrationInput.limits
    : {};

  return {
    orchestration: {
      enabled: normalizeBoolean(channelsOrchestrationInput.enabled, defaults.orchestration.enabled),
      scopeStrategy: VALID_CHANNEL_SCOPE_STRATEGIES.has(
        channelsOrchestrationInput.scopeStrategy as string,
      )
        ? (channelsOrchestrationInput.scopeStrategy as BrewvaConfig["channels"]["orchestration"]["scopeStrategy"])
        : defaults.orchestration.scopeStrategy,
      aclModeWhenOwnersEmpty: VALID_CHANNEL_ACL_MODES.has(
        channelsOrchestrationInput.aclModeWhenOwnersEmpty as string,
      )
        ? (channelsOrchestrationInput.aclModeWhenOwnersEmpty as BrewvaConfig["channels"]["orchestration"]["aclModeWhenOwnersEmpty"])
        : defaults.orchestration.aclModeWhenOwnersEmpty,
      owners: {
        telegram: normalizeStringArray(
          channelsOwnersInput.telegram,
          defaults.orchestration.owners.telegram,
        ),
      },
      limits: {
        fanoutMaxAgents: normalizePositiveInteger(
          channelsLimitsInput.fanoutMaxAgents,
          defaults.orchestration.limits.fanoutMaxAgents,
        ),
        maxDiscussionRounds: normalizePositiveInteger(
          channelsLimitsInput.maxDiscussionRounds,
          defaults.orchestration.limits.maxDiscussionRounds,
        ),
        a2aMaxDepth: normalizePositiveInteger(
          channelsLimitsInput.a2aMaxDepth,
          defaults.orchestration.limits.a2aMaxDepth,
        ),
        a2aMaxHops: normalizePositiveInteger(
          channelsLimitsInput.a2aMaxHops,
          defaults.orchestration.limits.a2aMaxHops,
        ),
        maxLiveRuntimes: normalizePositiveInteger(
          channelsLimitsInput.maxLiveRuntimes,
          defaults.orchestration.limits.maxLiveRuntimes,
        ),
        idleRuntimeTtlMs: normalizePositiveInteger(
          channelsLimitsInput.idleRuntimeTtlMs,
          defaults.orchestration.limits.idleRuntimeTtlMs,
        ),
      },
    },
  };
}
