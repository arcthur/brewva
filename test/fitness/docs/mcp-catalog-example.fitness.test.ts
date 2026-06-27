import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const KNOWN_TRANSPORTS = new Set(["stdio", "streamable_http"]);

interface McpServerExample {
  readonly id?: unknown;
  readonly transport?: unknown;
  readonly includeToolNames?: unknown;
}

// Pull every MCP server out of the fenced config blocks in the docs. Try-parsing every
// fence (not just `json`) keeps the extractor robust to the language tag; non-JSON and
// non-config blocks fail to parse or lack the path and are skipped.
function mcpServersFromMarkdown(markdown: string): McpServerExample[] {
  const servers: McpServerExample[] = [];
  for (const fence of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/giu)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fence[1] ?? "");
    } catch {
      continue;
    }
    const list = (parsed as { integrations?: { mcp?: { servers?: unknown } } }).integrations?.mcp
      ?.servers;
    if (Array.isArray(list)) {
      servers.push(...(list as McpServerExample[]));
    }
  }
  return servers;
}

describe("MCP catalog example hygiene", () => {
  test("every documented MCP server models a bounded, known-transport catalog", () => {
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/mcp-integration.md"), "utf8");
    const servers = mcpServersFromMarkdown(markdown);

    // Guard against a silent pass if the doc's config shape changes out from under the
    // extractor: the canonical example must always be present and checked.
    expect(servers.length).toBeGreaterThan(0);

    for (const server of servers) {
      // Known transport set — the loader already enforces this; the doc must not teach
      // an unknown one.
      expect(KNOWN_TRANSPORTS.has(server.transport as string)).toBe(true);
      // A bounded allowlist, never a "*" that reads as wildcard-allow but exposes nothing.
      // An MCP server's self-declared catalog must never auto-derive authority (axiom 18).
      expect(Array.isArray(server.includeToolNames)).toBe(true);
      const include = (server.includeToolNames as readonly string[] | undefined) ?? [];
      expect(include.length).toBeGreaterThan(0);
      expect(include).not.toContain("*");
    }
  });
});
