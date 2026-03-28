import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  attachStringEnumContractPaths,
  buildStringEnumSchema,
  collectStringEnumContractMismatches,
  collectStringEnumContracts,
  lowerStringEnumContractParameters,
} from "../../../packages/brewva-tools/src/utils/input-alias.js";

const requireFromBrewvaTools = createRequire(
  new URL("../../../packages/brewva-tools/package.json", import.meta.url),
);

type SchemaLike = ReturnType<typeof buildStringEnumSchema>;
type TypeBoxFactory = {
  Object: (properties: Record<string, SchemaLike>) => SchemaLike;
  Array: (schema: SchemaLike) => SchemaLike;
  Optional: (schema: SchemaLike) => SchemaLike;
  String: (...args: unknown[]) => SchemaLike;
  Number: (...args: unknown[]) => SchemaLike;
};

const { Type } = requireFromBrewvaTools("@sinclair/typebox") as {
  Type: TypeBoxFactory;
};

describe("string enum contract helpers", () => {
  test("retains string enum contract metadata across Type.Optional wrappers", () => {
    const statusSchema = buildStringEnumSchema(["pending", "in_progress"] as const, {
      recommendedValue: "pending",
      guidance: "Use pending for not-started work.",
      runtimeValueMap: {
        pending: "todo",
        in_progress: "doing",
      },
    });
    const schema = Type.Object({
      status: Type.Optional(statusSchema),
    });

    const contracts = collectStringEnumContracts(schema);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.pathText).toBe("status");
    expect(contracts[0]?.contract.canonicalValues).toEqual(["pending", "in_progress"]);
    expect(contracts[0]?.contract.recommendedValue).toBe("pending");
    expect(contracts[0]?.contract.runtimeValueMap).toEqual({
      pending: "todo",
      in_progress: "doing",
    });
  });

  test("collects and validates nested path contract metadata on composite schemas", () => {
    const predicateSchema = attachStringEnumContractPaths(
      Type.Object({
        filter: Type.Object({
          value: Type.String(),
        }),
      }),
      [
        {
          path: ["filter", "mode"],
          contract: {
            canonicalValues: ["and", "or"] as const,
            guidance: "Use and or or when composing filters.",
          },
        },
      ],
    );

    const schema = Type.Object({
      predicate: predicateSchema,
    });

    const contracts = collectStringEnumContracts(schema);
    expect(contracts).toEqual([
      expect.objectContaining({
        pathText: "predicate.filter.mode",
        contract: expect.objectContaining({
          canonicalValues: ["and", "or"],
        }),
      }),
    ]);

    const mismatches = collectStringEnumContractMismatches(schema, {
      predicate: {
        filter: {
          mode: "xor",
        },
      },
    });
    expect(mismatches).toEqual([
      expect.objectContaining({
        pathText: "predicate.filter.mode",
        received: "xor",
      }),
    ]);
  });

  test("lowers agent-facing enum values into runtime canonical values", () => {
    const schema = Type.Object({
      verification: Type.Object({
        level: buildStringEnumSchema(["smoke", "targeted", "full", "none"] as const, {
          runtimeValueMap: {
            smoke: "quick",
            targeted: "standard",
            full: "strict",
            none: "none",
          },
        }),
      }),
      items: Type.Array(
        Type.Object({
          status: buildStringEnumSchema(["pending", "in_progress", "done", "blocked"] as const, {
            runtimeValueMap: {
              pending: "todo",
              in_progress: "doing",
              done: "done",
              blocked: "blocked",
            },
          }),
        }),
      ),
    });

    const lowered = lowerStringEnumContractParameters(schema, {
      verification: {
        level: "targeted",
      },
      items: [{ status: "pending" }, { status: "in_progress" }],
    });

    expect(lowered).toEqual({
      verification: {
        level: "standard",
      },
      items: [{ status: "todo" }, { status: "doing" }],
    });
  });
});
