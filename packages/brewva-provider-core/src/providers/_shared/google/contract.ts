export type GoogleThinkingLevel =
  | "THINKING_LEVEL_UNSPECIFIED"
  | "MINIMAL"
  | "LOW"
  | "MEDIUM"
  | "HIGH";

export interface GoogleThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: Exclude<GoogleThinkingLevel, "THINKING_LEVEL_UNSPECIFIED">;
}
