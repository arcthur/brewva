import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  BREWVA_CANONICAL_PARAMETER_KEYS,
  applyTopLevelCaseAliases,
  attachCanonicalParameterKeys,
} from "../../../packages/brewva-tools/src/utils/input-alias.js";

const requireFromBrewvaTools = createRequire(
  new URL("../../../packages/brewva-tools/package.json", import.meta.url),
);

type SchemaLike = Parameters<typeof attachCanonicalParameterKeys>[0];
type TypeBoxFactory = {
  Object: (...args: unknown[]) => SchemaLike;
  String: (...args: unknown[]) => SchemaLike;
  Number: (...args: unknown[]) => SchemaLike;
};

const { Type } = requireFromBrewvaTools("@sinclair/typebox") as {
  Type: TypeBoxFactory;
};

describe("tool input alias helpers", () => {
  test("preserves explicit canonical parameter metadata for schemas with manual aliases", () => {
    const schema = attachCanonicalParameterKeys(
      Type.Object({
        sessionId: Type.String(),
        session_id: Type.String(),
        timeout: Type.Number(),
        timeout_ms: Type.Number(),
      }),
      ["sessionId", "timeout"],
    );

    const aliased = applyTopLevelCaseAliases(schema).schema as Record<string, unknown>;
    expect(aliased[BREWVA_CANONICAL_PARAMETER_KEYS]).toEqual(["sessionId", "timeout"]);
  });

  test("rejects schemas whose required alias expansion would exceed the safety limit", () => {
    const schema = Type.Object({
      firstField: Type.String(),
      secondField: Type.String(),
      thirdField: Type.String(),
      fourthField: Type.String(),
      fifthField: Type.String(),
      sixthField: Type.String(),
    });

    expect(() => applyTopLevelCaseAliases(schema)).toThrow(
      "top-level alias expansion exceeds supported limit",
    );
  });
});
