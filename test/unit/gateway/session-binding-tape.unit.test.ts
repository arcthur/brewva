import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendGatewaySessionBindingReceipt,
  listGatewaySessionBindings,
  resolveGatewaySessionBindingStorePath,
} from "../../../packages/brewva-gateway/src/daemon/session-supervisor/session-binding-store.js";

describe("gateway session binding store", () => {
  test("records replay bindings durably and deduplicates identical segment receipts", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "brewva-session-binding-store-"));
    try {
      const bindingStorePath = resolveGatewaySessionBindingStorePath(stateDir);
      appendGatewaySessionBindingReceipt(bindingStorePath, {
        gatewaySessionId: "session-a",
        agentSessionId: "agent-1",
        cwd: "/tmp/workspace-a",
        timestamp: 100,
      });
      appendGatewaySessionBindingReceipt(bindingStorePath, {
        gatewaySessionId: "session-a",
        agentSessionId: "agent-1",
        cwd: "/tmp/workspace-a",
        timestamp: 101,
      });
      appendGatewaySessionBindingReceipt(bindingStorePath, {
        gatewaySessionId: "session-a",
        agentSessionId: "agent-2",
        cwd: "/tmp/workspace-a",
        timestamp: 200,
      });
      appendGatewaySessionBindingReceipt(bindingStorePath, {
        gatewaySessionId: "session-b",
        agentSessionId: "agent-3",
        cwd: "/tmp/workspace-b",
        timestamp: 300,
      });

      expect(listGatewaySessionBindings(bindingStorePath, "session-a")).toEqual([
        {
          gatewaySessionId: "session-a",
          agentSessionId: "agent-1",
          cwd: "/tmp/workspace-a",
          openedAt: 100,
        },
        {
          gatewaySessionId: "session-a",
          agentSessionId: "agent-2",
          cwd: "/tmp/workspace-a",
          openedAt: 200,
        },
      ]);
      expect(listGatewaySessionBindings(bindingStorePath, "session-b")).toEqual([
        {
          gatewaySessionId: "session-b",
          agentSessionId: "agent-3",
          cwd: "/tmp/workspace-b",
          openedAt: 300,
        },
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("updates the in-process binding index after a list call has already hydrated it", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "brewva-session-binding-store-cache-"));
    try {
      const bindingStorePath = resolveGatewaySessionBindingStorePath(stateDir);
      appendGatewaySessionBindingReceipt(bindingStorePath, {
        gatewaySessionId: "session-c",
        agentSessionId: "agent-1",
        timestamp: 100,
      });

      expect(listGatewaySessionBindings(bindingStorePath, "session-c")).toHaveLength(1);

      appendGatewaySessionBindingReceipt(bindingStorePath, {
        gatewaySessionId: "session-c",
        agentSessionId: "agent-2",
        timestamp: 200,
      });

      expect(listGatewaySessionBindings(bindingStorePath, "session-c")).toEqual([
        {
          gatewaySessionId: "session-c",
          agentSessionId: "agent-1",
          cwd: undefined,
          openedAt: 100,
        },
        {
          gatewaySessionId: "session-c",
          agentSessionId: "agent-2",
          cwd: undefined,
          openedAt: 200,
        },
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
