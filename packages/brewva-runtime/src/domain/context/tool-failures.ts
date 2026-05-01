import type { JsonValue } from "../../utils/json.js";

export type ToolFailureClass =
  | "execution"
  | "invocation_validation"
  | "policy_denied"
  | "shell_syntax"
  | "script_composition";

export interface ToolFailureEntry {
  toolName: string;
  args: Record<string, JsonValue>;
  outputText: string;
  turn: number;
  failureClass?: ToolFailureClass;
}
