import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("provider event contract authority", () => {
  test("keeps provider-core as the single event contract authority across substrate agent protocol and session surfaces", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const providerEventPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "contracts",
      "event.ts",
    );
    const parseTypesPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "parse",
      "types.ts",
    );
    const agentProtocolTypesPath = resolve(
      repoRoot,
      "packages",
      "brewva-substrate",
      "src",
      "agent-protocol",
      "types.ts",
    );
    const promptSessionPath = resolve(
      repoRoot,
      "packages",
      "brewva-substrate",
      "src",
      "session",
      "prompt-session.ts",
    );
    const sessionApiPath = resolve(
      repoRoot,
      "packages",
      "brewva-substrate",
      "src",
      "session",
      "api.ts",
    );
    const substrateIndexPath = resolve(repoRoot, "packages", "brewva-substrate", "src", "index.ts");

    const providerEventSource = readFileSync(providerEventPath, "utf8");
    const parseTypesSource = readFileSync(parseTypesPath, "utf8");
    const agentProtocolTypesSource = readFileSync(agentProtocolTypesPath, "utf8");
    const promptSessionSource = readFileSync(promptSessionPath, "utf8");
    const sessionApiSource = readFileSync(sessionApiPath, "utf8");
    const substrateIndexSource = readFileSync(substrateIndexPath, "utf8");

    expect(providerEventSource).toContain("export type StreamingParseStatus");
    expect(providerEventSource).toContain("parseStatus?: StreamingParseStatus");
    expect(providerEventSource).toContain("export type AssistantMessageEventOf");

    expect(parseTypesSource).toContain('from "../contracts/event.js"');
    expect(parseTypesSource).not.toContain("export type StreamingParseStatus =");

    expect(agentProtocolTypesSource).toContain("AssistantMessageEventOf");
    expect(agentProtocolTypesSource).toContain(
      "export type BrewvaAgentProtocolAssistantMessageEvent = AssistantMessageEventOf<",
    );
    expect(agentProtocolTypesSource).toContain("ProviderCachePolicy");
    expect(agentProtocolTypesSource).toContain("ProviderCacheRenderResult");
    expect(agentProtocolTypesSource).toContain("ProviderPayloadMetadata");
    expect(agentProtocolTypesSource).not.toContain("BrewvaAgentProtocolCachePolicy");
    expect(agentProtocolTypesSource).not.toContain("BrewvaAgentEngine");

    expect(promptSessionSource).toContain("AssistantMessageEventOf");
    expect(promptSessionSource).toContain(
      "export type BrewvaPromptAssistantMessageEvent = AssistantMessageEventOf<",
    );
    expect(promptSessionSource).not.toContain('type: "toolcall_start"');
    expect(promptSessionSource).not.toContain('type: "toolcall_delta"');
    expect(promptSessionSource).not.toContain('type: "toolcall_end"');
    expect(sessionApiSource).toContain("type BrewvaPromptAssistantMessageEvent");
    expect(substrateIndexSource).toContain('export * from "./public/index.js"');
    expect(substrateIndexSource).not.toContain("BrewvaPromptAssistantMessageEvent");
    expect(substrateIndexSource).not.toContain("type BrewvaPromptMessageDeltaEvent");
  });
});
