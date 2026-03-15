import { describe, expect, test } from "bun:test";

describe("extensions entrypoint surface", () => {
  test("keeps host and runtime plugins on explicit gateway subpaths", async () => {
    const [gateway, host, runtimePlugins] = await Promise.all([
      import("@brewva/brewva-gateway"),
      import("@brewva/brewva-gateway/host"),
      import("@brewva/brewva-gateway/runtime-plugins"),
    ]);

    expect(typeof host.createHostedSession).toBe("function");
    expect(typeof runtimePlugins.createBrewvaExtension).toBe("function");
    expect("createHostedSession" in gateway).toBe(false);
    expect("createBrewvaExtension" in gateway).toBe(false);
  });

  test("does not expose removed memory bridge hook", async () => {
    const extensions = await import("@brewva/brewva-gateway/runtime-plugins");
    expect("registerMemoryBridge" in extensions).toBe(false);
  });
});
