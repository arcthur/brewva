import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function writeIdentity(workspace: string, agentId: string, content: string): string {
  const path = join(workspace, ".brewva", "agents", agentId, "identity.md");
  mkdirSync(join(workspace, ".brewva", "agents", agentId), { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, "utf8");
  return path;
}

function writeAgentArtifact(
  workspace: string,
  agentId: string,
  fileName: string,
  content: string,
): string {
  const path = join(workspace, ".brewva", "agents", agentId, fileName);
  mkdirSync(join(workspace, ".brewva", "agents", agentId), { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, "utf8");
  return path;
}

describe("Identity context injection", () => {
  test("injects existing identity file for current agent", async () => {
    const workspace = createTestWorkspace("identity-existing");
    writeIdentity(
      workspace,
      "code-reviewer",
      [
        "## Who I Am",
        "Senior code reviewer focused on correctness and safety.",
        "",
        "## How I Work",
        "- Read code before judging.",
        "- Prefer evidence over intuition.",
        "",
        "## What I Care About",
        "- no_direct_code_changes",
      ].join("\n"),
    );
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "Code Reviewer",
    });

    const injection = await runtime.context.buildInjection("identity-existing-1", "review");
    expect(injection.accepted).toBe(true);
    expect(injection.text).toContain("[PersonaProfile]");
    expect(injection.text).toContain("[WhoIAm]");
    expect(injection.text).toContain("[HowIWork]");
    expect(injection.text).toContain("[WhatICareAbout]");
    expect(injection.text).toContain("agent_id: code-reviewer");
    expect(injection.text).toContain("Senior code reviewer focused on correctness and safety.");
    expect(injection.text).toContain("no_direct_code_changes");
  });

  test("does not inject identity when file is missing", async () => {
    const workspace = createTestWorkspace("identity-missing");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "missing-agent",
    });

    const injection = await runtime.context.buildInjection("identity-missing-1", "continue");
    expect(injection.accepted).toBe(true);
    expect(injection.text).not.toContain("[PersonaProfile]");

    const path = join(workspace, ".brewva", "agents", "missing-agent", "identity.md");
    expect(existsSync(path)).toBe(false);
  });

  test("resolves per-agent file and applies oncePerSession semantics", async () => {
    const workspace = createTestWorkspace("identity-agent-scope");
    writeIdentity(workspace, "reviewer-a", ["## Who I Am", "Reviewer A"].join("\n"));
    writeIdentity(workspace, "reviewer-b", ["## Who I Am", "Reviewer B"].join("\n"));

    const runtimeA = new BrewvaRuntime({
      cwd: workspace,
      agentId: "reviewer-a",
    });
    const first = await runtimeA.context.buildInjection(
      "identity-agent-scope-1",
      "continue",
      undefined,
      "leaf-a",
    );
    expect(first.text).toContain("Reviewer A");
    expect(first.text).not.toContain("Reviewer B");

    const second = await runtimeA.context.buildInjection(
      "identity-agent-scope-1",
      "continue",
      undefined,
      "leaf-b",
    );
    expect(second.accepted).toBe(true);
    expect(second.text).not.toContain("[PersonaProfile]");

    runtimeA.context.markCompacted("identity-agent-scope-1", { fromTokens: 1000, toTokens: 300 });
    const third = await runtimeA.context.buildInjection(
      "identity-agent-scope-1",
      "continue",
      undefined,
      "leaf-c",
    );
    expect(third.accepted).toBe(true);
    expect(third.text).toContain("Reviewer A");

    const runtimeB = new BrewvaRuntime({
      cwd: workspace,
      agentId: "reviewer-b",
    });
    const b = await runtimeB.context.buildInjection("identity-agent-scope-2", "continue");
    expect(b.accepted).toBe(true);
    expect(b.text).toContain("Reviewer B");
    expect(b.text).not.toContain("Reviewer A");
  });

  test("does not inject identity without persona headings", async () => {
    const workspace = createTestWorkspace("identity-no-headings");
    writeIdentity(workspace, "reviewer-a", "role: Reviewer A");

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "reviewer-a",
    });

    const injection = await runtime.context.buildInjection("identity-no-headings-1", "continue");
    expect(injection.accepted).toBe(true);
    expect(injection.text).not.toContain("[PersonaProfile]");
  });

  test("injects constitution and memory as explicit narrative providers", async () => {
    const workspace = createTestWorkspace("identity-self-bundle");
    writeIdentity(workspace, "reviewer-a", ["## Who I Am", "Reviewer A"].join("\n"));
    writeAgentArtifact(
      workspace,
      "reviewer-a",
      "constitution.md",
      [
        "## Operating Principles",
        "- Keep kernel authority explicit.",
        "",
        "## Delegation Defaults",
        "- Delegate cross-file exploration before broad guessing.",
      ].join("\n"),
    );
    writeAgentArtifact(
      workspace,
      "reviewer-a",
      "memory.md",
      [
        "## Stable Memory",
        "- Arthur prefers concise, high-signal reviews.",
        "",
        "## Continuity Notes",
        "- This memory is narrative only, never authoritative.",
      ].join("\n"),
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "reviewer-a",
    });

    const injection = await runtime.context.buildInjection("identity-self-bundle-1", "continue");
    expect(injection.accepted).toBe(true);
    expect(injection.text).toContain("[PersonaProfile]");
    expect(injection.text).toContain("[AgentConstitution]");
    expect(injection.text).toContain("[OperatingPrinciples]");
    expect(injection.text).toContain("[AgentMemory]");
    expect(injection.text).toContain("[StableMemory]");
    expect(injection.text).toContain("Arthur prefers concise, high-signal reviews.");
  });
});
