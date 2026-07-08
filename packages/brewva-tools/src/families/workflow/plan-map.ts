import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  planMapBlocked,
  planMapClaimed,
  planMapDecisions,
  planMapFrontier,
  planMapInvalidated,
  planMapOutOfScope,
  type PlanMapState,
} from "@brewva/brewva-vocabulary/plan-map";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import {
  claimPlanTicket,
  closePlanTicket,
  createPlanMap,
  getPlanMapState,
  graduatePlanFog,
  openPlanTicket,
  recordPlanFog,
  rescopePlanTicket,
  resolvePlanTicket,
  unclaimPlanTicket,
} from "../../runtime-port/plan-map.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

function section(label: string, items: readonly { readonly title: string }[]): string {
  if (items.length === 0) {
    return `${label} (0)`;
  }
  return `${label} (${items.length}):\n${items.map((item) => `  - ${item.title}`).join("\n")}`;
}

/** The low-resolution map: refer to every ticket by its title, never a bare id. */
function formatPlanMapText(map: PlanMapState): string {
  const lines = [
    `Map: ${map.destination}`,
    map.notes ? `Notes: ${map.notes}` : undefined,
    section("Frontier", planMapFrontier(map)),
    section("Blocked", planMapBlocked(map)),
    section("Claimed", planMapClaimed(map)),
    section("Decisions", planMapDecisions(map)),
    section("Out of scope", planMapOutOfScope(map)),
    section("Invalidated", planMapInvalidated(map)),
    section(
      "Not yet specified",
      map.notYetSpecified.map((patch) => ({ title: patch.text })),
    ),
    section(
      "Graduated fog",
      map.graduatedFog.map((graduation) => ({
        title: `${graduation.text} → ${graduation.intoTicketIds.length} ticket(s)`,
      })),
    ),
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

const TICKET_TYPE = Type.Union([
  Type.Literal("research"),
  Type.Literal("prototype"),
  Type.Literal("grilling"),
  Type.Literal("task"),
  Type.Literal("decision"),
]);

export function createPlanMapTools(options: BrewvaToolOptions): ToolDefinition[] {
  const createFactory = createRuntimeBoundBrewvaToolFactory(options.runtime, "create_plan_map");
  const getFactory = createRuntimeBoundBrewvaToolFactory(options.runtime, "get_plan_map");
  const openFactory = createRuntimeBoundBrewvaToolFactory(options.runtime, "open_plan_ticket");
  const claimFactory = createRuntimeBoundBrewvaToolFactory(options.runtime, "claim_plan_ticket");
  const resolveFactory = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "resolve_plan_ticket",
  );
  const closeFactory = createRuntimeBoundBrewvaToolFactory(options.runtime, "close_plan_ticket");
  const rescopeFactory = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "rescope_plan_ticket",
  );
  const recordFogFactory = createRuntimeBoundBrewvaToolFactory(options.runtime, "record_fog");
  const graduateFogFactory = createRuntimeBoundBrewvaToolFactory(options.runtime, "graduate_fog");
  const unclaimFactory = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "unclaim_plan_ticket",
  );

  const createTool = createFactory.define(
    {
      name: "create_plan_map",
      label: "Create Plan Map",
      description: "Chart a durable, cross-session planning map toward a destination.",
      promptSnippet:
        "Name the destination the map is finding its way to. Create once per effort; the mapId is the effort's key.",
      parameters: Type.Object({
        mapId: Type.String(),
        destination: Type.String(),
        notes: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = createPlanMap(createFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          destination: params.destination,
          notes: params.notes,
        });
        return result.ok
          ? okTextResult(formatPlanMapText(result.map), result)
          : errTextResult(`Create plan map rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  const getTool = getFactory.define(
    {
      name: "get_plan_map",
      label: "Get Plan Map",
      description: "Read the low-resolution planning map: decisions, frontier, blocked, and fog.",
      promptSnippet: "Load the map before choosing which frontier ticket to work.",
      parameters: Type.Object({ mapId: Type.String() }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const map = getPlanMapState(getFactory.runtime, params.mapId);
        if (!map) {
          return errTextResult(`No plan map found for ${params.mapId}.`, {
            ok: false,
            error: "map_not_found",
          });
        }
        return okTextResult(formatPlanMapText(map), { ok: true, map });
      },
    },
    { surface: "control_plane", actionClass: "runtime_observe" },
  );

  const openTool = openFactory.define(
    {
      name: "open_plan_ticket",
      label: "Open Plan Ticket",
      description:
        "Open a single-session-sized ticket on the map; the result carries its id for blocking edges.",
      promptSnippet:
        "One sharp question per ticket. Set blockedBy to sibling ticket ids that must close first.",
      parameters: Type.Object({
        mapId: Type.String(),
        type: TICKET_TYPE,
        title: Type.String(),
        question: Type.String(),
        blockedBy: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = openPlanTicket(openFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          type: params.type,
          title: params.title,
          question: params.question,
          blockedBy: params.blockedBy,
        });
        return result.ok
          ? okTextResult(
              `Opened ticket ${result.ticketId}.\n${formatPlanMapText(result.map)}`,
              result,
            )
          : errTextResult(`Open plan ticket rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  const resolveTool = resolveFactory.define(
    {
      name: "resolve_plan_ticket",
      label: "Resolve Plan Ticket",
      description: "Record a ticket's decision (the answer) and close it as resolved.",
      promptSnippet: "Resolve only with a real answer; an empty answer is rejected.",
      parameters: Type.Object({
        mapId: Type.String(),
        ticketId: Type.String(),
        answer: Type.String(),
        assetRefs: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = resolvePlanTicket(resolveFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          ticketId: params.ticketId,
          answer: params.answer,
          assetRefs: params.assetRefs,
        });
        return result.ok
          ? okTextResult(formatPlanMapText(result.map), result)
          : errTextResult(`Resolve plan ticket rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  const closeTool = closeFactory.define(
    {
      name: "close_plan_ticket",
      label: "Close Plan Ticket",
      description: "Close a ticket out of scope (ruled beyond the destination) or invalidated.",
      promptSnippet:
        "Use out_of_scope for work past the destination; it is recorded, never resolved. Resolution has its own tool.",
      parameters: Type.Object({
        mapId: Type.String(),
        ticketId: Type.String(),
        reason: Type.Union([Type.Literal("out_of_scope"), Type.Literal("invalidated")]),
        why: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = closePlanTicket(closeFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          ticketId: params.ticketId,
          reason: params.reason,
          why: params.why,
        });
        return result.ok
          ? okTextResult(formatPlanMapText(result.map), result)
          : errTextResult(`Close plan ticket rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  const claimTool = claimFactory.define(
    {
      name: "claim_plan_ticket",
      label: "Claim Plan Ticket",
      description: "Claim a frontier ticket so concurrent sessions take disjoint work.",
      promptSnippet:
        "Claim a ticket before working it; omit ticketId to take the first frontier ticket. First claim in file order wins; a lost race returns claim_lost.",
      parameters: Type.Object({
        mapId: Type.String(),
        ticketId: Type.Optional(Type.String()),
        owner: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = claimPlanTicket(claimFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          ticketId: params.ticketId,
          owner: params.owner,
        });
        return result.ok
          ? okTextResult(formatPlanMapText(result.map), result)
          : errTextResult(`Claim plan ticket rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  const unclaimTool = unclaimFactory.define(
    {
      name: "unclaim_plan_ticket",
      label: "Unclaim Plan Ticket",
      description: "Release a claim so the ticket returns to the frontier for another session.",
      promptSnippet:
        "Unclaim a ticket you are abandoning, or reclaim a stranded ticket from a crashed session (any session may release a claim).",
      parameters: Type.Object({
        mapId: Type.String(),
        ticketId: Type.String(),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = unclaimPlanTicket(unclaimFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          ticketId: params.ticketId,
        });
        return result.ok
          ? okTextResult(formatPlanMapText(result.map), result)
          : errTextResult(`Unclaim plan ticket rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  const rescopeTool = rescopeFactory.define(
    {
      name: "rescope_plan_ticket",
      label: "Rescope Plan Ticket",
      description:
        "Re-frame an open ticket's type, title, or question in place, keeping its id and blocking edges.",
      promptSnippet:
        "Rescope a mis-framed but still on-route ticket; at least one of type/title/question must change. To rule a ticket out entirely, close it out_of_scope instead.",
      parameters: Type.Object({
        mapId: Type.String(),
        ticketId: Type.String(),
        type: Type.Optional(TICKET_TYPE),
        title: Type.Optional(Type.String()),
        question: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = rescopePlanTicket(rescopeFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          ticketId: params.ticketId,
          type: params.type,
          title: params.title,
          question: params.question,
        });
        return result.ok
          ? okTextResult(formatPlanMapText(result.map), result)
          : errTextResult(`Rescope plan ticket rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  const recordFogTool = recordFogFactory.define(
    {
      name: "record_fog",
      label: "Record Fog",
      description:
        "Record a Not-yet-specified fog patch: an in-scope question too unsharp to ticket yet.",
      promptSnippet:
        "Park a question you cannot ticket sharply yet; the result carries the patch id to graduate it later.",
      parameters: Type.Object({
        mapId: Type.String(),
        text: Type.String(),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = recordPlanFog(recordFogFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          text: params.text,
        });
        return result.ok
          ? okTextResult(
              `Recorded fog ${result.patchId}.\n${formatPlanMapText(result.map)}`,
              result,
            )
          : errTextResult(`Record fog rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  const graduateFogTool = graduateFogFactory.define(
    {
      name: "graduate_fog",
      label: "Graduate Fog",
      description:
        "Graduate a fog patch into the fresh tickets it became; the patch leaves the Not-yet-specified list.",
      promptSnippet: "Open the fresh tickets first, then graduate the fog patch citing their ids.",
      parameters: Type.Object({
        mapId: Type.String(),
        patchId: Type.String(),
        intoTicketIds: Type.Array(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = graduatePlanFog(graduateFogFactory.runtime, params.mapId, {
          sessionId: getSessionId(ctx),
          patchId: params.patchId,
          intoTicketIds: params.intoTicketIds,
        });
        return result.ok
          ? okTextResult(formatPlanMapText(result.map), result)
          : errTextResult(`Graduate fog rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  return [
    createTool,
    getTool,
    openTool,
    claimTool,
    unclaimTool,
    resolveTool,
    closeTool,
    rescopeTool,
    recordFogTool,
    graduateFogTool,
  ];
}
