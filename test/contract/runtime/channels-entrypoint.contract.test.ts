import { describe, expect, test } from "bun:test";

describe("runtime channels entrypoint", () => {
  test("keeps channel contracts out of runtime root surface", async () => {
    const runtime = await import("@brewva/brewva-runtime");
    expect("ChannelTurnBridge" in runtime).toBe(false);
    expect("buildChannelSessionId" in runtime).toBe(false);
    expect("DEFAULT_CHANNEL_CAPABILITIES" in runtime).toBe(false);
  });

  test("exposes channel contracts from dedicated channels subpath", async () => {
    const channels = await import("@brewva/brewva-runtime/channels");
    expect(typeof channels.ChannelTurnBridge).toBe("function");
    expect(typeof channels.buildChannelSessionId).toBe("function");
    expect(channels.DEFAULT_CHANNEL_CAPABILITIES.inlineActions).toBe(false);
  });
});
