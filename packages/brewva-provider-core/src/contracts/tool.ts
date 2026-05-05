import type { TSchema } from "@sinclair/typebox";
import type { Message } from "./message.js";

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
