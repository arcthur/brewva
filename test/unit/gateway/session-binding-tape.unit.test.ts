import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendGatewayControlReceipt,
  closeGatewayControlTape,
  compactGatewayControlTapeAdmissions,
  findGatewayPromptAdmission,
  GATEWAY_CONTROL_TAPE_SCHEMA,
  listGatewaySessionBindings,
  readGatewayControlReceipts,
  resolveGatewayControlTapePath,
} from "../../../packages/brewva-gateway/src/daemon/session-supervisor/control-tape.js";

function withStateDir(run: (stateDir: string, tapePath: string) => void): void {
  const stateDir = mkdtempSync(join(tmpdir(), "brewva-gateway-control-tape-"));
  const tapePath = resolveGatewayControlTapePath(stateDir);
  try {
    run(stateDir, tapePath);
  } finally {
    closeGatewayControlTape(tapePath);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function bindSession(
  tapePath: string,
  gatewaySessionId: string,
  agentSessionId: string,
  cwd: string | undefined,
  timestamp: number,
): void {
  appendGatewayControlReceipt(tapePath, {
    type: "gateway_session_bound",
    gatewaySessionId,
    agentSessionId,
    cwd,
    timestamp,
  });
}

describe("gateway control tape — session bindings", () => {
  test("records replay bindings durably and deduplicates identical segment receipts", () => {
    withStateDir((_stateDir, tapePath) => {
      bindSession(tapePath, "session-a", "agent-1", "/tmp/workspace-a", 100);
      // Re-binding the same (session, agent, cwd) triple is idempotent regardless
      // of timestamp — the deterministic receipt id collapses the duplicate.
      bindSession(tapePath, "session-a", "agent-1", "/tmp/workspace-a", 101);
      bindSession(tapePath, "session-a", "agent-2", "/tmp/workspace-a", 200);
      bindSession(tapePath, "session-b", "agent-3", "/tmp/workspace-b", 300);

      expect(listGatewaySessionBindings(tapePath, "session-a")).toEqual([
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
      expect(listGatewaySessionBindings(tapePath, "session-b")).toEqual([
        {
          gatewaySessionId: "session-b",
          agentSessionId: "agent-3",
          cwd: "/tmp/workspace-b",
          openedAt: 300,
        },
      ]);
    });
  });

  test("updates the in-process binding index after a list call has already hydrated it", () => {
    withStateDir((_stateDir, tapePath) => {
      bindSession(tapePath, "session-c", "agent-1", undefined, 100);

      expect(listGatewaySessionBindings(tapePath, "session-c")).toHaveLength(1);

      bindSession(tapePath, "session-c", "agent-2", undefined, 200);

      expect(listGatewaySessionBindings(tapePath, "session-c")).toEqual([
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
    });
  });

  test("persists bindings as append-only tape lines that survive a process restart", () => {
    withStateDir((_stateDir, tapePath) => {
      bindSession(tapePath, "session-d", "agent-1", "/tmp/workspace-d", 100);
      bindSession(tapePath, "session-d", "agent-2", "/tmp/workspace-d", 200);

      const lines = readFileSync(tapePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.schema === GATEWAY_CONTROL_TAPE_SCHEMA)).toBe(true);
      expect(lines.every((line) => line.type === "gateway_session_bound")).toBe(true);

      // Drop the in-memory index to emulate a fresh daemon process rehydrating
      // from the tape on disk.
      closeGatewayControlTape(tapePath);

      expect(listGatewaySessionBindings(tapePath, "session-d")).toEqual([
        {
          gatewaySessionId: "session-d",
          agentSessionId: "agent-1",
          cwd: "/tmp/workspace-d",
          openedAt: 100,
        },
        {
          gatewaySessionId: "session-d",
          agentSessionId: "agent-2",
          cwd: "/tmp/workspace-d",
          openedAt: 200,
        },
      ]);
    });
  });

  test("rejects a complete corrupt line loudly instead of dropping a binding", () => {
    withStateDir((_stateDir, tapePath) => {
      bindSession(tapePath, "session-e", "agent-1", "/tmp/workspace-e", 100);
      // A newline-terminated malformed line is genuine corruption, not a torn write.
      appendFileSync(tapePath, "{not valid json\n", "utf8");
      // Drop the in-memory index so the next read re-parses from disk.
      closeGatewayControlTape(tapePath);

      expect(() => listGatewaySessionBindings(tapePath, "session-e")).toThrow(
        /unsupported_gateway_control_tape/,
      );
    });
  });

  test("tolerates and discards an interrupted trailing write (torn tail)", () => {
    withStateDir((_stateDir, tapePath) => {
      bindSession(tapePath, "session-f", "agent-1", "/tmp/workspace-f", 100);
      // Simulate a crash mid-append: a trailing fragment with no terminating newline.
      appendFileSync(tapePath, '{"schema":"brewva.gateway-control.v3","id":"tor', "utf8");
      closeGatewayControlTape(tapePath);

      // The committed binding is still readable; the torn fragment is ignored.
      expect(listGatewaySessionBindings(tapePath, "session-f")).toHaveLength(1);

      // The fragment was truncated, so a later append lands on a clean line
      // boundary and stays parseable rather than concatenating into garbage.
      bindSession(tapePath, "session-f", "agent-2", "/tmp/workspace-f", 200);
      closeGatewayControlTape(tapePath);
      expect(listGatewaySessionBindings(tapePath, "session-f")).toHaveLength(2);
    });
  });
});

describe("gateway control tape — receipt-first control plane", () => {
  test("records token rotation, stop, and scheduler decisions as durable receipts", () => {
    withStateDir((_stateDir, tapePath) => {
      appendGatewayControlReceipt(tapePath, {
        type: "gateway_token_rotated",
        revokedConnections: 3,
        connId: "conn-1",
        timestamp: 10,
      });
      appendGatewayControlReceipt(tapePath, {
        type: "gateway_scheduler_paused",
        reason: "operator_request",
        timestamp: 20,
      });
      appendGatewayControlReceipt(tapePath, {
        type: "gateway_scheduler_resumed",
        timestamp: 30,
      });
      appendGatewayControlReceipt(tapePath, {
        type: "gateway_stopped",
        reason: "remote_stop",
        timestamp: 40,
      });

      expect(readGatewayControlReceipts(tapePath).map((receipt) => receipt.type)).toEqual([
        "gateway_token_rotated",
        "gateway_scheduler_paused",
        "gateway_scheduler_resumed",
        "gateway_stopped",
      ]);

      const rotations = readGatewayControlReceipts(tapePath, { type: "gateway_token_rotated" });
      expect(rotations).toHaveLength(1);
      expect(rotations[0]).toMatchObject({ revokedConnections: 3, connId: "conn-1" });
    });
  });

  test("event-like receipts are not collapsed even when their payloads match", () => {
    withStateDir((_stateDir, tapePath) => {
      appendGatewayControlReceipt(tapePath, { type: "gateway_scheduler_resumed", timestamp: 1 });
      appendGatewayControlReceipt(tapePath, { type: "gateway_scheduler_resumed", timestamp: 2 });

      expect(
        readGatewayControlReceipts(tapePath, { type: "gateway_scheduler_resumed" }),
      ).toHaveLength(2);
    });
  });
});

describe("gateway control tape — prompt admission idempotency", () => {
  test("records a prompt admission and resolves it for an idempotent retry", () => {
    withStateDir((_stateDir, tapePath) => {
      expect(findGatewayPromptAdmission(tapePath, "session-a", "turn-1")).toBeNull();

      appendGatewayControlReceipt(tapePath, {
        type: "gateway_prompt_admitted",
        gatewaySessionId: "session-a",
        turnId: "turn-1",
        promptHash: "sha256:abc",
        agentSessionId: "agent-1",
        timestamp: 500,
      });

      expect(findGatewayPromptAdmission(tapePath, "session-a", "turn-1")).toEqual({
        gatewaySessionId: "session-a",
        turnId: "turn-1",
        promptHash: "sha256:abc",
        agentSessionId: "agent-1",
        admittedAt: 500,
      });
      // A different turn id on the same session is a distinct admission.
      expect(findGatewayPromptAdmission(tapePath, "session-a", "turn-2")).toBeNull();
    });
  });

  test("re-admitting the same (session, turn) is idempotent and writes one line", () => {
    withStateDir((_stateDir, tapePath) => {
      const first = appendGatewayControlReceipt(tapePath, {
        type: "gateway_prompt_admitted",
        gatewaySessionId: "session-b",
        turnId: "turn-9",
        promptHash: "sha256:p1",
        timestamp: 10,
      });
      const second = appendGatewayControlReceipt(tapePath, {
        type: "gateway_prompt_admitted",
        gatewaySessionId: "session-b",
        turnId: "turn-9",
        promptHash: "sha256:p1",
        timestamp: 20,
      });

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(
        readGatewayControlReceipts(tapePath, { type: "gateway_prompt_admitted" }),
      ).toHaveLength(1);
      // The conflict (different prompt, same turn) is decided by the daemon; the
      // tape itself keeps the first receipt and dedupes by deterministic id.
      expect(findGatewayPromptAdmission(tapePath, "session-b", "turn-9")?.promptHash).toBe(
        "sha256:p1",
      );
    });
  });

  test("admissions survive a process restart", () => {
    withStateDir((_stateDir, tapePath) => {
      appendGatewayControlReceipt(tapePath, {
        type: "gateway_prompt_admitted",
        gatewaySessionId: "session-c",
        turnId: "turn-3",
        promptHash: "sha256:p3",
        agentSessionId: "agent-3",
        timestamp: 7,
      });
      closeGatewayControlTape(tapePath);

      expect(findGatewayPromptAdmission(tapePath, "session-c", "turn-3")).toEqual({
        gatewaySessionId: "session-c",
        turnId: "turn-3",
        promptHash: "sha256:p3",
        agentSessionId: "agent-3",
        admittedAt: 7,
      });
    });
  });
});

describe("gateway control tape — admission compaction", () => {
  function admit(tapePath: string, gatewaySessionId: string, turnId: string, timestamp: number) {
    appendGatewayControlReceipt(tapePath, {
      type: "gateway_prompt_admitted",
      gatewaySessionId,
      turnId,
      promptHash: `sha256:${turnId}`,
      timestamp,
    });
  }

  test("compacts old admissions while preserving bindings and operator receipts", () => {
    withStateDir((_stateDir, tapePath) => {
      // A binding (replay authority) and an operator receipt (audit) that must
      // survive compaction untouched.
      bindSession(tapePath, "session-z", "agent-z", "/tmp/z", 1);
      appendGatewayControlReceipt(tapePath, {
        type: "gateway_stopped",
        reason: "manual",
        timestamp: 2,
      });
      admit(tapePath, "session-z", "turn-1", 10);
      admit(tapePath, "session-z", "turn-2", 20);
      admit(tapePath, "session-z", "turn-3", 30);

      expect(compactGatewayControlTapeAdmissions(tapePath, 1)).toBe(2);

      // Authority and audit preserved; only the most recent admission survives.
      expect(listGatewaySessionBindings(tapePath, "session-z")).toHaveLength(1);
      expect(readGatewayControlReceipts(tapePath, { type: "gateway_stopped" })).toHaveLength(1);
      expect(findGatewayPromptAdmission(tapePath, "session-z", "turn-3")).not.toBeNull();
      expect(findGatewayPromptAdmission(tapePath, "session-z", "turn-1")).toBeNull();
      expect(findGatewayPromptAdmission(tapePath, "session-z", "turn-2")).toBeNull();

      // The rewrite survives a restart: binding + operator + 1 admission = 3 lines.
      closeGatewayControlTape(tapePath);
      const lines = readFileSync(tapePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      expect(lines).toHaveLength(3);
      expect(findGatewayPromptAdmission(tapePath, "session-z", "turn-3")).not.toBeNull();
      expect(findGatewayPromptAdmission(tapePath, "session-z", "turn-1")).toBeNull();
      expect(listGatewaySessionBindings(tapePath, "session-z")).toHaveLength(1);
    });
  });

  test("a later append after compaction lands on a clean line and stays parseable", () => {
    withStateDir((_stateDir, tapePath) => {
      admit(tapePath, "s", "t1", 1);
      admit(tapePath, "s", "t2", 2);
      compactGatewayControlTapeAdmissions(tapePath, 1); // keeps t2, drops t1
      admit(tapePath, "s", "t3", 3);
      closeGatewayControlTape(tapePath);

      expect(findGatewayPromptAdmission(tapePath, "s", "t1")).toBeNull();
      expect(findGatewayPromptAdmission(tapePath, "s", "t2")).not.toBeNull();
      expect(findGatewayPromptAdmission(tapePath, "s", "t3")).not.toBeNull();
      expect(
        readGatewayControlReceipts(tapePath, { type: "gateway_prompt_admitted" }),
      ).toHaveLength(2);
    });
  });

  test("compaction is a no-op when admissions are within retention", () => {
    withStateDir((_stateDir, tapePath) => {
      admit(tapePath, "s", "t1", 1);
      expect(compactGatewayControlTapeAdmissions(tapePath, 10)).toBe(0);
      expect(findGatewayPromptAdmission(tapePath, "s", "t1")).not.toBeNull();
    });
  });
});
