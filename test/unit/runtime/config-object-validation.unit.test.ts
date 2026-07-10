import { describe, expect, test } from "bun:test";
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
          roots: ["./skills"],
        },
      },
      "<test-config>",
    );

    expect(validated.value.$schema).toBe(undefined);
    expect(validated.value.skills).toEqual({
      roots: ["./skills"],
    });
    expect(validated.warnings).toEqual([]);
  });

  test("removed-field policy violations strip with a warning instead of failing the load", () => {
    const input = {
      skills: {
        selector: {
          mode: "llm_auto",
        },
      },
    };
    const validated = validateLoadedBrewvaConfigObject(input, "<test-config>");

    // Old semantics stay disabled: the removed field is gone from the value.
    expect(validated.value.skills).toEqual({});
    expect(validated.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(validated.warnings[0]?.message).toMatch(/skills\.selector has been removed/);
    expect(validated.warnings[0]?.fields).toEqual(["/skills/selector"]);
    // Stripping operates on a clone: the caller's own object is untouched.
    expect(input.skills.selector.mode).toBe("llm_auto");
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

    expect(forensic.parsed).toBe(undefined);
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
