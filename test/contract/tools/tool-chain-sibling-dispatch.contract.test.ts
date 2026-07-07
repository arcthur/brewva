import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaReadToolDefinition } from "@brewva/brewva-substrate/tools";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import type { BrewvaBundledToolRuntime } from "@brewva/brewva-tools/contracts";
import { requireDefined } from "../../helpers/assertions.js";
import { createBundledToolRuntime, createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";
import { fakeContext } from "./tools-flow.helpers.js";

function joinTextParts(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("tool_chain sibling dispatch across the bundle boundary", () => {
  test("a real grep -> read chain reaches the gateway-registered read tool", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tool-chain-siblings-"));
    writeFileSync(join(workspace, "notes.md"), "line one\nTODO findme here\nline three\n", "utf8");

    // `read` is registered on the session by the gateway, NOT in the default
    // bundle — the exact seam the bug lived at. Wire it through the runtime
    // sibling resolver, the way the gateway now does at session assembly.
    const readTool = createBrewvaReadToolDefinition(workspace);
    const baseRuntime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));
    const runtime = {
      ...baseRuntime,
      toolSiblingResolver: {
        resolve: (name: string) => (name === "read" ? readTool : undefined),
      },
    } as unknown as BrewvaBundledToolRuntime;

    const toolChain = requireDefined(
      buildBrewvaTools({ runtime }).find((tool) => tool.name === "tool_chain"),
      "expected tool_chain in the bundle",
    );

    const result = await toolChain.execute(
      "chain-real-siblings",
      {
        steps: [
          { tool: "grep", args: { query: "findme" } },
          { tool: "read", args: { path: "notes.md" } },
        ],
        returnSteps: "all",
      } as never,
      undefined,
      undefined,
      fakeContext("chain-real-siblings"),
    );

    // Before the fix `read` was unreachable: the chain stopped at step 1 with
    // "unknown tool 'read'" even though the description recommends `grep -> read`.
    // Now both real tools run to completion.
    expect(result.outcome.kind).toBe("ok");
    const payload = toolOutcomePayload(result) as { stepsRun?: number; stopped?: boolean };
    // Decisive proof: both steps ran (read was reached + dispatched), none stopped.
    expect(payload).toMatchObject({ stepsRun: 2, stopped: false });
    const text = joinTextParts(result);
    expect(text).toContain("TODO findme here"); // grep matched the real file
    expect(text).toContain("[step 1 · read]"); // read step surfaced (unreachable before the fix)
    expect(text).toContain("line three"); // read returned the real file body
  });

  test("a chain cannot dispatch a bundle tool hidden from the session by managedToolNames", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tool-chain-scope-"));
    writeFileSync(join(workspace, "notes.md"), "hello\n", "utf8");
    const runtime = createBundledToolRuntime(createRuntimeInstanceFixture({ cwd: workspace }));

    // Operator surface excludes source_read: it must be unreachable by a chain
    // too (capability-scope parity), not silently dispatchable via the resolver.
    const tools = buildBrewvaTools({ runtime, toolNames: ["grep", "tool_chain"] });
    const toolChain = requireDefined(
      tools.find((tool) => tool.name === "tool_chain"),
      "expected tool_chain in the filtered bundle",
    );

    const result = await toolChain.execute(
      "chain-scope",
      { steps: [{ tool: "source_read", args: { path: "notes.md" } }] } as never,
      undefined,
      undefined,
      fakeContext("chain-scope"),
    );

    expect(result.outcome.kind).toBe("err");
    const stopReason = (toolOutcomePayload(result) as { stopReason?: string }).stopReason ?? "";
    expect(stopReason).toContain("unknown tool");
  });
});
