import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCliSync } from "../../helpers/cli.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function parseJsonLine(stdout: string): Record<string, unknown> {
  return JSON.parse(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0) ?? "{}",
  ) as Record<string, unknown>;
}

describe("credentials subcommand", () => {
  test("stores, lists, and removes credentials through the encrypted vault", () => {
    const workspace = createTestWorkspace("cli-credentials");
    const env = {
      BREWVA_VAULT_KEY: "cli-credentials-test-key",
    };

    const add = runCliSync(
      workspace,
      [
        "credentials",
        "add",
        "--ref",
        "vault://openai/apiKey",
        "--value",
        "sk-cli-secret-value",
        "--json",
      ],
      { env },
    );
    expect(add.status).toBe(0);
    expect(parseJsonLine(add.stdout).schema).toBe("brewva.credentials.put.v1");

    const vaultPath = join(workspace, ".brewva/credentials.vault");
    expect(existsSync(vaultPath)).toBe(true);
    expect(readFileSync(vaultPath, "utf8")).not.toContain("sk-cli-secret-value");

    const list = runCliSync(workspace, ["credentials", "list", "--json"], { env });
    expect(list.status).toBe(0);
    expect(parseJsonLine(list.stdout)).toMatchObject({
      schema: "brewva.credentials.list.v1",
      ok: true,
      entries: [
        {
          ref: "vault://openai/apiKey",
          maskedValue: "sk-cli...alue",
        },
      ],
    });

    const remove = runCliSync(
      workspace,
      ["credentials", "remove", "--ref", "vault://openai/apiKey", "--json"],
      { env },
    );
    expect(remove.status).toBe(0);
    expect(parseJsonLine(remove.stdout)).toMatchObject({
      schema: "brewva.credentials.remove.v1",
      ok: true,
      removed: true,
    });
  });

  test("discovers ambient credentials without importing them", () => {
    const workspace = createTestWorkspace("cli-credentials-discover");
    const result = runCliSync(workspace, ["credentials", "discover", "--json"], {
      env: {
        BREWVA_VAULT_KEY: "cli-credentials-discover-key",
        OPENAI_API_KEY: "sk-discover-secret",
      },
    });

    expect(result.status).toBe(0);
    const payload = parseJsonLine(result.stdout);
    expect(payload.schema).toBe("brewva.credentials.discover.v1");
    expect(payload.ok).toBe(true);
    expect(payload.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          envVar: "OPENAI_API_KEY",
          credentialRef: "vault://openai/apiKey",
          maskedValue: "sk-dis...cret",
        }),
      ]),
    );
    expect(existsSync(join(workspace, ".brewva/credentials.vault"))).toBe(false);
  });

  test("accepts root-level flags before the credentials subcommand", () => {
    const workspace = createTestWorkspace("cli-credentials-root-flags");
    const add = runCliSync(
      workspace,
      [
        "--cwd",
        workspace,
        "credentials",
        "add",
        "--ref",
        "vault://github/token",
        "--value",
        "ghp_root_flag_secret",
        "--json",
      ],
      {
        env: {
          BREWVA_VAULT_KEY: "cli-credentials-root-flags-key",
        },
      },
    );

    expect(add.status).toBe(0);
    expect(parseJsonLine(add.stdout)).toMatchObject({
      schema: "brewva.credentials.put.v1",
      ok: true,
      ref: "vault://github/token",
    });
  });
});
