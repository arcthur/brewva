import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  collectOpenSessionQuestions,
  resolveOpenSessionQuestion,
} from "@brewva/brewva-gateway";
import { runHostedPromptTurn } from "@brewva/brewva-gateway/host";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type {
  CliShellSessionBundle,
  OperatorSurfacePort,
  SessionViewPort,
  ShellConfigPort,
  WorkspaceCompletionPort,
} from "../types.js";
export { createCliShellPromptStore } from "../prompt-store.js";

const SLASH_COMMANDS = [
  {
    command: "inspect",
    description: "Replay-first inspect report for the current session.",
  },
  {
    command: "insights",
    description: "Workspace-level insights without entering a model turn.",
  },
  {
    command: "sessions",
    description: "Browse and switch replay sessions.",
  },
  {
    command: "approvals",
    description: "Review queued approval requests.",
  },
  {
    command: "tasks",
    description: "Inspect background task runs.",
  },
  {
    command: "notifications",
    description: "Open the operator notification inbox.",
  },
  {
    command: "questions",
    description: "List unresolved operator questions.",
  },
  {
    command: "theme",
    description: "List or switch interactive shell themes.",
  },
  {
    command: "answer",
    description: "Answer a queued operator question.",
  },
  {
    command: "agent-overlays",
    description: "Inspect authored agent overlays.",
  },
  {
    command: "update",
    description: "Queue Brewva update workflow.",
  },
  {
    command: "new",
    description: "Create a new interactive session.",
  },
  {
    command: "credentials",
    description: "Show credential vault references and management commands.",
  },
  {
    command: "stash",
    description: "Browse stashed prompt drafts.",
  },
  {
    command: "unstash",
    description: "Restore the latest stashed prompt.",
  },
  {
    command: "quit",
    description: "Exit the interactive shell.",
  },
] as const;

function resolvePathBase(cwd: string, prefix: string): { directory: string; search: string } {
  const normalized = prefix.replace(/^@/u, "");
  const resolved = resolve(cwd, normalized);
  const directory =
    normalized.endsWith("/") || normalized.endsWith("\\") ? resolved : dirname(resolved);
  const search =
    normalized.endsWith("/") || normalized.endsWith("\\")
      ? ""
      : resolved.slice(directory.length + 1);
  return { directory, search };
}

function formatPathSuggestion(cwd: string, fullPath: string): string {
  const rel = relative(cwd, fullPath);
  const normalized = rel.length > 0 ? rel : ".";
  return normalized.includes(" ") ? `"${normalized}"` : normalized;
}

export function createSessionViewPort(bundle: CliShellSessionBundle): SessionViewPort {
  return {
    session: bundle.session,
    getSessionId() {
      return bundle.session.sessionManager.getSessionId();
    },
    getModelLabel() {
      return bundle.session.model?.provider && bundle.session.model?.id
        ? `${bundle.session.model.provider}/${bundle.session.model.id}`
        : "unresolved-model";
    },
    getThinkingLevel() {
      return bundle.session.thinkingLevel ?? "off";
    },
    async prompt(parts, options) {
      if (
        bundle.session.isStreaming ||
        options?.streamingBehavior ||
        options?.source !== "interactive"
      ) {
        await bundle.session.prompt(parts, options);
        return;
      }
      const output = await runHostedPromptTurn({
        session: bundle.session,
        parts,
        source: "interactive",
        runtime: bundle.runtime,
        sessionId: bundle.session.sessionManager.getSessionId(),
      });
      if (output.status === "failed") {
        throw output.error instanceof Error ? output.error : new Error(String(output.error));
      }
    },
    waitForIdle() {
      return bundle.session.waitForIdle();
    },
    abort() {
      return bundle.session.abort();
    },
    subscribe(listener) {
      return bundle.session.subscribe(listener);
    },
    getTranscriptSeed() {
      const messages = bundle.session.sessionManager.buildSessionContext?.().messages;
      return Array.isArray(messages) ? messages : [];
    },
  };
}

export function createOperatorSurfacePort(input: {
  getBundle(): CliShellSessionBundle;
  openSession(sessionId: string): Promise<CliShellSessionBundle>;
  createSession(): Promise<CliShellSessionBundle>;
}): OperatorSurfacePort {
  return {
    async getSnapshot() {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const approvals = bundle.runtime.inspect.proposals.listPendingEffectCommitments(sessionId);
      const questions = (await collectOpenSessionQuestions(bundle.runtime, sessionId)).questions;
      const taskStatus = await bundle.orchestration?.subagents?.status?.({
        fromSessionId: sessionId,
        query: {
          includeTerminal: true,
          limit: 20,
        },
      });
      const taskRuns = taskStatus?.ok ? taskStatus.runs : [];
      const sessions = bundle.runtime.inspect.events.listReplaySessions(20);
      return { approvals, questions, taskRuns, sessions };
    },
    async decideApproval(requestId, inputDecision) {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      bundle.runtime.authority.proposals.decideEffectCommitment(
        sessionId,
        requestId,
        inputDecision,
      );
    },
    async answerQuestion(questionId, answerText) {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const question = await resolveOpenSessionQuestion(bundle.runtime, sessionId, questionId);
      if (!question) {
        throw new Error(`question_not_found:${questionId}`);
      }
      const prompt = buildOperatorQuestionAnswerPrompt({ question, answerText });
      if (bundle.session.isStreaming) {
        await bundle.session.prompt([{ type: "text", text: prompt }], {
          source: "interactive",
          streamingBehavior: "followUp",
        });
      } else {
        const output = await runHostedPromptTurn({
          session: bundle.session,
          parts: [{ type: "text", text: prompt }],
          source: "interactive",
          runtime: bundle.runtime,
          sessionId,
        });
        if (output.status === "failed") {
          throw output.error instanceof Error ? output.error : new Error(String(output.error));
        }
      }
      recordRuntimeEvent(bundle.runtime, {
        sessionId,
        type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
        payload: buildOperatorQuestionAnsweredPayload({
          question,
          answerText,
          source: "runtime_plugin",
        }),
      });
    },
    async stopTask(runId) {
      const bundle = input.getBundle();
      const sessionId = bundle.session.sessionManager.getSessionId();
      const result = await bundle.orchestration?.subagents?.cancel?.({
        fromSessionId: sessionId,
        runId,
        reason: "cli_tui_stop_task",
      });
      if (!result?.ok) {
        throw new Error(result?.error ?? `cancel_failed:${runId}`);
      }
    },
    openSession(sessionId) {
      return input.openSession(sessionId);
    },
    createSession() {
      return input.createSession();
    },
  };
}

export function createWorkspaceCompletionPort(cwd: string): WorkspaceCompletionPort {
  return {
    listSlashCommands() {
      return SLASH_COMMANDS;
    },
    listPaths(prefix) {
      const { directory, search } = resolvePathBase(cwd, prefix);
      try {
        return readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.name.startsWith(search))
          .map((entry) => {
            const isDirectory = entry.isDirectory();
            const suggestion = formatPathSuggestion(cwd, join(directory, entry.name));
            return {
              value: isDirectory ? `${suggestion}/` : suggestion,
              kind: isDirectory ? ("directory" as const) : ("file" as const),
              description: isDirectory ? "directory" : "file",
            };
          })
          .slice(0, 20);
      } catch {
        return [];
      }
    },
  };
}

export function createShellConfigPort(): ShellConfigPort {
  return {
    getEditorCommand() {
      return process.env.VISUAL ?? process.env.EDITOR;
    },
  };
}
