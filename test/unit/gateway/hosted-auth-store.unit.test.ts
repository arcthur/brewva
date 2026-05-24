import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostedAuthStore,
  type HostedAuthCredential,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/settings/hosted-auth-store.js";
import { patchDateNow, patchProcessEnv } from "../../helpers/global-state.js";

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

  test("renders Google OAuth credentials as Cloud Code Assist credential JSON", async () => {
    const authStore = HostedAuthStore.inMemory({
      google: authSlots({
        type: "oauth",
        accessToken: "google-access-token",
        refreshToken: "google-refresh-token",
        expiresAt: Date.now() + 60_000,
        projectId: "project-1",
      }),
    });

    expect(JSON.parse((await authStore.getApiKey("google")) ?? "{}")).toEqual({
      token: "google-access-token",
      projectId: "project-1",
    });
  });

  test("refreshes expired Google OAuth credentials before rendering credential JSON", async () => {
    const restoreEnv = patchProcessEnv({
      BREWVA_GOOGLE_OAUTH_CLIENT_ID: "brewva-google-oauth-client-id-for-tests",
      BREWVA_GOOGLE_OAUTH_CLIENT_SECRET: "brewva-google-oauth-client-secret-for-tests",
    });
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: toRequestUrl(input), body: toRequestBodyText(init?.body) });
      return jsonResponse({
        access_token: "refreshed-google-access-token",
        refresh_token: "next-google-refresh-token",
        expires_in: 3600,
      });
    }) as typeof fetch;
    const authStore = HostedAuthStore.inMemory({
      google: authSlots({
        type: "oauth",
        accessToken: "expired-google-access-token",
        refreshToken: "google-refresh-token",
        expiresAt: Date.now() - 60_000,
        projectId: "project-1",
      }),
    });

    try {
      expect(JSON.parse((await authStore.getApiKey("google")) ?? "{}")).toEqual({
        token: "refreshed-google-access-token",
        projectId: "project-1",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
      expect(requests[0]?.body).toContain("grant_type=refresh_token");
      expect(requests[0]?.body).toContain("refresh_token=google-refresh-token");
      expect(authStore.get("google")).toMatchObject({
        type: "oauth",
        accessToken: "refreshed-google-access-token",
        refreshToken: "next-google-refresh-token",
        projectId: "project-1",
      });
    } finally {
      restoreEnv();
    }
  });

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
