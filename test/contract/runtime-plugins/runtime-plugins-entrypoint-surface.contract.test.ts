import { describe, expect, test } from "bun:test";

describe("runtime plugins entrypoint surface", () => {
  test("keeps host and runtime plugins on explicit gateway subpaths", async () => {
    const [gateway, host, runtimePlugins] = await Promise.all([
      import("@brewva/brewva-gateway"),
      import("@brewva/brewva-gateway/host"),
      import("@brewva/brewva-gateway/runtime-plugins"),
    ]);

    expect(typeof host.createHostedSession).toBe("function");
    expect("adaptRuntimePluginFactories" in host).toBe(false);
    expect(typeof runtimePlugins.createHostedTurnPipeline).toBe("function");
    expect("createHostedSession" in gateway).toBe(false);
    expect("createHostedTurnPipeline" in gateway).toBe(false);
  });

  test("does not expose removed memory bridge hook", async () => {
    const runtimePluginExports = await import("@brewva/brewva-gateway/runtime-plugins");
    expect("registerMemoryBridge" in runtimePluginExports).toBe(false);
  });
});
