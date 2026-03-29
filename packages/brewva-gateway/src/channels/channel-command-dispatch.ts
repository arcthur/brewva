import type { ChannelCommandMatch } from "./command-router.js";

export interface ChannelPreparedCommand {
  match: ChannelCommandMatch;
  handled: boolean;
  release?: () => void;
}

export interface ChannelCommandDispatchResult {
  handled: boolean;
  routeAgentId?: string;
  routeTask?: string;
}
