import { describe, expect, test } from "bun:test";
import { connectGatewayClient, readGatewayToken } from "@brewva/brewva-gateway";
import { requireNonEmptyString } from "../../helpers/assertions.js";
import {
  closeRawSocket,
  connectRawAuthenticated,
  sendRawRequest,
  startDaemonHarness,
  waitForSocketClose,
  withTimeout,
} from "./gateway-raw.helpers.js";

describe("gateway daemon lifecycle", () => {
  test("handles concurrent requests on a single websocket client", async () => {
    const harness = await startDaemonHarness([{ id: "rule-a", intervalMinutes: 5, prompt: "A" }]);

    let client: Awaited<ReturnType<typeof connectGatewayClient>> | null = null;
    try {
      client = await connectGatewayClient({
        host: harness.host,
        port: harness.port,
        token: harness.token,
        connectTimeoutMs: 3_000,
        requestTimeoutMs: 3_000,
      });

      const operations = Array.from({ length: 24 }, (_, index) => {
        const slot = index % 4;
        if (slot === 0) {
          return client!.request("health", {});
        }
        if (slot === 1) {
          return client!.request("status.deep", {});
        }
        if (slot === 2) {
          return client!.request("sessions.close", { sessionId: `ghost-${index}` });
        }
        return client!.request("heartbeat.reload", {});
      });

      const results = await Promise.all(operations);
      expect(results.length).toBe(24);

      const closePayloads = results.filter(
        (value) =>
          value &&
          typeof value === "object" &&
          typeof (value as { sessionId?: unknown }).sessionId === "string" &&
          Object.hasOwn(value, "closed"),
      ) as Array<{ sessionId: string; closed: boolean }>;
      expect(closePayloads.length).toBe(6);
      for (const payload of closePayloads) {
        expect(payload.closed).toBe(false);
        expect(payload.sessionId).toMatch(/^ghost-/);
      }

      const healthPayloads = results.filter(
        (value) => value && typeof value === "object" && (value as { ok?: unknown }).ok === true,
      ) as Array<{ ok: boolean }>;
      expect(healthPayloads.length).toBeGreaterThanOrEqual(6);
    } finally {
      if (client) {
        await client.close().catch(() => undefined);
      }
      await harness.dispose();
    }
  });

  test("stops cleanly when remote gateway.stop is requested", async () => {
    const harness = await startDaemonHarness([]);

    let client: Awaited<ReturnType<typeof connectGatewayClient>> | null = null;
    try {
      client = await connectGatewayClient({
        host: harness.host,
        port: harness.port,
        token: harness.token,
        connectTimeoutMs: 3_000,
        requestTimeoutMs: 3_000,
      });

      const stopPayload = (await client.request("gateway.stop", {
        reason: "integration_shutdown",
      })) as { stopping?: boolean; reason?: string };
      expect(stopPayload.stopping).toBe(true);
      expect(stopPayload.reason).toBe("integration_shutdown");

      await withTimeout(harness.daemon.waitForStop(), 4_000, "daemon did not stop in time");
    } finally {
      if (client) {
        await client.close().catch(() => undefined);
      }
      await harness.dispose();
    }
  });

  test("gateway.rotate-token revokes authenticated connections using the previous token", async () => {
    const harness = await startDaemonHarness([]);
    let wsRotator: Awaited<ReturnType<typeof connectRawAuthenticated>> | null = null;
    let wsPeer: Awaited<ReturnType<typeof connectRawAuthenticated>> | null = null;
    try {
      wsRotator = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });
      wsPeer = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: harness.token,
      });

      const rotatorClosed = waitForSocketClose(wsRotator, 4_000);
      const peerClosed = waitForSocketClose(wsPeer, 4_000);

      const response = await sendRawRequest(wsRotator, "gateway.rotate-token", {});
      expect(response.ok).toBe(true);
      const payload = response.payload as {
        rotated: boolean;
        revokedConnections: number;
      };
      expect(payload.rotated).toBe(true);
      expect(payload.revokedConnections).toBe(2);

      const [rotatorClose, peerClose] = await Promise.all([rotatorClosed, peerClosed]);
      expect(rotatorClose).toEqual({
        code: 1008,
        reason: "auth token rotated",
      });
      expect(peerClose).toEqual({
        code: 1008,
        reason: "auth token rotated",
      });

      wsRotator = null;
      wsPeer = null;

      const nextToken = requireNonEmptyString(
        readGatewayToken(harness.tokenFilePath),
        "expected rotated gateway token",
      );
      expect(nextToken).not.toBe(harness.token);

      let oldTokenError: unknown;
      try {
        await connectRawAuthenticated({
          host: harness.host,
          port: harness.port,
          token: harness.token,
        });
      } catch (error) {
        oldTokenError = error;
      }
      expect(oldTokenError).toBeInstanceOf(Error);

      const wsNext = await connectRawAuthenticated({
        host: harness.host,
        port: harness.port,
        token: nextToken ?? "",
      });
      await closeRawSocket(wsNext);
    } finally {
      if (wsRotator) {
        await closeRawSocket(wsRotator);
      }
      if (wsPeer) {
        await closeRawSocket(wsPeer);
      }
      await harness.dispose();
    }
  });
});
