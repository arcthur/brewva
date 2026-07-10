import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBrewvaResourceRouter,
  createHostedResourceLoader,
} from "@brewva/brewva-substrate/resources";

function testAgentDir(workspace: string): string {
  const agentDir = join(workspace, ".agent");
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

function createTestResourceLoader(workspace: string) {
  return createHostedResourceLoader({ cwd: workspace, agentDir: testAgentDir(workspace) });
}

describe("Brewva resource router", () => {
  test("reads file resources through brewva-resource URIs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-file-"));
    writeFileSync(join(workspace, "note.md"), "# Note\n", "utf8");
    const loader = await createTestResourceLoader(workspace);
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
    const loader = await createTestResourceLoader(workspace);
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read(pathToFileURL(filePath).toString());

    expect(result.status).toBe("ok");
    expect(result.path).toBe(filePath);
    expect(result.content).toBe("# Note\n");
  });

  test("reads source:/// triple-slash URIs as repo-relative file resources", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-source-triple-"));
    mkdirSync(join(workspace, "packages"), { recursive: true });
    writeFileSync(join(workspace, "packages", "note.md"), "# Note\n", "utf8");
    const loader = await createTestResourceLoader(workspace);
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("source:///packages/note.md");

    expect(result.status).toBe("ok");
    expect(result.uri).toBe("brewva-resource:///file/packages/note.md");
    expect(result.path).toBe(join(workspace, "packages", "note.md"));
    expect(result.content).toBe("# Note\n");
  });

  test("reads source:// double-slash URIs as repo-relative file resources", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-source-double-"));
    writeFileSync(join(workspace, "note.md"), "# Note\n", "utf8");
    const loader = await createTestResourceLoader(workspace);
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("source://note.md");

    expect(result.status).toBe("ok");
    expect(result.path).toBe(join(workspace, "note.md"));
  });

  test("resolves source:/// absolute payloads inside the allowed roots", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-source-abs-"));
    const filePath = join(workspace, "note.md");
    writeFileSync(filePath, "# Note\n", "utf8");
    const loader = await createTestResourceLoader(workspace);
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read(`source://${filePath}`);

    expect(result.status).toBe("ok");
    expect(result.path).toBe(filePath);
  });

  test("returns unknown_scheme for unrecognized URI schemes instead of path-mangling", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-unknown-scheme-"));
    const loader = await createTestResourceLoader(workspace);
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("repo://packages/note.md");

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("unknown_scheme");
    expect(result.uri).toBe("brewva-resource:///repo/packages/note.md");
  });

  test("reads canonical brewva-resource URIs written with two slashes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-two-slash-"));
    writeFileSync(join(workspace, "note.md"), "# Note\n", "utf8");
    const loader = await createTestResourceLoader(workspace);
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("brewva-resource://file/note.md");

    expect(result.status).toBe("ok");
    expect(result.path).toBe(join(workspace, "note.md"));
  });

  test("still reads bare relative paths containing a colon", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-colon-file-"));
    writeFileSync(join(workspace, "note:draft.md"), "# Colon\n", "utf8");
    const loader = await createTestResourceLoader(workspace);
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("note:draft.md");

    expect(result.status).toBe("ok");
    expect(result.path).toBe(join(workspace, "note:draft.md"));
    expect(result.content).toBe("# Colon\n");
  });

  test("supports agent JSON field-path sub-selection", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-resource-router-agent-"));
    const loader = await createTestResourceLoader(workspace);
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
    const loader = await createTestResourceLoader(workspace);
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
    const loader = await createTestResourceLoader(workspace);
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
        return await createTestResourceLoader(workspace);
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
    const loader = await createTestResourceLoader(workspace);
    const router = createBrewvaResourceRouter({ cwd: workspace, loader });

    const result = await router.read("brewva-resource:///pr/123");

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("provider_unavailable");
  });
});
