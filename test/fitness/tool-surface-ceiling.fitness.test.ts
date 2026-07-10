import { describe, expect, test } from "bun:test";
import {
  BASE_BREWVA_TOOL_NAMES,
  CONTROL_PLANE_BREWVA_TOOL_NAMES,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
  SKILL_BREWVA_TOOL_NAMES,
} from "@brewva/brewva-tools/registry";

// Surface ceiling (tool-surface subtraction RFC, Option A): the model-facing
// default surface is a BUDGET, not an open set. Across n=12 real sessions the
// model exercised 4-12 distinct tools while ~94 shipped every turn, so growth
// here is presumed cost until measured demand says otherwise (axiom 15: public
// width should compress toward authority width). These ceilings are pinned at
// the audited counts as an anti-growth ratchet — raising one requires the same
// evidence bar the RFC sets for additions (a real corpus showing invocation),
// while lowering it with a demotion just tightens the pin.
const BASE_SURFACE_CEILING = 23;
const SKILL_SURFACE_CEILING = 59;
// Post-demotion reality (the Step-4 gate): only base ships in the default
// per-turn payload; skill tools surface for one turn on an explicit $name
// request or a selected capability. The default-surfaced managed ceiling is
// therefore the base ceiling itself.
const DEFAULT_SURFACED_MANAGED_CEILING = BASE_SURFACE_CEILING;

describe("model-facing tool surface ceiling", () => {
  test("base (always-on) surface stays within its audited budget", () => {
    expect(BASE_BREWVA_TOOL_NAMES.length).toBeLessThanOrEqual(BASE_SURFACE_CEILING);
  });

  test("skill surface stays within its audited budget", () => {
    expect(SKILL_BREWVA_TOOL_NAMES.length).toBeLessThanOrEqual(SKILL_SURFACE_CEILING);
  });

  test("the default-surfaced managed set (base only, post-gate) stays within the audited ceiling", () => {
    expect(BASE_BREWVA_TOOL_NAMES.length).toBeLessThanOrEqual(DEFAULT_SURFACED_MANAGED_CEILING);
  });

  test("every managed tool is accounted to exactly one surface bucket", () => {
    const bucketed =
      BASE_BREWVA_TOOL_NAMES.length +
      SKILL_BREWVA_TOOL_NAMES.length +
      CONTROL_PLANE_BREWVA_TOOL_NAMES.length +
      OPERATOR_BREWVA_TOOL_NAMES.length;
    expect(bucketed).toBe(MANAGED_BREWVA_TOOL_NAMES.length);
  });
});
