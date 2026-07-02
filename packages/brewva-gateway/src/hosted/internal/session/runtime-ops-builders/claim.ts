import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import { CLAIM_UPSERTED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import type { ClaimState } from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildClaimRuntimeOps(ctx: HostedRuntimeOpsContext): HostedRuntimeOpsPort["claim"] {
  return {
    facts: {
      resolve: () => ({ ok: true }),
      upsert(sessionId, claim) {
        ctx.emit(
          sessionId,
          CLAIM_UPSERTED_EVENT_TYPE,
          typeof claim === "object" && claim ? claim : {},
        );
        return { ok: true };
      },
    },
    state: {
      get: (sessionId) => claimStateFor(ctx, sessionId),
    },
  };
}

function claimStateFor(ctx: HostedRuntimeOpsContext, sessionId: string): ClaimState {
  const events = ctx.listEvents(sessionId, { type: CLAIM_UPSERTED_EVENT_TYPE });
  const claimsById = new Map<string, ProtocolRecord>();
  let updatedAt: number | null = null;
  for (const event of events) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const claim: ProtocolRecord = { status: "active", ...payload };
    const id =
      typeof claim.id === "string" && claim.id.trim().length > 0 ? claim.id : `claim:${event.id}`;
    claimsById.set(id, claim);
    updatedAt = typeof event.timestamp === "number" ? event.timestamp : updatedAt;
  }
  return {
    claims: [...claimsById.values()],
    updatedAt,
  };
}
