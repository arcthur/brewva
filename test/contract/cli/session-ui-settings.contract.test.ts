import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHostedSession as createBrewvaSession } from "@brewva/brewva-gateway/host";
import { createTestWorkspace } from "../../helpers/workspace.js";

function writeSkill(filePath: string, name: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${name}`,
      `description: ${name} skill`,
      "intent:",
      "  outputs: []",
      "effects:",
      "  allowed_effects: [workspace_read]",
      "resources:",
      "  default_lease:",
      "    max_tool_calls: 5",
      "    max_tokens: 2000",
      "  hard_ceiling:",
      "    max_tool_calls: 10",
      "    max_tokens: 4000",
      "execution_hints:",
      "  preferred_tools: [read]",
      "  fallback_tools: []",
      "consumes: []",
      "---",
      `# ${name}`,
      "",
      "## Intent",
      "",
      "test skill",
      "",
      "## Trigger",
      "",
      "test",
      "",
      "## Workflow",
      "",
      "### Step 1",
      "",
      "test",
      "",
      "## Stop Conditions",
      "",
      "- none",
      "",
      "## Anti-Patterns",
      "",
      "- none",
      "",
      "## Example",
      "",
      "Input: test",
    ].join("\n"),
    "utf8",
  );
}

describe("brewva session ui settings wiring", () => {
  test("normalizes agentId into runtime identity", async () => {
    const workspace = createTestWorkspace("session-ui-agent-id");
    const result = await createBrewvaSession({
      cwd: workspace,
      agentId: "Code Reviewer",
    });
    try {
      expect(result.runtime.agentId).toBe("code-reviewer");
    } finally {
      result.session.dispose();
    }
  });

  test("applies ui quietStartup override from config", async () => {
    const workspace = createTestWorkspace("session-ui-explicit");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          ui: {
            quietStartup: false,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await createBrewvaSession({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    try {
      expect(result.runtime.config.ui.quietStartup).toBe(false);
      expect(result.session.settingsManager.getQuietStartup()).toBe(false);
    } finally {
      result.session.dispose();
    }
  });

  test("preserves runtime ui defaults when config only changes skills routing", async () => {
    const workspace = createTestWorkspace("session-ui-default");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              scopes: ["core", "domain", "operator"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await createBrewvaSession({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    try {
      expect(result.runtime.config.ui.quietStartup).toBe(true);
      expect(result.session.settingsManager.getQuietStartup()).toBe(true);
    } finally {
      result.session.dispose();
    }
  });

  test("session_bootstrap payload records routing load report", async () => {
    const workspace = createTestWorkspace("session-ui-skill-load-report");
    writeSkill(join(workspace, ".brewva/skills/operator/custom-ops/SKILL.md"), "custom-ops");

    const result = await createBrewvaSession({
      cwd: workspace,
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            skillLoad?: {
              routingEnabled?: boolean;
              routingScopes?: string[];
              routableSkills?: string[];
              hiddenSkills?: string[];
            };
          }
        | undefined) ?? { skillLoad: {} };

      expect(payload.skillLoad?.routingEnabled).toBe(false);
      expect(payload.skillLoad?.routingScopes).toEqual(["core", "domain"]);
      expect(payload.skillLoad?.routableSkills).toEqual([]);
      expect(payload.skillLoad?.hiddenSkills).toContain("custom-ops");
    } finally {
      result.session.dispose();
    }
  });

  test("routingScopes option overrides skill routing exposure", async () => {
    const workspace = createTestWorkspace("session-ui-skill-routing-override");
    writeSkill(join(workspace, ".brewva/skills/operator/custom-ops/SKILL.md"), "custom-ops");

    const result = await createBrewvaSession({
      cwd: workspace,
      routingScopes: ["core", "domain", "operator"],
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            skillLoad?: {
              routingEnabled?: boolean;
              routingScopes?: string[];
              routableSkills?: string[];
            };
          }
        | undefined) ?? { skillLoad: {} };

      expect(payload.skillLoad?.routingEnabled).toBe(true);
      expect(payload.skillLoad?.routingScopes).toEqual(["core", "domain", "operator"]);
      expect(payload.skillLoad?.routableSkills).toContain("custom-ops");
    } finally {
      result.session.dispose();
    }
  });

  test("session bootstrap no longer exposes removed skill-broker metadata", async () => {
    const workspace = createTestWorkspace("session-ui-skill-broker-bootstrap");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              enabled: true,
              scopes: ["core", "domain"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const result = await createBrewvaSession({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            skillBroker?: unknown;
            skillLoad?: {
              routingEnabled?: boolean;
              routingScopes?: string[];
            };
          }
        | undefined) ?? { skillLoad: {} };
      expect(payload.skillBroker).toBeUndefined();
      expect(payload.skillLoad?.routingEnabled).toBe(true);
      expect(payload.skillLoad?.routingScopes).toEqual(["core", "domain"]);
    } finally {
      result.session.dispose();
    }
  });

  test("no-extensions session bootstrap does not reintroduce removed skill-broker metadata", async () => {
    const workspace = createTestWorkspace("session-ui-skill-broker-no-extensions");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const result = await createBrewvaSession({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      enableExtensions: false,
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            extensionsEnabled?: boolean;
            skillBroker?: unknown;
            skillLoad?: {
              routingEnabled?: boolean;
            };
          }
        | undefined) ?? { extensionsEnabled: true, skillLoad: {} };
      expect(payload.extensionsEnabled).toBe(false);
      expect(payload.skillBroker).toBeUndefined();
      expect(payload.skillLoad?.routingEnabled).toBe(true);
    } finally {
      result.session.dispose();
    }
  });
});
