import { asBrewvaToolCallId, asBrewvaToolName } from "../../../core/identifiers.js";
import {
  readSessionUncleanShutdownDiagnosticEventPayload,
  readToolLifecycleEventPayload,
} from "../../../events/descriptors.js";
import {
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
} from "../../../events/registry.js";
import type { SessionHydrationFold, ToolLifecycleHydrationState } from "./fold.js";

export const SESSION_HYDRATION_TOOL_LIFECYCLE_TURN_LIFECYCLE_PLACEMENT = {
  foldId: "session_hydration_tool_lifecycle",
  source: "packages/brewva-runtime/src/domain/sessions/hydration/fold-tool-lifecycle.ts",
  observes: ["effect_authorized", "execution_recorded", "recovery_settled"],
  role: "hydrate",
} as const;

export function createToolLifecycleHydrationFold(): SessionHydrationFold<ToolLifecycleHydrationState> {
  return {
    domain: "tool_lifecycle",
    initial(cell) {
      return {
        openToolCalls: new Map(cell.openToolCalls),
        latestUncleanShutdownDiagnostic: cell.uncleanShutdownDiagnostic,
      };
    },
    fold(state, event) {
      state.latestEventAt = Math.max(state.latestEventAt ?? 0, event.timestamp);

      if (event.type === TOOL_CALL_EVENT_TYPE || event.type === TOOL_EXECUTION_START_EVENT_TYPE) {
        const payload = readToolLifecycleEventPayload(event);
        if (!payload) {
          return;
        }
        const toolCallId = asBrewvaToolCallId(payload.toolCallId);
        const toolName = asBrewvaToolName(payload.toolName);
        state.openToolCalls.set(toolCallId, {
          toolCallId,
          toolName,
          openedAt: event.timestamp,
          ...(typeof event.turn === "number" && Number.isFinite(event.turn)
            ? { turn: Math.max(0, Math.floor(event.turn)) }
            : {}),
          ...(payload.attempt !== undefined ? { attempt: payload.attempt } : {}),
          eventId: event.id,
        });
        return;
      }

      if (event.type === TOOL_EXECUTION_END_EVENT_TYPE) {
        const payload = readToolLifecycleEventPayload(event);
        if (!payload) {
          return;
        }
        state.openToolCalls.delete(asBrewvaToolCallId(payload.toolCallId));
        return;
      }

      if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
        state.lastSessionShutdownAt = event.timestamp;
        state.openToolCalls.clear();
        state.latestUncleanShutdownDiagnostic = undefined;
        return;
      }

      if (event.type === SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE) {
        state.latestUncleanShutdownDiagnostic =
          readSessionUncleanShutdownDiagnosticEventPayload(event) ?? undefined;
      }
    },
    apply(state, cell) {
      cell.openToolCalls = state.openToolCalls;
      cell.uncleanShutdownDiagnostic = state.latestUncleanShutdownDiagnostic;
    },
  };
}
