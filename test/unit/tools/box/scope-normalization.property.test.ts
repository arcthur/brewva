import { describe, expect } from "bun:test";
import fc from "fast-check";
import type {
  BoxCapabilitySet,
  BoxScope,
} from "../../../../packages/brewva-tools/src/internal/box/contract.js";
import {
  fingerprintBoxScope,
  normalizeBoxCapabilitySet,
  normalizeBoxScope,
} from "../../../../packages/brewva-tools/src/internal/box/scope.js";
import { propertyTest } from "../../../helpers/property.js";

const networkCapabilityArbitrary: fc.Arbitrary<BoxCapabilitySet["network"]> = fc.oneof(
  fc.constant({ mode: "off" } as const),
  fc.record({
    mode: fc.constant("allowlist" as const),
    allow: fc.array(
      fc
        .string({ maxLength: 24 })
        .map((value) => (value.trim() ? ` ${value.toUpperCase()} ` : value)),
      { maxLength: 8 },
    ),
  }),
);

const volumeArbitrary: fc.Arbitrary<BoxCapabilitySet["extraVolumes"][number]> = fc.record({
  hostPath: fc.string({ minLength: 1, maxLength: 24 }),
  guestPath: fc.string({ minLength: 1, maxLength: 24 }).map((value) => `/workspace/${value}`),
  readonly: fc.boolean(),
});

const portArbitrary: fc.Arbitrary<BoxCapabilitySet["ports"][number]> = fc.record({
  guest: fc.integer({ min: 0, max: 65_535 }),
  host: fc.option(fc.integer({ min: 0, max: 65_535 }), { nil: undefined }),
  protocol: fc.option(fc.constantFrom("tcp" as const, "udp" as const), { nil: undefined }),
});

const capabilitySetArbitrary: fc.Arbitrary<BoxCapabilitySet> = fc.record({
  network: networkCapabilityArbitrary,
  gpu: fc.boolean(),
  extraVolumes: fc.array(volumeArbitrary, { maxLength: 6 }),
  secrets: fc.array(fc.string({ maxLength: 24 }), { maxLength: 8 }),
  ports: fc.array(portArbitrary, { maxLength: 8 }),
});

function reverseCapabilityOrder(input: BoxCapabilitySet): BoxCapabilitySet {
  return {
    ...input,
    network:
      input.network.mode === "allowlist"
        ? { mode: "allowlist", allow: input.network.allow.toReversed() }
        : input.network,
    extraVolumes: input.extraVolumes.toReversed(),
    secrets: input.secrets.toReversed(),
    ports: input.ports.toReversed(),
  };
}

describe("box scope normalization properties", () => {
  propertyTest("box capability normalization is idempotent and order-insensitive", {
    propertyId: "box.scope.capability-normalization",
    layer: "unit",
    arbitraries: [capabilitySetArbitrary],
    predicate: (capabilities) => {
      const normalized = normalizeBoxCapabilitySet(capabilities);

      expect(normalizeBoxCapabilitySet(normalized)).toEqual(normalized);
      expect(normalizeBoxCapabilitySet(reverseCapabilityOrder(capabilities))).toEqual(normalized);
    },
  });

  propertyTest("box scope fingerprint is stable after normalization", {
    propertyId: "box.scope.fingerprint-normalization",
    layer: "unit",
    arbitraries: [
      fc.record({
        kind: fc.constantFrom("session" as const, "task" as const, "ephemeral" as const),
        id: fc.string({ minLength: 1, maxLength: 16 }),
        image: fc.string({ minLength: 1, maxLength: 24 }),
        workspaceRoot: fc.string({ minLength: 1, maxLength: 24 }),
        capabilities: capabilitySetArbitrary,
      }),
    ],
    predicate: (scope: BoxScope) => {
      const normalized = normalizeBoxScope(scope);

      expect(normalizeBoxScope(normalized)).toEqual(normalized);
      expect(fingerprintBoxScope(normalized)).toBe(fingerprintBoxScope(scope));
    },
  });
});
