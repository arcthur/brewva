import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionBackendCapacityError,
  SessionBackendStateError,
  SessionSupervisor,
} from "@brewva/brewva-gateway";
import { requireDefined } from "../../helpers/assertions.js";

interface SentPromptMessage {
  kind: "send";
  requestId: string;
  payload: {
    trigger?: {
      kind: "schedule";
      continuityMode: "inherit" | "fresh";
      taskSpec?: {
        schema: "brewva.task.v1";
        goal: string;
      } | null;
      truthFacts?: Array<{
        id: string;
        kind: string;
        severity: "info" | "warn" | "error";
        status: "active" | "resolved";
        summary: string;
        evidenceIds: string[];
        firstSeenAt: number;
        lastSeenAt: number;
      }>;
      parentAnchor?: {
        id: string;
        name?: string;
        summary?: string;
        nextSteps?: string;
      } | null;
    };
  };
}

describe("session supervisor safeguards", () => {
  test("given worker limit reached and queue disabled, when openSession is called, then capacity error is raised", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
      maxWorkers: 1,
      maxPendingSessionOpens: 0,
    });
    try {
      supervisor.testHooks.seedWorker({
        sessionId: "existing",
        pid: 10001,
      });

      let openError: unknown;
      try {
        await supervisor.openSession({
          sessionId: "new-session",
        });
      } catch (error) {
        openError = error;
      }
      expect(openError).toBeInstanceOf(SessionBackendCapacityError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given seeded workers, when persisting registry, then file is written atomically without tmp residue", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      supervisor.testHooks.seedWorker({
        sessionId: "s1",
        pid: 10011,
      });
      supervisor.testHooks.persistRegistry();

      const registryPath = join(stateDir, "children.json");
      const tmpPath = `${registryPath}.tmp`;
      expect(existsSync(registryPath)).toBe(true);
      expect(existsSync(tmpPath)).toBe(false);

      const rows = JSON.parse(readFileSync(registryPath, "utf8")) as Array<{
        sessionId?: string;
        pid?: number;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.sessionId).toBe("s1");
      expect(rows[0]?.pid).toBe(10011);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given injected state store, when persisting registry, then store write path is used", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const calls: Array<{ kind: string; path: string }> = [];
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
      stateStore: {
        readToken: () => undefined,
        writeToken: () => {},
        readChildrenRegistry: (path) => {
          calls.push({ kind: "read", path });
          return [];
        },
        writeChildrenRegistry: (path) => {
          calls.push({ kind: "write", path });
        },
        removeChildrenRegistry: (path) => {
          calls.push({ kind: "remove", path });
        },
      },
    });
    try {
      supervisor.testHooks.seedWorker({
        sessionId: "s1",
        pid: 10021,
      });
      supervisor.testHooks.persistRegistry();

      const registryPath = join(stateDir, "children.json");
      expect(calls).toEqual([
        {
          kind: "write",
          path: registryPath,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given unknown session id, when sendPrompt is called, then typed session_not_found error is returned", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      let sendError: unknown;
      try {
        await supervisor.sendPrompt("missing-session", "hello");
      } catch (error) {
        sendError = error;
      }
      expect(sendError).toBeInstanceOf(SessionBackendStateError);
      expect(sendError).toMatchObject({
        code: "session_not_found",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given worker returns session_busy, when result is dispatched, then typed SessionBackendStateError is propagated", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      const rejectCalls: Error[] = [];
      const pendingTimer = setTimeout(() => {}, 1_000);
      pendingTimer.unref?.();

      supervisor.testHooks.seedWorker({
        sessionId: "busy-session",
        pid: 10031,
        pendingRequests: [
          {
            requestId: "req-1",
            resolve: () => undefined,
            reject: (error: Error) => {
              rejectCalls.push(error);
            },
            timer: pendingTimer,
          },
        ],
      });

      supervisor.testHooks.dispatchWorkerMessage("busy-session", {
        kind: "result",
        requestId: "req-1",
        ok: false,
        error: "session is busy with active turn: turn-1",
        errorCode: "session_busy",
      });

      expect(rejectCalls.length).toBe(1);
      expect(rejectCalls[0]).toBeInstanceOf(SessionBackendStateError);
      expect((rejectCalls[0] as SessionBackendStateError).code).toBe("session_busy");
      const pendingRequests = supervisor
        .listWorkers()
        .find((worker) => worker.sessionId === "busy-session")?.pendingRequests;
      expect(pendingRequests).toBe(0);
      clearTimeout(pendingTimer);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given an active turn, when a second prompt arrives, then it waits in the session queue until the first turn ends", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      supervisor.testHooks.seedWorker({
        sessionId: "queued-session",
        pid: 10035,
      });

      const sentMessages: SentPromptMessage[] = [];
      supervisor.testHooks.replaceWorkerSend("queued-session", (message: unknown) => {
        if ((message as { kind?: string }).kind === "send") {
          sentMessages.push(message as SentPromptMessage);
        }
        return true;
      });

      const firstSend = supervisor.sendPrompt("queued-session", "first prompt", {
        turnId: "turn-1",
      });
      expect(sentMessages).toHaveLength(1);

      const secondSend = supervisor.sendPrompt("queued-session", "second prompt", {
        turnId: "turn-2",
      });
      expect(sentMessages).toHaveLength(1);
      expect(supervisor.testHooks.getWorkerSnapshot("queued-session")).toMatchObject({
        turnQueueLength: 1,
        activeTurnId: "turn-1",
      });

      const firstMessage = requireDefined(sentMessages[0], "expected first worker message");

      supervisor.testHooks.dispatchWorkerMessage("queued-session", {
        kind: "result",
        requestId: firstMessage.requestId,
        ok: true,
        payload: {
          sessionId: "queued-session",
          turnId: "turn-1",
          accepted: true,
        },
      });
      const firstResult = await firstSend;
      expect(firstResult).toMatchObject({
        sessionId: "queued-session",
        turnId: "turn-1",
        accepted: true,
      });
      expect(sentMessages).toHaveLength(1);

      supervisor.testHooks.dispatchWorkerMessage("queued-session", {
        kind: "event",
        event: "session.turn.end",
        payload: {
          sessionId: "queued-session",
          agentSessionId: "agent-queued",
          turnId: "turn-1",
          assistantText: "done",
          toolOutputs: [],
          ts: Date.now(),
        },
      });

      await Promise.resolve();
      expect(sentMessages).toHaveLength(2);
      expect(supervisor.testHooks.getWorkerSnapshot("queued-session")).toMatchObject({
        turnQueueLength: 0,
        activeTurnId: "turn-2",
      });

      const secondMessage = requireDefined(sentMessages[1], "expected second worker message");

      supervisor.testHooks.dispatchWorkerMessage("queued-session", {
        kind: "result",
        requestId: secondMessage.requestId,
        ok: true,
        payload: {
          sessionId: "queued-session",
          turnId: "turn-2",
          accepted: true,
        },
      });
      const secondResult = await secondSend;
      expect(secondResult).toMatchObject({
        sessionId: "queued-session",
        turnId: "turn-2",
        accepted: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given a heartbeat-sourced prompt, when supervisor forwards to worker, then no extra trigger payload is attached", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      supervisor.testHooks.seedWorker({
        sessionId: "trigger-session",
        pid: 10041,
      });

      let sentMessage: SentPromptMessage | undefined;
      supervisor.testHooks.replaceWorkerSend("trigger-session", (message: unknown) => {
        sentMessage = message as SentPromptMessage;
        setTimeout(() => {
          if (!sentMessage) {
            return;
          }
          supervisor.testHooks.dispatchWorkerMessage("trigger-session", {
            kind: "result",
            requestId: sentMessage.requestId,
            ok: true,
            payload: {
              sessionId: "trigger-session",
              turnId: "turn-1",
              accepted: true,
            },
          });
        }, 0).unref?.();
        return true;
      });

      await supervisor.sendPrompt("trigger-session", "Check project status.", {
        source: "heartbeat",
      });

      const heartbeatMessage = requireDefined(sentMessage, "expected heartbeat worker message");
      expect(heartbeatMessage.kind).toBe("send");
      expect(heartbeatMessage.payload.trigger).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given schedule trigger metadata, when supervisor forwards to worker, then schedule payload is preserved", async () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-session-supervisor-"));
    const stateDir = join(root, "state");
    const supervisor = new SessionSupervisor({
      stateDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
      defaultCwd: root,
    });
    try {
      supervisor.testHooks.seedWorker({
        sessionId: "schedule-session",
        pid: 10051,
      });

      let sentMessage: SentPromptMessage | undefined;
      supervisor.testHooks.replaceWorkerSend("schedule-session", (message: unknown) => {
        sentMessage = message as SentPromptMessage;
        setTimeout(() => {
          if (!sentMessage) {
            return;
          }
          supervisor.testHooks.dispatchWorkerMessage("schedule-session", {
            kind: "result",
            requestId: sentMessage.requestId,
            ok: true,
            payload: {
              sessionId: "schedule-session",
              turnId: "turn-2",
              accepted: true,
            },
          });
        }, 0).unref?.();
        return true;
      });

      await supervisor.sendPrompt("schedule-session", "Continue the task.", {
        source: "schedule",
        trigger: {
          kind: "schedule",
          continuityMode: "inherit",
          taskSpec: {
            schema: "brewva.task.v1",
            goal: "Finish the release checklist",
          },
          truthFacts: [
            {
              id: "fact-1",
              kind: "status",
              severity: "warn",
              status: "active",
              summary: "The release note draft is incomplete.",
              evidenceIds: [],
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          parentAnchor: {
            id: "anchor-1",
            name: "release-checkpoint",
            summary: "Release prep is half done.",
          },
        },
      });

      expect(sentMessage?.payload.trigger).toEqual({
        kind: "schedule",
        continuityMode: "inherit",
        taskSpec: {
          schema: "brewva.task.v1",
          goal: "Finish the release checklist",
        },
        truthFacts: [
          {
            id: "fact-1",
            kind: "status",
            severity: "warn",
            status: "active",
            summary: "The release note draft is incomplete.",
            evidenceIds: [],
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        ],
        parentAnchor: {
          id: "anchor-1",
          name: "release-checkpoint",
          summary: "Release prep is half done.",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
