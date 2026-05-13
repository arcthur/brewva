import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBrewvaUpdatePrompt } from "@brewva/brewva-gateway";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { resolveProjectBrewvaConfigPath } from "@brewva/brewva-runtime/config";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("gateway update workflow prompt", () => {
  test("grounds the update workflow in changelog review and validation gates", () => {
    const workspace = createTestWorkspace("gateway-update-workflow");
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify(
        {
          name: "brewva",
          scripts: {
            check: "bun run check",
            test: "bun test",
            "test:dist": "bun run test:dist",
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    writeFileSync(join(workspace, "CHANGELOG.md"), "# Changelog\n\n## 0.2.0\n", "utf8");

    try {
      const runtime = new BrewvaRuntime({
        cwd: workspace,
        config: structuredClone(DEFAULT_BREWVA_CONFIG),
      });
      const prompt = buildBrewvaUpdatePrompt({
        runtime,
        rawArgs: "target=latest\nmode=safe",
      });

      expect(prompt).toContain("Run a Brewva update workflow for this environment.");
      expect(prompt).toContain(`Workspace root: ${runtime.identity.workspaceRoot}`);
      expect(prompt).toContain(
        `Project config: ${resolveProjectBrewvaConfigPath(runtime.identity.cwd)}`,
      );
      expect(prompt).toContain("Review the relevant changelog or release notes");
      expect(prompt).toContain("Fail closed if you cannot collect authoritative release evidence");
      expect(prompt).toContain("Resolve changelog sources in this order");
      expect(prompt).toContain("upgrade_blocked_missing_release_evidence");
      expect(prompt).toContain("Prefer local changelog source:");
      expect(prompt).toContain("npm pack");
      expect(prompt).toContain("version-only rather than file-exact");
      expect(prompt).toContain("bun run check");
      expect(prompt).toContain("bun run test:dist");
      expect(prompt).toContain("- target=latest");
      expect(prompt).toContain("- mode=safe");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
