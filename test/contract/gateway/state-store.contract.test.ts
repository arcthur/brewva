import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileGatewayStateStore, loadOrCreateGatewayToken } from "@brewva/brewva-gateway";
import { patchProcessEnv } from "../../helpers/global-state.js";

describe("gateway file state store", () => {
  test("given token value, when writing and reading token, then newline normalization is preserved", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-"));
    try {
      const store = new FileGatewayStateStore();
      const tokenPath = join(root, "gateway.token");
      store.writeToken(tokenPath, "token-123");

      const raw = readFileSync(tokenPath, "utf8");
      expect(raw).toBe("token-123\n");
      expect(store.readToken(tokenPath)).toBe("token-123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given malformed children registry rows, when reading registry, then invalid rows are ignored", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-"));
    try {
      const store = new FileGatewayStateStore();
      const registryPath = join(root, "children.json");
      writeFileSync(
        registryPath,
        JSON.stringify(
          [
            { sessionId: "s1", pid: 1001, startedAt: 100 },
            { sessionId: "", pid: 1002, startedAt: 200 },
            { sessionId: "s3", pid: 0, startedAt: 300 },
            { sessionId: "s4", pid: 1004 },
            "bad-row",
          ],
          null,
          2,
        ),
        "utf8",
      );

      const rows = store.readChildrenRegistry(registryPath);
      expect(rows).toEqual([{ sessionId: "s1", pid: 1001, startedAt: 100 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given children registry entries, when writing registry, then file is written atomically without stale temp file", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-"));
    try {
      const store = new FileGatewayStateStore();
      const registryPath = join(root, "children.json");
      store.writeChildrenRegistry(registryPath, [{ sessionId: "s1", pid: 1001, startedAt: 123 }]);

      expect(existsSync(registryPath)).toBe(true);
      expect(existsSync(`${registryPath}.tmp`)).toBe(false);
      expect(store.readChildrenRegistry(registryPath)).toEqual([
        { sessionId: "s1", pid: 1001, startedAt: 123 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given vault-backed token storage, when writing token, then pointer file is persisted and token resolves through the vault", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-vault-"));
    const restoreEnv = patchProcessEnv({
      BREWVA_VAULT_KEY: "state-store-test-key",
    });
    try {
      const tokenPath = join(root, "gateway.token");
      const vaultPath = join(root, "credentials.vault");
      const store = new FileGatewayStateStore({
        tokenVault: {
          vaultPath,
          credentialRef: "vault://gateway/token",
          masterKeyEnv: "BREWVA_VAULT_KEY",
        },
      });

      store.writeToken(tokenPath, "token-123");

      const raw = readFileSync(tokenPath, "utf8");
      expect(raw).toContain("brewva.gateway-token-pointer.v1");
      expect(raw).not.toContain("token-123");
      expect(store.readToken(tokenPath)).toBe("token-123");
      expect(new FileGatewayStateStore().readToken(tokenPath)).toBe("token-123");
    } finally {
      restoreEnv();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given a raw gateway token and a vault-backed state store, when loading the token, then storage migrates to the configured vault pointer", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-vault-migrate-"));
    const restoreEnv = patchProcessEnv({
      BREWVA_VAULT_KEY: "state-store-migrate-key",
    });
    try {
      const tokenPath = join(root, "gateway.token");
      const vaultPath = join(root, "credentials.vault");
      writeFileSync(tokenPath, "token-123\n", "utf8");
      const store = new FileGatewayStateStore({
        tokenVault: {
          vaultPath,
          credentialRef: "vault://gateway/token",
          masterKeyEnv: "BREWVA_VAULT_KEY",
        },
      });

      expect(loadOrCreateGatewayToken(tokenPath, store)).toBe("token-123");
      expect(readFileSync(tokenPath, "utf8")).toContain("brewva.gateway-token-pointer.v1");
      expect(readFileSync(tokenPath, "utf8")).not.toContain("token-123");
      expect(store.readToken(tokenPath)).toBe("token-123");
    } finally {
      restoreEnv();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given a vault-backed token file and a plain state store, when loading the token, then the pointer file stays intact", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-pointer-preserve-"));
    const restoreEnv = patchProcessEnv({
      BREWVA_VAULT_KEY: "state-store-pointer-key",
    });
    try {
      const tokenPath = join(root, "gateway.token");
      const vaultPath = join(root, "credentials.vault");
      new FileGatewayStateStore({
        tokenVault: {
          vaultPath,
          credentialRef: "vault://gateway/token",
          masterKeyEnv: "BREWVA_VAULT_KEY",
        },
      }).writeToken(tokenPath, "token-123");
      const pointerFile = readFileSync(tokenPath, "utf8");

      expect(loadOrCreateGatewayToken(tokenPath, new FileGatewayStateStore())).toBe("token-123");
      expect(readFileSync(tokenPath, "utf8")).toBe(pointerFile);
    } finally {
      restoreEnv();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given a vault-backed token pointer that already matches the configured vault, when loading the token, then state store does not rewrite pointer or vault contents", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-pointer-stable-"));
    const restoreEnv = patchProcessEnv({
      BREWVA_VAULT_KEY: "state-store-stable-key",
    });
    try {
      const tokenPath = join(root, "gateway.token");
      const vaultPath = join(root, "credentials.vault");
      const store = new FileGatewayStateStore({
        tokenVault: {
          vaultPath,
          credentialRef: "vault://gateway/token",
          masterKeyEnv: "BREWVA_VAULT_KEY",
        },
      });
      store.writeToken(tokenPath, "token-123");
      const pointerBefore = readFileSync(tokenPath, "utf8");
      const vaultBefore = readFileSync(vaultPath, "utf8");

      expect(loadOrCreateGatewayToken(tokenPath, store)).toBe("token-123");
      expect(readFileSync(tokenPath, "utf8")).toBe(pointerBefore);
      expect(readFileSync(vaultPath, "utf8")).toBe(vaultBefore);
    } finally {
      restoreEnv();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given an unreadable vault-backed token pointer, when loading the gateway token, then startup fails closed instead of rotating silently", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-vault-fail-closed-"));
    const restoreEnv = patchProcessEnv({
      BREWVA_VAULT_KEY: "state-store-correct-key",
    });
    try {
      const tokenPath = join(root, "gateway.token");
      const vaultPath = join(root, "credentials.vault");
      const store = new FileGatewayStateStore({
        tokenVault: {
          vaultPath,
          credentialRef: "vault://gateway/token",
          masterKeyEnv: "BREWVA_VAULT_KEY",
        },
      });

      store.writeToken(tokenPath, "token-123");
      const pointerFile = readFileSync(tokenPath, "utf8");

      const restoreWrongKey = patchProcessEnv({
        BREWVA_VAULT_KEY: "state-store-wrong-key",
      });
      expect(() => loadOrCreateGatewayToken(tokenPath, new FileGatewayStateStore())).toThrow();
      restoreWrongKey();
      expect(readFileSync(tokenPath, "utf8")).toBe(pointerFile);
    } finally {
      restoreEnv();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("given a malformed structured token file, when reading the gateway token, then state store rejects it instead of treating it as a raw token", () => {
    const root = mkdtempSync(join(tmpdir(), "brewva-state-store-invalid-pointer-"));
    try {
      const tokenPath = join(root, "gateway.token");
      writeFileSync(tokenPath, '{ "schema": "brewva.gateway-token-pointer.v1"\n', "utf8");

      expect(() => new FileGatewayStateStore().readToken(tokenPath)).toThrow(
        "Invalid gateway token pointer file",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
