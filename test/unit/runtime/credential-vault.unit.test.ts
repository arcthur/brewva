import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CredentialVaultService } from "../../../packages/brewva-runtime/src/credentials/credential-vault.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("credential vault", () => {
  test("discovers Kimi credentials without a generic Moonshot fallback", () => {
    const workspace = createTestWorkspace("credential-vault-kimi-discovery");
    const vault = new CredentialVaultService({
      vaultPath: join(workspace, "credentials.vault"),
      allowDerivedKeyFallback: true,
      env: {},
      machineHostname: "test-host",
      machineHomeDir: workspace,
    });

    const discovered = vault.discover({
      KIMI_API_KEY: "sk-kimi",
      MOONSHOT_CN_API_KEY: "sk-moonshot-cn",
      MOONSHOT_AI_API_KEY: "sk-moonshot-ai",
      MOONSHOT_API_KEY: "sk-moonshot-generic",
    });

    const discoveredRefs = discovered.map((entry) => ({
      provider: entry.provider,
      envVar: entry.envVar,
      credentialRef: entry.credentialRef,
    }));
    expect(discoveredRefs).toEqual(
      expect.arrayContaining([
        {
          provider: "kimi-coding",
          envVar: "KIMI_API_KEY",
          credentialRef: "vault://kimi-coding/apiKey",
        },
        {
          provider: "moonshot-cn",
          envVar: "MOONSHOT_CN_API_KEY",
          credentialRef: "vault://moonshot-cn/apiKey",
        },
        {
          provider: "moonshot-ai",
          envVar: "MOONSHOT_AI_API_KEY",
          credentialRef: "vault://moonshot-ai/apiKey",
        },
      ]),
    );
    expect(discovered.some((entry) => entry.envVar === "MOONSHOT_API_KEY")).toBe(false);
  });

  test("discovers DeepSeek credentials from its provider-specific env var", () => {
    const workspace = createTestWorkspace("credential-vault-deepseek-discovery");
    const vault = new CredentialVaultService({
      vaultPath: join(workspace, "credentials.vault"),
      allowDerivedKeyFallback: true,
      env: {},
      machineHostname: "test-host",
      machineHomeDir: workspace,
    });

    expect(
      vault.discover({
        DEEPSEEK_API_KEY: "sk-deepseek",
      }),
    ).toEqual([
      expect.objectContaining({
        provider: "deepseek",
        envVar: "DEEPSEEK_API_KEY",
        credentialRef: "vault://deepseek/apiKey",
      }),
    ]);
  });

  test("discovers direct Google GenAI API key credentials", () => {
    const workspace = createTestWorkspace("credential-vault-google-genai-discovery");
    const vault = new CredentialVaultService({
      vaultPath: join(workspace, "credentials.vault"),
      allowDerivedKeyFallback: true,
      env: {},
      machineHostname: "test-host",
      machineHomeDir: workspace,
    });

    const discovered = vault.discover({
      GEMINI_API_KEY: "sk-google",
      GOOGLE_API_KEY: "sk-google-legacy",
    });

    expect(discovered).toEqual([
      expect.objectContaining({
        provider: "google-genai",
        envVar: "GEMINI_API_KEY",
        credentialRef: "vault://google-genai/apiKey",
      }),
      expect.objectContaining({
        provider: "google-genai",
        envVar: "GOOGLE_API_KEY",
        credentialRef: "vault://google-genai/apiKey",
      }),
    ]);
  });
});
