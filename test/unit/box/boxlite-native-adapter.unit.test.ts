import { describe, expect, test } from "bun:test";
import type { BoxPlaneOptions, BoxScope } from "@brewva/brewva-box";
import {
  cloneNativeBox,
  createNativeBox,
  inspectNativeBox,
  killNativeExecution,
  type NativeBox,
} from "../../../packages/brewva-box/src/boxlite/native.js";
import type { BoxLiteRuntime } from "../../../packages/brewva-box/src/boxlite/runtime.js";

const boxOptions: BoxPlaneOptions = {
  home: "/tmp/brewva-boxlite-test",
  image: "alpine:latest",
  cpus: 2,
  memoryMib: 1024,
  diskGb: 8,
  workspaceGuestPath: "/workspace",
  network: { mode: "off" },
  detach: true,
};

function boxScope(input: Partial<BoxScope> = {}): BoxScope {
  return {
    kind: "session",
    id: "session-alpha",
    image: "alpine:latest",
    workspaceRoot: "/host/workspace",
    capabilities: {
      network: { mode: "off" },
      gpu: false,
      extraVolumes: [],
      secrets: [],
      ports: [],
    },
    ...input,
  };
}

function capturingRuntime(calls: { options: unknown[]; names: Array<string | undefined> }) {
  return {
    async getOrCreate(options: unknown, name?: string) {
      calls.options.push(options);
      calls.names.push(name);
      return { box: { id: "box-native" } };
    },
  } satisfies BoxLiteRuntime;
}

describe("BoxLite native adapter", () => {
  test("maps offline Brewva scopes to BoxLite 0.9 structured network options", async () => {
    const calls = { options: [] as unknown[], names: [] as Array<string | undefined> };

    await createNativeBox(capturingRuntime(calls), boxOptions, boxScope(), "a".repeat(64));

    expect(calls.options[0]).toMatchObject({
      network: { mode: "disabled" },
    });
  });

  test("maps Brewva network allowlists to BoxLite allowNet", async () => {
    const calls = { options: [] as unknown[], names: [] as Array<string | undefined> };

    await createNativeBox(
      capturingRuntime(calls),
      boxOptions,
      boxScope({
        capabilities: {
          network: { mode: "allowlist", allow: ["api.openai.com", "registry.npmjs.org"] },
          gpu: false,
          extraVolumes: [],
          secrets: [],
          ports: [],
        },
      }),
      "b".repeat(64),
    );

    expect(calls.options[0]).toMatchObject({
      network: {
        mode: "enabled",
        allowNet: ["api.openai.com", "registry.npmjs.org"],
      },
    });
  });

  test("uses the BoxLite 0.9 cloneBox options/name signature", async () => {
    const calls: unknown[][] = [];
    const child = { id: "box-child" };
    const native: NativeBox = {
      async cloneBox(...args: unknown[]) {
        calls.push(args);
        return child;
      },
    };

    const cloned = await cloneNativeBox(native, "fork-alpha");
    expect(cloned).toMatchObject(child);
    expect(calls).toEqual([[null, "fork-alpha"]]);
  });

  test("prefers BoxLite signal() over kill() when a specific signal is requested", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const execution = {
      async signal(...args: unknown[]) {
        calls.push(["signal", args]);
      },
      async kill(...args: unknown[]) {
        calls.push(["kill", args]);
      },
    };

    await killNativeExecution(execution, "SIGTERM");

    expect(calls).toEqual([["signal", [15]]]);
  });

  test("collects BoxLite 0.9 info and metrics for inventory inspection", async () => {
    const native = {
      id: "box-native",
      info() {
        return {
          state: { status: "running", running: true, pid: 1234 },
          healthStatus: { state: "Healthy", failures: 0 },
        };
      },
      async metrics() {
        return {
          commandsExecutedTotal: 7,
          execErrorsTotal: 1,
          bytesSentTotal: 128,
          bytesReceivedTotal: 256,
          cpuPercent: 12.5,
          memoryBytes: 1048576,
          networkBytesSent: 64,
          networkBytesReceived: 96,
          networkTcpConnections: 2,
          networkTcpErrors: 0,
        };
      },
    } satisfies NativeBox;

    const inspection = await inspectNativeBox(native);

    expect(inspection).toEqual({
      nativeState: {
        status: "running",
        running: true,
        pid: 1234,
        health: { state: "Healthy", failures: 0 },
      },
      metrics: {
        commandsExecutedTotal: 7,
        execErrorsTotal: 1,
        bytesSentTotal: 128,
        bytesReceivedTotal: 256,
        cpuPercent: 12.5,
        memoryBytes: 1048576,
        networkBytesSent: 64,
        networkBytesReceived: 96,
        networkTcpConnections: 2,
        networkTcpErrors: 0,
      },
    });
  });

  test("omits native metrics when BoxLite inspection fails", async () => {
    const native = {
      id: "box-native",
      async metrics() {
        throw new Error("metrics unavailable");
      },
    } satisfies NativeBox;

    const inspection = await inspectNativeBox(native);

    expect(inspection).toEqual({});
  });
});
