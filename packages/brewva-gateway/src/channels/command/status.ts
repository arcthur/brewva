import { createOperatorRuntimePort, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { formatCostViewText } from "@brewva/brewva-tools/workflow";
import { toErrorMessage } from "../../utils/errors.js";
import type { ChannelReplyWriter } from "../channel-reply-writer.js";
import type { ChannelRuntimeSessionPort } from "../session/coordinator.js";
import type { ChannelQuestionSurface } from "../session/queries.js";
import type { ChannelControlCommand } from "../types.js";
import type {
  ChannelInspectCommandInput,
  ChannelInspectCommandResult,
  ChannelInsightsCommandInput,
  ChannelInsightsCommandResult,
  ChannelQuestionsCommandInput,
  ChannelQuestionsCommandResult,
} from "./contracts.js";
import type { ChannelCommandDispatchResult } from "./dispatch.js";

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatStatusSummaryText(input: {
  targetAgentId: string;
  focusedAgentId: string;
  liveSessionId?: string;
  costText: string;
  questionsText: string;
  inspectText?: string;
  insightsText?: string;
}): string {
  const lines = [
    `Status @${input.targetAgentId}${input.targetAgentId === input.focusedAgentId ? "" : ` (focus @${input.focusedAgentId})`}`,
    `Live session: ${input.liveSessionId ?? "none"}`,
    "",
    "Cost",
    indentBlock(input.costText),
    "",
    "Operator input",
    indentBlock(input.questionsText),
  ];
  if (input.inspectText !== undefined) {
    lines.push("", "Inspect", indentBlock(input.inspectText));
  }
  if (input.insightsText !== undefined) {
    lines.push("", "Insights", indentBlock(input.insightsText));
  }
  return lines.join("\n");
}

function buildStatusSectionFailure(
  section: "questions" | "inspect" | "insights",
  message: string,
): ChannelQuestionsCommandResult | ChannelInspectCommandResult | ChannelInsightsCommandResult {
  return {
    text: message,
    meta: {
      command: section,
      status: "dependency_failed",
    },
  };
}

export async function handleChannelStatusCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "status" }>;
  turn: TurnEnvelope;
  runtime: BrewvaRuntime;
  replyWriter: ChannelReplyWriter;
  focusedAgentId: string;
  targetAgentId: string;
  isTargetActive: boolean;
  openLiveSession(scopeKey: string, agentId: string): ChannelRuntimeSessionPort | undefined;
  resolveQuestionSurface(
    scopeKey: string,
    agentId: string,
  ): Promise<ChannelQuestionSurface | undefined>;
  dependencies?: {
    handleInspectCommand?: (
      input: ChannelInspectCommandInput,
    ) => Promise<ChannelInspectCommandResult>;
    handleInsightsCommand?: (
      input: ChannelInsightsCommandInput,
    ) => Promise<ChannelInsightsCommandResult>;
    handleQuestionsCommand?: (
      input: ChannelQuestionsCommandInput,
    ) => Promise<ChannelQuestionsCommandResult>;
  };
}): Promise<ChannelCommandDispatchResult> {
  const { command, turn, replyWriter } = input;
  if (!input.isTargetActive) {
    await replyWriter.sendControllerReply(
      turn,
      command.scopeKey,
      `Status unavailable: agent @${input.targetAgentId} is not active in this workspace.`,
      {
        command: "status",
        agentId: input.targetAgentId,
        status: "agent_not_active",
      },
    );
    return { handled: true };
  }
  const targetSession = input.openLiveSession(command.scopeKey, input.targetAgentId);
  const top = typeof command.top === "number" ? command.top : 5;
  const includeDiagnostics = command.details === true || typeof command.directory === "string";
  let questionSurface: ChannelQuestionSurface | undefined;
  let questionsResult: ChannelQuestionsCommandResult | undefined;
  try {
    questionSurface = await input.resolveQuestionSurface(command.scopeKey, input.targetAgentId);
  } catch (error) {
    questionsResult = buildStatusSectionFailure(
      "questions",
      `Operator input unavailable: failed to load durable session history for @${input.targetAgentId} (${toErrorMessage(error)}).`,
    );
  }
  if (!questionsResult) {
    if (input.dependencies?.handleQuestionsCommand) {
      try {
        questionsResult = await input.dependencies.handleQuestionsCommand({
          turn,
          scopeKey: command.scopeKey,
          focusedAgentId: input.focusedAgentId,
          targetAgentId: input.targetAgentId,
          questionSurface,
        });
      } catch (error) {
        questionsResult = buildStatusSectionFailure(
          "questions",
          `Operator input unavailable: failed to build the questions summary for @${input.targetAgentId} (${toErrorMessage(error)}).`,
        );
      }
    } else {
      questionsResult = {
        text: "Operator inbox is unavailable in this host.",
      };
    }
  }
  const targetSessionPort = targetSession
    ? {
        agentId: targetSession.agentId,
        runtime: createOperatorRuntimePort(targetSession.runtime),
        sessionId: targetSession.agentSessionId,
      }
    : undefined;
  const inspectResult = includeDiagnostics
    ? input.dependencies?.handleInspectCommand
      ? await input.dependencies
          .handleInspectCommand({
            directory: command.directory,
            turn,
            scopeKey: command.scopeKey,
            focusedAgentId: input.focusedAgentId,
            targetAgentId: input.targetAgentId,
            targetSession: targetSessionPort,
          })
          .catch((error) =>
            buildStatusSectionFailure(
              "inspect",
              `Inspect unavailable: failed to build the inspect summary for @${input.targetAgentId} (${toErrorMessage(error)}).`,
            ),
          )
      : {
          text: "Inspect is unavailable in this host.",
        }
    : undefined;
  const insightsResult = includeDiagnostics
    ? input.dependencies?.handleInsightsCommand
      ? await input.dependencies
          .handleInsightsCommand({
            directory: command.directory,
            turn,
            scopeKey: command.scopeKey,
            focusedAgentId: input.focusedAgentId,
            targetAgentId: input.targetAgentId,
            targetSession: targetSessionPort,
          })
          .catch((error) =>
            buildStatusSectionFailure(
              "insights",
              `Insights unavailable: failed to build the insights summary for @${input.targetAgentId} (${toErrorMessage(error)}).`,
            ),
          )
      : {
          text: "Insights are unavailable in this host.",
        }
    : undefined;
  const costText = targetSession
    ? formatCostViewText(
        targetSession.runtime.inspect.cost.getSummary(targetSession.agentSessionId),
        top,
      )
    : `Cost view unavailable: agent @${input.targetAgentId} does not have a live session.`;
  const statusMeta = {
    command: "status",
    agentId: input.targetAgentId,
    top,
    directory: command.directory,
    details: includeDiagnostics,
    liveSessionId: targetSession?.agentSessionId ?? null,
    sections: {
      cost: {
        top,
        liveSessionId: targetSession?.agentSessionId ?? null,
      },
      questions: questionsResult.meta ?? null,
      ...(inspectResult
        ? {
            inspect: inspectResult.meta ?? null,
          }
        : {}),
      ...(insightsResult
        ? {
            insights: insightsResult.meta ?? null,
          }
        : {}),
    },
  } satisfies Record<string, unknown>;
  const text = formatStatusSummaryText({
    targetAgentId: input.targetAgentId,
    focusedAgentId: input.focusedAgentId,
    liveSessionId: targetSession?.agentSessionId,
    costText,
    questionsText: questionsResult.text,
    inspectText: inspectResult?.text,
    insightsText: insightsResult?.text,
  });
  await replyWriter.sendControllerReply(turn, command.scopeKey, text, statusMeta);
  return { handled: true };
}
