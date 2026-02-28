import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaEventStore, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `brewva-event-store-${name}-`));
}

function listJsonlFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

describe("BrewvaEventStore session id file mapping", () => {
  test("encodes session ids into distinct files and lists true session ids", () => {
    const workspace = createWorkspace("encoded");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionA = "heartbeat:rule-1";
    const sessionB = "heartbeat_rule-1";

    store.append({ sessionId: sessionA, type: "a", timestamp: 100 });
    store.append({ sessionId: sessionB, type: "b", timestamp: 101 });

    const eventsRoot = join(workspace, DEFAULT_BREWVA_CONFIG.infrastructure.events.dir);
    const files = listJsonlFiles(eventsRoot);
    expect(files).toHaveLength(2);
    expect(files.every((name) => name.startsWith("sess_"))).toBe(true);

    const sessionIds = store.listSessionIds();
    expect(new Set(sessionIds)).toEqual(new Set([sessionA, sessionB]));

    expect(store.list(sessionA).map((row) => row.sessionId)).toEqual([sessionA]);
    expect(store.list(sessionB).map((row) => row.sessionId)).toEqual([sessionB]);
  });

  test("ignores non-encoded session jsonl files", () => {
    const workspace = createWorkspace("ignore-legacy");
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
});
