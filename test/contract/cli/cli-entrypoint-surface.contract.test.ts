import { describe, expect, test } from "bun:test";

describe("cli entrypoint surface", () => {
  test("keeps session helpers on gateway host instead of cli root", async () => {
    const [cli, gatewayHost] = await Promise.all([
      import("@brewva/brewva-cli"),
      import("@brewva/brewva-gateway/host"),
    ]);

    expect(typeof cli.parseArgs).toBe("function");
    expect(typeof cli.writeJsonLine).toBe("function");
    expect("createBrewvaSession" in cli).toBe(false);
    expect("registerRuntimeCoreEventBridge" in cli).toBe(false);

    expect(typeof gatewayHost.createHostedSession).toBe("function");
    expect(typeof gatewayHost.registerRuntimeCoreEventBridge).toBe("function");
  });
});
