import { describe, expect, test } from "bun:test";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";
import { createPlanMapTools } from "@brewva/brewva-tools/workflow";
import {
  createBundledToolRuntime,
  createRuntimeConfig,
  createRuntimeFixture,
} from "../../helpers/runtime.js";

const planningEnabledFixture = () =>
  createRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.planning.mapEnabled = true;
    }),
  });

const toolContext = (sessionId: string) =>
  ({ sessionManager: { getSessionId: () => sessionId } }) as never;

const NONE = undefined as never;

const PLAN_TOOL_NAMES = [
  "create_plan_map",
  "get_plan_map",
  "open_plan_ticket",
  "claim_plan_ticket",
  "unclaim_plan_ticket",
  "resolve_plan_ticket",
  "close_plan_ticket",
  "rescope_plan_ticket",
  "record_fog",
  "graduate_fog",
];

function textOf(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

function ticketIdOf(openOutput: string): string {
  const match = /Opened ticket (\S+)\./u.exec(openOutput);
  if (!match?.[1]) {
    throw new Error(`no ticket id in open output: ${openOutput}`);
  }
  return match[1];
}

describe("plan-map managed tools", () => {
  test("ships the plan-map tools as control-plane tools when planning is enabled", () => {
    const runtime = createBundledToolRuntime(planningEnabledFixture());
    const tools = buildBrewvaTools({ runtime });
    const planTools = tools.filter((tool) => PLAN_TOOL_NAMES.includes(tool.name));

    expect(planTools.map((tool) => tool.name).toSorted()).toEqual([...PLAN_TOOL_NAMES].toSorted());
    expect(new Set(planTools.map((tool) => getBrewvaToolMetadata(tool)?.surface))).toEqual(
      new Set(["control_plane"]),
    );
  });

  test("keeps the plan-map tools out of the default bundle (opt-in via planning.mapEnabled)", () => {
    const runtime = createBundledToolRuntime(createRuntimeFixture());
    const tools = buildBrewvaTools({ runtime });
    expect(tools.filter((tool) => PLAN_TOOL_NAMES.includes(tool.name))).toEqual([]);
  });

  test("create -> open -> resolve -> get round-trips through the durable map", async () => {
    const runtime = createBundledToolRuntime(createRuntimeFixture());
    const byName = new Map(
      createPlanMapTools({ runtime }).map((tool) => [tool.name, tool] as const),
    );
    const create = byName.get("create_plan_map");
    const get = byName.get("get_plan_map");
    const open = byName.get("open_plan_ticket");
    const resolve = byName.get("resolve_plan_ticket");
    const ctx = toolContext("plan-tool-session");
    const mapId = "effort-x";

    expect(
      (await create!.execute("c", { mapId, destination: "Decide the substrate" }, NONE, NONE, ctx))
        .outcome.kind,
    ).toBe("ok");

    const opened = await open!.execute(
      "o",
      { mapId, type: "decision", title: "Sidecar or tape?", question: "Which substrate holds it?" },
      NONE,
      NONE,
      ctx,
    );
    expect(opened.outcome.kind).toBe("ok");
    const ticketId = ticketIdOf(textOf(opened));

    expect(
      (
        await resolve!.execute(
          "r",
          { mapId, ticketId, answer: "Effort-scoped sidecar" },
          NONE,
          NONE,
          ctx,
        )
      ).outcome.kind,
    ).toBe("ok");

    const got = await get!.execute("g", { mapId }, NONE, NONE, ctx);
    expect(got.outcome.kind).toBe("ok");
    const text = textOf(got);
    expect(text).toContain("Decide the substrate");
    expect(text).toContain("Decisions (1)");
  });

  test("get fails closed for an unknown map; resolve rejects an empty answer", async () => {
    const runtime = createBundledToolRuntime(createRuntimeFixture());
    const byName = new Map(
      createPlanMapTools({ runtime }).map((tool) => [tool.name, tool] as const),
    );
    const create = byName.get("create_plan_map");
    const get = byName.get("get_plan_map");
    const open = byName.get("open_plan_ticket");
    const resolve = byName.get("resolve_plan_ticket");
    const ctx = toolContext("plan-tool-session-2");

    expect((await get!.execute("g", { mapId: "nope" }, NONE, NONE, ctx)).outcome.kind).toBe("err");

    await create!.execute("c", { mapId: "m", destination: "d" }, NONE, NONE, ctx);
    const opened = await open!.execute(
      "o",
      { mapId: "m", type: "task", title: "T", question: "Q?" },
      NONE,
      NONE,
      ctx,
    );
    const ticketId = ticketIdOf(textOf(opened));
    const badResolve = await resolve!.execute(
      "r",
      { mapId: "m", ticketId, answer: "   " },
      NONE,
      NONE,
      ctx,
    );
    expect(badResolve.outcome.kind).toBe("err");
  });
});
