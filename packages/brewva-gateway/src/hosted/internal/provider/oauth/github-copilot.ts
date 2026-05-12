import { setTimeout as sleep } from "node:timers/promises";
import type { HostedAuthCredential } from "../../session/settings/hosted-auth-store.js";
import type {
  ProviderAuthHandler,
  ProviderOAuthAuthMethod,
  ProviderOAuthCompletion,
} from "../types.js";
import {
  fetchOAuth,
  formatOAuthHttpError,
  OAUTH_DEVICE_FLOW_TIMEOUT_MS,
  OAUTH_POLLING_SAFETY_MARGIN_MS,
  readFiniteNumber,
  readString,
} from "./shared.js";

const GITHUB_COPILOT_OAUTH_CLIENT_ID = "Ov23li8tweQw6odWQebz";

function normalizeGitHubDomain(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.host;
  } catch {
    return "";
  }
}

function githubCopilotUrls(domain: string): { deviceCodeUrl: string; accessTokenUrl: string } {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  };
}

function githubCopilotDeviceFlowErrorMessage(error: string): string {
  switch (error) {
    case "expired_token":
    case "token_expired":
      return "GitHub device authorization expired. Reopen /model to request a new code.";
    case "access_denied":
      return "GitHub device authorization was denied.";
    case "incorrect_device_code":
      return "GitHub device authorization failed: incorrect device code.";
    case "incorrect_client_credentials":
      return "GitHub device authorization failed: incorrect client credentials.";
    case "device_flow_disabled":
      return "GitHub device authorization failed: device flow is disabled for this OAuth app.";
    case "unsupported_grant_type":
      return "GitHub device authorization failed: unsupported grant type.";
    default:
      return `GitHub device authorization failed: ${error}`;
  }
}

async function waitForGitHubCopilotDevicePoll(
  intervalMs: number,
  deadline: number,
): Promise<boolean> {
  const waitMs = intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS;
  if (Date.now() + waitMs >= deadline) {
    return false;
  }
  await sleep(waitMs);
  return true;
}

async function authorizeGitHubCopilot(
  inputs: Record<string, string> = {},
): Promise<ProviderOAuthCompletion> {
  const deploymentType = inputs.deploymentType || "github.com";
  const domain =
    deploymentType === "enterprise"
      ? normalizeGitHubDomain(inputs.enterpriseUrl ?? "")
      : "github.com";
  if (!domain) {
    throw new Error("GitHub Enterprise URL is required.");
  }
  const urls = githubCopilotUrls(domain);
  const response = await fetchOAuth(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "brewva",
    },
    body: JSON.stringify({
      client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
      scope: "read:user",
    }),
  });
  if (!response.ok) {
    throw new Error(
      await formatOAuthHttpError(response, "Failed to start GitHub device authorization"),
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const verificationUri =
    readString(payload.verification_uri_complete) ?? readString(payload.verification_uri);
  const userCode = readString(payload.user_code);
  const deviceCode = readString(payload.device_code);
  const intervalSeconds = readFiniteNumber(payload.interval) ?? 5;
  const expiresInSeconds =
    readFiniteNumber(payload.expires_in) ?? OAUTH_DEVICE_FLOW_TIMEOUT_MS / 1000;
  if (!verificationUri || !userCode || !deviceCode) {
    throw new Error("GitHub device authorization response was incomplete.");
  }
  return {
    url: verificationUri,
    method: "auto",
    instructions: `Enter code: ${userCode}`,
    copyText: userCode,
    async complete() {
      let intervalMs = Math.max(intervalSeconds, 1) * 1000;
      const deadline = Date.now() + Math.max(expiresInSeconds, 1) * 1000;
      while (Date.now() < deadline) {
        const tokenResponse = await fetchOAuth(urls.accessTokenUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": "brewva",
          },
          body: JSON.stringify({
            client_id: GITHUB_COPILOT_OAUTH_CLIENT_ID,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
        const accessToken = readString(tokenPayload.access_token);
        if (accessToken) {
          const credential: Extract<HostedAuthCredential, { type: "oauth" }> = {
            type: "oauth",
            accessToken,
            refreshToken: accessToken,
            expiresAt: 0,
            access: accessToken,
            refresh: accessToken,
            expires: 0,
          };
          return deploymentType === "enterprise"
            ? { ...credential, enterpriseUrl: domain }
            : credential;
        }
        const error = readString(tokenPayload.error);
        if (error === "authorization_pending") {
          if (!(await waitForGitHubCopilotDevicePoll(intervalMs, deadline))) {
            break;
          }
          continue;
        }
        if (error === "slow_down") {
          const serverInterval = readFiniteNumber(tokenPayload.interval);
          intervalMs = Math.max(serverInterval ? serverInterval * 1000 : intervalMs + 5_000, 1_000);
          if (!(await waitForGitHubCopilotDevicePoll(intervalMs, deadline))) {
            break;
          }
          continue;
        }
        if (error) {
          throw new Error(githubCopilotDeviceFlowErrorMessage(error));
        }
        if (!tokenResponse.ok) {
          throw new Error(
            await formatOAuthHttpError(tokenResponse, "GitHub device authorization failed"),
          );
        }
        throw new Error("GitHub device authorization failed.");
      }
      throw new Error("GitHub device authorization expired. Reopen /model to request a new code.");
    },
  };
}

export function createGitHubCopilotAuthHandler(): ProviderAuthHandler {
  const methods: readonly ProviderOAuthAuthMethod[] = [
    {
      id: "github_copilot",
      kind: "oauth",
      type: "oauth",
      label: "Login with GitHub Copilot",
      prompts: [
        {
          type: "select",
          key: "deploymentType",
          message: "Select GitHub deployment type",
          options: [
            { label: "GitHub.com", value: "github.com", hint: "Public" },
            {
              label: "GitHub Enterprise",
              value: "enterprise",
              hint: "Data residency or self-hosted",
            },
          ],
        },
        {
          type: "text",
          key: "enterpriseUrl",
          message: "Enter your GitHub Enterprise URL or domain",
          placeholder: "company.ghe.com or https://company.ghe.com",
          when: { key: "deploymentType", op: "eq", value: "enterprise" },
        },
      ],
    },
  ];
  return {
    provider: "github-copilot",
    listAuthMethods() {
      return methods;
    },
    async authorizeOAuth(methodId, inputs = {}) {
      if (methodId !== "github_copilot") {
        return undefined;
      }
      return authorizeGitHubCopilot(inputs);
    },
  };
}
