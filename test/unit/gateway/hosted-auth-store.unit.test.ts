import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostedAuthStore,
  type HostedAuthCredential,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/settings/hosted-auth-store.js";
import { patchDateNow } from "../../helpers/global-state.js";

const INTRINSIC_FETCH = globalThis.fetch;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function toRequestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return "";
}

function authSlots(credential: HostedAuthCredential) {
  return {
    activeSlot: "default",
    slots: {
      default: {
        id: "default",
        credential,
      },
    },
  };
}

afterEach(() => {
  globalThis.fetch = INTRINSIC_FETCH;
});

describe("hosted auth store", () => {
  test("rejects legacy single-credential auth storage shape", () => {
    expect(() =>
      HostedAuthStore.inMemory({
        openai: { type: "api_key", key: "sk-legacy" },
      } as never),
    ).toThrow('provider "openai" must use credential slots');
  });

  test("rejects legacy single-credential auth files", () => {
    const authDir = mkdtempSync(join(tmpdir(), "brewva-hosted-auth-legacy-"));
    try {
      const authPath = join(authDir, "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          openai: { type: "api_key", key: "sk-legacy" },
        }),
        "utf8",
      );

      expect(() => HostedAuthStore.create(authPath)).toThrow(
        'provider "openai" must use credential slots',
      );
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  for (const provider of ["openai", "openai-codex"]) {
    test(`reads opencode-style oauth access tokens for ${provider}`, async () => {
      const restoreNow = patchDateNow(() => 1_000_000);
      try {
        const authStore = HostedAuthStore.inMemory({
          [provider]: authSlots({
            type: "oauth",
            access: "legacy-access-token",
            refresh: "legacy-refresh-token",
            expires: 1_060_000,
          }),
        });

        expect(await authStore.getApiKey(provider)).toBe("legacy-access-token");
      } finally {
        restoreNow();
      }
    });
  }

  for (const provider of ["openai", "openai-codex"]) {
    test(`refreshes expired opencode-style oauth tokens for ${provider}`, async () => {
      const now = 2_000_000;
      const restoreNow = patchDateNow(() => now);
      let fetchCalls = 0;
      globalThis.fetch = (async (input, init) => {
        fetchCalls += 1;
        expect(toRequestUrl(input)).toBe("https://auth.openai.com/oauth/token");
        expect(init?.method).toBe("POST");
        const bodyText = toRequestBodyText(init?.body);
        expect(bodyText).toContain("grant_type=refresh_token");
        expect(bodyText).toContain("refresh_token=legacy-refresh-token");
        expect(bodyText).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
        return jsonResponse({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600,
        });
      }) as typeof fetch;

      try {
        const authStore = HostedAuthStore.inMemory({
          [provider]: authSlots({
            type: "oauth",
            access: "stale-access-token",
            refresh: "legacy-refresh-token",
            expires: now - 1,
          }),
        });

        expect(await authStore.getApiKey(provider)).toBe("fresh-access-token");
        expect(await authStore.getApiKey(provider)).toBe("fresh-access-token");
        expect(fetchCalls).toBe(1);
        expect(authStore.get(provider)).toEqual({
          type: "oauth",
          access: "fresh-access-token",
          accessToken: "fresh-access-token",
          expires: now + 3_600_000,
          expiresAt: now + 3_600_000,
          refresh: "fresh-refresh-token",
          refreshToken: "fresh-refresh-token",
        });
      } finally {
        restoreNow();
      }
    });
  }

  test("rotates provider credential slots without exposing secret material", async () => {
    const restoreNow = patchDateNow(() => 1_000);
    try {
      const authStore = HostedAuthStore.inMemory();
      authStore.setCredentialSlot("openai", {
        id: "primary",
        credential: { type: "api_key", key: "sk-primary-secret" },
      });
      authStore.setCredentialSlot("openai", {
        id: "secondary",
        credential: { type: "api_key", key: "sk-secondary-secret" },
      });

      expect(await authStore.getApiKey("openai")).toBe("sk-primary-secret");

      const rotation = authStore.rotateCredential("openai", "rate_limit", 5_000);

      expect(rotation).toEqual({
        providerId: "openai",
        credentialSlot: "secondary",
        reason: "rate_limit",
        cooldownMs: 5_000,
      });
      expect(JSON.stringify(rotation)).not.toContain("sk-");
      expect(await authStore.getApiKey("openai")).toBe("sk-secondary-secret");
      expect(authStore.rotateCredential("openai", "quota", 5_000)).toBe(undefined);
    } finally {
      restoreNow();
    }
  });
});
