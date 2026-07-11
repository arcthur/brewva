import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveScheduleApprovalMode } from "../../../packages/brewva-gateway/src/daemon/schedule-runner.js";
import { DEFAULT_BREWVA_CONFIG } from "../../../packages/brewva-runtime/src/config/defaults.js";
import { normalizeExplicitBrewvaConfig } from "../../../packages/brewva-runtime/src/config/loader.js";
import { normalizeBrewvaConfig } from "../../../packages/brewva-runtime/src/config/normalize.js";

// The schedule approval envelope is derived from CONFIG IDENTITY, never from
// intent records (auto-research assembly, step 1). A model can mint schedule
// intents through `schedule_intent` / `follow_up`, so if the envelope keyed off
// the record, a model could schedule itself a future auto-approved session —
// the exact authority escalation the permission layer must sit outside of.
describe("schedule approval envelope resolution", () => {
  const policy = {
    enabled: true,
    approvalMode: "auto_within_envelope" as const,
    intentId: "intent_self_improve",
    parentSessionId: "session_self_improve_parent",
  };

  // The daemon-stamped config intent: matching identity AND the unforgeable
  // provenance stamp.
  const configIntent = {
    intentId: "intent_self_improve",
    parentSessionId: "session_self_improve_parent",
    origin: "config_policy" as const,
  };

  test("the config-authored self-improve intent gets the envelope", () => {
    expect(resolveScheduleApprovalMode({ intent: configIntent, selfImprovePolicy: policy })).toBe(
      "auto_within_envelope",
    );
  });

  test("a matching identity WITHOUT the origin stamp resolves to suspend", () => {
    // This is the collision case: a model mints an intent whose intentId and
    // (somehow) parentSessionId match, but it can never carry the daemon-only
    // origin stamp, so provenance denies the envelope.
    expect(
      resolveScheduleApprovalMode({
        intent: {
          intentId: "intent_self_improve",
          parentSessionId: "session_self_improve_parent",
        },
        selfImprovePolicy: policy,
      }),
    ).toBe("suspend");
  });

  test("a model-minted intent never gets the envelope, whatever its record carries", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: {
          intentId: "intent_model_minted",
          parentSessionId: "session_self_improve_parent",
          // Smuggled fields on the record must be ignored: authorization comes
          // from the daemon-only origin stamp plus config identity, never from
          // intent payloads. Even a forged origin here fails because the
          // intentId does not match the config policy.
          approvalMode: "auto_within_envelope",
          origin: "config_policy",
        } as unknown as Parameters<typeof resolveScheduleApprovalMode>[0]["intent"],
        selfImprovePolicy: policy,
      }),
    ).toBe("suspend");
  });

  test("a parent-session mismatch resolves to suspend", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: { ...configIntent, parentSessionId: "session_other" },
        selfImprovePolicy: policy,
      }),
    ).toBe("suspend");
  });

  test("config approvalMode suspend keeps even the config intent suspended", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: configIntent,
        selfImprovePolicy: { ...policy, approvalMode: "suspend" },
      }),
    ).toBe("suspend");
  });

  test("a disabled self-improve schedule resolves to suspend", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: configIntent,
        selfImprovePolicy: { ...policy, enabled: false },
      }),
    ).toBe("suspend");
  });
});

describe("schedule.selfImprove.approvalMode config contract", () => {
  test("the default lane is ON with the envelope (calibration-report pass)", () => {
    const config = normalizeBrewvaConfig({}, DEFAULT_BREWVA_CONFIG);
    expect(config.schedule.enabled).toBe(true);
    expect(config.schedule.selfImprove.enabled).toBe(true);
    expect(config.schedule.selfImprove.approvalMode).toBe("auto_within_envelope");
    expect(config.schedule.selfImprove.taskSpec.goal).toContain("calibration-report");
  });

  test("explicit suspend is honored; an unrecognized value fails CLOSED to suspend", () => {
    const suspended = normalizeBrewvaConfig(
      { schedule: { selfImprove: { approvalMode: "suspend" } } },
      DEFAULT_BREWVA_CONFIG,
    );
    expect(suspended.schedule.selfImprove.approvalMode).toBe("suspend");

    // Defense-in-depth for any path that bypasses schema validation: normalize
    // coerces an unknown mode to "suspend". The PRIMARY gate is AJV (below).
    const bogus = normalizeBrewvaConfig(
      { schedule: { selfImprove: { approvalMode: "yes_please" } } },
      DEFAULT_BREWVA_CONFIG,
    );
    expect(bogus.schedule.selfImprove.approvalMode).toBe("suspend");
  });

  // The generated schema's public description must not misstate the shipped
  // default. This ties the prose to DEFAULT_BREWVA_CONFIG so the contract text
  // cannot drift from the actual value again (the bug this test guards).
  test("the schema description names the actual shipped default", () => {
    const schemaPath = resolve(
      import.meta.dir,
      "../../../packages/brewva-runtime/schema/brewva.schema.json",
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
    const description = findApprovalModeDescription(schema);
    expect(description).toBeTypeOf("string");
    const claimedDefault = description?.match(/"([a-z_]+)"\s*\(the shipped default/)?.[1];
    expect(claimedDefault).toBe(DEFAULT_BREWVA_CONFIG.schedule.selfImprove.approvalMode);
    // The old, wrong claim must be gone.
    expect(description).not.toContain('"suspend" (default');
  });

  // The real loader rejects an unrecognized approvalMode at load via the AJV
  // enum — it does NOT silently normalize it. This closes the blind spot where
  // the unit test above exercises the normalizer directly, past the loader gate.
  test("the config loader rejects an unrecognized approvalMode via schema enum", () => {
    let thrown: unknown;
    try {
      normalizeExplicitBrewvaConfig({
        schedule: { selfImprove: { approvalMode: "yes_please" } },
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string })?.code).toBe("config_schema_invalid");
  });
});

// Deep-find the selfImprove approvalMode node's description. The schema root uses
// `$ref` + `definitions`, so walk generically rather than pinning a fixed path.
function findApprovalModeDescription(schema: unknown): string | undefined {
  let found: string | undefined;
  const visit = (node: unknown): void => {
    if (found !== undefined || node === null || typeof node !== "object") {
      return;
    }
    const record = node as Record<string, unknown>;
    const approvalMode = record.approvalMode as { description?: unknown } | undefined;
    if (
      approvalMode &&
      typeof approvalMode.description === "string" &&
      approvalMode.description.includes("self-improve schedule")
    ) {
      found = approvalMode.description;
      return;
    }
    for (const value of Object.values(record)) {
      visit(value);
    }
  };
  visit(schema);
  return found;
}
