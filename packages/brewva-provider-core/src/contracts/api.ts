export type KnownApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-genai";

export type Api = KnownApi | (string & {});

export type KnownProvider =
  | "anthropic"
  | "google"
  | "google-genai"
  | "openai"
  | "openai-codex"
  | "github-copilot"
  | "deepseek"
  | "openrouter"
  | "kimi-coding"
  | "moonshot-cn"
  | "moonshot-ai";

export type Provider = KnownProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export type Transport = "sse" | "websocket" | "auto";
