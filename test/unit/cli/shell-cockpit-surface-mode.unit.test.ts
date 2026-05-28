import { describe, expect, test } from "bun:test";
import { resolveCockpitSurfaceMode } from "../../../packages/brewva-cli/runtime/shell/cockpit/surface.js";

describe("cockpit surface mode", () => {
  test("uses full, narrow, and mini modes from viewport dimensions", () => {
    expect(resolveCockpitSurfaceMode({ width: 120, height: 36 })).toBe("full");
    expect(resolveCockpitSurfaceMode({ width: 78, height: 28 })).toBe("narrow");
    expect(resolveCockpitSurfaceMode({ width: 120, height: 17 })).toBe("mini");
    expect(resolveCockpitSurfaceMode({ width: 58, height: 40 })).toBe("mini");
  });
});
