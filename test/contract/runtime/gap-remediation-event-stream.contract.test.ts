import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  GAP_REMEDIATION_CONFIG_PATH,
  createGapRemediationConfig as createConfig,
  createGapRemediationWorkspace as createWorkspace,
  findGapRemediationEventFilePath,
  writeGapRemediationConfig as writeConfig,
} from "./gap-remediation.helpers.js";

describe("Gap remediation: event stream safety", () => {
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "events-payload-1";

    runtime.events.record({
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

    const events = runtime.events.query(sessionId);
    expect(events).toHaveLength(1);
    const payload = (events[0]?.payload ?? {}) as {
      ok?: boolean;
      missing?: unknown;
      nan?: number;
      inf?: number;
      nested?: {
        value?: number;
        arr?: Array<number | { x?: unknown; y?: number }>;
      };
    };
    expect(payload.ok).toBe(true);
    expect("missing" in payload).toBe(false);
    expect(payload.nan).toBe(0);
    expect(payload.inf).toBe(0);
    expect(payload.nested).toBeDefined();
    expect(payload.nested?.value).toBe(0);
    const nestedItems = payload.nested?.arr;
    expect(nestedItems).toBeDefined();
    expect(nestedItems?.[0]).toBe(1);
    expect(nestedItems?.[1]).toBe(0);
    expect(nestedItems?.[2]).toBe(0);
    const nestedObject = nestedItems?.[3];
    expect(typeof nestedObject).toBe("object");
    expect("x" in (nestedObject as Record<string, unknown>)).toBe(false);
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "events-bad-lines-1";
    runtime.events.record({ sessionId, type: "session_start", payload: { cwd: workspace } });

    const eventsPath = findGapRemediationEventFilePath(
      workspace,
      runtime.config.infrastructure.events.dir,
      sessionId,
    );
    appendFileSync(eventsPath, "\n{ this is not json", "utf8");

    const events = runtime.events.query(sessionId);
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: GAP_REMEDIATION_CONFIG_PATH });
    const sessionId = "events-redact-1";
    runtime.events.record({
      sessionId,
      type: "custom_event",
      payload: {
        token: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
        auth: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        nested: { key: "AKIA1234567890ABCDEF" },
      },
    });

    const eventsPath = findGapRemediationEventFilePath(
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
