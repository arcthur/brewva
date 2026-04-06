import type { ManagedToolMode, SessionWireFrame } from "@brewva/brewva-runtime";
import type { SendPromptTrigger } from "../daemon/session-backend.js";

export type WorkerResultErrorCode = "session_busy";

export type ParentToWorkerMessage =
  | {
      kind: "init";
      requestId: string;
      payload: {
        sessionId: string;
        cwd?: string;
        configPath?: string;
        model?: string;
        agentId?: string;
        managedToolMode?: ManagedToolMode;
        parentPid: number;
      };
    }
  | {
      kind: "send";
      requestId: string;
      payload: {
        prompt: string;
        turnId: string;
        walReplayId?: string;
        trigger?: SendPromptTrigger;
        source?: "gateway" | "heartbeat" | "schedule";
      };
    }
  | {
      kind: "abort";
      requestId: string;
      payload?: {
        reason?: "user_submit";
      };
    }
  | {
      kind: "bridge.ping";
      ts: number;
    }
  | {
      kind: "shutdown";
      requestId: string;
      payload?: {
        reason?: string;
      };
    }
  | {
      kind: "sessionContextPressure.query";
      requestId: string;
    };

export type WorkerToParentMessage =
  | {
      kind: "ready";
      requestId: string;
      payload: {
        requestedSessionId: string;
        agentSessionId: string;
        agentEventLogPath: string;
      };
    }
  | {
      kind: "result";
      requestId: string;
      ok: true;
      payload?: Record<string, unknown>;
    }
  | {
      kind: "result";
      requestId: string;
      ok: false;
      error: string;
      errorCode?: WorkerResultErrorCode;
    }
  | {
      kind: "event";
      event: "session.wire.frame";
      payload: {
        sessionId: string;
        frame: SessionWireFrame;
      };
    }
  | {
      kind: "bridge.heartbeat";
      ts: number;
    }
  | {
      kind: "log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      fields?: Record<string, unknown>;
    };
