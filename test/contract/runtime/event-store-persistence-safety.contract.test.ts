import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { BrewvaRuntime, createHostedRuntimePort } from "@brewva/brewva-runtime";
import { requireArray, requireRecord } from "../../helpers/assertions.js";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  findRuntimeContractEventFilePath,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("event store persistence safety", () => {
  test("normalizes event payload to JSON-safe values", async () => {
    const workspace = createWorkspace("events-payload");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          events: {
            level: "ops",
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "events-payload-1";

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "payload_test",
      payload: {
        ok: true,
        missing: undefined,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        nested: {
          drop: undefined,
          value: Number.NEGATIVE_INFINITY,
          arr: [1, Number.NaN, Number.POSITIVE_INFINITY, { x: undefined, y: 2 }],
        },
      },
    });

    const events = runtime.inspect.events.records.query(sessionId);
    expect(events).toHaveLength(1);
    const payload = (events[0]?.payload ?? {}) as {
      ok?: boolean;
      missing?: unknown;
      nan?: null;
      inf?: null;
      nested?: {
        value?: null;
        arr?: Array<number | null | { x?: unknown; y?: number }>;
      };
    };
    expect(payload.ok).toBe(true);
    expect("missing" in payload).toBe(false);
    expect(payload.nan).toBeNull();
    expect(payload.inf).toBeNull();
    const nested = requireRecord(payload.nested, "Expected normalized nested payload.") as {
      value?: null;
      arr?: unknown;
    };
    expect(nested.value).toBeNull();
    const nestedItems = requireArray(nested.arr, "Expected normalized nested array.");
    expect(nestedItems[0]).toBe(1);
    expect(nestedItems[1]).toBeNull();
    expect(nestedItems[2]).toBeNull();
    const nestedObject = requireRecord(nestedItems[3], "Expected normalized nested object.");
    expect("x" in nestedObject).toBe(false);
    expect((nestedObject as { y?: number }).y).toBe(2);
  });

  test("tolerates invalid JSON lines in persisted event stream", async () => {
    const workspace = createWorkspace("events-bad-lines");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          events: {
            level: "ops",
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "events-bad-lines-1";
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
    });

    const eventsPath = findRuntimeContractEventFilePath(
      workspace,
      runtime.config.infrastructure.events.dir,
      sessionId,
    );
    appendFileSync(eventsPath, "\n{ this is not json", "utf8");

    const events = runtime.inspect.events.records.query(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session_start");
  });

  test("secret values are redacted before event persistence", async () => {
    const workspace = createWorkspace("events-redact");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          events: {
            level: "ops",
          },
        },
      }),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "events-redact-1";
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "custom_event",
      payload: {
        token: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
        auth: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        nested: { key: "AKIA1234567890ABCDEF" },
      },
    });

    const eventsPath = findRuntimeContractEventFilePath(
      workspace,
      runtime.config.infrastructure.events.dir,
      sessionId,
    );
    const raw = readFileSync(eventsPath, "utf8");
    expect(raw.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(raw.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(raw.includes("AKIA1234567890ABCDEF")).toBe(false);
  });
});
