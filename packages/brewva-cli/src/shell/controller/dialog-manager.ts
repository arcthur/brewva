import { type SessionQuestionRequest } from "@brewva/brewva-gateway";
import {
  type BrewvaInteractiveQuestionRequest,
  type BrewvaUiDialogOptions,
  normalizeQuestionPrompt,
} from "@brewva/brewva-substrate/host-api";
import type { OverlayPriority } from "../../internal/tui/index.js";
import type { CliShellOverlayPayload } from "../domain/overlays/payloads.js";
import { buildOpenQuestionsFromRequest } from "../domain/question-utils.js";

interface PendingInteractiveQuestionRequest {
  overlayId: string;
  sessionId: string;
  settle(value: readonly (readonly string[])[] | undefined): void;
}

export interface ShellDialogManagerContext {
  getSessionId(): string;
  openOverlayWithOptions(
    payload: CliShellOverlayPayload,
    options?: { priority?: OverlayPriority; suspendCurrent?: boolean },
  ): string;
  closeOverlayById(overlayId: string): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readQuestionOption(value: unknown): { label: string; description?: string } | null {
  const record = asRecord(value);
  const label =
    typeof record?.label === "string" && record.label.trim().length > 0
      ? record.label.trim()
      : null;
  if (!label) {
    return null;
  }
  const description =
    typeof record?.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : undefined;
  return description ? { label, description } : { label };
}

function buildInteractiveQuestionRequest(input: {
  sessionId: string;
  request: BrewvaInteractiveQuestionRequest;
}): SessionQuestionRequest | null {
  const questions: SessionQuestionRequest["questions"] = [];
  for (const [index, question] of input.request.questions.entries()) {
    const normalizedQuestion = normalizeQuestionPrompt(question);
    if (!normalizedQuestion) {
      return null;
    }
    questions.push({
      questionId: `tool:${input.request.toolCallId}:question:${index + 1}`,
      header: normalizedQuestion.header,
      questionText: normalizedQuestion.question,
      options: normalizedQuestion.options
        .map((option) => readQuestionOption(option))
        .filter((option): option is { label: string; description?: string } => option !== null),
      ...(normalizedQuestion.multiple === true ? { multiple: true } : {}),
      custom: normalizedQuestion.custom,
    });
  }
  if (questions.length === 0) {
    return null;
  }
  return {
    requestId: `tool:${input.request.toolCallId}`,
    sessionId: input.sessionId,
    createdAt: Date.now(),
    presentationKind: "input_request",
    sourceKind: "tool",
    sourceEventId: `tool:${input.request.toolCallId}`,
    sourceLabel: "tool:question",
    questions,
  };
}

export class ShellDialogManager {
  readonly #dialogResolvers = new Map<string, (value: unknown) => void>();
  readonly #pendingInteractiveQuestionRequests = new Map<
    string,
    PendingInteractiveQuestionRequest
  >();

  constructor(private readonly context: ShellDialogManagerContext) {}

  resolveDialog(dialogId: string | undefined, value: unknown): void {
    if (!dialogId) {
      return;
    }
    const resolve = this.#dialogResolvers.get(dialogId);
    if (!resolve) {
      return;
    }
    this.#dialogResolvers.delete(dialogId);
    resolve(value);
  }

  settleInteractiveQuestionRequest(
    requestId: string,
    value: readonly (readonly string[])[] | undefined,
  ): void {
    const pending = this.#pendingInteractiveQuestionRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.#pendingInteractiveQuestionRequests.delete(requestId);
    pending.settle(value);
  }

  dismissPendingInteractiveQuestionRequests(input?: { sessionId?: string }): void {
    for (const [requestId, pending] of this.#pendingInteractiveQuestionRequests.entries()) {
      if (input?.sessionId && pending.sessionId !== input.sessionId) {
        continue;
      }
      this.#pendingInteractiveQuestionRequests.delete(requestId);
      pending.settle(undefined);
      this.context.closeOverlayById(pending.overlayId);
    }
  }

  async requestDialog<T>(
    request: {
      id: string;
      kind: "confirm" | "input" | "select";
      title: string;
      message?: string;
      options?: string[];
      masked?: boolean;
      compact?: boolean;
    },
    options: { priority?: OverlayPriority; suspendCurrent?: boolean } = {},
  ): Promise<T> {
    return await new Promise<T>((resolve) => {
      const settle = (value: unknown): void => {
        resolve(value as T);
      };
      this.#dialogResolvers.set(request.id, settle);
      const payload =
        request.kind === "confirm"
          ? ({
              kind: "confirm",
              dialogId: request.id,
              message: request.message ?? request.title,
            } satisfies CliShellOverlayPayload)
          : request.kind === "input"
            ? ({
                kind: "input",
                dialogId: request.id,
                title: request.title,
                message: request.message,
                value: "",
                masked: request.masked,
                compact: request.compact,
              } satisfies CliShellOverlayPayload)
            : ({
                kind: "select",
                dialogId: request.id,
                title: request.title,
                options: request.options ?? [],
                selectedIndex: 0,
              } satisfies CliShellOverlayPayload);
      this.context.openOverlayWithOptions(payload, {
        priority: options.priority ?? "queued",
        suspendCurrent: options.suspendCurrent,
      });
    });
  }

  async requestCustom<T>(
    kind: string,
    payload: unknown,
    options?: BrewvaUiDialogOptions,
  ): Promise<T> {
    if (kind !== "question" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Unsupported UI custom request.");
    }
    const interactiveRequest = payload as BrewvaInteractiveQuestionRequest;
    const request = buildInteractiveQuestionRequest({
      sessionId: this.context.getSessionId(),
      request: interactiveRequest,
    });
    if (!request) {
      throw new Error("Invalid interactive question request.");
    }
    if (options?.signal?.aborted) {
      return undefined as T;
    }

    return await new Promise<T>((resolve) => {
      let settled = false;
      let overlayId = "";
      const settle = (value: readonly (readonly string[])[] | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", handleAbort);
        this.#pendingInteractiveQuestionRequests.delete(request.requestId);
        resolve(value as T);
      };
      const handleAbort = (): void => {
        settle(undefined);
        if (overlayId) {
          this.context.closeOverlayById(overlayId);
        }
      };
      if (options?.signal) {
        options.signal.addEventListener("abort", handleAbort, { once: true });
      }
      overlayId = this.context.openOverlayWithOptions(
        {
          kind: "question",
          mode: "interactive",
          selectedIndex: 0,
          requestTitle:
            typeof interactiveRequest.title === "string" &&
            interactiveRequest.title.trim().length > 0
              ? interactiveRequest.title.trim()
              : "Agent needs input",
          interactiveRequest,
          snapshot: {
            approvals: [],
            questions: buildOpenQuestionsFromRequest(request),
            taskRuns: [],
            sessions: [],
          },
        },
        {
          priority: "normal",
          suspendCurrent: true,
        },
      );
      this.#pendingInteractiveQuestionRequests.set(request.requestId, {
        overlayId,
        sessionId: request.sessionId,
        settle,
      });
    });
  }
}
