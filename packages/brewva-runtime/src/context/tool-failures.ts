export type ToolFailureClass =
  | "execution"
  | "invocation_validation"
  | "shell_syntax"
  | "script_composition";

export interface ToolFailureEntry {
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  turn: number;
  failureClass?: ToolFailureClass;
}
