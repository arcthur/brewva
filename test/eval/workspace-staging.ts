import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Materialize a map of workspace-relative path -> content into a hermetic
 * workspace, guarding every path against escaping the workspace root. Shared by
 * the eval generic-runtime scenario stager and the self-eval fixture driver so
 * the escape guard — a security-relevant check — has ONE definition rather than
 * a copy per call site.
 */
export function stageWorkspaceFiles(
  files: Readonly<Record<string, string>>,
  workspace: string,
  context: string,
): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = resolve(workspace, relativePath);
    if (absolutePath !== workspace && !absolutePath.startsWith(`${workspace}/`)) {
      throw new Error(`${context}: workspace file path escapes the workspace: ${relativePath}`);
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
}
