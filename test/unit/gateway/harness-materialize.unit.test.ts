import { describe, expect, test } from "bun:test";
import {
  buildHarnessManifest,
  type BuildHarnessManifestInput,
} from "@brewva/brewva-vocabulary/harness";
import { buildHarnessCandidatePatch } from "../../../packages/brewva-gateway/src/harness/internal/candidate-patch.js";
import { resolveHarnessCandidatePatchMaterialization } from "../../../packages/brewva-gateway/src/harness/internal/materialize.js";

function manifest(overrides: Partial<BuildHarnessManifestInput> = {}) {
  return buildHarnessManifest({
    sessionId: "source-session",
    turn: 3,
    attempt: 1,
    runtime: {
      configHash: "runtime_config:base",
      runtimeIdentityHash: "runtime_identity:base",
    },
    prompt: { systemPromptHash: "prompt:base" },
    tools: { activeToolNames: ["read", "exec"], toolSchemaSnapshotHash: "tools:base" },
    provider: { provider: "faux", api: "faux-api", model: "faux-model" },
    refs: { sourceEventIds: ["event-1"] },
    ...overrides,
  });
}

function patchFor(base: ReturnType<typeof manifest>, candidate: ReturnType<typeof manifest>) {
  return buildHarnessCandidatePatch({ base, candidate }).delta;
}

describe("harness candidate materialization", () => {
  test("a model delta materializes as a hosted-session override", () => {
    const base = manifest();
    const candidate = manifest({
      provider: { provider: "faux", api: "faux-api", model: "candidate-model" },
    });

    const resolution = resolveHarnessCandidatePatchMaterialization(patchFor(base, candidate));

    if (!resolution.ok) {
      throw new Error(`expected materialization, got ${JSON.stringify(resolution)}`);
    }
    expect(resolution.overrides).toEqual({ model: "candidate-model" });
    expect(resolution.materializedFields).toEqual(["provider.model"]);
  });

  test("the patch strips derived and provenance deltas, leaving an empty no-op", () => {
    const base = manifest();
    const candidate = manifest({
      sessionId: "other-session",
      turn: 9,
      runtime: {
        configHash: "runtime_config:candidate",
        runtimeIdentityHash: "runtime_identity:candidate",
      },
      prompt: { systemPromptHash: "prompt:candidate" },
      refs: { sourceEventIds: ["event-2"] },
    });

    // Only derived/provenance fields changed, so the editable delta is empty:
    // there is no derived-field "exemption" bookkeeping — the patch never
    // carries them, and materialization is a clean no-op.
    const delta = patchFor(base, candidate);
    expect(delta).toEqual([]);

    const resolution = resolveHarnessCandidatePatchMaterialization(delta);
    if (!resolution.ok) {
      throw new Error(`expected materialization, got ${JSON.stringify(resolution)}`);
    }
    expect(resolution.overrides).toEqual({});
    expect(resolution.materializedFields).toEqual([]);
  });

  test("value fields without an execution seam refuse with the field named", () => {
    const base = manifest();
    const candidate = manifest({
      tools: { activeToolNames: ["read"], toolSchemaSnapshotHash: "tools:base" },
      provider: { provider: "other-provider", api: "faux-api", model: "faux-model" },
    });

    expect(resolveHarnessCandidatePatchMaterialization(patchFor(base, candidate))).toEqual({
      ok: false,
      blockedFields: [
        { field: "provider.provider", reason: "field_not_yet_materializable" },
        { field: "tools.activeToolNames", reason: "field_not_yet_materializable" },
      ],
    });
  });

  test("a value-bearing plugins delta refuses instead of passing as derived", () => {
    const base = manifest({
      plugins: { mutatingHookIds: ["before_provider_request:alpha"] },
    });
    const candidate = manifest({
      plugins: { mutatingHookIds: ["before_provider_request:beta"] },
    });

    expect(resolveHarnessCandidatePatchMaterialization(patchFor(base, candidate))).toEqual({
      ok: false,
      blockedFields: [{ field: "plugins.mutatingHookIds", reason: "field_not_yet_materializable" }],
    });
  });

  test("removing the model refuses: execute-with-default is not the candidate's claim", () => {
    const base = manifest();
    const candidate = manifest({
      provider: { provider: "faux", api: "faux-api" },
    });

    expect(resolveHarnessCandidatePatchMaterialization(patchFor(base, candidate))).toEqual({
      ok: false,
      blockedFields: [{ field: "provider.model", reason: "field_removal_not_materializable" }],
    });
  });

  test("an explicit JSON null model refuses the same removal direction", () => {
    const base = manifest();
    // A loaded candidate file can spell removal as `"model": null`; the patch
    // marks the removal as `to: null`, which the string-only materializer
    // refuses instead of leaking a null into the session override.
    const candidate = manifest({
      provider: { provider: "faux", api: "faux-api", model: null as unknown as string },
    });

    expect(resolveHarnessCandidatePatchMaterialization(patchFor(base, candidate))).toEqual({
      ok: false,
      blockedFields: [{ field: "provider.model", reason: "field_removal_not_materializable" }],
    });
  });

  test("a smuggled derived field in a hand-crafted patch refuses, not silently applied", () => {
    // The honest patch builder never emits a derived field. A patch delta
    // hand-crafted to carry one must still refuse — the allowlist is the only
    // way through, so a frozen-surface field cannot ride in as "derived".
    expect(
      resolveHarnessCandidatePatchMaterialization([
        { field: "provider.model", to: "candidate-model" },
        { field: "runtime.configHash", to: "forged" },
      ]),
    ).toEqual({
      ok: false,
      blockedFields: [{ field: "runtime.configHash", reason: "field_not_classified" }],
    });
  });

  test("unclassified fields refuse fail-closed so future manifest fields arrive blocked", () => {
    expect(
      resolveHarnessCandidatePatchMaterialization([
        { field: "provider.model", to: "candidate-model" },
        { field: "future.surface.knob", to: "x" },
      ]),
    ).toEqual({
      ok: false,
      blockedFields: [{ field: "future.surface.knob", reason: "field_not_classified" }],
    });
  });
});
