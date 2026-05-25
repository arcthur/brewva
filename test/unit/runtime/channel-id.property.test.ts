import { describe, expect } from "bun:test";
import { normalizeChannelId } from "@brewva/brewva-vocabulary/wire";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";

describe("channel id properties", () => {
  propertyTest("channel id normalization is idempotent", {
    propertyId: "runtime.channel-id.idempotent",
    layer: "unit",
    arbitraries: [fc.string()],
    predicate: (raw) => {
      const normalized = normalizeChannelId(raw);

      expect(normalizeChannelId(normalized)).toBe(normalized);
      expect(normalized).toBe(normalized.trim());
      expect(normalized).toBe(normalized.toLowerCase());
    },
  });
});
