import type { ChannelCommandMatch } from "./parser.js";

export interface ChannelPreparedCommand {
  match: ChannelCommandMatch;
  handled: boolean;
  release?: () => void;
}

export interface ChannelCommandDispatchResult {
  handled: boolean;
  routeAgentId?: string;
  routeTask?: string;
  afterRouteSuccess?: () => Promise<void> | void;
}
