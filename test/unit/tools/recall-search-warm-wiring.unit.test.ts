import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools/contracts";
import { createRecallSearchTool } from "@brewva/brewva-tools/memory";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";

// Production-wiring test for rfc-recall-next-turn-cache-warming. Next-turn warming
// only pays off if the broker is subscribed to turn.ended BEFORE the session's
// first recall_search — the broker subscribes only in its constructor, and the
// tool now creates it eagerly at construction (not lazily on first execute). So
// building the tool, without ever calling recall_search, must already wire the
// subscription; otherwise the first pull is cold and no prior turn could warm it.
// (The turn.ended -> warm behaviour itself is covered in broker-warm.unit.test.ts.)

interface RecallToolFixture {
  readonly runtime: BrewvaToolRuntime;
  subscriberCount(): number;
}

function createRecallToolFixture(workspaceRoot: string): RecallToolFixture {
  const listeners = new Set<(event: BrewvaEventRecord) => void>();
  const runtime = {
    identity: { cwd: workspaceRoot, workspaceRoot, agentId: "agent-test" },
    config: {} as BrewvaToolRuntime["config"],
    capabilities: {
      events: {
        records: {
          listSessionIds: () => [],
          list: () => [],
          subscribe: (listener: (event: BrewvaEventRecord) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
      task: { target: { getDescriptor: () => ({}) } },
      skills: { catalog: undefined },
    } as unknown as BrewvaToolRuntime["capabilities"],
    extensions: {},
  };
  return {
    runtime,
    subscriberCount: () => listeners.size,
  };
}

describe("recall_search wires next-turn warming at tool construction", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-recall-wiring-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("constructing the tool eagerly subscribes the broker before any recall_search", () => {
    const fixture = createRecallToolFixture(workspaceRoot);

    // Build the tool only — never execute recall_search.
    createRecallSearchTool({ runtime: fixture.runtime });

    // A lazily-created broker would have ZERO subscribers until the first pull (the
    // bug this fixes), so no prior turn.ended could warm it. Eager wiring creates
    // the broker — and its session-index — at construction, so the runtime event
    // stream already has live subscribers (the broker's turn.ended/dirty listener
    // plus the index's catch-up listener) before any recall_search runs.
    expect(fixture.subscriberCount()).toBeGreaterThan(0);
  });
});
