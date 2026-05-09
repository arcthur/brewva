import { describe, expect, test } from "bun:test";
import { BrewvaConfigLoadError } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG } from "../../../packages/brewva-runtime/src/config/defaults.js";
import {
  forensicallyValidateLoadedBrewvaConfigObject,
  validateLoadedBrewvaConfigObject,
} from "../../../packages/brewva-runtime/src/config/object-validation.js";

describe("config object validation boundary", () => {
  test("loaded config validation strips runtime-ignored meta fields", () => {
    const validated = validateLoadedBrewvaConfigObject(
      {
        $schema: "./brewva.schema.json",
        skills: {
          routing: {
            scopes: ["domain"],
          },
        },
      },
      "<test-config>",
    );

    expect(validated.$schema).toBeUndefined();
    expect(validated.skills).toEqual({
      routing: {
        scopes: ["domain"],
      },
    });
  });

  test("loaded config validation rejects active-config field policy violations with semantic errors", () => {
    expect(() =>
      validateLoadedBrewvaConfigObject(
        {
          skills: {
            selector: {
              mode: "llm_auto",
            },
          },
        },
        "<test-config>",
      ),
    ).toThrow(BrewvaConfigLoadError);

    expect(() =>
      validateLoadedBrewvaConfigObject(
        {
          skills: {
            selector: {
              mode: "llm_auto",
            },
          },
        },
        "<test-config>",
      ),
    ).toThrow(/skills\.selector has been removed/);
  });

  test("loaded config validation rejects schema drift separately from field policy", () => {
    expect(() =>
      validateLoadedBrewvaConfigObject(
        {
          unexpectedTopLevelField: true,
        },
        "<test-config>",
      ),
    ).toThrow(/Config does not match schema/);
  });

  test("forensic validation strips policy and unknown fields into warnings", () => {
    const forensic = forensicallyValidateLoadedBrewvaConfigObject(
      {
        $schema: "./brewva.schema.json",
        skills: {
          selector: {
            mode: "llm_auto",
          },
        },
        security: {
          execution: {
            commandDenyList: ["node"],
          },
        },
        unexpectedTopLevelField: true,
      },
      "<test-config>",
    );

    expect(forensic.parsed).toEqual({
      skills: {},
      security: {
        execution: {},
      },
    });
    expect(forensic.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
      "config_unknown_fields_stripped",
    ]);
    expect(forensic.warnings[0]?.fields).toEqual(
      expect.arrayContaining(["/skills/selector", "/security/execution/commandDenyList"]),
    );
    expect(forensic.warnings[1]?.fields).toEqual(
      expect.arrayContaining(["/unexpectedTopLevelField"]),
    );
  });

  test("forensic validation skips non-object values with a typed warning", () => {
    const forensic = forensicallyValidateLoadedBrewvaConfigObject("not-an-object", "<test-config>");

    expect(forensic.parsed).toBeUndefined();
    expect(forensic.warnings).toEqual([
      {
        code: "config_not_object_skipped",
        configPath: "<test-config>",
        message: "Skipped inspect config because the top-level value is not an object.",
      },
    ]);
  });
});

describe("default config protectedTools alignment with real tool registry", () => {
  const REAL_TOOL_NAMES = new Set<string>([
    "workbench_note",
    "workbench_evict",
    "workbench_undo_evict",
    "workbench_compact",
    "recall_search",
    "recall_curate",
    "tape_handoff",
    "tape_info",
    "tape_search",
  ]);

  test("each default protectedTools entry resolves to a real tool name", () => {
    const protectedTools = DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget.compaction
      .protectedTools as readonly string[];
    for (const name of protectedTools) {
      expect(REAL_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test("default protectedTools no longer references the historical recall_query typo", () => {
    const protectedTools = DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget.compaction
      .protectedTools as readonly string[];
    expect(protectedTools).not.toContain("recall_query");
  });

  test("default protectedTools covers model-authored workbench mutation receipts", () => {
    const protectedTools = new Set(
      DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget.compaction
        .protectedTools as readonly string[],
    );
    expect(protectedTools.has("workbench_note")).toBe(true);
    expect(protectedTools.has("workbench_evict")).toBe(true);
    expect(protectedTools.has("workbench_undo_evict")).toBe(true);
    expect(protectedTools.has("workbench_compact")).toBe(true);
  });
});
