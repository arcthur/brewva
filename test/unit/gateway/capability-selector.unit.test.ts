import { describe, expect, test } from "bun:test";
import {
  carryCapabilitySelection,
  computeCapabilityManifestHash,
  computeCapabilityRegistryVersion,
  parseCapabilityManifestContent,
  resolveCarriedCapabilityReceipt,
  selectCapabilities,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.js";

const POLICY = {
  agentScope: ["coding-agent"],
  workspaceScope: ["default"],
  allowedAccounts: ["google-work"],
};

function manifest(
  name: string,
  options: {
    riskLevel?: "read" | "draft" | "write";
    whenToUse?: string;
    agentScope?: string;
    fileName?: string;
  } = {},
) {
  const riskLevel = options.riskLevel ?? "read";
  return parseCapabilityManifestContent(
    `name: ${name}
provider: google
domain: email
action: ${name}
resource_types:
  - email
risk_level: ${riskLevel}
requires_explicit_account: true
requires_confirmation: ${riskLevel === "read" ? "false" : "true"}
agent_scope:
  - ${options.agentScope ?? "coding-agent"}
workspace_scope:
  - default
conflicts_with: []
auth_profile: google-work
side_effects: []
env_allowlist:
  - GOOGLE_APPLICATION_CREDENTIALS
inherit_env: false
selection:
  when_to_use: ${options.whenToUse ?? `Use for ${name} email tasks.`}
`,
    options.fileName ?? `${name}.yaml`,
  );
}

describe("capability selector", () => {
  test("honors explicit capability before deterministic ranking", () => {
    const draft = manifest("gmail-draft", { riskLevel: "draft" });
    const receipt = selectCapabilities({
      manifests: [manifest("gmail-search"), draft],
      explicitCapability: "gmail-draft",
      intentText: "search email",
      trigger: "explicit_capability",
      policy: POLICY,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(receipt.selected_capabilities).toEqual([
      {
        name: "gmail-draft",
        source: "explicit",
        score: 1000,
        reason: "explicit capability target",
        manifestHash: computeCapabilityManifestHash(draft),
      },
    ]);
  });

  test("policy defaults bind only through key tokens, never manifest description", () => {
    // Intent overlaps the manifest's descriptive tokens ("search email") but
    // not the default key ("calendar"). Descriptive matching may rank views
    // (deterministic), never mint policy authority (axiom 18).
    const receipt = selectCapabilities({
      manifests: [manifest("gmail-search")],
      intentText: "search email",
      trigger: "user_message",
      policy: { ...POLICY, defaults: { calendar: "gmail-search" } },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(receipt.selected_capabilities.map((entry) => entry.source)).toEqual(["deterministic"]);
  });

  test("a policy default whose key matches intent mints policy authority", () => {
    const receipt = selectCapabilities({
      manifests: [manifest("gmail-search")],
      intentText: "search email",
      trigger: "user_message",
      policy: { ...POLICY, defaults: { email: "gmail-search" } },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      receipt.selected_capabilities.map((entry) => ({ name: entry.name, source: entry.source })),
    ).toEqual([{ name: "gmail-search", source: "policy" }]);
  });

  test("filters scope and account mismatches fail closed", () => {
    const receipt = selectCapabilities({
      manifests: [manifest("gmail-search")],
      intentText: "email",
      trigger: "user_message",
      policy: { ...POLICY, agentScope: ["ops-agent"] },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(receipt.selected_capabilities).toEqual([]);
    expect(receipt.filtered_out).toEqual([{ name: "gmail-search", reason: "agent_scope" }]);
  });

  test("carries previous receipt for tool-only turns", () => {
    const first = selectCapabilities({
      manifests: [manifest("gmail-search")],
      explicitCapability: "gmail-search",
      trigger: "explicit_capability",
      policy: POLICY,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const carried = carryCapabilitySelection({
      previous: first,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(carried.trigger).toBe("carried");
    expect(carried.carried_from).toBe(first.selection_id);
    expect(carried.selected_capabilities).toEqual(first.selected_capabilities);
  });

  test("carried receipts keep policy exclusions and drop intent-relative ranking leftovers", () => {
    const first = selectCapabilities({
      manifests: [manifest("gmail-search")],
      intentText: "email",
      trigger: "user_message",
      policy: { ...POLICY, agentScope: ["ops-agent"] },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(first.filtered_out).toEqual([{ name: "gmail-search", reason: "agent_scope" }]);

    const carried = carryCapabilitySelection({
      previous: {
        ...first,
        filtered_out: [...first.filtered_out, { name: "gmail-draft", reason: "not_ranked" }],
      },
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(carried.filtered_out).toEqual([{ name: "gmail-search", reason: "agent_scope" }]);
  });

  test("registry version tracks every authored manifest field", () => {
    const baseVersion = computeCapabilityRegistryVersion([manifest("gmail-search")]);
    const whenToUseVersion = computeCapabilityRegistryVersion([
      manifest("gmail-search", { whenToUse: "Changed guidance must change the version." }),
    ]);
    const scopeVersion = computeCapabilityRegistryVersion([
      manifest("gmail-search", { agentScope: "ops-agent" }),
    ]);

    expect(whenToUseVersion).not.toBe(baseVersion);
    expect(scopeVersion).not.toBe(baseVersion);
    expect(computeCapabilityRegistryVersion([manifest("gmail-search")])).toBe(baseVersion);
  });

  test("registry version and manifest hash ignore pure file renames", () => {
    const original = manifest("gmail-search");
    const renamed = manifest("gmail-search", { fileName: "renamed-gmail.yaml" });

    expect(computeCapabilityManifestHash(renamed)).toBe(computeCapabilityManifestHash(original));
    expect(computeCapabilityRegistryVersion([renamed])).toBe(
      computeCapabilityRegistryVersion([original]),
    );
  });

  test("resolveCarriedCapabilityReceipt carries when the registry and policy still match", () => {
    const manifests = [manifest("gmail-search")];
    const registryVersion = computeCapabilityRegistryVersion(manifests);
    const previous = selectCapabilities({
      manifests,
      explicitCapability: "gmail-search",
      trigger: "explicit_capability",
      policy: POLICY,
      registryVersion,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = resolveCarriedCapabilityReceipt({
      registry: { manifests, registryVersion },
      policy: POLICY,
      previous,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(resolved.trigger).toBe("carried");
    expect(resolved.carried_from).toBe(previous.selection_id);
    expect(resolved.selected_capabilities).toEqual(previous.selected_capabilities);
  });

  test("unrelated registry churn keeps a revalidated explicit selection", () => {
    const oldManifests = [manifest("gmail-search")];
    const previous = selectCapabilities({
      manifests: oldManifests,
      explicitCapability: "gmail-search",
      trigger: "explicit_capability",
      policy: POLICY,
      registryVersion: computeCapabilityRegistryVersion(oldManifests),
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const newManifests = [
      manifest("gmail-search"),
      manifest("slack-notify", { riskLevel: "write" }),
    ];
    const newVersion = computeCapabilityRegistryVersion(newManifests);
    const resolved = resolveCarriedCapabilityReceipt({
      registry: { manifests: newManifests, registryVersion: newVersion },
      policy: POLICY,
      previous,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(resolved.trigger).toBe("registry_change");
    expect(resolved.carried_from).toBe(previous.selection_id);
    expect(resolved.registry_version).toBe(newVersion);
    expect(resolved.selected_capabilities).toEqual(previous.selected_capabilities);
    expect(resolved.policy_decisions).toEqual([
      `carried selection ${previous.selection_id} revalidated against the current registry and policy`,
    ]);
  });

  test("an edited selected manifest drops exactly that carried entry", () => {
    const oldManifests = [manifest("gmail-search")];
    const previous = selectCapabilities({
      manifests: oldManifests,
      explicitCapability: "gmail-search",
      trigger: "explicit_capability",
      policy: POLICY,
      registryVersion: computeCapabilityRegistryVersion(oldManifests),
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const editedManifests = [manifest("gmail-search", { whenToUse: "Edited guidance." })];
    const editedVersion = computeCapabilityRegistryVersion(editedManifests);
    const resolved = resolveCarriedCapabilityReceipt({
      registry: { manifests: editedManifests, registryVersion: editedVersion },
      policy: POLICY,
      previous,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(resolved.trigger).toBe("registry_change");
    expect(resolved.selected_capabilities).toEqual([]);
    expect(resolved.registry_version).toBe(editedVersion);
    expect(resolved.policy_decisions).toEqual([
      `carried selection ${previous.selection_id} revalidated against the current registry and policy`,
      "carried_selection_dropped: gmail-search manifest_changed",
    ]);
  });

  test("a policy narrowed mid-session drops the carried entry as policy_change", () => {
    const manifests = [manifest("gmail-search")];
    const registryVersion = computeCapabilityRegistryVersion(manifests);
    const previous = selectCapabilities({
      manifests,
      explicitCapability: "gmail-search",
      trigger: "explicit_capability",
      policy: POLICY,
      registryVersion,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = resolveCarriedCapabilityReceipt({
      registry: { manifests, registryVersion },
      policy: { ...POLICY, allowedAccounts: ["ops-account"] },
      previous,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(resolved.trigger).toBe("policy_change");
    expect(resolved.carried_from).toBe(previous.selection_id);
    expect(resolved.selected_capabilities).toEqual([]);
    expect(resolved.filtered_out).toEqual([
      { name: "gmail-search", reason: "account_restriction" },
    ]);
    expect(resolved.policy_decisions).toEqual([
      `carried selection ${previous.selection_id} revalidated against the current registry and policy`,
      "carried_selection_dropped: gmail-search account_restriction",
    ]);
  });

  test("a removed policy default revokes the carried policy-sourced entry", () => {
    const manifests = [manifest("gmail-search")];
    const registryVersion = computeCapabilityRegistryVersion(manifests);
    const previous = selectCapabilities({
      manifests,
      intentText: "search email",
      trigger: "user_message",
      policy: { ...POLICY, defaults: { email: "gmail-search" } },
      registryVersion,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(previous.selected_capabilities.map((entry) => entry.source)).toEqual(["policy"]);

    const resolved = resolveCarriedCapabilityReceipt({
      registry: { manifests, registryVersion },
      policy: POLICY,
      previous,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(resolved.trigger).toBe("policy_change");
    expect(resolved.selected_capabilities).toEqual([]);
    expect(resolved.policy_decisions).toEqual([
      `carried selection ${previous.selection_id} revalidated against the current registry and policy`,
      "carried_selection_dropped: gmail-search policy_default_removed",
    ]);
  });

  test("a remapped policy default revokes the orphaned carried entry", () => {
    const manifests = [manifest("gmail-search"), manifest("gmail-draft", { riskLevel: "draft" })];
    const registryVersion = computeCapabilityRegistryVersion(manifests);
    const previous = selectCapabilities({
      manifests,
      intentText: "search email",
      trigger: "user_message",
      policy: { ...POLICY, defaults: { email: "gmail-search" } },
      registryVersion,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(previous.selected_capabilities.map((entry) => entry.source)).toEqual(["policy"]);

    const resolved = resolveCarriedCapabilityReceipt({
      registry: { manifests, registryVersion },
      policy: { ...POLICY, defaults: { email: "gmail-draft" } },
      previous,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(resolved.trigger).toBe("policy_change");
    expect(resolved.selected_capabilities).toEqual([]);
    expect(resolved.policy_decisions).toEqual([
      `carried selection ${previous.selection_id} revalidated against the current registry and policy`,
      "carried_selection_dropped: gmail-search policy_default_removed",
    ]);
  });

  test("legacy entries without a manifest hash drop as stale instead of carrying", () => {
    const manifests = [manifest("gmail-search")];
    const registryVersion = computeCapabilityRegistryVersion(manifests);
    const withHash = selectCapabilities({
      manifests,
      explicitCapability: "gmail-search",
      trigger: "explicit_capability",
      policy: POLICY,
      registryVersion,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const legacy = {
      ...withHash,
      selected_capabilities: withHash.selected_capabilities.map(
        ({ manifestHash: _manifestHash, ...entry }) => entry,
      ),
    };

    const resolved = resolveCarriedCapabilityReceipt({
      registry: { manifests, registryVersion },
      policy: POLICY,
      previous: legacy,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(resolved.trigger).toBe("registry_change");
    expect(resolved.selected_capabilities).toEqual([]);
    expect(resolved.policy_decisions).toEqual([
      `carried selection ${legacy.selection_id} revalidated against the current registry and policy`,
      "carried_selection_dropped: gmail-search manifest_hash_unavailable",
    ]);
  });

  test("selection ids are stable across receipt creation times", () => {
    const base = {
      manifests: [manifest("gmail-search")],
      explicitCapability: "gmail-search",
      trigger: "explicit_capability" as const,
      policy: POLICY,
    };

    const first = selectCapabilities({
      ...base,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const second = selectCapabilities({
      ...base,
      createdAt: "2026-01-01T00:05:00.000Z",
    });

    expect(first.created_at).not.toBe(second.created_at);
    expect(first.selection_id).toBe(second.selection_id);
  });
});
