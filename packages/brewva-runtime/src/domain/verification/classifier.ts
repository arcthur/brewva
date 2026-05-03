const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "ast_rename_in_file",
  "ast_grep_replace",
]);

export function isMutationTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName.toLowerCase());
}
