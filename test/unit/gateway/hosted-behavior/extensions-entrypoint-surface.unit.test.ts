import { describe, expect, test } from "bun:test";

describe("hosted behavior entrypoint surface", () => {
  test("keeps hosted behavior on explicit gateway subpaths", async () => {
    const [gateway, host, hostedBehavior] = await Promise.all([
      import("@brewva/brewva-gateway"),
      import("@brewva/brewva-gateway/hosted"),
      import("../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js"),
    ]);

    expect(typeof host.createHostedSession).toBe("function");
    expect("adaptRuntimePluginFactories" in host).toBe(false);
    expect(typeof hostedBehavior.createHostedBehaviorHostAdapter).toBe("function");
    expect("createHostedSession" in gateway).toBe(false);
    expect("createHostedBehaviorHostAdapter" in gateway).toBe(false);
  });

  test("does not expose removed memory bridge hook", async () => {
    const hostedBehaviorExports =
      await import("../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js");
    expect("registerMemoryBridge" in hostedBehaviorExports).toBe(false);
  });
});
