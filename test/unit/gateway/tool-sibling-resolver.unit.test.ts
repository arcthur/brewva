import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  createHostedRuntimeAdapter,
  toToolRuntimeAdapterPort,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

describe("hosted runtime tool sibling resolver", () => {
  test("forwards the gateway-populated sibling registry to the tool-facing runtime", () => {
    const adapter = createHostedRuntimeAdapter({ cwd: mkdtempSync(join(tmpdir(), "brewva-sib-")) });
    const toolRuntime = toToolRuntimeAdapterPort(adapter);

    const fakeRead = { name: "read" } as unknown as BrewvaToolDefinition;

    // Nothing resolves until the gateway registers into the shared registry.
    expect(toolRuntime.toolSiblingResolver?.resolve("read")).toBe(undefined);
    adapter.toolSiblingResolver.register([fakeRead]);

    // The tool-facing runtime resolves via the SAME mutable registry the gateway
    // seeds at assembly — so a bundle tool_chain reaches the session's real read.
    expect(toolRuntime.toolSiblingResolver?.resolve("read")).toBe(fakeRead);

    // First registration per name wins (a later duplicate does not shadow it).
    adapter.toolSiblingResolver.register([{ name: "read" } as unknown as BrewvaToolDefinition]);
    expect(toolRuntime.toolSiblingResolver?.resolve("read")).toBe(fakeRead);
  });
});
