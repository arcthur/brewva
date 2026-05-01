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
    expect("RecoveryWalStore" in channels).toBe(false);
    expect("RecoveryWalRecovery" in channels).toBe(false);
  });

  test("exposes Recovery WAL machinery from the dedicated recovery subpath", async () => {
    const recovery = await import("@brewva/brewva-runtime/recovery");
    expect(typeof recovery.createRecoveryWalStore).toBe("function");
    expect(typeof recovery.createRecoveryWalRecovery).toBe("function");
    expect("RecoveryWalStore" in recovery).toBe(false);
    expect("RecoveryWalRecovery" in recovery).toBe(false);
  });

  test("removes the catch-all internal subpath", async () => {
    const internalEntrypoint = "@brewva/brewva-runtime/internal" as string;
    let rejected = false;
    try {
      await import(internalEntrypoint);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
