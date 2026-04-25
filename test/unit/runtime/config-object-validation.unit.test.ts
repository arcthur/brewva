import { describe, expect, test } from "bun:test";
import { BrewvaConfigLoadError } from "@brewva/brewva-runtime";
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
