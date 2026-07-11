import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import {
  loadBrewvaConfig,
  loadBrewvaConfigResolution,
  resolveGlobalBrewvaConfigPath,
} from "@brewva/brewva-runtime/config";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("Brewva config loader normalization", () => {
  test("fails fast on unknown removed context-budget fields", () => {
    const workspace = createTestWorkspace("config-schema-invalid");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            contextBudget: {
              truncationStrategy: "invalid_strategy",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("strips removed legacy context-budget keys from direct runtime config", () => {
    const legacyCases = [
      { key: "hardLimitPercent", value: 0.9 },
      { key: "compactionThresholdPercent", value: 0.85 },
      { key: "maxInjectionTokens", value: 2400 },
      { key: "arena", value: { enabled: true } },
    ] as const;

    for (const legacyCase of legacyCases) {
      const workspace = createTestWorkspace(`legacy-context-budget-${legacyCase.key}`);
      const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
      config["infrastructure"] = {
        ...DEFAULT_BREWVA_CONFIG.infrastructure,
        contextBudget: {
          ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
          [legacyCase.key]: legacyCase.value,
        },
      };

      const runtime = createRuntimeInstanceFixture({
        cwd: workspace,
        config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
      });
      const contextBudget = runtime.config.infrastructure.contextBudget as unknown as Record<
        string,
        unknown
      >;
      expect(contextBudget[legacyCase.key]).toBe(undefined);
    }
  });

  test("strips withdrawn compaction shrink-guard keys from direct runtime config", () => {
    const withdrawnCases = [
      { key: "minCompactionShrinkRatio", value: 0.1 },
      { key: "minCompactionShrinkAttempts", value: 1 },
    ] as const;

    for (const withdrawnCase of withdrawnCases) {
      const workspace = createTestWorkspace(`withdrawn-compaction-${withdrawnCase.key}`);
      const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
      config["infrastructure"] = {
        ...DEFAULT_BREWVA_CONFIG.infrastructure,
        contextBudget: {
          ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
          compaction: {
            ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget.compaction,
            [withdrawnCase.key]: withdrawnCase.value,
          },
        },
      };

      const runtime = createRuntimeInstanceFixture({
        cwd: workspace,
        config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
      });
      const compaction = runtime.config.infrastructure.contextBudget
        .compaction as unknown as Record<string, unknown>;
      expect(compaction[withdrawnCase.key]).toBe(undefined);
    }
  });

  test("fails fast when removed tool-output distillation injection config is present", () => {
    const workspace = createTestWorkspace("removed-tool-output-distillation-injection");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["infrastructure"] = {
      ...DEFAULT_BREWVA_CONFIG.infrastructure,
      toolOutputDistillationInjection: {
        enabled: true,
      },
    };

    expect(() =>
      createRuntimeInstanceFixture({
        cwd: workspace,
        config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
      }),
    ).toThrow(/unknown property "toolOutputDistillationInjection"/);
  });

  test("strips removed adaptive projection fields from config files with a warning", () => {
    const workspace = createTestWorkspace("config-removed-projection-fields");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          projection: {
            recallMode: "always",
            cognitive: {
              mode: "shadow",
            },
            global: {
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(resolution.warnings[0]?.message).toMatch(/projection\.recallMode has been removed/);
    const projection = resolution.config.projection as unknown as Record<string, unknown>;
    expect(projection.recallMode).toBe(undefined);
    expect(projection.cognitive).toBe(undefined);
    expect(projection.global).toBe(undefined);
  });

  test("fails fast when legacy top-level memory config is present", () => {
    const workspace = createTestWorkspace("legacy-memory-top-level");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            enabled: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /unknown property "memory"/,
    );
  });

  test("fails fast when an unknown infrastructure section is present in a file", () => {
    const workspace = createTestWorkspace("unknown-infrastructure-file");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            unexpectedInfrastructureField: {
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /unknown property "unexpectedInfrastructureField"/,
    );
  });

  test("fails fast when an unknown infrastructure section is passed directly", () => {
    const workspace = createTestWorkspace("unknown-infrastructure-direct");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["infrastructure"] = {
      ...DEFAULT_BREWVA_CONFIG.infrastructure,
      unexpectedInfrastructureField: {
        enabled: true,
      },
    };

    expect(() =>
      createRuntimeInstanceFixture({
        cwd: workspace,
        config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
      }),
    ).toThrow(/unknown property "unexpectedInfrastructureField"/);
  });

  test("normalizes minimal projection config fields deterministically", () => {
    const workspace = createTestWorkspace("projection-minimal");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          projection: {
            enabled: true,
            dir: "  .orchestrator/projection-custom  ",
            workingFile: "  working-custom.md  ",
            maxWorkingChars: 2400.9,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.projection.enabled).toBe(true);
    expect(loaded.projection.dir).toBe(".orchestrator/projection-custom");
    expect(loaded.projection.workingFile).toBe("working-custom.md");
    expect(loaded.projection.maxWorkingChars).toBe(2400);
  });

  test("normalizes canonical tape directory separately from legacy event logs", () => {
    const workspace = createTestWorkspace("canonical-tape-dir-config");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          tape: {
            enabled: false,
            dir: "  .brewva/canonical-tape  ",
            checkpointIntervalEntries: 42.9,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });

    expect(loaded.tape.enabled).toBe(false);
    expect(loaded.tape.dir).toBe(".brewva/canonical-tape");
    expect(loaded.tape.checkpointIntervalEntries).toBe(42);
  });

  test("normalizes contracted context budget tuning", () => {
    const workspace = createTestWorkspace("contracted-context-budget");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            contextBudget: {
              thresholds: {
                hardRatio: 0.7,
                advisoryRatio: 0.9,
                headroomTokens: 0,
              },
              dynamicTailTokens: 320,
              predictedTurnGrowthTokens: -1,
              providerCacheStalenessMs: 60_000,
              consequenceDigestMaxChars: 240,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.infrastructure.contextBudget.thresholds.hardRatio).toBe(0.7);
    expect(loaded.infrastructure.contextBudget.thresholds.advisoryRatio).toBe(0.7);
    expect(loaded.infrastructure.contextBudget.thresholds.headroomTokens).toBe(0);
    expect(loaded.infrastructure.contextBudget.dynamicTailTokens).toBe(320);
    expect(loaded.infrastructure.contextBudget.predictedTurnGrowthTokens).toBe(0);
    expect(loaded.infrastructure.contextBudget.providerCacheStalenessMs).toBe(60_000);
    expect(loaded.infrastructure.contextBudget.consequenceDigestMaxChars).toBe(240);
  });

  test("normalizes MCP integration config", () => {
    const workspace = createTestWorkspace("mcp-integration-config");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          integrations: {
            mcp: {
              enabled: true,
              servers: [
                {
                  id: "repo",
                  enabled: true,
                  transport: "stdio",
                  command: "bunx",
                  args: ["@modelcontextprotocol/server-filesystem", "."],
                  env: {
                    MCP_LOG_LEVEL: "info",
                  },
                  envAllowlist: ["PATH"],
                  inheritEnv: false,
                  timeoutMs: 5000,
                  includeToolNames: ["search"],
                  toolPolicies: {
                    search: {
                      actionClass: "workspace_read",
                      surface: "base",
                    },
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.integrations.mcp).toEqual({
      enabled: true,
      servers: [
        {
          id: "repo",
          enabled: true,
          transport: "stdio",
          command: "bunx",
          args: ["@modelcontextprotocol/server-filesystem", "."],
          env: {
            MCP_LOG_LEVEL: "info",
          },
          envAllowlist: ["PATH"],
          inheritEnv: false,
          timeoutMs: 5000,
          includeToolNames: ["search"],
          toolPolicies: {
            search: {
              actionClass: "workspace_read",
              surface: "base",
            },
          },
        },
      ],
    });
  });

  test("fails fast on invalid MCP config", () => {
    const workspace = createTestWorkspace("mcp-invalid-config");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          integrations: {
            mcp: {
              enabled: true,
              servers: [
                {
                  id: "repo",
                  command: "bunx",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /transport/,
    );
  });

  test("fails fast on a wildcard MCP includeToolNames entry", () => {
    const workspace = createTestWorkspace("mcp-wildcard-include-tool-names");
    // A schema-valid server (the loader validates the schema before normalizing); the
    // wildcard is a semantic footgun the schema cannot catch, so normalization rejects it.
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.integrations.mcp.enabled = true;
    config.integrations.mcp.servers = [
      {
        id: "repo",
        enabled: true,
        transport: "stdio",
        command: "bunx",
        args: [],
        env: {},
        envAllowlist: [],
        inheritEnv: false,
        timeoutMs: 30_000,
        includeToolNames: ["*"],
        toolPolicies: {},
      },
    ];
    writeFileSync(join(workspace, ".brewva/brewva.json"), JSON.stringify(config, null, 2), "utf8");

    // "*" looks like wildcard-allow but exposes none (it matches only a tool named "*");
    // the loader rejects it rather than silently adopting that footgun.
    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /includeToolNames/,
    );
  });

  test("fails fast on duplicate MCP server ids in direct runtime config", () => {
    const workspace = createTestWorkspace("mcp-duplicate-server-ids");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.integrations.mcp.enabled = true;
    config.integrations.mcp.servers = [
      {
        id: "repo",
        enabled: true,
        transport: "stdio",
        command: "bunx",
        args: [],
        env: {},
        envAllowlist: [],
        inheritEnv: false,
        timeoutMs: 30_000,
        includeToolNames: [],
        toolPolicies: {},
      },
      {
        id: "repo",
        enabled: true,
        transport: "streamable_http",
        url: "http://localhost:3333/mcp",
        headers: {},
        timeoutMs: 30_000,
        includeToolNames: [],
        toolPolicies: {},
      },
    ];

    expect(() => createRuntimeInstanceFixture({ cwd: workspace, config })).toThrow(
      /duplicate server id "repo"/,
    );
  });

  test("accepts JSONC comments and trailing commas in config files", () => {
    const workspace = createTestWorkspace("config-jsonc");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      [
        "{",
        "  // workspace-local capability catalog override",
        '  "capabilities": {',
        '    "roots": ["./capabilities",],',
        "    },",
        "}",
      ].join("\n"),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.capabilities.roots).toEqual(["./capabilities"]);
  });

  test("fails fast when an action admission override exceeds the action class maximum", () => {
    const workspace = createTestWorkspace("action-admission-override-too-relaxed");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          security: {
            actionAdmissionOverrides: {
              credential_access: "allow",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /security\.actionAdmissionOverrides\.credential_access cannot relax beyond max admission 'ask'/,
    );
  });

  test("fails fast on direct runtime config when an action admission override is too relaxed", () => {
    const workspace = createTestWorkspace("direct-action-admission-override-too-relaxed");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.security.actionAdmissionOverrides = {
      credential_access: "allow",
    };

    expect(() => createRuntimeInstanceFixture({ cwd: workspace, config })).toThrow(
      /security\.actionAdmissionOverrides\.credential_access cannot relax beyond max admission 'ask'/,
    );
  });

  test("honors a valid unattendedApproval envelope from a config OUTSIDE the workspace", () => {
    const workspace = createTestWorkspace("unattended-approval-operator-source");
    // The operator config lives OUTSIDE the model-writable workspace, so the
    // operator-source barrier honors it.
    const operatorDir = mkdtempSync(join(tmpdir(), "brewva-operator-config-"));
    const operatorConfigPath = join(operatorDir, "brewva.json");
    writeFileSync(
      operatorConfigPath,
      JSON.stringify(
        { security: { unattendedApproval: { local_exec: "allow", external_network: "deny" } } },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: operatorConfigPath });
    expect(loaded.security.unattendedApproval).toEqual({
      local_exec: "allow",
      external_network: "deny",
    });
  });

  test("strips a workspace-internal unattendedApproval as model-writable (operator-source barrier)", () => {
    const workspace = createTestWorkspace("unattended-approval-workspace-internal");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        { security: { unattendedApproval: { local_exec: "allow", external_network: "deny" } } },
        null,
        2,
      ),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    // A model with workspace-write could otherwise widen its own envelope; the
    // in-workspace policy is dropped to empty (suspend-everything) with a warning.
    expect(resolution.config.security.unattendedApproval).toEqual({});
    expect(resolution.warnings.map((warning) => warning.code)).toContain(
      "config_workspace_unattended_approval_stripped",
    );
  });

  test("defaults security.unattendedApproval to an empty (suspend-everything) policy", () => {
    const workspace = createTestWorkspace("unattended-approval-default");
    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.security.unattendedApproval).toEqual({});
  });

  test("an operator-source unattendedApproval still fails fast on an unknown effect class", () => {
    const workspace = createTestWorkspace("unattended-approval-bad-class");
    // Out-of-workspace (operator) source, so the barrier does not strip it and
    // normalization's fail-loud-on-typo guard is reached.
    const operatorDir = mkdtempSync(join(tmpdir(), "brewva-operator-config-"));
    const operatorConfigPath = join(operatorDir, "brewva.json");
    writeFileSync(
      operatorConfigPath,
      JSON.stringify(
        { security: { unattendedApproval: { not_an_effect_class: "allow" } } },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: operatorConfigPath })).toThrow(
      /unattendedApproval/,
    );
  });

  test("fails fast on an invalid security.unattendedApproval decision value", () => {
    const workspace = createTestWorkspace("unattended-approval-bad-value");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    (config.security.unattendedApproval as Record<string, unknown>).local_exec = "ask";

    // The schema (enum allow|deny) is the first fail-closed gate; it rejects the
    // invalid value before normalization's defense-in-depth throw is reached.
    expect(() => createRuntimeInstanceFixture({ cwd: workspace, config })).toThrow(
      /unattendedApproval\/local_exec/,
    );
  });

  test("loads the project config from workspace root when running from a nested cwd inside a repo", () => {
    const workspace = createTestWorkspace("workspace-root-config");
    const nestedCwd = join(workspace, "packages", "api");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            roots: ["./skills"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(join(workspace, ".git"), "", "utf8");

    const loaded = loadBrewvaConfig({ cwd: nestedCwd });
    expect(loaded.skills.roots).toEqual([join(workspace, ".brewva/skills")]);
  });

  test("rejects null session cost cap now that zero is the only unlimited sentinel", () => {
    const workspace = createTestWorkspace("cost-cap-null-sentinel");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            costTracking: {
              maxCostUsdPerSession: null,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /maxCostUsdPerSession/,
    );
  });

  test("strips removed skills.selector config with a warning", () => {
    const workspace = createTestWorkspace("selector-config-removed");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            selector: {
              mode: "llm_auto",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(resolution.warnings[0]?.message).toMatch(/skills\.selector has been removed/);
    expect((resolution.config.skills as unknown as Record<string, unknown>).selector).toBe(
      undefined,
    );
  });

  test("strips removed skills.routing continuity override config with a warning", () => {
    const workspace = createTestWorkspace("routing-continuity-config-removed");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              continuityPhrases: ["keep going"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(resolution.warnings[0]?.message).toMatch(/skills\.routing has been removed/);
    expect((resolution.config.skills as unknown as Record<string, unknown>).routing).toBe(
      undefined,
    );
  });

  test("returns isolated config instances", () => {
    const workspace = createTestWorkspace("isolation");
    const first = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const second = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });

    expect(first).not.toBe(second);
    first.projection.maxWorkingChars = 9999;
    expect(second.projection.maxWorkingChars).toBe(
      DEFAULT_BREWVA_CONFIG.projection.maxWorkingChars,
    );
  });

  test("defaults exec routing to stateful box and network allowlist", () => {
    const workspace = createTestWorkspace("exec-fail-closed-defaults");
    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });

    expect(loaded.security.execution.backend).toBe("box");
    expect(loaded.security.execution.box.network.mode).toBe("off");
    expect(loaded.security.boundaryPolicy.network.mode).toBe("allowlist");
  });

  test("resolves global config path", () => {
    const resolved = resolveGlobalBrewvaConfigPath();
    expect(typeof resolved).toBe("string");
    expect(resolved.endsWith("brewva/brewva.json")).toBe(true);
  });

  test("strips security.execution.commandDenyList from config files with a warning", () => {
    const workspace = createTestWorkspace("execution-command-deny-list-present");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          security: {
            execution: {
              commandDenyList: ["node"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(resolution.warnings[0]?.message).toMatch(
      /security\.execution\.commandDenyList must not appear in active config/,
    );
    expect(
      (resolution.config.security.execution as unknown as Record<string, unknown>).commandDenyList,
    ).toBe(undefined);
  });

  test("strips removed security.execution.sandbox from config files with a warning", () => {
    const workspace = createTestWorkspace("inline-sandbox-present");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          security: {
            execution: {
              sandbox: {},
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(resolution.warnings[0]?.message).toMatch(
      /security\.execution\.sandbox has been removed/,
    );
    expect(
      (resolution.config.security.execution as unknown as Record<string, unknown>).sandbox,
    ).toBe(undefined);
  });

  test("strips removed security.credentials.sandboxApiKeyRef with a warning", () => {
    const workspace = createTestWorkspace("sandbox-api-key-ref-present");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          security: {
            credentials: {
              sandboxApiKeyRef: "vault://sandbox/apiKey",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(resolution.warnings[0]?.message).toMatch(
      /security\.credentials\.sandboxApiKeyRef has been removed/,
    );
    expect(
      (resolution.config.security.credentials as unknown as Record<string, unknown>)
        .sandboxApiKeyRef,
    ).toBe(undefined);
  });

  test("strips legacy context-budget keys from config files with a warning", () => {
    const workspace = createTestWorkspace("file-legacy-context-budget");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            contextBudget: {
              hardLimitPercent: 0.9,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(resolution.warnings[0]?.message).toMatch(
      /infrastructure\.contextBudget\.hardLimitPercent has been removed/,
    );
    expect(
      (resolution.config.infrastructure.contextBudget as unknown as Record<string, unknown>)
        .hardLimitPercent,
    ).toBe(undefined);
  });

  test("strips security.execution.commandDenyList from direct runtime config", () => {
    const workspace = createTestWorkspace("direct-runtime-command-deny-list");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["security"] = {
      ...DEFAULT_BREWVA_CONFIG.security,
      execution: {
        ...DEFAULT_BREWVA_CONFIG.security.execution,
        commandDenyList: ["node"],
      },
    };

    const runtime = createRuntimeInstanceFixture({
      cwd: workspace,
      config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
    });
    expect(
      (runtime.config.security.execution as unknown as Record<string, unknown>).commandDenyList,
    ).toBe(undefined);
  });

  test("strips removed security.execution.sandbox from direct runtime config", () => {
    const workspace = createTestWorkspace("direct-runtime-inline-sandbox");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["security"] = {
      ...DEFAULT_BREWVA_CONFIG.security,
      execution: {
        ...DEFAULT_BREWVA_CONFIG.security.execution,
        sandbox: {},
      },
    };

    const runtime = createRuntimeInstanceFixture({
      cwd: workspace,
      config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
    });
    expect((runtime.config.security.execution as unknown as Record<string, unknown>).sandbox).toBe(
      undefined,
    );
  });

  test("strips removed skills.selector from direct runtime config", () => {
    const workspace = createTestWorkspace("direct-runtime-skills-selector-removed");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["skills"] = {
      ...DEFAULT_BREWVA_CONFIG.skills,
      selector: {
        mode: "llm_auto",
      },
    };

    const runtime = createRuntimeInstanceFixture({
      cwd: workspace,
      config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
    });
    expect((runtime.config.skills as unknown as Record<string, unknown>).selector).toBe(undefined);
  });

  test("strips removed skills.routing continuity overrides from direct runtime config", () => {
    const workspace = createTestWorkspace("direct-runtime-routing-continuity-removed");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["skills"] = {
      ...DEFAULT_BREWVA_CONFIG.skills,
      routing: {
        continuityPhrases: ["keep going"],
      },
    };

    const runtime = createRuntimeInstanceFixture({
      cwd: workspace,
      config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
    });
    expect((runtime.config.skills as unknown as Record<string, unknown>).routing).toBe(undefined);
  });

  test("strips removed skills.cascade from direct runtime config", () => {
    const workspace = createTestWorkspace("direct-runtime-skills-cascade-removed");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["skills"] = {
      ...DEFAULT_BREWVA_CONFIG.skills,
      cascade: {
        enabled: true,
      },
    };

    const runtime = createRuntimeInstanceFixture({
      cwd: workspace,
      config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
    });
    expect((runtime.config.skills as unknown as Record<string, unknown>).cascade).toBe(undefined);
  });
});
