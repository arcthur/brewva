import { redactedStableJsonStringify, sha256Hex } from "@brewva/brewva-std/hash";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { BrewvaHostCustomMessage } from "@brewva/brewva-substrate/host-api";

export interface WorkbenchContextFingerprintInput {
  present: boolean;
  scope: "dynamic_tail";
  entryCount: number;
  notes: number;
  evictions: number;
  contentHash: string | null;
}

export const EMPTY_WORKBENCH_CONTEXT_FINGERPRINT: WorkbenchContextFingerprintInput = {
  present: false,
  scope: "dynamic_tail",
  entryCount: 0,
  notes: 0,
  evictions: 0,
  contentHash: null,
};

/**
 * Single-slot holder for the latest workbench-context fingerprint. The prompt
 * dispatch path writes via `set(...)` while the provider payload pipeline reads
 * via `get()`, so both sides share one instance instead of reaching across the
 * session for a mutable class field.
 */
export class WorkbenchContextFingerprintHolder {
  #value: WorkbenchContextFingerprintInput = { ...EMPTY_WORKBENCH_CONTEXT_FINGERPRINT };

  get(): WorkbenchContextFingerprintInput {
    return this.#value;
  }

  set(value: WorkbenchContextFingerprintInput): void {
    this.#value = value;
  }
}

export function resolveWorkbenchContextFingerprint(
  messages: readonly BrewvaHostCustomMessage[] | undefined,
): WorkbenchContextFingerprintInput {
  let latest: WorkbenchContextFingerprintInput | undefined;
  for (const message of messages ?? []) {
    if (message.customType !== "brewva-workbench-context") {
      continue;
    }
    const workbench = isRecord(message.details) ? message.details.workbench : undefined;
    if (!isRecord(workbench)) {
      continue;
    }
    latest = {
      present: true,
      scope: "dynamic_tail",
      entryCount: typeof workbench.entries === "number" ? Math.max(0, workbench.entries) : 0,
      notes: typeof workbench.notes === "number" ? Math.max(0, workbench.notes) : 0,
      evictions: typeof workbench.evictions === "number" ? Math.max(0, workbench.evictions) : 0,
      contentHash:
        typeof workbench.contentHash === "string" && workbench.contentHash.trim().length > 0
          ? workbench.contentHash
          : null,
    };
  }
  return latest ?? { ...EMPTY_WORKBENCH_CONTEXT_FINGERPRINT };
}

export function buildProviderDynamicTailSummary(input: {
  payload: unknown;
  channelContext: unknown;
  workbenchContext: WorkbenchContextFingerprintInput;
  visibleHistoryReduction: unknown;
}): unknown {
  return {
    version: 1,
    payloadTail: summarizeProviderPayloadTail(input.payload),
    channelContext: input.channelContext,
    workbenchContext: input.workbenchContext,
    visibleHistoryReduction: input.visibleHistoryReduction,
  };
}

function summarizeProviderPayloadTail(payload: unknown): unknown {
  if (!isRecord(payload)) {
    const serialized = redactedStableJsonStringify(payload);
    return {
      kind: typeof payload,
      bytes: serialized.length,
      tailHash: sha256Hex(serialized.slice(-4096)),
    };
  }
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  return {
    messageCount: messages.length,
    lastMessages: messages.slice(-4).map((message) => summarizeProviderPayloadMessage(message)),
    hasTools: Array.isArray(payload.tools) && payload.tools.length > 0,
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
  };
}

function summarizeProviderPayloadMessage(message: unknown): unknown {
  const serialized = redactedStableJsonStringify(message);
  const role = isRecord(message) && typeof message.role === "string" ? message.role : null;
  const type = isRecord(message) && typeof message.type === "string" ? message.type : null;
  const content = isRecord(message) ? message.content : undefined;
  const contentSerialized = redactedStableJsonStringify(content ?? null);
  return {
    role,
    type,
    bytes: serialized.length,
    contentBytes: contentSerialized.length,
    contentTailHash: sha256Hex(contentSerialized.slice(-4096)),
  };
}
