import { toJsonValue } from "@brewva/brewva-std/json";
import {
  stableHarnessId,
  wrapHarnessManifestRecordedAdvisoryPayload,
  type HarnessManifest,
} from "@brewva/brewva-vocabulary/harness";
import type { HostedRuntimeAdapterPort } from "../runtime-ports.js";

// Harness-manifest read/record helpers for the managed agent session. These are
// pure, `this`-free utilities extracted from session.ts so the session class
// keeps only orchestration. The manifest is the per-attempt provider/skill/
// capability fingerprint recorded as an advisory event.

export function recordRuntimeHarnessManifest(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly manifest: HarnessManifest;
  readonly turnId?: string;
}): void {
  const advisoryPayload = wrapHarnessManifestRecordedAdvisoryPayload(input.manifest);
  input.runtime.runtime.kernel.recordAdvisoryEvent({
    sessionId: input.manifest.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    namespace: advisoryPayload.namespace,
    kind: advisoryPayload.kind,
    version: advisoryPayload.version,
    payload: toJsonValue(advisoryPayload.payload),
  });
}

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readProviderFallbackActive(value: unknown): boolean {
  return readRecordValue(value)?.active === true;
}

export function turnNumberFromTurnId(turnId: string | undefined): number | undefined {
  if (!turnId) return undefined;
  const numeric = Number(turnId);
  if (Number.isFinite(numeric)) return numeric;
  const structured = /^turn[-_](\d+)$/u.exec(turnId);
  if (!structured) return undefined;
  const structuredNumeric = Number(structured[1]);
  return Number.isFinite(structuredNumeric) ? structuredNumeric : undefined;
}

export function nextHarnessProviderAttemptSequence(input: {
  readonly turnId?: string;
  readonly currentTurnKey?: string;
  readonly currentSequence: number;
  readonly update: (next: { readonly turnKey: string; readonly sequence: number }) => void;
}): number {
  const turnKey = input.turnId ?? "__unknown_turn__";
  const sequence = input.currentTurnKey === turnKey ? input.currentSequence + 1 : 1;
  input.update({ turnKey, sequence });
  return sequence;
}

export function readHarnessSkillSelection(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): HarnessManifest["skillSelection"] | undefined {
  const receipt = readRecordValue(runtime.ops.skills.selection.latest(sessionId));
  if (!receipt) return undefined;
  const invocationRecords = Array.isArray(receipt.skillInvocationRecords)
    ? receipt.skillInvocationRecords
    : [];
  const selectedSkillIds = invocationRecords
    .map((entry) => readStringValue(readRecordValue(entry)?.name))
    .filter((entry): entry is string => entry !== undefined)
    .toSorted();
  return {
    selectionId: readStringValue(receipt.selectionId),
    mode: readStringValue(receipt.selectionMode),
    selectedSkillIds,
    renderedContextHash: stableHarnessId("skill_context", {
      selectionId: receipt.selectionId,
      renderedSkillCount: receipt.renderedSkillCount,
      omittedSkillCount: receipt.omittedSkillCount,
      promptPaths: receipt.promptPaths,
    }),
  };
}

export function readHarnessCapabilitySelection(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): HarnessManifest["capabilitySelection"] | undefined {
  const receipt = readRecordValue(runtime.ops.tools.capabilitySelection.latest(sessionId));
  if (!receipt) return undefined;
  const selected = Array.isArray(receipt.selected_capabilities)
    ? receipt.selected_capabilities
    : [];
  return {
    selectionId: readStringValue(receipt.selection_id),
    selectedCapabilityNames: selected
      .map((entry) => readStringValue(readRecordValue(entry)?.name))
      .filter((entry): entry is string => entry !== undefined)
      .toSorted(),
  };
}
