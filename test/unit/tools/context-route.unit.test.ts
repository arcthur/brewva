import { describe, expect, test } from "bun:test";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools/contracts";
import { createContextRouteTool } from "@brewva/brewva-tools/memory";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

function createRuntime(): BrewvaToolRuntime {
  return {
    identity: { cwd: "/tmp/brewva", workspaceRoot: "/tmp/brewva", agentId: "agent-test" },
    config: {} as BrewvaToolRuntime["config"],
    capabilities: {} as unknown as BrewvaToolRuntime["capabilities"],
    extensions: {},
  };
}

function run(content: string, spanRef?: string) {
  return createContextRouteTool({ runtime: createRuntime() }).execute(
    "call",
    { content, ...(spanRef ? { span_ref: spanRef } : {}) } as never,
    new AbortController().signal,
    async () => undefined,
    {} as never,
  );
}

const BUILD_LOG = [
  "2026-06-14T10:00:00Z INFO building package",
  "2026-06-14T10:00:01Z WARN deprecated api used",
  "2026-06-14T10:00:02Z ERROR compilation failed",
  "    at compile (src/build.ts:42:7)",
  "2026-06-14T10:00:03Z INFO build finished with errors",
].join("\n");

describe("context_route", () => {
  test("returns a reduction candidate for a reducible span", async () => {
    const payload = toolOutcomePayload(await run(BUILD_LOG, "message:5")) as {
      ok: boolean;
      candidate: { spanRef: string; detectedShape: string; estimatedTokensSaved: number } | null;
    };

    expect(payload.ok).toBe(true);
    expect(payload.candidate?.spanRef).toBe("message:5");
    expect(payload.candidate?.detectedShape).toBe("build_log");
    expect(payload.candidate?.estimatedTokensSaved).toBeGreaterThan(0);
  });

  test("returns no candidate for prose with no worthwhile reduction", async () => {
    const payload = toolOutcomePayload(
      await run("This is an ordinary explanatory paragraph about the system, in plain prose."),
    ) as { ok: boolean; candidate: null };

    expect(payload.ok).toBe(true);
    expect(payload.candidate).toBeNull();
  });
});
