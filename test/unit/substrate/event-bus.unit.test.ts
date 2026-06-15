import { describe, expect, test } from "bun:test";
import { createBrewvaEventBus } from "../../../packages/brewva-substrate/src/execution/index.js";

describe("substrate event bus", () => {
  test("settles listeners sequentially and returns the transformed event", async () => {
    const order: string[] = [];
    const { bus, controller } = createBrewvaEventBus<{
      type: "message";
      text: string;
    }>();

    bus.subscribe(async (event) => {
      order.push(`first:${event.text}`);
      await Promise.resolve();
      return { ...event, text: `${event.text}:first` };
    });
    bus.subscribe((event) => {
      order.push(`second:${event.text}`);
      return { ...event, text: `${event.text}:second` };
    });

    expect("emit" in bus).toBe(false);
    expect("subscribe" in controller).toBe(false);
    const result = await controller.emit({ type: "message", text: "start" });

    expect(order).toEqual(["first:start", "second:start:first"]);
    expect(result.text).toBe("start:first:second");
  });

  test("can reject returned events that violate the caller contract", async () => {
    const { bus, controller } = createBrewvaEventBus<
      { type: "keep"; value: number } | { type: "drop"; value: number }
    >({
      acceptReturnedEvent: ({ current, returned }) => returned.type === current.type,
    });

    bus.subscribe(() => ({ type: "drop", value: 2 }));
    bus.subscribe((event) => ({ ...event, value: event.value + 1 }));

    const result = await controller.emit({ type: "keep", value: 1 });

    expect(result).toEqual({ type: "keep", value: 2 });
  });

  test("clear removes listeners", async () => {
    const { bus, controller } = createBrewvaEventBus<{ type: "ping" }>();
    let calls = 0;

    bus.subscribe(() => {
      calls += 1;
    });
    expect(bus.listenerCount()).toBe(1);

    controller.clear();
    await controller.emit({ type: "ping" });

    expect(bus.listenerCount()).toBe(0);
    expect(calls).toBe(0);
  });
});
