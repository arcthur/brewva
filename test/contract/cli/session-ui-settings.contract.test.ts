import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHostedSession as createBrewvaSession } from "@brewva/brewva-gateway/hosted";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { createTrustedLocalGovernancePort } from "@brewva/brewva-runtime/governance";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("brewva session ui settings wiring", () => {
  test("normalizes agentId into runtime identity", async () => {
    const workspace = createTestWorkspace("session-ui-agent-id");
    const result = await createBrewvaSession({
      cwd: workspace,
      agentId: "Code Reviewer",
    });
    try {
      expect(result.runtime.identity.agentId).toBe("code-reviewer");
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

  test("session_bootstrap omits removed skill-load routing metadata", async () => {
    const workspace = createTestWorkspace("session-ui-no-skill-load-report");

    const result = await createBrewvaSession({
      cwd: workspace,
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.inspect.events.records.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload =
        (bootstrap?.payload as
          | {
              runtimeConfig?: {
                artifactRoots?: {
                  eventsDir?: string;
                  recoveryWalDir?: string;
                };
              };
              skillLoad?: unknown;
            }
          | undefined) ?? {};

      expect(payload.skillLoad).toBeUndefined();
      expect(payload.runtimeConfig?.artifactRoots?.eventsDir).toBe(".orchestrator/events");
      expect(payload.runtimeConfig?.artifactRoots?.recoveryWalDir).toBe(
        ".orchestrator/recovery-wal",
      );
    } finally {
      result.session.dispose();
    }
  });

  test("existing runtimes reject routingDefaultScopes inference", async () => {
    const workspace = createTestWorkspace("session-ui-routing-default-scopes-existing-runtime");
    const runtime = createBrewvaRuntime({
      cwd: workspace,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
    }).hosted;

    return expect(
      createBrewvaSession({
        runtime,
        cwd: workspace,
        routingDefaultScopes: ["core", "domain"],
      }),
    ).rejects.toThrow(/routingDefaultScopes must be applied when calling createBrewvaRuntime/);
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
      const bootstrap = result.runtime.inspect.events.records.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload =
        (bootstrap?.payload as
          | {
              skillBroker?: unknown;
              skillLoad?: unknown;
            }
          | undefined) ?? {};
      expect(payload.skillBroker).toBeUndefined();
      expect(payload.skillLoad).toBeUndefined();
    } finally {
      result.session.dispose();
    }
  });

  test("direct managed tools session bootstrap does not reintroduce removed skill-broker metadata", async () => {
    const workspace = createTestWorkspace("session-ui-skill-broker-direct-tools");
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
      managedToolMode: "direct",
    });
    try {
      const sessionId = result.session.sessionManager.getSessionId();
      const bootstrap = result.runtime.inspect.events.records.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      const payload = (bootstrap?.payload as
        | {
            managedToolMode?: "hosted" | "direct";
            skillBroker?: unknown;
            skillLoad?: unknown;
          }
        | undefined) ?? { managedToolMode: "hosted" };
      expect(payload.managedToolMode).toBe("direct");
      expect(payload.skillBroker).toBeUndefined();
      expect(payload.skillLoad).toBeUndefined();
    } finally {
      result.session.dispose();
    }
  });
});
