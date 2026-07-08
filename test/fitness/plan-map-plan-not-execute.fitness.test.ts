import { describe, expect, test } from "bun:test";
import {
  MANAGED_BREWVA_TOOL_METADATA_BY_NAME,
  type ManagedBrewvaToolMetadataRegistryEntry,
} from "../../packages/brewva-tools/src/registry/managed-metadata.js";

// RFC: durable-cross-session-planning-map — the plan-not-execute invariant
// (axiom 18 "descriptive metadata derives views, never authority" + axiom 19
// "a documented invariant that nothing checks is a promise").
//
// The map is a PLANNING artifact: creating a map, opening / claiming / resolving /
// closing a ticket records a decision receipt, never a world effect. The RFC names
// this a shipped fitness artifact; determinism and claim exclusion have theirs in
// the vocabulary unit suite, and this file is the third.
//
// The guard pins the invariant at the managed-metadata registry — the single source
// the tools' capability scoping derives from, and (via the managed-tool contract
// test that asserts `metadata.actionClass === TOOL_ACTION_POLICY_BY_NAME[name]`) the
// same action class the kernel admission policy enforces. So an edit that arms a
// plan tool with an effectful action class or an effect capability trips here,
// instead of silently letting the map execute.

// The two non-world-effect action classes the map uses: an observe read
// (`get_plan_map`) and a control-plane state mutation (the sidecar receipt writers).
// Neither reaches exec, the filesystem patch surface, the network, credentials, the
// scheduler, or delegation.
const PLANNING_ONLY_ACTION_CLASSES: ReadonlySet<string> = new Set([
  "runtime_observe",
  "control_state_mutation",
]);

const PLAN_MAP_CAPABILITY_PREFIX = "capabilities.planMap.";

// The reviewed plan-map tool surface (Phase 1 + Phase 2: claim, rescope, fog). Kept
// explicit so a new plan tool must be added here deliberately; the first test also
// proves this list is exactly the set of planMap-capability tools, so one cannot slip
// in unlisted.
const EXPECTED_PLAN_MAP_TOOLS = [
  "claim_plan_ticket",
  "close_plan_ticket",
  "create_plan_map",
  "get_plan_map",
  "graduate_fog",
  "open_plan_ticket",
  "record_fog",
  "rescope_plan_ticket",
  "resolve_plan_ticket",
  "unclaim_plan_ticket",
];

function requiredCapabilitiesOf(meta: ManagedBrewvaToolMetadataRegistryEntry): readonly string[] {
  return meta.requiredCapabilities ?? [];
}

const planMapTools = Object.entries(MANAGED_BREWVA_TOOL_METADATA_BY_NAME).filter(([, meta]) =>
  requiredCapabilitiesOf(meta).some((cap) => cap.startsWith(PLAN_MAP_CAPABILITY_PREFIX)),
);

describe("plan-map is a planning artifact, never an execution surface (RFC axiom 18/19)", () => {
  test("the planMap-capability tools are exactly the reviewed plan-map surface", () => {
    expect(planMapTools.map(([name]) => name).toSorted()).toEqual(EXPECTED_PLAN_MAP_TOOLS);
  });

  test("every plan-map tool is planning-only — no world-effect action class", () => {
    const offenders = planMapTools
      .filter(([, meta]) => !PLANNING_ONLY_ACTION_CLASSES.has(meta.actionClass))
      .map(([name, meta]) => `${name}:${meta.actionClass}`);
    expect(offenders).toEqual([]);
  });

  test("every plan-map tool requires only planMap capabilities — no effect capability", () => {
    const offenders = planMapTools.flatMap(([name, meta]) =>
      requiredCapabilitiesOf(meta)
        .filter((cap) => !cap.startsWith(PLAN_MAP_CAPABILITY_PREFIX))
        .map((cap) => `${name}:${cap}`),
    );
    expect(offenders).toEqual([]);
  });
});
