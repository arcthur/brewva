import { describe, expect, test } from "bun:test";
import { createHostedSession as createBrewvaSession } from "@brewva/brewva-gateway/host";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

interface StaticComponentLike {
  render: (width: number) => string[];
}

interface ThemeLike {
  bold: (text: string) => string;
  fg: (_tone: string, text: string) => string;
}

interface ReadToolRendererLike {
  name: string;
  renderResult?: (
    result: {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
    },
    options: { expanded: boolean },
    theme: ThemeLike,
  ) => StaticComponentLike;
}

interface SessionWithToolRegistry {
  getRegisteredTools(): readonly ReadToolRendererLike[];
}

const plainTheme: ThemeLike = {
  bold(text) {
    return text;
  },
  fg(_tone, text) {
    return text;
  },
};

describe("brewva session tool rendering", () => {
  test("collapsed read output stays summary-only while expanded output keeps file content", async () => {
    const workspace = createTestWorkspace("session-tool-rendering");
    const result = await createBrewvaSession({
      cwd: workspace,
      builtinToolNames: ["read"],
    });

    try {
      const sessionWithRegistry = result.session as unknown as SessionWithToolRegistry;
      const readTool = sessionWithRegistry
        .getRegisteredTools()
        .find((tool) => tool.name === "read");

      expect(typeof readTool?.renderResult).toBe("function");

      const toolResult = {
        content: [
          {
            type: "text",
            text: "alpha\nbeta\ngamma\n\n[Showing lines 1-3 of 10. Use offset=4 to continue.]",
          },
        ],
        details: {
          truncation: {
            truncated: true,
            totalLines: 10,
            outputLines: 3,
            truncatedBy: "lines",
            firstLineExceedsLimit: false,
          },
        },
      };

      const collapsed = readTool
        ?.renderResult?.(toolResult, { expanded: false }, plainTheme)
        .render(120)
        .join("\n");
      const expanded = readTool
        ?.renderResult?.(toolResult, { expanded: true }, plainTheme)
        .render(120)
        .join("\n");

      expect(collapsed).toContain("3 lines");
      expect(collapsed).toContain("truncated from 10");
      expect(collapsed).not.toContain("alpha");
      expect(collapsed).not.toContain("beta");
      expect(collapsed).not.toContain("gamma");
      expect(collapsed).not.toContain("Showing lines 1-3 of 10");

      expect(expanded).toContain("alpha");
      expect(expanded).toContain("beta");
      expect(expanded).toContain("gamma");
      expect(expanded).toContain("showing 3 of 10 lines");
      expect(expanded).not.toContain("Showing lines 1-3 of 10");
    } finally {
      result.session.dispose();
      cleanupTestWorkspace(workspace);
    }
  });

  test("collapsed read output ignores continuation footer from user-provided limit", async () => {
    const workspace = createTestWorkspace("session-tool-rendering-limit-footer");
    const result = await createBrewvaSession({
      cwd: workspace,
      builtinToolNames: ["read"],
    });

    try {
      const sessionWithRegistry = result.session as unknown as SessionWithToolRegistry;
      const readTool = sessionWithRegistry
        .getRegisteredTools()
        .find((tool) => tool.name === "read");

      expect(typeof readTool?.renderResult).toBe("function");

      const toolResult = {
        content: [
          {
            type: "text",
            text: "alpha\nbeta\ngamma\n\n[7 more lines in file. Use offset=4 to continue.]",
          },
        ],
      };

      const collapsed = readTool
        ?.renderResult?.(toolResult, { expanded: false }, plainTheme)
        .render(120)
        .join("\n");
      const expanded = readTool
        ?.renderResult?.(toolResult, { expanded: true }, plainTheme)
        .render(120)
        .join("\n");

      expect(collapsed).toContain("3 lines");
      expect(collapsed).not.toContain("7 more lines in file");
      expect(collapsed).not.toContain("alpha");

      expect(expanded).toContain("alpha");
      expect(expanded).toContain("beta");
      expect(expanded).toContain("gamma");
      expect(expanded).toContain("[7 more lines in file. Use offset=4 to continue.]");
    } finally {
      result.session.dispose();
      cleanupTestWorkspace(workspace);
    }
  });
});
