import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendGatewaySessionBindingReceipt,
  listGatewaySessionBindings,
  resolveGatewaySessionBindingLogPath,
} from "../../../packages/brewva-gateway/src/daemon/session-binding-tape.js";

describe("gateway session binding tape", () => {
  test("records replay bindings durably and deduplicates identical segment receipts", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "brewva-session-binding-tape-"));
    try {
      const bindingLogPath = resolveGatewaySessionBindingLogPath(stateDir);
      appendGatewaySessionBindingReceipt(bindingLogPath, {
        gatewaySessionId: "session-a",
        agentSessionId: "agent-1",
        agentEventLogPath: "/tmp/agent-1.jsonl",
        cwd: "/tmp/workspace-a",
        timestamp: 100,
      });
      appendGatewaySessionBindingReceipt(bindingLogPath, {
        gatewaySessionId: "session-a",
        agentSessionId: "agent-1",
        agentEventLogPath: "/tmp/agent-1.jsonl",
        cwd: "/tmp/workspace-a",
        timestamp: 101,
      });
      appendGatewaySessionBindingReceipt(bindingLogPath, {
        gatewaySessionId: "session-a",
        agentSessionId: "agent-2",
        agentEventLogPath: "/tmp/agent-2.jsonl",
        cwd: "/tmp/workspace-a",
        timestamp: 200,
      });
      appendGatewaySessionBindingReceipt(bindingLogPath, {
        gatewaySessionId: "session-b",
        agentSessionId: "agent-3",
        agentEventLogPath: "/tmp/agent-3.jsonl",
        cwd: "/tmp/workspace-b",
        timestamp: 300,
      });

      expect(listGatewaySessionBindings(bindingLogPath, "session-a")).toEqual([
        {
          gatewaySessionId: "session-a",
          agentSessionId: "agent-1",
          agentEventLogPath: "/tmp/agent-1.jsonl",
          cwd: "/tmp/workspace-a",
          openedAt: 100,
          eventId: expect.any(String),
        },
        {
          gatewaySessionId: "session-a",
          agentSessionId: "agent-2",
          agentEventLogPath: "/tmp/agent-2.jsonl",
          cwd: "/tmp/workspace-a",
          openedAt: 200,
          eventId: expect.any(String),
        },
      ]);
      expect(listGatewaySessionBindings(bindingLogPath, "session-b")).toEqual([
        {
          gatewaySessionId: "session-b",
          agentSessionId: "agent-3",
          agentEventLogPath: "/tmp/agent-3.jsonl",
          cwd: "/tmp/workspace-b",
          openedAt: 300,
          eventId: expect.any(String),
        },
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("updates the in-process binding index after a list call has already hydrated it", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "brewva-session-binding-tape-cache-"));
    try {
      const bindingLogPath = resolveGatewaySessionBindingLogPath(stateDir);
      appendGatewaySessionBindingReceipt(bindingLogPath, {
        gatewaySessionId: "session-c",
        agentSessionId: "agent-1",
        agentEventLogPath: "/tmp/agent-c-1.jsonl",
        timestamp: 100,
      });

      expect(listGatewaySessionBindings(bindingLogPath, "session-c")).toHaveLength(1);

      appendGatewaySessionBindingReceipt(bindingLogPath, {
        gatewaySessionId: "session-c",
        agentSessionId: "agent-2",
        agentEventLogPath: "/tmp/agent-c-2.jsonl",
        timestamp: 200,
      });

      expect(listGatewaySessionBindings(bindingLogPath, "session-c")).toEqual([
        {
          gatewaySessionId: "session-c",
          agentSessionId: "agent-1",
          agentEventLogPath: "/tmp/agent-c-1.jsonl",
          cwd: undefined,
          openedAt: 100,
          eventId: expect.any(String),
        },
        {
          gatewaySessionId: "session-c",
          agentSessionId: "agent-2",
          agentEventLogPath: "/tmp/agent-c-2.jsonl",
          cwd: undefined,
          openedAt: 200,
          eventId: expect.any(String),
        },
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
