import { describe, expect, test } from "bun:test";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("hosted runtime event query", () => {
  test("uses canonical tape window semantics for derived event views", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-events-query-window"),
    });

    for (let index = 0; index < 5; index += 1) {
      runtime.ops.task.items.add("query-window-session", {
        id: `item-${index}`,
        text: `item ${index}`,
        timestamp: 1_000 + index,
      });
    }

    expect(
      runtime.ops.events.records
        .query("query-window-session", {
          type: "task.item.added",
          last: 3,
          offset: 1,
          limit: 1,
        })
        .map((event) => event.payload?.id),
    ).toEqual(["item-3"]);
  });
});
