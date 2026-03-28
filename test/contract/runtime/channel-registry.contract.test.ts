import { describe, expect, test } from "bun:test";
import {
  ChannelAdapterRegistry,
  DEFAULT_CHANNEL_CAPABILITIES,
  type ChannelAdapter,
} from "@brewva/brewva-runtime/channels";

function createAdapter(id: string): ChannelAdapter {
  return {
    id,
    capabilities: () => DEFAULT_CHANNEL_CAPABILITIES,
    start: async () => undefined,
    stop: async () => undefined,
    sendTurn: async () => ({ providerMessageId: "m1" }),
  };
}

describe("channel adapter registry", () => {
  test("given adapter registration without aliases, when resolving ids, then only canonical ids are accepted", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      id: "telegram",
      create: () => createAdapter("telegram"),
    });

    expect(registry.resolveId("telegram")).toBe("telegram");
    expect(registry.resolveId("TG")).toBeUndefined();
    expect(registry.resolveId("tg")).toBeUndefined();
    expect(registry.list()).toEqual([{ id: "telegram" }]);
  });

  test("given conflicting adapter ids, when registering adapter, then registry rejects duplicates", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      id: "telegram",
      create: () => createAdapter("telegram"),
    });
    expect(() =>
      registry.register({
        id: "telegram",
        create: () => createAdapter("telegram"),
      }),
    ).toThrow("adapter already registered: telegram");
  });

  test("given adapter factory output id mismatch, when creating adapter, then registry throws mismatch error", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      id: "telegram",
      create: () => createAdapter("telegram"),
    });
    expect(registry.createAdapter("telegram")?.id).toBe("telegram");

    registry.register({
      id: "slack",
      create: () => createAdapter("discord"),
    });
    expect(() => registry.createAdapter("slack")).toThrow(
      "adapter id mismatch: expected slack, got discord",
    );
  });

  test("given adapter id, when unregistering, then the adapter is removed", () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      id: "telegram",
      create: () => createAdapter("telegram"),
    });
    expect(registry.unregister("telegram")).toBe(true);
    expect(registry.resolveId("telegram")).toBeUndefined();
  });
});
