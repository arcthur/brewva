import { describe, expect, test } from "bun:test";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools";
import { Type } from "@sinclair/typebox";
import { textResult } from "../../../packages/brewva-tools/src/utils/result.js";
import {
  createManagedBrewvaToolFactory,
  createRuntimeBoundBrewvaToolFactory,
} from "../../../packages/brewva-tools/src/utils/runtime-bound-tool.js";
import { getBrewvaToolMetadata } from "../../../packages/brewva-tools/src/utils/tool.js";

function createToolRuntimeFixture(): BrewvaToolRuntime {
  return {
    cwd: "/tmp/brewva",
    workspaceRoot: "/tmp/brewva",
    agentId: "agent-test",
    config: {} as BrewvaToolRuntime["config"],
    authority: {
      tools: {
        requestResourceLease(sessionId: string) {
          return { ok: true, sessionId };
        },
        rollbackLastPatchSet(sessionId: string) {
          return {
            ok: true,
            sessionId,
            restoredPaths: [],
            failedPaths: [],
          };
        },
      },
    } as unknown as BrewvaToolRuntime["authority"],
    inspect: {
      tools: {
        listResourceLeases(sessionId: string) {
          return [{ id: "lease-1", sessionId }];
        },
      },
    } as unknown as BrewvaToolRuntime["inspect"],
  };
}

describe("runtime-bound managed Brewva tool factory", () => {
  test("managed tool factory enforces canonical tool names without runtime binding", async () => {
    const factory = createManagedBrewvaToolFactory("process");
    const tool = factory.define({
      name: "process",
      label: "Process",
      description: "test",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return textResult("ok", { ok: true });
      },
    });

    const result = await tool.execute(
      "call-1",
      {},
      new AbortController().signal,
      () => undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({ ok: true });
    expect(() =>
      factory.define({
        name: "exec",
        label: "Mismatch",
        description: "test",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          return textResult("ok", { ok: true });
        },
      }),
    ).toThrow("managed Brewva tool definition mismatch: expected 'process', received 'exec'.");
  });

  test("wraps managed tools with scoped runtime access and canonical metadata", async () => {
    const factory = createRuntimeBoundBrewvaToolFactory(
      createToolRuntimeFixture(),
      "resource_lease",
    );
    const tool = factory.define(
      {
        name: "resource_lease",
        label: "Resource Lease",
        description: "test",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          const leases = factory.runtime.inspect.tools.listResourceLeases("session-1", {} as never);
          expect(leases).toHaveLength(1);
          expect(() =>
            (factory.runtime as BrewvaToolRuntime).authority.tools.rollbackLastPatchSet(
              "session-1",
            ),
          ).toThrow(
            "managed Brewva tool 'resource_lease' attempted to access protected runtime capability 'authority.tools.rollbackLastPatchSet' without declaring it.",
          );
          const result = factory.runtime.authority.tools.requestResourceLease(
            "session-1",
            {} as never,
          );
          expect(result.ok).toBe(true);
          return textResult("ok", { ok: true });
        },
      },
      {
        requiredCapabilities: [
          "authority.tools.requestResourceLease",
          "inspect.tools.listResourceLeases",
        ],
      },
    );

    const result = await tool.execute(
      "call-1",
      {},
      new AbortController().signal,
      () => undefined,
      {} as never,
    );

    expect(getBrewvaToolMetadata(tool)?.requiredCapabilities).toEqual([
      "authority.tools.requestResourceLease",
      "inspect.tools.listResourceLeases",
    ]);
    expect(result.details).toMatchObject({ ok: true });
  });

  test("fails fast when the built tool name drifts from the scoped runtime name", () => {
    const factory = createRuntimeBoundBrewvaToolFactory(
      createToolRuntimeFixture(),
      "resource_lease",
    );
    expect(() =>
      factory.define({
        name: "rollback_last_patch",
        label: "Mismatch",
        description: "test",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          return textResult("ok", { ok: true });
        },
      }),
    ).toThrow(
      "managed Brewva tool definition mismatch: expected 'resource_lease', received 'rollback_last_patch'.",
    );
  });
});
