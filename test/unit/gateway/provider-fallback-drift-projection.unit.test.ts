import { describe, expect, test } from "bun:test";
import {
  readProviderFallbackActive,
  readProviderFallbackSelection,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/session-harness-manifest.js";

// WS3 (RFC "Drift Is Evidence, Seam-Wide"): the projection that turns raw providerFallback
// metadata into a `fallback_selection` drift sample must (a) stay closed unless a fallback
// is active with a resolved selected route, and (b) distinguish a genuine model fallback
// (carries `attempted`) from a same-model credential rotation (omits `attempted`, carried
// only by `credentialSlot`) — so the inspect view never reads a misleading "fell back to
// the same model".

describe("readProviderFallbackActive", () => {
  test("is false for non-records and inactive metadata, true only when active", () => {
    expect(readProviderFallbackActive(undefined)).toBe(false);
    expect(readProviderFallbackActive(null)).toBe(false);
    expect(readProviderFallbackActive("active")).toBe(false);
    expect(readProviderFallbackActive({ active: false })).toBe(false);
    expect(readProviderFallbackActive({ active: "true" })).toBe(false);
    expect(readProviderFallbackActive({ active: true })).toBe(true);
  });
});

describe("readProviderFallbackSelection", () => {
  test("returns undefined unless a fallback is active with a resolved selected route", () => {
    expect(readProviderFallbackSelection(undefined)).toBe(undefined);
    expect(readProviderFallbackSelection({ active: false })).toBe(undefined);
    expect(
      readProviderFallbackSelection({ active: true, selectedRoute: { provider: "openai" } }),
    ).toBe(undefined);
    expect(
      readProviderFallbackSelection({ active: true, selectedRoute: { model: "gpt-5.5" } }),
    ).toBe(undefined);
  });

  test("a genuine model fallback carries `attempted`", () => {
    const sample = readProviderFallbackSelection({
      active: true,
      reason: "primary_5xx",
      attemptedRoute: { provider: "openai", model: "gpt-5.5" },
      selectedRoute: { provider: "anthropic", model: "claude-opus-4-8" },
    });
    expect(sample).toEqual({
      source: "fallback_selection",
      provider: "anthropic",
      reason: "primary_5xx",
      attempted: { provider: "openai", model: "gpt-5.5" },
      selected: { provider: "anthropic", model: "claude-opus-4-8" },
    });
  });

  test("a same-model credential rotation omits `attempted` and keeps the credential slot", () => {
    const sample = readProviderFallbackSelection({
      active: true,
      reason: "credential_rotated",
      attemptedRoute: { provider: "openai", model: "gpt-5.5" },
      selectedRoute: { provider: "openai", model: "gpt-5.5", credentialSlot: "slot-2" },
    });
    expect(sample).toEqual({
      source: "fallback_selection",
      provider: "openai",
      reason: "credential_rotated",
      selected: { provider: "openai", model: "gpt-5.5", credentialSlot: "slot-2" },
    });
    expect(sample?.attempted).toBe(undefined);
  });

  test("a missing reason projects to an explicit null, never a dropped field", () => {
    const sample = readProviderFallbackSelection({
      active: true,
      selectedRoute: { provider: "anthropic", model: "claude-opus-4-8" },
    });
    expect(sample?.reason).toBe(null);
  });
});
