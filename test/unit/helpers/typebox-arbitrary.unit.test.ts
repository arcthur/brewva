import { expect, test } from "bun:test";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import fc, { type Arbitrary } from "fast-check";
import { arbitraryFromTypeBox } from "../../helpers/typebox-arbitrary.js";

function sampleValues<T>(arbitrary: Arbitrary<T>, numRuns = 40): T[] {
  return fc.sample(arbitrary, { seed: 0x5eed2026, numRuns });
}

function expectAllValid<T extends TSchema>(schema: T, values: Static<T>[]): void {
  for (const value of values) {
    expect(Value.Check(schema, value)).toBe(true);
  }
}

test("typebox arbitrary respects string and integer constraints", () => {
  const schema = Type.Object({
    name: Type.String({ minLength: 2, maxLength: 6 }),
    count: Type.Integer({ minimum: 3, maximum: 9 }),
  });

  const values = sampleValues(arbitraryFromTypeBox(schema));

  expectAllValid(schema, values);
  expect(values.every((value) => value.name.length >= 2 && value.name.length <= 6)).toBe(true);
  expect(values.every((value) => value.count >= 3 && value.count <= 9)).toBe(true);
});

test("typebox arbitrary emits finite numbers, booleans, nulls, literals, and unions", () => {
  const schema = Type.Object({
    score: Type.Number({ minimum: -2.5, maximum: 2.5 }),
    enabled: Type.Boolean(),
    cleared: Type.Null(),
    tag: Type.Literal("stable"),
    mode: Type.Union([Type.Literal("read"), Type.Literal("write")]),
  });

  const values = sampleValues(arbitraryFromTypeBox(schema));

  expectAllValid(schema, values);
  expect(values.every((value) => Number.isFinite(value.score))).toBe(true);
  expect(new Set(values.map((value) => value.mode)).size).toBeGreaterThan(1);
});

test("typebox arbitrary handles arrays and optional object properties", () => {
  const schema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 4 }),
    labels: Type.Array(Type.String({ minLength: 1, maxLength: 3 }), { minItems: 1, maxItems: 4 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  });

  const values = sampleValues(arbitraryFromTypeBox(schema), 80);

  expectAllValid(schema, values);
  expect(values.some((value) => "limit" in value)).toBe(true);
  expect(values.some((value) => !("limit" in value))).toBe(true);
  expect(values.every((value) => value.labels.length >= 1 && value.labels.length <= 4)).toBe(true);
});

test("typebox arbitrary honors explicit schema maxima over helper defaults", () => {
  const schema = Type.Object({
    name: Type.String({ minLength: 40, maxLength: 48 }),
    values: Type.Array(Type.Integer({ minimum: 0, maximum: 5 }), {
      minItems: 8,
      maxItems: 10,
    }),
  });

  const values = sampleValues(
    arbitraryFromTypeBox(schema, {
      defaultStringMaxLength: 8,
      defaultArrayMaxLength: 2,
    }),
  );

  expectAllValid(schema, values);
  expect(values.every((value) => value.name.length >= 40 && value.name.length <= 48)).toBe(true);
  expect(values.every((value) => value.values.length >= 8 && value.values.length <= 10)).toBe(true);
});

test("typebox arbitrary distinguishes nullable unions from optional properties", () => {
  const schema = Type.Object({
    nullableName: Type.Union([Type.String({ minLength: 1, maxLength: 4 }), Type.Null()]),
    optionalName: Type.Optional(Type.String({ minLength: 1, maxLength: 4 })),
  });

  const values = sampleValues(arbitraryFromTypeBox(schema), 120);

  expectAllValid(schema, values);
  expect(values.every((value) => "nullableName" in value)).toBe(true);
  expect(values.some((value) => value.nullableName === null)).toBe(true);
  expect(values.some((value) => typeof value.nullableName === "string")).toBe(true);
  expect(values.some((value) => "optionalName" in value)).toBe(true);
  expect(values.some((value) => !("optionalName" in value))).toBe(true);
});

test("typebox arbitrary fails fast for unsupported schema features", () => {
  expect(() => arbitraryFromTypeBox(Type.String({ pattern: "^[a-z]+$" }))).toThrow(
    /Unsupported TypeBox schema feature: pattern/,
  );

  expect(() => arbitraryFromTypeBox(Type.Tuple([Type.String(), Type.Number()]))).toThrow(
    /Unsupported TypeBox schema feature: tuple array/,
  );
});
