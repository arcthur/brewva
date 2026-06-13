import { describe, expect, test } from "bun:test";
import { createManualShellClock } from "../../helpers/manual-shell-clock.js";

describe("createManualShellClock", () => {
  test("fires timers in due-time order when advancing", () => {
    const clock = createManualShellClock();
    const fired: string[] = [];
    clock.schedule(() => fired.push("late"), 30);
    clock.schedule(() => fired.push("early"), 10);
    clock.schedule(() => fired.push("middle"), 20);

    clock.advance(15);
    expect(fired).toEqual(["early"]);
    expect(clock.now()).toBe(15);

    clock.advance(20);
    expect(fired).toEqual(["early", "middle", "late"]);
    expect(clock.now()).toBe(35);
  });

  test("fires ties in scheduling order", () => {
    const clock = createManualShellClock();
    const fired: string[] = [];
    clock.schedule(() => fired.push("first"), 10);
    clock.schedule(() => fired.push("second"), 10);
    clock.advance(10);
    expect(fired).toEqual(["first", "second"]);
  });

  test("cancelled timers never fire", () => {
    const clock = createManualShellClock();
    const fired: string[] = [];
    const handle = clock.schedule(() => fired.push("cancelled"), 10);
    clock.schedule(() => fired.push("kept"), 10);
    handle.cancel();
    clock.runAll();
    expect(fired).toEqual(["kept"]);
    expect(clock.pendingCount()).toBe(0);
  });

  test("timers scheduled inside callbacks fire within the same advance window", () => {
    const clock = createManualShellClock();
    const fired: string[] = [];
    clock.schedule(() => {
      fired.push("outer");
      clock.schedule(() => fired.push("inner"), 5);
    }, 10);

    clock.advance(20);
    expect(fired).toEqual(["outer", "inner"]);
  });

  test("timers scheduled inside callbacks beyond the window stay pending", () => {
    const clock = createManualShellClock();
    const fired: string[] = [];
    clock.schedule(() => {
      fired.push("outer");
      clock.schedule(() => fired.push("inner"), 100);
    }, 10);

    clock.advance(20);
    expect(fired).toEqual(["outer"]);
    expect(clock.pendingCount()).toBe(1);

    clock.advance(100);
    expect(fired).toEqual(["outer", "inner"]);
  });

  test("now() reflects timer due time while firing", () => {
    const clock = createManualShellClock();
    let observed = -1;
    clock.schedule(() => {
      observed = clock.now();
    }, 10);
    clock.advance(50);
    expect(observed).toBe(10);
    expect(clock.now()).toBe(50);
  });
});
