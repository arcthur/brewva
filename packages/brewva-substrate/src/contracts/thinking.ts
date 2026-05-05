export const BREWVA_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type BrewvaThinkingLevel = (typeof BREWVA_THINKING_LEVELS)[number];
export type BrewvaReasoningThinkingLevel = Exclude<BrewvaThinkingLevel, "off">;
