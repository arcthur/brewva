import { randomUUID } from "node:crypto";
import process from "node:process";
import { runEdgeOperation } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import {
  buildUnattendedApprovalDecider,
  createProviderConnectionPort,
  createProviderConnectionSeams,
  resumeApprovalsWithinEnvelope,
  runHostedPromptTurn,
  unattendedApprovalPolicyIsActive,
} from "@brewva/brewva-gateway/hosted";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  BrewvaManagedPromptSession,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate/session";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { SessionPromptSnapshot } from "@brewva/brewva-vocabulary/session";
import type { OpenTuiScreenMode } from "../internal/tui/internal-opentui-runtime.js";
import {
  extractMessageError,
  extractVisibleTextFromMessage,
  readMessageRole,
  readMessageStopReason,
} from "../io/message-content.js";
import {
  createCliRuntimePorts,
  type CliInspectPort,
  type CliOperatorPort,
} from "../runtime/cli-runtime-ports.js";
import type { CliShellSessionBundle } from "../shell/ports/session-port.js";
import type { BrewvaSessionResult } from "./session.js";

type CliPrintMode = "json" | "text";

/**
 * Provenance label recorded on every unattended auto-decision receipt. The
 * decision's authority is the operator-authored, deep-readonly config policy —
 * the model cannot reach it — and this actor makes the auto-approval auditable on
 * the tape, mirroring the `schedule-envelope` / `delegation-envelope` lanes.
 */
const UNATTENDED_APPROVAL_ACTOR = "unattended-config-policy";

export interface CliInteractiveShellOptions {
  cwd: string;
  initialMessage?: string;
  verbose?: boolean;
  openSession(sessionId: string): Promise<BrewvaSessionResult>;
  createSession(): Promise<BrewvaSessionResult>;
  onSessionChange?(result: BrewvaSessionResult): void;
}

export interface CliInteractiveSessionOptions extends CliInteractiveShellOptions {
  runtime: HostedRuntimeAdapterPort;
  providerConnections?: BrewvaSessionResult["providerConnections"];
  initPhases: BrewvaSessionResult["initPhases"];
  phase: BrewvaSessionResult["phase"];
  orchestration?: BrewvaSessionResult["orchestration"];
}

export interface CliInteractiveSmokeResult {
  backend: "opentui";
  screenMode: OpenTuiScreenMode;
  label?: string;
}

export type CliInteractiveShellLauncher = (
  bundle: CliShellSessionBundle,
  options: {
    cwd: string;
    initialMessage?: string;
    verbose?: boolean;
    openSession(sessionId: string): Promise<CliShellSessionBundle>;
    createSession(): Promise<CliShellSessionBundle>;
    onBundleChange?(bundle: CliShellSessionBundle): void;
  },
) => Promise<void>;

function writeStdout(text: string): void {
  if (text.length === 0) {
    return;
  }
  process.stdout.write(text);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function createToolDefinitionMap(
  session: BrewvaManagedPromptSession,
): ReadonlyMap<string, BrewvaToolDefinition> {
  return new Map(
    session
      .getRegisteredTools()
      .map((tool) => [tool.name, tool] satisfies [string, BrewvaToolDefinition]),
  );
}

function toCliShellSessionBundle(input: {
  session: BrewvaManagedPromptSession;
  runtime: HostedRuntimeAdapterPort;
  providerConnections?: BrewvaSessionResult["providerConnections"];
  initPhases: BrewvaSessionResult["initPhases"];
  phase: BrewvaSessionResult["phase"];
  orchestration?: BrewvaSessionResult["orchestration"];
}): CliShellSessionBundle {
  const { inspect, operator } = createCliRuntimePorts(input.runtime);
  return {
    session: input.session,
    runtime: input.runtime,
    inspect,
    operator,
    toolDefinitions: createToolDefinitionMap(input.session),
    providerConnections:
      input.providerConnections ??
      (input.session.modelRegistry
        ? createProviderConnectionSeams(
            createProviderConnectionPort({
              runtime: input.runtime,
              modelRegistry: input.session.modelRegistry,
            }),
          )
        : undefined),
    initPhases: input.initPhases,
    phase: input.phase,
    orchestration: input.orchestration,
  };
}

async function runCliTurn(
  session: BrewvaManagedPromptSession,
  prompt: string,
  options: {
    printText: boolean;
    runtime: HostedRuntimeAdapterPort;
    operator: CliOperatorPort;
    inspect: CliInspectPort;
  },
): Promise<string> {
  let emittedText = "";
  let streamedText = false;
  let terminalAssistantError: string | undefined;
  // Whether the current assistant message streamed any delta. An unattended
  // approval resume produces MULTIPLE assistant messages within one runCliTurn
  // (pre-suspension text, then post-approval continuation); each message's text
  // must accumulate. Tracking deltas per message — rather than "has emittedText
  // grown at all" — lets a non-streaming provider's later message contribute its
  // fallback text instead of being locked out by an earlier one.
  let sawDeltaForCurrentMessage = false;

  const unsubscribe = session.subscribe((event: BrewvaPromptSessionEvent) => {
    if (event.type === "message_update") {
      const deltaEvent = asRecord(event.assistantMessageEvent);
      if (
        deltaEvent?.type === "text_delta" &&
        typeof deltaEvent.delta === "string" &&
        deltaEvent.delta.length > 0
      ) {
        sawDeltaForCurrentMessage = true;
        emittedText += deltaEvent.delta;
        if (options.printText) {
          streamedText = true;
          writeStdout(deltaEvent.delta);
        }
      }
      return;
    }

    if (event.type !== "message_end") {
      return;
    }

    if (readMessageRole(event.message) !== "assistant") {
      return;
    }

    if (readMessageStopReason(event.message) === "error") {
      terminalAssistantError = extractMessageError(event.message) ?? "Assistant turn failed.";
      return;
    }

    // A non-streaming message contributes its full text once, appended so a
    // resumed continuation adds to (never replaces) the pre-suspension text.
    const fallbackText = extractVisibleTextFromMessage(event.message);
    if (!sawDeltaForCurrentMessage && fallbackText.length > 0) {
      emittedText += fallbackText;
      if (options.printText) {
        streamedText = true;
        writeStdout(fallbackText);
      }
    }
    sawDeltaForCurrentMessage = false;
  });

  try {
    const sessionId = session.sessionManager?.getSessionId?.()?.trim();
    if (!sessionId) {
      throw new Error("cli_print_session_missing_session_id");
    }
    const parts = [{ type: "text" as const, text: prompt }];
    // This identity binds the checkpoint, every turn receipt, and the
    // unattended approval envelope. A reused session can contain requests from
    // other turns, so a time snapshot is insufficient authority correlation.
    const turnId = `print:${randomUUID()}`;
    options.operator.session.recordCheckpoint(sessionId, {
      turnId,
      prompt: {
        text: prompt,
        parts: structuredClone(parts) as unknown as SessionPromptSnapshot["parts"],
      },
    });
    let output = await runHostedPromptTurn({
      session,
      parts,
      source: "print",
      runtime: options.runtime,
      sessionId,
      turnId,
    });
    // Unattended (`--print`) runs have no interactive approver. When the operator
    // has declared an effect-class envelope, auto-decide approvals within it and
    // resume; an uncovered class still suspends fail-closed. Interactive sessions
    // never reach here (they answer approvals through the operator). The policy is
    // honored only from an operator source outside the model-writable workspace
    // (the loader's operator-source barrier) and its resolved snapshot is
    // immutable, so a model cannot widen its own envelope by editing workspace
    // state. (Granting `local_exec` remains host execution, a separate boundary.)
    let approvalCapExhausted = false;
    if (output.status === "suspended" && output.reason === "approval") {
      const policy = options.runtime.config.security.unattendedApproval;
      if (unattendedApprovalPolicyIsActive(policy)) {
        const resumed = await resumeApprovalsWithinEnvelope({
          initial: output,
          sessionId,
          turnId,
          listPendingApprovals: (id) => options.inspect.proposals.listPending(id),
          decide: buildUnattendedApprovalDecider(policy),
          acceptApproval: (id, requestId) =>
            options.operator.proposals.decide(id, requestId, {
              decision: "accept",
              actor: UNATTENDED_APPROVAL_ACTOR,
              reason:
                "unattended config policy allows this effect class within its declared envelope",
            }),
          denyApproval: (id, requestId) =>
            options.operator.proposals.decide(id, requestId, {
              decision: "deny",
              actor: UNATTENDED_APPROVAL_ACTOR,
              reason: "unattended config policy denies this effect class",
            }),
          resumeTurn: (resolveApproval) =>
            runHostedPromptTurn({
              session,
              parts: [],
              source: "print",
              runtime: options.runtime,
              sessionId,
              turnId,
              resolveApproval,
            }),
        });
        output = resumed.output;
        approvalCapExhausted = resumed.capExhausted;
      }
    }
    if (output.status === "failed") {
      throw output.error instanceof Error ? output.error : new Error(String(output.error));
    }
    if (output.status === "suspended") {
      // A `--print` run that ends still suspended did not finish its work; surface
      // it as a non-zero failure (matching the worker path, which projects an
      // unconverged turn as failed) rather than exiting 0 on incomplete work.
      const detail = approvalCapExhausted
        ? "it exhausted the approval-resume cap"
        : output.reason === "approval"
          ? "an approval was left unresolved (an uncovered effect class fail-closed, or no unattended policy is active)"
          : `it suspended (${output.reason ?? "unknown reason"})`;
      throw new Error(`unattended print run did not converge: ${detail}`);
    }
    if (output.status === "completed" && emittedText.length === 0) {
      emittedText = output.assistantText;
      if (options.printText) {
        streamedText = true;
        writeStdout(output.assistantText);
      }
    }
    await session.waitForIdle();
  } finally {
    unsubscribe();
  }

  if (terminalAssistantError) {
    throw new Error(terminalAssistantError);
  }

  if (options.printText && streamedText && !emittedText.endsWith("\n")) {
    writeStdout("\n");
  }

  return emittedText;
}

export async function runCliInteractiveSessionOperation(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
  launchInteractiveShell: CliInteractiveShellLauncher,
): Promise<void> {
  await launchInteractiveShell(
    toCliShellSessionBundle({
      session,
      runtime: options.runtime,
      providerConnections: options.providerConnections,
      initPhases: options.initPhases,
      phase: options.phase,
      orchestration: options.orchestration,
    }),
    {
      cwd: options.cwd,
      initialMessage: options.initialMessage,
      verbose: options.verbose,
      async openSession(sessionId) {
        const result = await options.openSession(sessionId);
        options.onSessionChange?.(result);
        return toCliShellSessionBundle(result);
      },
      async createSession() {
        const result = await options.createSession();
        options.onSessionChange?.(result);
        return toCliShellSessionBundle(result);
      },
      onBundleChange(bundle) {
        options.onSessionChange?.({
          session: bundle.session,
          runtime: bundle.runtime,
          initPhases: bundle.initPhases,
          phase: bundle.phase,
          orchestration: bundle.orchestration,
        });
      },
    },
  );
}

export function runCliInteractiveShellEffect(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
  launchInteractiveShell: CliInteractiveShellLauncher,
): BrewvaEffect.Effect<void, unknown> {
  return BrewvaEffect.promise(() =>
    runCliInteractiveSessionOperation(session, options, launchInteractiveShell),
  );
}

export async function runCliInteractiveSession(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
  launchInteractiveShell: CliInteractiveShellLauncher,
): Promise<void> {
  return await runEdgeOperation(
    "brewva.cli.interactive",
    runCliInteractiveShellEffect(session, options, launchInteractiveShell),
    {
      fields: {
        cwd: options.cwd,
      },
    },
  );
}

export async function runCliPrintSession(
  session: BrewvaManagedPromptSession,
  options: {
    mode: CliPrintMode;
    initialMessage?: string;
    runtime: HostedRuntimeAdapterPort;
    operator: CliOperatorPort;
    inspect: CliInspectPort;
  },
): Promise<void> {
  if (typeof options.initialMessage !== "string" || options.initialMessage.trim().length === 0) {
    return;
  }

  await runCliTurn(session, options.initialMessage, {
    printText: options.mode === "text",
    runtime: options.runtime,
    operator: options.operator,
    inspect: options.inspect,
  });
}
