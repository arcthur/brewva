import { describe, expect, test } from "bun:test";
import {
  carryCapabilitySelection,
  parseCapabilityManifestContent,
  selectCapabilities,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.js";

function manifest(name: string, riskLevel: "read" | "draft" | "write" = "read") {
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
  - coding-agent
workspace_scope:
  - default
conflicts_with: []
auth_profile: google-work
side_effects: []
env_allowlist:
  - GOOGLE_APPLICATION_CREDENTIALS
inherit_env: false
selection:
  when_to_use: Use for ${name} email tasks.
`,
    `${name}.yaml`,
  );
}

describe("capability selector", () => {
  test("honors explicit capability before deterministic ranking", () => {
    const receipt = selectCapabilities({
      manifests: [manifest("gmail-search"), manifest("gmail-draft", "draft")],
      explicitCapability: "gmail-draft",
      intentText: "search email",
      trigger: "explicit_capability",
      policy: {
        agentScope: ["coding-agent"],
        workspaceScope: ["default"],
        allowedAccounts: ["google-work"],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(receipt.selected_capabilities).toEqual([
      {
        name: "gmail-draft",
        source: "explicit",
        score: 1000,
        reason: "explicit capability target",
      },
    ]);
  });

  test("filters scope and account mismatches fail closed", () => {
    const receipt = selectCapabilities({
      manifests: [manifest("gmail-search")],
      intentText: "email",
      trigger: "user_message",
      policy: {
        agentScope: ["ops-agent"],
        workspaceScope: ["default"],
        allowedAccounts: ["google-work"],
      },
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
      policy: {
        agentScope: ["coding-agent"],
        workspaceScope: ["default"],
        allowedAccounts: ["google-work"],
      },
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

  test("selection ids are stable across receipt creation times", () => {
    const base = {
      manifests: [manifest("gmail-search")],
      explicitCapability: "gmail-search",
      trigger: "explicit_capability" as const,
      policy: {
        agentScope: ["coding-agent"],
        workspaceScope: ["default"],
        allowedAccounts: ["google-work"],
      },
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
