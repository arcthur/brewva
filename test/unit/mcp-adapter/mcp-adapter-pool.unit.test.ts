import { afterEach, describe, expect, test } from "bun:test";
import {
  computeMcpTransportPoolKey,
  getDefaultMcpAdapterPool,
  McpAdapterPool,
  resetDefaultMcpAdapterPoolForTests,
  type McpClientLike,
  type McpTransportConfig,
} from "@brewva/brewva-mcp-adapter";

afterEach(() => {
  resetDefaultMcpAdapterPoolForTests();
});

interface FakeClientHandle {
  client: McpClientLike;
  events: { connect: number; close: number; listToolsCalls: number; toolCalls: number };
}

function createFakeClient(): FakeClientHandle {
  const events = { connect: 0, close: 0, listToolsCalls: 0, toolCalls: 0 };
  const client: McpClientLike = {
    async connect() {
      events.connect += 1;
    },
    async close() {
      events.close += 1;
    },
    async listTools() {
      events.listToolsCalls += 1;
      return { tools: [] };
    },
    async callTool() {
      events.toolCalls += 1;
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
  };
  return { client, events };
}

describe("computeMcpTransportPoolKey", () => {
  test("produces identical keys for stdio configs that differ only by env ordering", () => {
    const configA: McpTransportConfig = {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { B: "2", A: "1" },
    };
    const configB: McpTransportConfig = {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { A: "1", B: "2" },
    };
    expect(computeMcpTransportPoolKey(configA)).toBe(computeMcpTransportPoolKey(configB));
  });

  test("produces distinct keys when args or command differ", () => {
    const configA: McpTransportConfig = { type: "stdio", command: "node", args: ["a.js"] };
    const configB: McpTransportConfig = { type: "stdio", command: "node", args: ["b.js"] };
    expect(computeMcpTransportPoolKey(configA)).not.toBe(computeMcpTransportPoolKey(configB));
  });

  test("normalizes streamable_http header casing into the key", () => {
    const a: McpTransportConfig = {
      type: "streamable_http",
      url: "https://example.com/mcp",
      requestInit: { headers: { Authorization: "x" } },
    };
    const b: McpTransportConfig = {
      type: "streamable_http",
      url: "https://example.com/mcp",
      requestInit: { headers: { authorization: "x" } },
    };
    expect(computeMcpTransportPoolKey(a)).toBe(computeMcpTransportPoolKey(b));
  });
});

describe("McpAdapterPool", () => {
  test("shares a single underlying adapter across multiple acquisitions of the same transport", async () => {
    const pool = new McpAdapterPool();
    const handle = createFakeClient();

    const leaseA = pool.acquire({
      transport: { type: "stdio", command: "node", args: ["a.js"] },
      createClient: () => handle.client,
    });
    const leaseB = pool.acquire({
      transport: { type: "stdio", command: "node", args: ["a.js"] },
      createClient: () => handle.client,
    });

    await leaseA.callTool({ name: "noop" });
    await leaseB.callTool({ name: "noop" });

    // Single shared client => single connect, two callTool dispatches.
    expect(handle.events.connect).toBe(1);
    expect(handle.events.toolCalls).toBe(2);
    expect(pool.stats().size).toBe(1);
    expect(pool.stats().entries[0]?.refCount).toBe(2);

    // Closing one lease must not close the underlying client while another lease holds it.
    await leaseA.close();
    expect(handle.events.close).toBe(0);
    expect(pool.stats().size).toBe(1);

    // Closing the last lease tears the adapter down.
    await leaseB.close();
    expect(handle.events.close).toBe(1);
    expect(pool.stats().size).toBe(0);
  });

  test("creates separate adapters for distinct transports", async () => {
    const pool = new McpAdapterPool();
    const handleA = createFakeClient();
    const handleB = createFakeClient();

    const leaseA = pool.acquire({
      transport: { type: "stdio", command: "node", args: ["a.js"] },
      createClient: () => handleA.client,
    });
    const leaseB = pool.acquire({
      transport: { type: "stdio", command: "node", args: ["b.js"] },
      createClient: () => handleB.client,
    });

    await leaseA.callTool({ name: "noop" });
    await leaseB.callTool({ name: "noop" });

    expect(handleA.events.connect).toBe(1);
    expect(handleB.events.connect).toBe(1);
    expect(pool.stats().size).toBe(2);

    await leaseA.close();
    await leaseB.close();
    expect(handleA.events.close).toBe(1);
    expect(handleB.events.close).toBe(1);
  });

  test("fans events out to every active lease", async () => {
    const pool = new McpAdapterPool();
    const handle = createFakeClient();
    const seenA: string[] = [];
    const seenB: string[] = [];

    const leaseA = pool.acquire({
      transport: { type: "stdio", command: "node", args: ["a.js"] },
      createClient: () => handle.client,
      onEvent: (event) => {
        seenA.push(event.type);
      },
    });
    const leaseB = pool.acquire({
      transport: { type: "stdio", command: "node", args: ["a.js"] },
      createClient: () => handle.client,
      onEvent: (event) => {
        seenB.push(event.type);
      },
    });

    // First call triggers connect, which fans server_connected to both subscribers.
    await leaseA.callTool({ name: "noop" });
    await Promise.resolve();

    expect(seenA).toContain("server_connected");
    expect(seenB).toContain("server_connected");

    // After releasing leaseA, subsequent events should only reach leaseB.
    await leaseA.close();
    await leaseB.close();
    await Promise.resolve();
    expect(seenB).toContain("server_disconnected");
    // Leased A unsubscribed before close fired, so it must not receive the disconnect.
    expect(seenA).not.toContain("server_disconnected");
  });

  test("getDefaultMcpAdapterPool returns a process-singleton until reset", () => {
    const a = getDefaultMcpAdapterPool();
    const b = getDefaultMcpAdapterPool();
    expect(a).toBe(b);
    resetDefaultMcpAdapterPoolForTests();
    const c = getDefaultMcpAdapterPool();
    expect(c).not.toBe(a);
  });
});
