import { normalizeToolName } from "../../../utils/tool-name.js";
import type { RuntimeToolAuthorityResolver } from "../../runtime-api.js";
import {
  getToolActionPolicyForClass,
  getToolActionPolicyResolution,
  resolveToolAuthority,
  type ToolActionAdmissionOverrides,
} from "./public-contract.js";

// RFC R4 Phase 0 — evidence-gated admission refinement, shadow only.
//
// The admission tree defers whole action classes; the one existing static
// downgrade (`exec` -> local_exec_readonly) shows some ask-class calls have
// statically decidable observation-only semantics. This classifier names the
// next candidates and runs ONLY through the kernel's `shadowToolAuthority`
// seam: zero outcome change, divergence evidence accumulates on the tape.
// Promotion into the real `resolveToolAuthority` seat (Phase 2) is gated on
// zero unsafe-allow divergence over a defined window — numeric, not vibes.
//
// Membership is deliberately conservative — a shape belongs here only when the
// call cannot mutate workspace, external, or session state regardless of
// argument values. Reviewed exclusions (their action policies declare
// `workspace_write` or destructive reads, so classifying them would poison the
// Phase 2 promotion evidence):
//  - browser_snapshot / browser_diff_snapshot / browser_screenshot: always
//    persist an artifact file into the workspace (model-controlled path).
//  - browser_get with field=text: persists a text artifact; only title/url are
//    pure reads.
//  - process poll: drains the session output cursor (destructive read); only
//    list and log are idempotent observations.

export const OBSERVATION_SHAPE_SHADOW_INTERCEPTOR_ID = "observation-shape-shadow/v1";

const BROWSER_GET_OBSERVATION_FIELDS = new Set(["title", "url"]);

const PROCESS_OBSERVATION_ACTIONS = new Set(["list", "log"]);

/**
 * Statically decidable observation-only call shapes inside currently-ask
 * action classes.
 */
export function classifyObservationShape(
  toolName: string,
  args: Record<string, unknown> | undefined,
): { readonly shape: string } | null {
  const normalized = normalizeToolName(toolName);
  if (normalized === "browser_get") {
    const field = typeof args?.field === "string" ? args.field : "";
    if (BROWSER_GET_OBSERVATION_FIELDS.has(field)) {
      return { shape: `browser_observe:get_${field}` };
    }
    return null;
  }
  if (normalized === "process") {
    const action = typeof args?.action === "string" ? args.action : "";
    if (PROCESS_OBSERVATION_ACTIONS.has(action)) {
      return { shape: `process_observe:${action}` };
    }
  }
  return null;
}

export interface ObservationShapeShadowResolverOptions {
  /** The real resolver to fall through to for non-observation shapes. */
  readonly base?: RuntimeToolAuthorityResolver;
  readonly admissionOverrides?: ToolActionAdmissionOverrides;
}

/**
 * Shadow resolver: observation-shaped ask-class calls resolve as
 * `runtime_observe` (would-allow); everything else resolves exactly like the
 * real policy, so divergence evidence isolates the classifier's own claims.
 */
export function createObservationShapeShadowResolver(
  options: ObservationShapeShadowResolverOptions = {},
): RuntimeToolAuthorityResolver {
  const base: RuntimeToolAuthorityResolver =
    options.base ??
    ((toolName, args) =>
      resolveToolAuthority(toolName, undefined, args, options.admissionOverrides));
  return (toolName, args, sessionId) => {
    const classification = classifyObservationShape(toolName, args);
    if (!classification) {
      return base(toolName, args, sessionId);
    }
    return resolveToolAuthority(
      toolName,
      {
        resolve: (name, resolveArgs) => {
          const observed = classifyObservationShape(name, resolveArgs);
          return observed
            ? { policy: getToolActionPolicyForClass("runtime_observe"), source: "exact" }
            : getToolActionPolicyResolution(name, undefined, resolveArgs);
        },
      },
      args,
      options.admissionOverrides,
    );
  };
}
