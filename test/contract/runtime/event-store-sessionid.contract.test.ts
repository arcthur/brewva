import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  asBrewvaEventType,
  asBrewvaSessionId,
} from "@brewva/brewva-runtime";
import { BrewvaEventStore } from "@brewva/brewva-runtime/internal";
import { createTestWorkspace } from "../../helpers/workspace.js";

function listJsonlFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

describe("BrewvaEventStore session id file mapping", () => {
  test("encodes session ids into distinct files and lists true session ids", () => {
    const workspace = createTestWorkspace("event-store-encoded");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionA = asBrewvaSessionId("heartbeat:rule-1");
    const sessionB = asBrewvaSessionId("heartbeat_rule-1");

    store.append({ sessionId: sessionA, type: "a", timestamp: 100 });
    store.append({ sessionId: sessionB, type: "b", timestamp: 101 });

    const eventsRoot = join(workspace, DEFAULT_BREWVA_CONFIG.infrastructure.events.dir);
    const files = listJsonlFiles(eventsRoot);
    expect(files).toHaveLength(2);
    expect(files).toEqual([expect.stringMatching(/^sess_/), expect.stringMatching(/^sess_/)]);

    const sessionIds = store.listSessionIds();
    expect(new Set(sessionIds)).toEqual(new Set([sessionA, sessionB]));

    expect(store.list(sessionA).map((row) => row.sessionId)).toEqual([sessionA]);
    expect(store.list(sessionB).map((row) => row.sessionId)).toEqual([sessionB]);
  });

  test("ignores non-encoded session jsonl files", () => {
    const workspace = createTestWorkspace("event-store-ignore-legacy");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionA = "heartbeat:rule-1";

    const eventsRoot = join(workspace, DEFAULT_BREWVA_CONFIG.infrastructure.events.dir);
    const legacyPath = join(eventsRoot, "heartbeat_rule-1.jsonl");
    writeFileSync(
      legacyPath,
      JSON.stringify({ id: "evt_legacy_1", sessionId: sessionA, type: "legacy", timestamp: 100 }),
      "utf8",
    );

    expect(store.listSessionIds()).toEqual([]);
    expect(store.list(sessionA)).toEqual([]);
  });

  test("recreates the events directory when it disappears after initialization", () => {
    const workspace = createTestWorkspace("event-store-recreate-events-dir");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = asBrewvaSessionId("heartbeat:rule-1");
    const eventsRoot = join(workspace, DEFAULT_BREWVA_CONFIG.infrastructure.events.dir);

    store.append({ sessionId, type: "startup", timestamp: 100 });
    expect(existsSync(eventsRoot)).toBe(true);

    rmSync(eventsRoot, { recursive: true, force: true });
    expect(existsSync(eventsRoot)).toBe(false);

    store.append({ sessionId, type: "resume", timestamp: 101 });

    expect(existsSync(eventsRoot)).toBe(true);
    expect(store.list(sessionId).map((row) => row.type)).toEqual([asBrewvaEventType("resume")]);
  });
});
