import type { RuntimeResult } from "./shared.js";

export type TaskSpecSchema = "brewva.task.v1";

export interface TaskSpec {
  schema: TaskSpecSchema;
  goal: string;
  targets?: {
    files?: string[];
    symbols?: string[];
  };
  expectedBehavior?: string;
  constraints?: string[];
  verification?: {
    commands?: string[];
  };
  acceptance?: {
    required?: boolean;
    criteria?: string[];
  };
}

export interface TaskTargetDescriptor {
  primaryRoot: string;
  roots: string[];
}

export type TaskItemStatus = "todo" | "doing" | "done" | "blocked";

export type TaskPhase =
  | "align"
  | "investigate"
  | "execute"
  | "verify"
  | "ready_for_acceptance"
  | "blocked"
  | "done";

export type TaskHealth =
  | "ok"
  | "exploring"
  | "blocked"
  | "verification_missing"
  | "verification_failed"
  | "acceptance_pending"
  | "acceptance_rejected"
  | "budget_pressure"
  | "unknown";

export interface TaskStatus {
  phase: TaskPhase;
  health: TaskHealth;
  reason?: string;
  updatedAt: number;
  truthFactIds?: string[];
}

export interface TaskItem {
  id: string;
  text: string;
  status: TaskItemStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TaskBlocker {
  id: string;
  message: string;
  createdAt: number;
  source?: string;
  truthFactId?: string;
}

export type TaskAcceptanceStatus = "pending" | "accepted" | "rejected";

export interface TaskAcceptanceState {
  status: TaskAcceptanceStatus;
  updatedAt: number;
  decidedBy?: string;
  notes?: string;
}

export interface TaskState {
  spec?: TaskSpec;
  status?: TaskStatus;
  acceptance?: TaskAcceptanceState;
  items: TaskItem[];
  blockers: TaskBlocker[];
  updatedAt: number | null;
}

export type TaskItemAddResult = RuntimeResult<{ itemId: string }>;
export type TaskItemUpdateResult = RuntimeResult;
export type TaskBlockerRecordResult = RuntimeResult<{ blockerId: string }>;
export type TaskBlockerResolveResult = RuntimeResult;
export type TaskAcceptanceRecordResult = RuntimeResult;

export type TaskLedgerEventPayload =
  | {
      schema: "brewva.task.ledger.v1";
      kind: "spec_set";
      spec: TaskSpec;
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "checkpoint_set";
      state: TaskState;
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "status_set";
      status: TaskStatus;
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "item_added";
      item: {
        id: string;
        text: string;
        status?: TaskItemStatus;
      };
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "item_updated";
      item: {
        id: string;
        text?: string;
        status?: TaskItemStatus;
      };
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "blocker_recorded";
      blocker: {
        id: string;
        message: string;
        source?: string;
        truthFactId?: string;
      };
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "blocker_resolved";
      blockerId: string;
    }
  | {
      schema: "brewva.task.ledger.v1";
      kind: "acceptance_set";
      acceptance: TaskAcceptanceState;
    };
