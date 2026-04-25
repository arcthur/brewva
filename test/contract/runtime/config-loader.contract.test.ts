import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  loadBrewvaConfig,
  loadBrewvaConfigResolution,
  resolveGlobalBrewvaConfigPath,
} from "@brewva/brewva-runtime";
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

  test("fails fast on replaced legacy context-budget keys for direct runtime config", () => {
    const legacyCases = [
      {
        key: "hardLimitPercent",
        value: 0.9,
      },
      {
        key: "compactionThresholdPercent",
        value: 0.85,
      },
      {
        key: "maxInjectionTokens",
        value: 2400,
      },
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

      expect(
        () =>
          new BrewvaRuntime({
            cwd: workspace,
            config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
          }),
      ).toThrow(new RegExp(`infrastructure\\.contextBudget\\.${legacyCase.key} has been replaced`));
    }
  });

  test("fails fast when removed adaptive projection fields are present", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /projection\.recallMode has been removed/,
    );
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

    expect(
      () =>
        new BrewvaRuntime({
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

  test("normalizes skills.routing scopes", () => {
    const workspace = createTestWorkspace("routing-scopes");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              scopes: ["domain", "operator", "domain"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.skills.routing.scopes).toEqual(["domain", "operator"]);
  });

  test("tracks explicit routing intent separately from normalized routing defaults", () => {
    const workspace = createTestWorkspace("routing-intent-metadata");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              scopes: ["operator"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfigResolution({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    });
    expect(loaded.config.skills.routing.enabled).toBe(false);
    expect(loaded.config.skills.routing.scopes).toEqual(["operator"]);
    expect(loaded.metadata.skills.routing.enabledExplicit).toBe(false);
    expect(loaded.metadata.skills.routing.scopesExplicit).toBe(true);
  });

  test("routingDefaultScopes enables routing when config leaves enabled unset", () => {
    const workspace = createTestWorkspace("routing-default-scopes-enable-when-unset");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              scopes: ["operator"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      routingDefaultScopes: ["core", "domain"],
    });
    expect(runtime.config.skills.routing.enabled).toBe(true);
    expect(runtime.config.skills.routing.scopes).toEqual(["operator"]);
  });

  test("routingDefaultScopes respects explicit routing disable", () => {
    const workspace = createTestWorkspace("routing-default-scopes-explicit-disable");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              enabled: false,
              scopes: ["operator"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      routingDefaultScopes: ["core", "domain"],
    });
    expect(runtime.config.skills.routing.enabled).toBe(false);
    expect(runtime.config.skills.routing.scopes).toEqual(["operator"]);
  });

  test("routingScopes remains a hard override over explicit routing disable", () => {
    const workspace = createTestWorkspace("routing-hard-override-explicit-disable");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              enabled: false,
              scopes: ["operator"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      routingScopes: ["meta"],
      routingDefaultScopes: ["core", "domain"],
    });
    expect(runtime.config.skills.routing.enabled).toBe(true);
    expect(runtime.config.skills.routing.scopes).toEqual(["meta"]);
  });

  test("accepts JSONC comments and trailing commas in config files", () => {
    const workspace = createTestWorkspace("config-jsonc");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      [
        "{",
        "  // workspace-local routing override",
        '  "skills": {',
        '    "routing": {',
        '      "scopes": ["domain", "operator",],',
        "    },",
        "  },",
        "}",
      ].join("\n"),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.skills.routing.scopes).toEqual(["domain", "operator"]);
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

    expect(() => new BrewvaRuntime({ cwd: workspace, config })).toThrow(
      /security\.actionAdmissionOverrides\.credential_access cannot relax beyond max admission 'ask'/,
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
            routing: {
              scopes: ["operator"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(join(workspace, ".git"), "", "utf8");

    const loaded = loadBrewvaConfig({ cwd: nestedCwd });
    expect(loaded.skills.routing.scopes).toEqual(["operator"]);
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

  test("fails fast on removed skills.selector config", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /skills\.selector has been removed/,
    );
  });

  test("fails fast on removed skills.routing continuity override config", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /skills\.routing\.continuityPhrases has been removed/,
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

  test("fails fast when security.execution.commandDenyList is present in config files", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /security\.execution\.commandDenyList must not appear in active config/,
    );
  });

  test("fails fast when removed security.execution.sandbox is present in config files", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /security\.execution\.sandbox has been removed/,
    );
  });

  test("fails fast when removed security.credentials.sandboxApiKeyRef is present", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /security\.credentials\.sandboxApiKeyRef has been removed/,
    );
  });

  test("fails fast when legacy context-budget keys are present in config files", () => {
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

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /infrastructure\.contextBudget\.hardLimitPercent has been replaced/,
    );
  });

  test("fails fast on direct runtime config when security.execution.commandDenyList appears", () => {
    const workspace = createTestWorkspace("direct-runtime-command-deny-list");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["security"] = {
      ...DEFAULT_BREWVA_CONFIG.security,
      execution: {
        ...DEFAULT_BREWVA_CONFIG.security.execution,
        commandDenyList: ["node"],
      },
    };

    expect(
      () =>
        new BrewvaRuntime({
          cwd: workspace,
          config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
        }),
    ).toThrow(/security\.execution\.commandDenyList must not appear in active config/);
  });

  test("fails fast on direct runtime config when removed security.execution.sandbox appears", () => {
    const workspace = createTestWorkspace("direct-runtime-inline-sandbox");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["security"] = {
      ...DEFAULT_BREWVA_CONFIG.security,
      execution: {
        ...DEFAULT_BREWVA_CONFIG.security.execution,
        sandbox: {},
      },
    };

    expect(
      () =>
        new BrewvaRuntime({
          cwd: workspace,
          config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
        }),
    ).toThrow(/security\.execution\.sandbox has been removed/);
  });

  test("fails fast on direct runtime config when removed skills.selector appears", () => {
    const workspace = createTestWorkspace("direct-runtime-skills-selector-removed");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["skills"] = {
      ...DEFAULT_BREWVA_CONFIG.skills,
      selector: {
        mode: "llm_auto",
      },
    };

    expect(
      () =>
        new BrewvaRuntime({
          cwd: workspace,
          config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
        }),
    ).toThrow(/skills\.selector has been removed/);
  });

  test("fails fast on direct runtime config when removed skills.routing continuity overrides appear", () => {
    const workspace = createTestWorkspace("direct-runtime-routing-continuity-removed");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["skills"] = {
      ...DEFAULT_BREWVA_CONFIG.skills,
      routing: {
        ...DEFAULT_BREWVA_CONFIG.skills.routing,
        continuityPhrases: ["keep going"],
      },
    };

    expect(
      () =>
        new BrewvaRuntime({
          cwd: workspace,
          config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
        }),
    ).toThrow(/skills\.routing\.continuityPhrases has been removed/);
  });

  test("fails fast on direct runtime config when removed skills.cascade appears", () => {
    const workspace = createTestWorkspace("direct-runtime-skills-cascade-removed");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
    config["skills"] = {
      ...DEFAULT_BREWVA_CONFIG.skills,
      cascade: {
        enabled: true,
      },
    };

    expect(
      () =>
        new BrewvaRuntime({
          cwd: workspace,
          config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
        }),
    ).toThrow(/skills\.cascade has been removed/);
  });
});
