import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialVaultService } from "@brewva/brewva-runtime";
import { runCliSync } from "../../helpers/cli.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function writeInvalidTelegramConfig(workspace: string): void {
  const configDir = join(workspace, ".brewva");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "brewva.json"),
    JSON.stringify(
      {
        channels: {
          telegram: {
            skillPolicy: {
              behaviorSkillName: "telegram-behavior-v2",
              interactiveSkillName: "telegram-ui-v2",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeInvalidExecutionConfig(workspace: string): void {
  const configDir = join(workspace, ".brewva");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "brewva.json"),
    JSON.stringify(
      {
        security: {
          boundaryPolicy: {
            commandDenyList: ["bun"],
          },
          execution: {
            commandDenyList: ["Node", "bun"],
            sandbox: {
              apiKey: "msb_inline_secret_value",
              serverUrl: "http://127.0.0.1:5555",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function parseJsonLine(stdout: string): Record<string, unknown> {
  return JSON.parse(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0) ?? "{}",
  ) as Record<string, unknown>;
}

describe("cli contract: config migration", () => {
  test("fails fast when invalid channels.telegram branch is present", () => {
    const workspace = createTestWorkspace("contract-config-migration");
    writeInvalidTelegramConfig(workspace);

    try {
      const run = runCliSync(workspace, ["--print", "health check prompt"]);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);

      const stderr = run.stderr ?? "";
      expect(stderr).toContain("[config:error]");
      expect(stderr).toContain('unknown property "telegram"');
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("reports invalid execution field rewrites in dry-run mode without mutating config or vault", () => {
    const workspace = createTestWorkspace("contract-config-migration-dry-run");
    writeInvalidExecutionConfig(workspace);

    try {
      const run = runCliSync(workspace, ["--cwd", workspace, "config", "migrate", "--json"], {
        env: {
          BREWVA_VAULT_KEY: "config-migration-dry-run-key",
        },
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);

      const payload = parseJsonLine(run.stdout);
      expect(payload).toMatchObject({
        schema: "brewva.config.migrate.v1",
        ok: true,
        exists: true,
        changed: true,
        applied: false,
      });
      expect(payload.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "execution_command_deny_list_to_boundary_policy",
            path: "security.execution.commandDenyList",
          }),
          expect.objectContaining({
            code: "inline_sandbox_api_key_to_vault_ref",
            path: "security.execution.sandbox.apiKey",
          }),
        ]),
      );

      const configPath = join(workspace, ".brewva/brewva.json");
      const rawConfig = readFileSync(configPath, "utf8");
      expect(rawConfig).toContain('"commandDenyList"');
      expect(rawConfig).toContain("msb_inline_secret_value");
      expect(existsSync(join(workspace, ".brewva/credentials.vault"))).toBe(false);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("fails fast on non-config cli paths when invalid execution fields are still present", () => {
    const workspace = createTestWorkspace("contract-config-migration-hard-fail");
    writeInvalidExecutionConfig(workspace);

    try {
      const run = runCliSync(workspace, ["--cwd", workspace, "credentials", "list", "--json"], {
        env: {
          BREWVA_VAULT_KEY: "config-migration-hard-fail-key",
        },
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(run.stdout.trim()).toBe("");
      expect(run.stderr).toContain("[config:error]");
      expect(run.stderr).toContain('unknown property "commandDenyList"');
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("writes migrated config and imports inline sandbox api key into the vault", () => {
    const workspace = createTestWorkspace("contract-config-migration-write");
    writeInvalidExecutionConfig(workspace);
    const env = {
      BREWVA_VAULT_KEY: "config-migration-write-key",
    };

    try {
      const run = runCliSync(workspace, ["config", "migrate", "--write", "--json"], {
        env,
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);

      const payload = parseJsonLine(run.stdout);
      expect(payload).toMatchObject({
        schema: "brewva.config.migrate.v1",
        ok: true,
        exists: true,
        changed: true,
        applied: true,
      });

      const configPath = join(workspace, ".brewva/brewva.json");
      const migrated = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      expect(readFileSync(configPath, "utf8")).not.toContain("msb_inline_secret_value");

      const security = migrated.security as Record<string, unknown>;
      const boundaryPolicy = security.boundaryPolicy as Record<string, unknown>;
      const execution = security.execution as Record<string, unknown>;
      const sandbox = execution.sandbox as Record<string, unknown>;
      const credentials = security.credentials as Record<string, unknown>;

      expect(boundaryPolicy.commandDenyList).toEqual(["bun", "node"]);
      expect(execution.commandDenyList).toBeUndefined();
      expect(sandbox.apiKey).toBeUndefined();
      expect(credentials.sandboxApiKeyRef).toBe("vault://sandbox/apiKey");

      const vaultPath = join(workspace, ".brewva/credentials.vault");
      expect(existsSync(vaultPath)).toBe(true);
      expect(readFileSync(vaultPath, "utf8")).not.toContain("msb_inline_secret_value");

      const vault = new CredentialVaultService({
        vaultPath,
        masterKeyEnv: "BREWVA_VAULT_KEY",
        env,
      });
      expect(vault.get("vault://sandbox/apiKey")).toBe("msb_inline_secret_value");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
