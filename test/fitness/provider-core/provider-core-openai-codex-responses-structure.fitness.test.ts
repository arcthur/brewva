import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("provider-core openai-codex-responses structure", () => {
  test("keeps facade thin and vertical slices explicit", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const providersRoot = resolve(repoRoot, "packages", "brewva-provider-core", "src", "providers");
    const providerRoot = resolve(providersRoot, "openai-codex-responses");
    const facadeSource = readFileSync(resolve(providerRoot, "index.ts"), "utf8");
    const adapterSource = readFileSync(resolve(providerRoot, "adapter.ts"), "utf8");
    const requestSource = readFileSync(resolve(providerRoot, "request.ts"), "utf8");
    const sseSource = readFileSync(resolve(providerRoot, "sse.ts"), "utf8");
    const websocketSource = readFileSync(resolve(providerRoot, "websocket.ts"), "utf8");

    expect(existsSync(resolve(providersRoot, "openai-codex-responses.ts"))).toBe(false);
    expect(facadeSource).toContain('from "./adapter.js"');
    expect(facadeSource).toContain('from "./websocket.js"');
    expect(facadeSource).not.toContain("fetch(");
    expect(facadeSource).not.toContain("new Headers(");
    expect(facadeSource).not.toContain("TEST_ONLY");

    expect(adapterSource).toContain("fetch(");
    expect(requestSource).toContain("buildRequestBody");
    expect(sseSource).toContain("parseSSE");
    expect(websocketSource).toContain("processWebSocketStream");
  });
});
