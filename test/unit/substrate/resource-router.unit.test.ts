import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBrewvaResourceRouter,
  createHostedResourceLoader,
} from "@brewva/brewva-substrate/resources";

describe("Brewva resource router", () => {
  test("reads file resources through brewva-resource URIs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-file-"));
    writeFileSync(join(workspace, "note.md"), "# Note\n", "utf8");
    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir: workspace });
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("brewva-resource:///file/note.md");

    expect(result.status).toBe("ok");
    expect(result.uri).toBe("brewva-resource:///file/note.md");
    expect(result.path).toBe(join(workspace, "note.md"));
    expect(result.mediaType).toBe("text/markdown");
    expect(result.content).toBe("# Note\n");
  });

  test("preserves absolute file URL paths during normalization", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-file-url-"));
    const filePath = join(workspace, "note.md");
    writeFileSync(filePath, "# Note\n", "utf8");
    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir: workspace });
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read(pathToFileURL(filePath).toString());

    expect(result.status).toBe("ok");
    expect(result.path).toBe(filePath);
    expect(result.content).toBe("# Note\n");
  });

  test("supports agent JSON field-path sub-selection", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-agent-"));
    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir: workspace });
    const router = createBrewvaResourceRouter({
      cwd: workspace,
      loader,
      providers: [
        {
          scheme: "agent",
          async read(uri) {
            return {
              status: "ok",
              uri,
              mediaType: "application/json",
              content: JSON.stringify({
                id: "agent-1",
                result: {
                  summary: "small answer",
                  transcript: "large transcript",
                },
              }),
            };
          },
        },
      ],
    });

    const result = await router.read("brewva-resource:///agent/agent-1/result.summary");

    expect(result.status).toBe("ok");
    expect(result.content).toBe('"small answer"');
  });

  test("dispatches loader-registered resource providers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-loader-provider-"));
    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir: workspace });
    loader.registerResourceProvider({
      scheme: "conflict",
      read(uri) {
        return {
          status: "ok",
          uri,
          mediaType: "text/plain",
          content: "conflict hunk",
        };
      },
    });
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("brewva-resource:///conflict/plan-1");

    expect(result.status).toBe("ok");
    expect(result.content).toBe("conflict hunk");
  });

  test("supports per-read scoped providers without rebuilding the router", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-scoped-provider-"));
    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir: workspace });
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const unavailable = await router.read("brewva-resource:///conflict/plan-1");
    const result = await router.read("brewva-resource:///conflict/plan-1", [
      {
        scheme: "conflict",
        read(uri) {
          return {
            status: "ok",
            uri,
            mediaType: "application/json",
            content: JSON.stringify({ planId: "plan-1" }),
          };
        },
      },
    ]);

    expect(unavailable.status).toBe("unavailable");
    expect(result.status).toBe("ok");
    expect(result.content).toContain("plan-1");
  });

  test("does not materialize lazy hosted loaders for file or scoped-provider reads", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-lazy-loader-"));
    writeFileSync(join(workspace, "note.md"), "# Note\n", "utf8");
    let loadCount = 0;
    const router = createBrewvaResourceRouter({
      cwd: workspace,
      loader: async () => {
        loadCount += 1;
        return await createHostedResourceLoader({ cwd: workspace, agentDir: workspace });
      },
    });

    const fileResult = await router.read("brewva-resource:///file/note.md");
    const scopedResult = await router.read("brewva-resource:///conflict/plan-1", [
      {
        scheme: "conflict",
        read(uri) {
          return {
            status: "ok",
            uri,
            mediaType: "text/plain",
            content: "conflict hunk",
          };
        },
      },
    ]);

    expect(fileResult.status).toBe("ok");
    expect(scopedResult.status).toBe("ok");
    expect(loadCount).toBe(0);
  });

  test("fails closed for unavailable external providers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-fail-closed-"));
    const loader = await createHostedResourceLoader({ cwd: workspace, agentDir: workspace });
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("brewva-resource:///pr/123");

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("provider_unavailable");
  });
});
