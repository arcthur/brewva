import { describe, expect, test } from "bun:test";
import {
  ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
  VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
  collectHostedExtensionManifests,
  defineHostedExtensionPlugin,
  evaluateVerificationGateManifest,
  parseAdvisoryExtensionManifest,
  parseVerificationGateManifest,
  resolveAdvisoryExtensionManifests,
  type VerificationGateManifest,
} from "@brewva/brewva-gateway/extensions";

describe("advisory extension manifests", () => {
  test("parses schema-tagged advisory manifests and fails closed on unknown fields", () => {
    expect(
      parseAdvisoryExtensionManifest({
        apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
        slot: "context.contributor",
        name: "project-hints",
        ambientCapabilityClass: "read_fs",
        inputs: ["work_card"],
        outputs: ["attention_candidate"],
      }),
    ).toEqual({
      ok: true,
      manifest: {
        apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
        slot: "context.contributor",
        name: "project-hints",
        ambientCapabilityClass: "read_fs",
        inputs: ["work_card"],
        outputs: ["attention_candidate"],
      },
    });

    expect(
      parseAdvisoryExtensionManifest({
        apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
        slot: "context.contributor",
        name: "networked",
        ambientCapabilityClass: "read_fs",
        inputs: [],
        outputs: [],
        network: true,
      }),
    ).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "unknown_field",
          message: "Unknown advisory extension manifest field 'network'.",
          field: "network",
        },
      ],
    });
  });

  test("resolves manifest precedence without letting low-priority duplicates override", () => {
    const resolution = resolveAdvisoryExtensionManifests([
      {
        precedence: "user",
        manifest: {
          apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
          slot: "inspect.renderer",
          name: "work-card",
          ambientCapabilityClass: "pure",
          inputs: ["projection"],
          outputs: ["text"],
        },
      },
      {
        precedence: "built_in",
        manifest: {
          apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
          slot: "inspect.renderer",
          name: "work-card",
          ambientCapabilityClass: "pure",
          inputs: ["projection"],
          outputs: ["text"],
        },
      },
      {
        precedence: "project",
        manifest: {
          apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
          slot: "skill.provider",
          name: "project-skills",
          ambientCapabilityClass: "read_fs",
          inputs: ["workspace"],
          outputs: ["skill_card"],
        },
      },
    ]);

    expect(resolution.manifests.map((manifest) => `${manifest.slot}:${manifest.name}`)).toEqual([
      "inspect.renderer:work-card",
      "skill.provider:project-skills",
    ]);
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: "shadowed_manifest",
        slot: "inspect.renderer",
        name: "work-card",
        precedence: "user",
        shadowedBy: "built_in",
      }),
    ]);
  });

  test("hosted extension manifests constrain runtime capabilities and registered events", () => {
    expect(() =>
      defineHostedExtensionPlugin({
        name: "legacy-context",
        capabilities: ["context_messages.write"],
        register() {},
      } as never),
    ).toThrow("hosted_extension_advisory_manifest_required:legacy-context");

    expect(() =>
      defineHostedExtensionPlugin({
        name: "project-context",
        capabilities: ["tool_registration.write"],
        advisoryManifest: {
          apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
          slot: "context.contributor",
          name: "project-context",
          ambientCapabilityClass: "read_fs",
          inputs: ["work_card"],
          outputs: ["attention_candidate"],
        },
        register() {},
      }),
    ).toThrow(
      "hosted_extension_manifest_capability_violation:project-context:context.contributor:tool_registration.write",
    );

    const plugin = defineHostedExtensionPlugin({
      name: "project-context",
      capabilities: ["context_messages.write"],
      advisoryManifest: {
        apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
        slot: "context.contributor",
        name: "project-context",
        ambientCapabilityClass: "read_fs",
        inputs: ["work_card"],
        outputs: ["attention_candidate"],
      },
      register(api) {
        api.on("tool_call", () => undefined);
      },
    });

    expect(() =>
      plugin.register({
        on() {},
        registerTool() {},
        registerCommand() {},
        sendMessage() {},
        sendUserMessage() {},
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools() {},
        refreshTools() {},
      }),
    ).toThrow(
      "hosted_extension_manifest_event_violation:project-context:context.contributor:tool_call",
    );
  });

  test("verification gate manifests stay explicit and separate from advisory adapters", () => {
    const gate = parseVerificationGateManifest({
      apiVersion: VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
      adapter: "typecheck",
      targetRoots: ["packages/brewva-cli/src"],
      patchSetRefs: ["patch:set-1"],
      evidenceRefs: ["event:verify-1"],
      freshness: { maxAgeMs: 300_000 },
      posture: {
        missing: "defer",
        stale: "defer",
        failed: "abort",
      },
    });

    expect(gate).toMatchObject({
      ok: true,
      manifest: {
        apiVersion: "brewva.verification-gate.manifest.v1",
        adapter: "typecheck",
        posture: {
          missing: "defer",
          stale: "defer",
          failed: "abort",
        },
      },
    });
    expect(
      parseVerificationGateManifest({
        apiVersion: VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
        adapter: "networked",
        targetRoots: ["packages/brewva-cli/src"],
        patchSetRefs: ["patch:set-1"],
        evidenceRefs: ["event:verify-1"],
        freshness: { maxAgeMs: 300_000 },
        posture: {
          missing: "defer",
          stale: "defer",
          failed: "abort",
        },
        network: true,
      }),
    ).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "unknown_field",
          field: "network",
          message: "Unknown verification gate manifest field 'network'.",
        },
      ],
    });
    expect(
      parseVerificationGateManifest({
        apiVersion: VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
        adapter: "typecheck",
        targetRoots: ["packages/brewva-cli/src"],
        patchSetRefs: ["patch:set-1"],
        evidenceRefs: ["event:verify-1"],
        freshness: { maxAgeMs: 300_000, graceMs: 10 },
        posture: {
          missing: "defer",
          stale: "defer",
          failed: "abort",
          flaky: "advisory",
        },
      }),
    ).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "unknown_field",
          field: "freshness.graceMs",
          message: "Unknown verification gate manifest field 'freshness.graceMs'.",
        },
        {
          code: "unknown_field",
          field: "posture.flaky",
          message: "Unknown verification gate manifest field 'posture.flaky'.",
        },
      ],
    });
  });

  test("evaluates verification gate evidence without making adapters authoritative by default", () => {
    const manifest: VerificationGateManifest = {
      apiVersion: VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
      adapter: "typecheck",
      targetRoots: ["packages/brewva-cli/src"],
      patchSetRefs: ["patch:set-1"],
      evidenceRefs: ["event:verify-pass", "event:verify-fail"],
      freshness: { maxAgeMs: 1_000 },
      posture: {
        missing: "defer",
        stale: "defer",
        failed: "abort",
      },
    };

    expect(
      evaluateVerificationGateManifest({
        manifest,
        evidence: [],
        now: 10_000,
      }),
    ).toMatchObject({
      status: "missing",
      posture: "defer",
      policyInput: {
        status: "missing",
        posture: "defer",
      },
    });

    expect(
      evaluateVerificationGateManifest({
        manifest,
        evidence: [
          {
            ref: "event:verify-pass",
            adapter: "typecheck",
            targetRoots: ["packages/brewva-cli/src"],
            patchSetRefs: ["patch:set-1"],
            status: "passed",
            observedAt: 8_000,
          },
        ],
        now: 10_000,
      }),
    ).toMatchObject({
      status: "stale",
      posture: "defer",
      policyInput: {
        status: "stale",
        posture: "defer",
      },
    });

    expect(
      evaluateVerificationGateManifest({
        manifest,
        evidence: [
          {
            ref: "event:verify-fail",
            adapter: "typecheck",
            targetRoots: ["packages/brewva-cli/src"],
            patchSetRefs: ["patch:set-1"],
            status: "failed",
            observedAt: 9_500,
          },
        ],
        now: 10_000,
      }),
    ).toMatchObject({
      status: "failed",
      posture: "abort",
      policyInput: {
        status: "failed",
        posture: "abort",
      },
    });

    const passed = evaluateVerificationGateManifest({
      manifest,
      evidence: [
        {
          ref: "event:verify-pass",
          adapter: "typecheck",
          targetRoots: ["packages/brewva-cli/src"],
          patchSetRefs: ["patch:set-1"],
          status: "passed",
          observedAt: 9_500,
        },
      ],
      now: 10_000,
    });
    expect(passed).toMatchObject({
      status: "ok",
      posture: "advisory",
    });
    expect(Object.hasOwn(passed, "policyInput")).toEqual(false);
  });

  test("hosted extension manifest collection exposes verification gate manifests for runtime turns", () => {
    const plugin = defineHostedExtensionPlugin({
      name: "typecheck-gate-provider",
      capabilities: [],
      advisoryManifest: {
        apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
        slot: "verifier.adapter",
        name: "typecheck-gate-provider",
        ambientCapabilityClass: "pure",
        inputs: ["verification.outcome.recorded"],
        outputs: ["verification_gate_policy"],
      },
      verificationGateManifests: [
        {
          apiVersion: VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
          adapter: "typecheck",
          targetRoots: ["packages/brewva-cli/src"],
          patchSetRefs: ["patch:set-1"],
          evidenceRefs: ["event:verify-1"],
          freshness: { maxAgeMs: 300_000 },
          posture: {
            missing: "defer",
            stale: "defer",
            failed: "abort",
          },
        },
      ],
      register() {},
    });

    expect(collectHostedExtensionManifests([plugin]).verificationGateManifests).toEqual([
      {
        apiVersion: VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
        adapter: "typecheck",
        targetRoots: ["packages/brewva-cli/src"],
        patchSetRefs: ["patch:set-1"],
        evidenceRefs: ["event:verify-1"],
        freshness: { maxAgeMs: 300_000 },
        posture: {
          missing: "defer",
          stale: "defer",
          failed: "abort",
        },
      },
    ]);
  });

  test("verification gate manifests only attach to verifier adapter slots", () => {
    expect(() =>
      defineHostedExtensionPlugin({
        name: "context-gate-provider",
        capabilities: ["context_messages.write"],
        advisoryManifest: {
          apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
          slot: "context.contributor",
          name: "context-gate-provider",
          ambientCapabilityClass: "read_fs",
          inputs: ["work_card"],
          outputs: ["attention_candidate"],
        },
        verificationGateManifests: [
          {
            apiVersion: VERIFICATION_GATE_MANIFEST_SCHEMA_V1,
            adapter: "typecheck",
            targetRoots: ["packages/brewva-cli/src"],
            patchSetRefs: ["patch:set-1"],
            evidenceRefs: ["event:verify-1"],
            freshness: { maxAgeMs: 300_000 },
            posture: {
              missing: "defer",
              stale: "defer",
              failed: "abort",
            },
          },
        ],
        register() {},
      }),
    ).toThrow(
      "hosted_extension_verification_gate_manifest_slot_violation:context-gate-provider:context.contributor",
    );
  });
});
