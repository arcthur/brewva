import type {
  KernelVerificationGatePolicyInput,
  RuntimeProviderFrame,
  RuntimeProviderPort,
} from "@brewva/brewva-runtime";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  evaluateVerificationGateManifest,
  type VerificationGateEvidence,
  type VerificationGateManifest,
} from "../../../extensions/api.js";

export interface RuntimeVerificationGateSource {
  getRuntimeVerificationGateManifests?(): readonly VerificationGateManifest[];
  getRuntimeVerificationGateEvidence?(sessionId: string): readonly VerificationGateEvidence[];
  getRuntimeVerificationGateNow?(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(readString).filter((entry): entry is string => typeof entry === "string");
}

function readPatchSetRefs(payload: Record<string, unknown>): string[] {
  const refs = readStringArray(payload.patchSetRefs);
  if (refs.length > 0) {
    return refs;
  }
  const patchSetId = readString(payload.patchSetId);
  return patchSetId ? [patchSetId] : [];
}

function readVerificationEvidenceStatus(
  payload: Record<string, unknown>,
): VerificationGateEvidence["status"] | null {
  if (payload.status === "passed" || payload.status === "failed") {
    return payload.status;
  }
  if (payload.outcome === "pass") {
    return "passed";
  }
  if (payload.outcome === "fail") {
    return "failed";
  }
  return null;
}

export function readRuntimeVerificationGateEvidenceFromEvent(
  event: BrewvaEventRecord,
): VerificationGateEvidence | null {
  if (!isRecord(event.payload)) {
    return null;
  }
  const payload = event.payload;
  const adapter =
    readString(payload.adapter) ??
    (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE ? readString(payload.level) : null);
  const status = readVerificationEvidenceStatus(payload);
  const ref = readString(payload.ref) ?? (event.id ? `event:${event.id}` : null);
  if (!adapter || !status || !ref) {
    return null;
  }
  return {
    ref,
    adapter,
    targetRoots: readStringArray(payload.targetRoots),
    patchSetRefs: readPatchSetRefs(payload),
    status,
    observedAt: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
  };
}

function evaluateRuntimeVerificationGates(input: {
  readonly source: RuntimeVerificationGateSource;
  readonly sessionId: string;
}): KernelVerificationGatePolicyInput[] {
  const manifests = input.source.getRuntimeVerificationGateManifests?.() ?? [];
  if (manifests.length === 0) {
    return [];
  }
  const evidence = input.source.getRuntimeVerificationGateEvidence?.(input.sessionId) ?? [];
  const now = input.source.getRuntimeVerificationGateNow?.() ?? Date.now();
  return manifests.flatMap((manifest) => {
    const evaluation = evaluateVerificationGateManifest({ manifest, evidence, now });
    return evaluation.policyInput ? [evaluation.policyInput] : [];
  });
}

function attachVerificationGates(
  frame: RuntimeProviderFrame,
  gates: readonly KernelVerificationGatePolicyInput[],
): RuntimeProviderFrame {
  if (frame.type !== "tool" || gates.length === 0) {
    return frame;
  }
  return {
    ...frame,
    call: {
      ...frame.call,
      verificationGates: [...(frame.call.verificationGates ?? []), ...gates],
    },
  };
}

export function createVerificationGateRuntimeProviderPort(
  provider: RuntimeProviderPort,
  source: RuntimeVerificationGateSource | null,
): RuntimeProviderPort {
  return {
    async *stream(input) {
      for await (const frame of provider.stream(input)) {
        if (frame.type !== "tool") {
          yield frame;
          continue;
        }
        yield attachVerificationGates(
          frame,
          source
            ? evaluateRuntimeVerificationGates({
                source,
                sessionId: input.turn.sessionId,
              })
            : [],
        );
      }
    },
  };
}
