import { describe, expect, test } from "bun:test";
import type { BrewvaConfigFile } from "@brewva/brewva-runtime";

describe("BrewvaConfigFile typing", () => {
  test("supports minimal projection overlay shape", () => {
    const config: BrewvaConfigFile = {
      projection: {
        enabled: true,
        dir: ".orchestrator/projection",
        workingFile: "working.md",
        maxWorkingChars: 3200,
      },
      infrastructure: {
        toolFailureInjection: {
          enabled: false,
          maxEntries: 5,
          maxOutputChars: 180,
        },
      },
    };

    expect(config.projection?.enabled).toBe(true);
    expect(config.projection?.workingFile).toBe("working.md");
    expect(config.infrastructure?.toolFailureInjection?.enabled).toBe(false);
  });

  test("accepts null as the explicit unlimited session-cost sentinel", () => {
    const config: BrewvaConfigFile = {
      infrastructure: {
        costTracking: {
          maxCostUsdPerSession: null,
        },
      },
    };

    expect(config.infrastructure?.costTracking?.maxCostUsdPerSession).toBeNull();
  });

  test("supports boundary policy, credential vault, and exact-call loop guard overlay shapes", () => {
    const config: BrewvaConfigFile = {
      security: {
        boundaryPolicy: {
          network: {
            mode: "allowlist",
            outbound: [{ host: "*.openai.com", ports: [443] }],
          },
        },
        credentials: {
          gatewayTokenRef: "vault://gateway/token",
          sandboxApiKeyRef: "vault://sandbox/apiKey",
          bindings: [
            {
              toolNames: ["exec"],
              envVar: "OPENAI_API_KEY",
              credentialRef: "vault://openai/apiKey",
            },
          ],
        },
        loopDetection: {
          exactCall: {
            enabled: true,
            threshold: 4,
            mode: "block",
            exemptTools: ["skill_complete"],
          },
        },
      },
    };

    expect(config.security?.credentials?.gatewayTokenRef).toBe("vault://gateway/token");
    expect(config.security?.boundaryPolicy?.network?.outbound?.[0]?.host).toBe("*.openai.com");
    expect(config.security?.loopDetection?.exactCall?.mode).toBe("block");
  });
});
