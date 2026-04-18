import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  collectPlaneSessionDigests,
  getOrCreatePlaneForRuntime,
  readNormalizedJsonFile,
  reconcileSessionDigestBackedPlaneState,
  shouldThrottlePlaneRefresh,
  writeFileAtomic,
  writeNormalizedJsonFile,
} from "@brewva/brewva-deliberation";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("plane substrate", () => {
  test("collects stable session digests from event-like stores", () => {
    const digests = collectPlaneSessionDigests({
      listSessionIds: () => ["b", "a", "empty"],
      list: (sessionId) => {
        if (sessionId === "a") return [{ timestamp: 10 }, { timestamp: 20 }];
        if (sessionId === "b") return [{ timestamp: 5 }];
        return [];
      },
    });

    expect(digests).toEqual([
      { sessionId: "a", eventCount: 2, lastEventAt: 20 },
      { sessionId: "b", eventCount: 1, lastEventAt: 5 },
    ]);
  });

  test("throttles dirty refresh only inside the configured interval", () => {
    expect(
      shouldThrottlePlaneRefresh({
        currentUpdatedAt: 1_000,
        dirty: true,
        digestsChanged: false,
        minRefreshIntervalMs: 250,
        now: 1_100,
      }),
    ).toBe(true);
    expect(
      shouldThrottlePlaneRefresh({
        currentUpdatedAt: 1_000,
        dirty: true,
        digestsChanged: false,
        minRefreshIntervalMs: 250,
        now: 1_300,
      }),
    ).toBe(false);
    expect(
      shouldThrottlePlaneRefresh({
        currentUpdatedAt: 1_000,
        dirty: false,
        digestsChanged: false,
        minRefreshIntervalMs: 250,
        now: 1_100,
      }),
    ).toBe(false);
  });

  test("writes atomically without leaving fixed tmp artifacts behind", () => {
    const workspace = createTestWorkspace("plane-substrate-atomic-write");
    const filePath = resolve(workspace, ".brewva", "deliberation", "state.json");

    writeFileAtomic(filePath, '{\n  "schema": "one"\n}\n');
    writeFileAtomic(filePath, '{\n  "schema": "two"\n}\n');

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain('"schema": "two"');
    const directoryEntries = readdirSync(join(workspace, ".brewva", "deliberation"));
    expect(directoryEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  test("shared JSON helpers read normalized state and fail soft on malformed content", () => {
    const workspace = createTestWorkspace("plane-substrate-json-read");
    const filePath = resolve(workspace, ".brewva", "deliberation", "state.json");
    mkdirSync(dirname(filePath), { recursive: true });

    writeFileSync(filePath, '{"schema":"ok","updatedAt":1}\n', "utf8");
    expect(
      readNormalizedJsonFile(filePath, (value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "schema" in value &&
          "updatedAt" in value
        ) {
          return value as { schema: string; updatedAt: number };
        }
        return undefined;
      }),
    ).toEqual({
      schema: "ok",
      updatedAt: 1,
    });

    writeFileSync(filePath, "{not-json}\n", "utf8");
    expect(
      readNormalizedJsonFile(filePath, (value) =>
        typeof value === "object" && value !== null ? value : undefined,
      ),
    ).toBeUndefined();
  });

  test("shared JSON helper writes canonical pretty JSON with atomic semantics", () => {
    const workspace = createTestWorkspace("plane-substrate-json-write");
    const filePath = resolve(workspace, ".brewva", "deliberation", "state.json");

    writeNormalizedJsonFile(filePath, {
      schema: "demo",
      updatedAt: 2,
      items: ["a", "b"],
    });

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(
      '{\n  "schema": "demo",\n  "updatedAt": 2,\n  "items": [\n    "a",\n    "b"\n  ]\n}\n',
    );
  });

  test("reuses the same plane instance for the same runtime key", () => {
    const planes = new WeakMap<object, { id: string }>();
    const runtime = { workspaceRoot: "/repo/workspace" };
    let creations = 0;

    const first = getOrCreatePlaneForRuntime({
      planes,
      runtime,
      create: () => {
        creations += 1;
        return { id: "first" };
      },
    });
    const second = getOrCreatePlaneForRuntime({
      planes,
      runtime,
      create: () => {
        creations += 1;
        return { id: "second" };
      },
    });

    expect(first).toBe(second);
    expect(creations).toBe(1);
  });

  test("reuses persisted state when digests are unchanged and the plane is clean", () => {
    const persistedState = {
      updatedAt: 1_000,
      sessionDigests: [{ sessionId: "s1", eventCount: 2, lastEventAt: 20 }],
      value: "persisted",
    };
    let dirtyWrites: boolean[] = [];
    let persistedWrites = 0;
    let rebuilds = 0;

    const nextState = reconcileSessionDigestBackedPlaneState({
      readPersistedState: () => persistedState,
      writePersistedState: () => {
        persistedWrites += 1;
      },
      dirty: false,
      setDirty: (dirty) => {
        dirtyWrites = [...dirtyWrites, dirty];
      },
      collectSessionDigests: () => [{ sessionId: "s1", eventCount: 2, lastEventAt: 20 }],
      createEmptyState: (sessionDigests) => ({
        updatedAt: 0,
        sessionDigests: [...sessionDigests],
        value: "empty",
      }),
      rebuildState: () => {
        rebuilds += 1;
        return {
          updatedAt: 2_000,
          sessionDigests: [{ sessionId: "s1", eventCount: 3, lastEventAt: 30 }],
          value: "rebuilt",
        };
      },
      now: 1_100,
    });

    expect(nextState).toBe(persistedState);
    expect(persistedWrites).toBe(0);
    expect(rebuilds).toBe(0);
    expect(dirtyWrites).toEqual([]);
  });

  test("keeps dirty state unmodified when throttling a refresh inside the configured interval", () => {
    const persistedState = {
      updatedAt: 1_000,
      sessionDigests: [{ sessionId: "s1", eventCount: 2, lastEventAt: 20 }],
      value: "persisted",
    };
    let dirtyWrites: boolean[] = [];
    let persistedWrites = 0;
    let rebuilds = 0;

    const nextState = reconcileSessionDigestBackedPlaneState({
      readPersistedState: () => persistedState,
      writePersistedState: () => {
        persistedWrites += 1;
      },
      dirty: true,
      setDirty: (dirty) => {
        dirtyWrites = [...dirtyWrites, dirty];
      },
      minRefreshIntervalMs: 250,
      collectSessionDigests: () => [{ sessionId: "s1", eventCount: 2, lastEventAt: 20 }],
      createEmptyState: (sessionDigests) => ({
        updatedAt: 0,
        sessionDigests: [...sessionDigests],
        value: "empty",
      }),
      rebuildState: () => {
        rebuilds += 1;
        return {
          updatedAt: 2_000,
          sessionDigests: [{ sessionId: "s1", eventCount: 3, lastEventAt: 30 }],
          value: "rebuilt",
        };
      },
      now: 1_100,
    });

    expect(nextState).toBe(persistedState);
    expect(persistedWrites).toBe(0);
    expect(rebuilds).toBe(0);
    expect(dirtyWrites).toEqual([]);
  });

  test("rebuilds persisted state and clears the dirty flag when session digests change", () => {
    const persistedState = {
      updatedAt: 1_000,
      sessionDigests: [{ sessionId: "s1", eventCount: 2, lastEventAt: 20 }],
      value: "persisted",
    };
    const persistedWrites: Array<{
      updatedAt: number;
      sessionDigests: readonly { sessionId: string; eventCount: number; lastEventAt: number }[];
      value: string;
    }> = [];
    let dirtyWrites: boolean[] = [];
    let rebuilds = 0;

    const nextState = reconcileSessionDigestBackedPlaneState({
      currentState: persistedState,
      readPersistedState: () => undefined,
      writePersistedState: (state) => {
        persistedWrites.push(state);
      },
      dirty: true,
      setDirty: (dirty) => {
        dirtyWrites = [...dirtyWrites, dirty];
      },
      collectSessionDigests: () => [{ sessionId: "s1", eventCount: 3, lastEventAt: 30 }],
      createEmptyState: (sessionDigests) => ({
        updatedAt: 0,
        sessionDigests: [...sessionDigests],
        value: "empty",
      }),
      rebuildState: ({ now, sessionDigests }) => {
        rebuilds += 1;
        return {
          updatedAt: now,
          sessionDigests: [...sessionDigests],
          value: "rebuilt",
        };
      },
      now: 1_500,
    });

    expect(nextState).toEqual({
      updatedAt: 1_500,
      sessionDigests: [{ sessionId: "s1", eventCount: 3, lastEventAt: 30 }],
      value: "rebuilt",
    });
    expect(rebuilds).toBe(1);
    expect(persistedWrites).toEqual([nextState]);
    expect(dirtyWrites).toEqual([false]);
  });
});
