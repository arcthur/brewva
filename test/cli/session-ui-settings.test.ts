import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaSession } from "@brewva/brewva-cli";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-session-ui-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("brewva session ui settings wiring", () => {
  test("given agentId option, when creating brewva session, then runtime identity agent id is normalized", async () => {
    const workspace = createWorkspace("agent-id");
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

  test("given ui quietStartup override in config, when creating brewva session, then runtime and session settings apply override", async () => {
    const workspace = createWorkspace("explicit");
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
      const activeTools = result.session.getActiveToolNames();
      expect(result.runtime.config.ui.quietStartup).toBe(false);
      expect(result.session.settingsManager.getQuietStartup()).toBe(false);
      expect(activeTools.includes("exec")).toBe(true);
      expect(activeTools.includes("process")).toBe(true);
    } finally {
      result.session.dispose();
    }
  });

  test("given config without ui override, when creating brewva session, then runtime ui defaults are preserved", async () => {
    const workspace = createWorkspace("default");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            packs: ["typescript", "react", "bun"],
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
      const activeTools = result.session.getActiveToolNames();
      expect(result.runtime.config.ui.quietStartup).toBe(true);
      expect(result.session.settingsManager.getQuietStartup()).toBe(true);
      expect(activeTools.includes("exec")).toBe(true);
      expect(activeTools.includes("process")).toBe(true);
    } finally {
      result.session.dispose();
    }
  });

  test("session_bootstrap payload includes skipped skill packs filtered by skills.packs", async () => {
    const workspace = createWorkspace("skill-load-report");
    mkdirSync(join(workspace, ".brewva/skills/packs/custom-pack"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/packs/custom-pack/SKILL.md"),
      [
        "---",
        "name: custom-pack-skill",
        "description: custom",
        "tags: [custom]",
        "tools:",
        "  required: [read]",
        "  optional: []",
        "  denied: []",
        "budget:",
        "  max_tool_calls: 5",
        "  max_tokens: 2000",
        "outputs: []",
        "consumes: []",
        "---",
        "# custom-pack-skill",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            packs: ["skill-creator"],
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
            skillLoad?: {
              skippedPacks?: Array<{ pack?: string }>;
            };
          }
        | undefined) ?? { skillLoad: { skippedPacks: [] } };
      const skippedPacks = payload.skillLoad?.skippedPacks ?? [];
      expect(skippedPacks.some((entry) => entry.pack === "custom-pack")).toBe(true);
    } finally {
      result.session.dispose();
    }
  });

  test("activePacks option merges with configured skills.packs instead of replacing it", async () => {
    const workspace = createWorkspace("skill-pack-merge");
    mkdirSync(join(workspace, ".brewva/skills/packs/custom-pack"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/packs/custom-pack/SKILL.md"),
      [
        "---",
        "name: custom-pack-skill-merge",
        "description: custom merge",
        "tags: [custom]",
        "tools:",
        "  required: [read]",
        "  optional: []",
        "  denied: []",
        "budget:",
        "  max_tool_calls: 5",
        "  max_tokens: 2000",
        "outputs: []",
        "consumes: []",
        "---",
        "# custom-pack-skill-merge",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            packs: ["skill-creator"],
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
      activePacks: ["custom-pack"],
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
              activePacks?: string[];
            };
          }
        | undefined) ?? { skillLoad: { activePacks: [] } };
      const activePacks = payload.skillLoad?.activePacks ?? [];
      expect(activePacks).toEqual(expect.arrayContaining(["skill-creator", "custom-pack"]));
    } finally {
      result.session.dispose();
    }
  });

  test("session bootstrap records external_only selector mode and configured broker judge mode", async () => {
    const workspace = createWorkspace("skill-broker-selector-mode");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            selector: {
              brokerJudgeMode: "llm",
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
      expect(result.runtime.config.skills.selector.mode).toBe("external_only");
      expect(result.runtime.config.skills.selector.brokerJudgeMode).toBe("llm");
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            skillBroker?: {
              enabled?: boolean;
              selectorMode?: string;
              judgeMode?: string;
            };
          }
        | undefined) ?? { skillBroker: { enabled: false } };
      expect(payload.skillBroker?.enabled).toBe(true);
      expect(payload.skillBroker?.selectorMode).toBe("external_only");
      expect(payload.skillBroker?.judgeMode).toBe("llm");
    } finally {
      result.session.dispose();
    }
  });

  test("no-extensions session bootstrap still enables broker with heuristic judge by default", async () => {
    const workspace = createWorkspace("skill-broker-no-extensions");
    const result = await createBrewvaSession({
      cwd: workspace,
      enableExtensions: false,
    });
    try {
      expect(result.runtime.config.skills.selector.mode).toBe("external_only");
      expect(result.runtime.config.skills.selector.brokerJudgeMode).toBe("heuristic");
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            extensionsEnabled?: boolean;
            skillBroker?: {
              enabled?: boolean;
              selectorMode?: string;
              judgeMode?: string;
            };
          }
        | undefined) ?? { extensionsEnabled: true, skillBroker: { enabled: false } };
      expect(payload.extensionsEnabled).toBe(false);
      expect(payload.skillBroker?.enabled).toBe(true);
      expect(payload.skillBroker?.selectorMode).toBe("external_only");
      expect(payload.skillBroker?.judgeMode).toBe("heuristic");
    } finally {
      result.session.dispose();
    }
  });
});
