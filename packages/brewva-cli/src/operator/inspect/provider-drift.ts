import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import type { ProviderDriftSource } from "@brewva/brewva-vocabulary/context";
import { createCliInspectPort } from "../../runtime/cli-runtime-ports.js";

// Provider-drift inspect view: the read-path consumer the seam-wide drift primitive
// requires (a forensic layer without a consumer decays into unread dead weight). It
// pulls the latest lossy `provider_drift_sample` and projects it. Explicit-pull,
// read-only over evidence — no recall, no materialization, no provider routing, no
// mutation. Fails closed to a null projection when no sample is present.

export interface ProviderDriftLatest {
  readonly source: ProviderDriftSource;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reason: string | null;
  readonly attemptedProvider: string | null;
  readonly attemptedModel: string | null;
  readonly credentialSlot: string | null;
  readonly errorSummary: string | null;
  readonly requestedTransport: string | null;
  readonly actualTransport: string | null;
}

export interface ProviderDriftProjection {
  readonly sideEffectPolicy: "inspect_projection_only";
  readonly latest: ProviderDriftLatest | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readDriftSource(value: unknown): ProviderDriftSource | null {
  return value === "fallback_selection" || value === "transport_fallback" ? value : null;
}

export function buildProviderDriftProjection(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): ProviderDriftProjection {
  const inspect = createCliInspectPort(runtime);
  const sample = inspect.context.evidenceLatest(sessionId, "provider_drift_sample");
  const payload = sample?.payload;
  const source = readDriftSource(payload?.driftSource);
  if (!payload || !source) {
    return { sideEffectPolicy: "inspect_projection_only", latest: null };
  }
  return {
    sideEffectPolicy: "inspect_projection_only",
    latest: {
      source,
      provider: readString(payload.provider),
      model: readString(payload.model),
      reason: readString(payload.reason),
      attemptedProvider: readString(payload.attemptedProvider),
      attemptedModel: readString(payload.attemptedModel),
      credentialSlot: readString(payload.credentialSlot),
      errorSummary: readString(payload.errorSummary),
      requestedTransport: readString(payload.requestedTransport),
      actualTransport: readString(payload.actualTransport),
    },
  };
}
