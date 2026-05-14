import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

describe("default box image contract", () => {
  test("uses the repo-owned long-lived GHCR workbench image", () => {
    expect(DEFAULT_BREWVA_CONFIG.security.execution.box.image).toBe(
      "ghcr.io/arcthur/box-default:latest",
    );

    const repoRoot = resolve(import.meta.dirname, "../../../..");
    const containerfile = readFileSync(
      resolve(repoRoot, "distribution", "box-default", "Containerfile"),
      "utf8",
    );
    const workflow = readFileSync(
      resolve(repoRoot, ".github", "workflows", "box-default.yml"),
      "utf8",
    );

    expect(containerfile).toContain("FROM oven/bun:1.3.12 AS bun");
    expect(containerfile).toContain("FROM node:22-bookworm-slim");
    expect(containerfile).toContain("COPY --from=bun /usr/local/bin/bun");
    expect(containerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(containerfile).toContain('CMD ["sleep", "infinity"]');
    expect(containerfile).not.toContain('CMD ["bash"]');

    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("username: ${{ github.actor }}");
    expect(workflow).toContain("password: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).not.toContain("GHCR_TOKEN");
    expect(workflow).toContain("IMAGE_NAME: arcthur/box-default");
    expect(workflow).toContain("docker/build-push-action");
    expect(workflow).toContain("context: distribution/box-default");
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
  });
});
