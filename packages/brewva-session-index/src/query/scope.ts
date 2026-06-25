import { sep } from "node:path";
import type { SessionIndexScope } from "../api.js";
import type { SqlParams } from "../sql/params.js";

export function buildSessionScopeSql(input: {
  scope: SessionIndexScope;
  targetRoots: readonly string[];
  workspaceRoot: string;
  params: SqlParams;
}): string {
  if (input.scope === "workspace_wide") {
    return "true";
  }
  if (input.scope === "session_local") {
    return "sessions.session_id = $currentSessionId";
  }
  const clauses = input.targetRoots.map((root, index) => {
    const rootKey = `scopeRoot${index}`;
    const prefixKey = `scopeRootPrefix${index}`;
    const separatorKey = `scopeSeparator${index}`;
    input.params[rootKey] = root;
    input.params[prefixKey] = root.endsWith(sep) ? root : `${root}${sep}`;
    input.params[separatorKey] = sep;
    return `
      session_target_roots.target_root = $${rootKey}
      or instr(session_target_roots.target_root, $${prefixKey}) = 1
      or instr($${rootKey}, session_target_roots.target_root || $${separatorKey}) = 1
    `;
  });
  input.params.repositoryRoot = input.workspaceRoot;
  return `
    sessions.repository_root = $repositoryRoot
    and exists (
      select 1
      from session_target_roots
      where session_target_roots.session_id = sessions.session_id
        and (${clauses.join(" or ")})
    )
  `;
}
