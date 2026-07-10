import { describe, expect, test } from "bun:test";
import {
  buildHarnessManifest,
  type BuildHarnessManifestInput,
} from "@brewva/brewva-vocabulary/harness";
import { diffHarnessManifestFields } from "../../../packages/brewva-gateway/src/harness/internal/manifest-diff.js";
import { resolveHarnessCandidateMaterialization } from "../../../packages/brewva-gateway/src/harness/internal/materialize.js";

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

describe("harness candidate materialization", () => {
  test("a model delta materializes as a hosted-session override", () => {
    const base = manifest();
    const candidate = manifest({
      provider: { provider: "faux", api: "faux-api", model: "candidate-model" },
    });

    const resolution = resolveHarnessCandidateMaterialization({
      base,
      candidate,
      changedFields: diffHarnessManifestFields(base, candidate),
    });

    if (!resolution.ok) {
      throw new Error(`expected materialization, got ${JSON.stringify(resolution)}`);
    }
    expect(resolution.overrides).toEqual({ model: "candidate-model" });
    expect(resolution.materializedFields).toEqual(["provider.model"]);
  });

  test("derived and provenance deltas materialize as a no-op", () => {
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

    const resolution = resolveHarnessCandidateMaterialization({
      base,
      candidate,
      changedFields: diffHarnessManifestFields(base, candidate),
    });

    if (!resolution.ok) {
      throw new Error(`expected materialization, got ${JSON.stringify(resolution)}`);
    }
    expect(resolution.overrides).toEqual({});
    expect(resolution.materializedFields).toEqual([]);
    expect(resolution.derivedFields).toEqual([
      "prompt.systemPromptHash",
      "runtime.configHash",
      "runtime.runtimeIdentityHash",
    ]);
  });

  test("value fields without an execution seam refuse with the field named", () => {
    const base = manifest();
    const candidate = manifest({
      tools: { activeToolNames: ["read"], toolSchemaSnapshotHash: "tools:base" },
      provider: { provider: "other-provider", api: "faux-api", model: "faux-model" },
    });

    const resolution = resolveHarnessCandidateMaterialization({
      base,
      candidate,
      changedFields: diffHarnessManifestFields(base, candidate),
    });

    expect(resolution).toEqual({
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

    const resolution = resolveHarnessCandidateMaterialization({
      base,
      candidate,
      changedFields: diffHarnessManifestFields(base, candidate),
    });

    expect(resolution).toEqual({
      ok: false,
      blockedFields: [{ field: "plugins.mutatingHookIds", reason: "field_not_yet_materializable" }],
    });
  });

  test("removing the model refuses: execute-with-default is not the candidate's claim", () => {
    const base = manifest();
    const candidate = manifest({
      provider: { provider: "faux", api: "faux-api" },
    });

    const resolution = resolveHarnessCandidateMaterialization({
      base,
      candidate,
      changedFields: diffHarnessManifestFields(base, candidate),
    });

    expect(resolution).toEqual({
      ok: false,
      blockedFields: [{ field: "provider.model", reason: "field_removal_not_materializable" }],
    });
  });

  test("an explicit JSON null model refuses the same removal direction", () => {
    const base = manifest();
    // A loaded candidate file can spell removal as `"model": null`; the
    // runtime value defeats an undefined-only guard and would leak a null
    // into the string-typed session override.
    const candidate = manifest({
      provider: { provider: "faux", api: "faux-api", model: null as unknown as string },
    });

    const resolution = resolveHarnessCandidateMaterialization({
      base,
      candidate,
      changedFields: diffHarnessManifestFields(base, candidate),
    });

    expect(resolution).toEqual({
      ok: false,
      blockedFields: [{ field: "provider.model", reason: "field_removal_not_materializable" }],
    });
  });

  test("unclassified fields refuse fail-closed so future manifest fields arrive blocked", () => {
    const base = manifest();
    const candidate = manifest({
      provider: { provider: "faux", api: "faux-api", model: "candidate-model" },
    });

    const resolution = resolveHarnessCandidateMaterialization({
      base,
      candidate,
      changedFields: ["provider.model", "future.surface.knob"],
    });

    expect(resolution).toEqual({
      ok: false,
      blockedFields: [{ field: "future.surface.knob", reason: "field_not_classified" }],
    });
  });
});
