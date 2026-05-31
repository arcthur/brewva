import type { BrewvaBundledToolOptions } from "../../../contracts/index.js";
import { recordToolRuntimeEvent } from "../../../runtime-port/extensions.js";
import { explainToolAccess } from "../../../runtime-port/tool-access.js";
import { errTextResult } from "../../../utils/result.js";
import { formatBrowserLabel } from "./render.js";

export function enforceRuntimeToolAccess(input: {
  options: BrewvaBundledToolOptions;
  sessionId: string;
  toolName: string;
  args?: Record<string, unknown>;
  cwd: string;
}): { allowed: true } | { allowed: false; result: ReturnType<typeof errTextResult> } {
  const decision = explainToolAccess(input);
  if (decision.allowed) {
    return { allowed: true };
  }

  recordToolRuntimeEvent(input.options.runtime, {
    sessionId: input.sessionId,
    type: "tool_call_blocked",
    payload: {
      schema: "brewva.tool_call_blocked.v1",
      toolName: input.toolName,
      reason: decision.reason ?? "Tool call blocked by runtime policy.",
      decision: null,
      proposalId: null,
      requestId: null,
      manifestBasis: null,
    },
  });

  return {
    allowed: false,
    result: errTextResult(
      `[${formatBrowserLabel(input.toolName)}]\nstatus: failed\nreason: Tool call blocked by runtime policy.${
        decision.reason ? ` ${decision.reason}` : ""
      }`,
      {
        ok: false,
        reason: decision.reason ?? "tool_blocked_by_runtime_policy",
      },
    ),
  };
}
