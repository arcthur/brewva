import { describe, expect, test } from "bun:test";
import { resolveRuntimeSourceIdentity } from "@brewva/brewva-std/runtime-identity";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools/contracts";
import {
  createManagedBrewvaToolFactory,
  getBrewvaToolMetadata,
  createRuntimeBoundBrewvaToolFactory,
} from "@brewva/brewva-tools/registry";
import { Type } from "@sinclair/typebox";
import { okTextResult } from "../../../packages/brewva-tools/src/utils/result.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

function createToolRuntimeFixture(): BrewvaToolRuntime {
  return {
    identity: {
      cwd: "/tmp/brewva",
      workspaceRoot: "/tmp/brewva",
      agentId: "agent-test",
    },
    config: {} as BrewvaToolRuntime["config"],
    capabilities: {
      tools: {
        resourceLeases: {
          request(sessionId: string) {
            return { ok: true, sessionId };
          },
          list(sessionId: string) {
            return [{ id: "lease-1", sessionId }];
          },
        },
        patches: {
          rollbackLastPatchSet(sessionId: string) {
            return {
              ok: true,
              sessionId,
              restoredPaths: [],
              failedPaths: [],
            };
          },
        },
      },
    } as unknown as BrewvaToolRuntime["capabilities"],
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
        return okTextResult("ok", { ok: true });
      },
    });

    const result = await tool.execute(
      "call-1",
      {},
      new AbortController().signal,
      async () => undefined,
      {} as never,
    );

    expect(toolOutcomePayload(result)).toMatchObject({ ok: true });
    expect(() =>
      factory.define({
        name: "exec",
        label: "Mismatch",
        description: "test",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          return okTextResult("ok", { ok: true });
        },
      }),
    ).toThrow("managed Brewva tool definition mismatch: expected 'process', received 'exec'.");
  });

  test("wraps managed tools with scoped runtime access and canonical metadata", async () => {
    const factory = createRuntimeBoundBrewvaToolFactory(
      createToolRuntimeFixture(),
      "resource_lease",
    );
    const tool = factory.define({
      name: "resource_lease",
      label: "Resource Lease",
      description: "test",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const leases = factory.runtime.capabilities.tools.resourceLeases.list(
          "session-1",
          {} as never,
        );
        expect(leases).toHaveLength(1);
        expect(() =>
          (factory.runtime as BrewvaToolRuntime).capabilities.tools.patches.rollbackLastPatchSet(
            "session-1",
          ),
        ).toThrow(
          "managed Brewva tool 'resource_lease' attempted to access protected runtime capability 'capabilities.tools.patches.rollbackLastPatchSet' without declaring it.",
        );
        const result = factory.runtime.capabilities.tools.resourceLeases.request(
          "session-1",
          {} as never,
        );
        expect(result.ok).toBe(true);
        return okTextResult("ok", { ok: true });
      },
    });

    const result = await tool.execute(
      "call-1",
      {},
      new AbortController().signal,
      async () => undefined,
      {} as never,
    );

    expect(getBrewvaToolMetadata(tool)?.requiredCapabilities).toEqual([
      "capabilities.tools.resourceLeases.cancel",
      "capabilities.tools.resourceLeases.list",
      "capabilities.tools.resourceLeases.request",
    ]);
    expect(toolOutcomePayload(result)).toMatchObject({ ok: true });
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
          return okTextResult("ok", { ok: true });
        },
      }),
    ).toThrow(
      "managed Brewva tool definition mismatch: expected 'resource_lease', received 'rollback_last_patch'.",
    );
  });

  test("keeps scoped runtime facades attached to the source runtime identity", () => {
    const runtime = createToolRuntimeFixture();
    const factory = createRuntimeBoundBrewvaToolFactory(runtime, "resource_lease");

    expect(resolveRuntimeSourceIdentity(factory.runtime as object)).toBe(runtime);
  });
});
