import { telegramChannelLauncher } from "./bridges/telegram/launcher.js";
import type { ChannelModeLauncher, SupportedChannel } from "./launcher.js";

export const DEFAULT_CHANNEL_LAUNCHERS: Record<SupportedChannel, ChannelModeLauncher> = {
  telegram: telegramChannelLauncher,
};
