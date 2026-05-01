const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "lsp_rename",
  "ast_grep_replace",
]);

export function isMutationTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName.toLowerCase());
}
