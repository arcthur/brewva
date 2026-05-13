import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { ToolBoxPolicy } from "@brewva/brewva-runtime/governance";
import { applyToolBoxPolicy } from "../../../packages/brewva-tools/src/families/execution/exec/policy.js";
import type { BoxConfig } from "../../../packages/brewva-tools/src/families/execution/exec/shared.js";

function defaultBoxConfig(): BoxConfig {
  return structuredClone(DEFAULT_BREWVA_CONFIG.security.execution.box);
}

describe("exec box policy", () => {
  test("maps tool network allowlists onto the BoxLite-backed box config", () => {
    const policy: ToolBoxPolicy = {
      kind: "box_required",
      scopeKind: "task",
      networkAllowlist: [" API.OpenAI.com ", "", "registry.npmjs.org"],
    };

    expect(applyToolBoxPolicy(defaultBoxConfig(), policy)).toMatchObject({
      scopeDefault: "task",
      network: {
        mode: "allowlist",
        allow: ["api.openai.com", "registry.npmjs.org"],
      },
    });
  });
});
